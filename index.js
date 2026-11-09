const {
    default: makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    downloadContentFromMessage
} = require('@whiskeysockets/baileys');
const qrcode = require('qrcode-terminal');
const express = require('express');
const axios = require('axios');
const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');
const pino = require('pino');
const sharp = require('sharp');

const app = express();
const port = 3456;

// Limit besar agar file base64 tidak terpotong
app.use(express.json({ limit: '100mb' }));
app.use(express.urlencoded({ limit: '100mb', extended: true }));

const N8N_WEBHOOK_URL = 'http://localhost:5678/webhook/wa-message';

let sock;
const sentByBotMessageIds = new Set();

// ============================================================================
// 1. HELPER OCR (Sharp Preprocessing + Tesseract OCR)
// ============================================================================
// Helper Pembersih & Normalisasi Cerdas Typo OCR Flyer
function cleanOcrTypo(text) {
    if (!text) return '';

    return text
        // 1. Variasi Zoom
        .replace(/\b[Zz2][0oOQ]{1,2}[mM]\b/gi, 'Zoom')
        .replace(/\bM0\)?/gi, 'Zoom')
        .replace(/Z0[O0]M/gi, 'Zoom')
        .replace(/Z0M/gi, 'Zoom')
        .replace(/\b200M\b/gi, 'Zoom')

        // 2. Rapikan spasi frasa ONLINE VIA (Beri spasi di akhir: "Zoom ")
        .replace(/ONLINEVIA/gi, 'ONLINE VIA ')
        .replace(/JOINONLINE/gi, 'JOIN ONLINE ')
        .replace(/JOIN ONLINE VIA\s*([^\n\w]*|M0\)?)/gi, 'JOIN ONLINE VIA Zoom ')
        .replace(/ONLINE VIA\s*([^\n\w]*|M0\)?)/gi, 'ONLINE VIA Zoom ')

        // 3. PISAHKAN ANGKA JIKA MENEMPEL DENGAN KATA ZOOM (misal: ZoomZoom4 -> Zoom 4)
        .replace(/(Zoom)+(\d+)/gi, 'Zoom $2')
        .replace(/(Zoom)+/gi, 'Zoom ')

        // 4. Rapikan spasi & baris kosong ganda
        .replace(/[ \t]+/g, ' ')
        .replace(/\n\s*\n/g, '\n')
        .trim();
}

// Helper: Tesseract OCR + Preprocessing Sharp (Formula Akurat Flyer)
function runTesseractOcr(base64Data) {
    return new Promise(async (resolve) => {
        const timestamp = `${Date.now()}_${Math.floor(Math.random() * 1000)}`;
        const tempOriginal = path.join(__dirname, `temp_orig_${timestamp}.jpg`);
        const tempProcessed = path.join(__dirname, `temp_proc_${timestamp}.png`);

        try {
            if (!base64Data) return resolve('');

            // Sanitasi string Base64 dari n8n (cegah buffer 0 bytes)
            let cleanB64 = String(base64Data).trim();
            while (cleanB64.startsWith('=')) {
                cleanB64 = cleanB64.slice(1);
            }
            if (cleanB64.startsWith('data:')) {
                const commaIdx = cleanB64.indexOf(',');
                if (commaIdx !== -1) cleanB64 = cleanB64.slice(commaIdx + 1);
            }

            const imgBuffer = Buffer.from(cleanB64, 'base64');
            if (imgBuffer.length < 100) {
                console.error(`❌ Buffer gambar tidak valid (${imgBuffer.length} bytes).`);
                return resolve('');
            }

            fs.writeFileSync(tempOriginal, imgBuffer);

            // TAHAP 1: Formula Andalan (Lebar 2600px + Linear 2.0, -80 + Sharpen)
            await sharp(tempOriginal)
                .resize({ width: 2600, fit: 'inside' })
                .grayscale()
                .linear(2.0, -80)
                .sharpen()
                .toFile(tempProcessed);

            // Eksekusi Tesseract PSM 11 (Sparse Text untuk tata letak poster/flyer)
            exec(`tesseract "${tempProcessed}" stdout --psm 11 -l ind+eng`, (error, stdout) => {
                if (fs.existsSync(tempProcessed)) fs.unlinkSync(tempProcessed);

                let textResult = stdout ? cleanOcrTypo(stdout) : '';

                // TAHAP 2: Fallback jika karakter terbaca terlalu sedikit (< 40 karakter)
                if (!textResult || textResult.length < 40) {
                    const tempProcessed2 = path.join(__dirname, `temp_proc2_${timestamp}.png`);
                    sharp(tempOriginal)
                        .resize({ width: 2200, fit: 'inside' })
                        .threshold(140)
                        .toFile(tempProcessed2)
                        .then(() => {
                            if (fs.existsSync(tempOriginal)) fs.unlinkSync(tempOriginal);
                            exec(`tesseract "${tempProcessed2}" stdout --psm 3 -l ind+eng`, (err2, stdout2) => {
                                if (fs.existsSync(tempProcessed2)) fs.unlinkSync(tempProcessed2);
                                let res2 = stdout2 ? cleanOcrTypo(stdout2) : (textResult || '');
                                resolve(res2);
                            });
                        })
                        .catch(() => {
                            if (fs.existsSync(tempOriginal)) fs.unlinkSync(tempOriginal);
                            resolve(textResult);
                        });
                } else {
                    if (fs.existsSync(tempOriginal)) fs.unlinkSync(tempOriginal);
                    resolve(textResult);
                }
            });
        } catch (err) {
            if (fs.existsSync(tempOriginal)) fs.unlinkSync(tempOriginal);
            if (fs.existsSync(tempProcessed)) fs.unlinkSync(tempProcessed);
            console.error('❌ Error Sharp Preprocessing:', err.message);
            resolve('');
        }
    });
}

// Helper: Download stream media langsung ke Base64
async function downloadMediaAsBase64(messageObj, type) {
    try {
        const stream = await downloadContentFromMessage(messageObj, type);
        let buffer = Buffer.from([]);
        for await (const chunk of stream) {
            buffer = Buffer.concat([buffer, chunk]);
        }
        return buffer.toString('base64');
    } catch (e) {
        console.error('❌ Gagal download stream media:', e.message);
        return null;
    }
}

// Helper: Format JID WhatsApp (Mendukung PRTG, Grup Lama/Baru, Japri, dan Akun LID)
function formatJid(target) {
    if (!target) return '';
    target = target.toString().trim();

    // 1. Jika sudah ada domain resmi (@s.whatsapp.net, @g.us, @lid), pertahankan
    if (target.endsWith('@s.whatsapp.net') || target.endsWith('@g.us') || target.endsWith('@lid')) {
        return target;
    }

    // 2. Cek format ID grup lama (ada tanda '-') ATAU ID grup baru (diawali 120363...)
    if (/^\d{10,16}-\d{9,12}$/.test(target) || /^120363\d{10,15}$/.test(target)) {
        return `${target}@g.us`;
    }

    // 3. Sisanya adalah nomor telepon personal
    let cleanNumber = target.replace(/\D/g, '');
    if (cleanNumber.startsWith('0')) {
        cleanNumber = '62' + cleanNumber.slice(1);
    }

    return `${cleanNumber}@s.whatsapp.net`;
}

// ============================================================================
// 2. ENDPOINT OCR & RESIZE (Dipanggil oleh n8n node HTTP Request)
// ============================================================================
app.post('/api/ocr', async (req, res) => {
    try {
        const { base64Data } = req.body;
        if (!base64Data) {
            console.log('⚠️ [OCR] base64Data KOSONG dari n8n!');
            return res.json({ status: 'error', text: '' });
        }

        console.log(`📥 [OCR API Diterima] Ukuran string Base64: ${base64Data.length}`);
        const resultText = await runTesseractOcr(base64Data);
        console.log(`📤 [OCR Balasan Dikirim] Panjang teks: ${resultText.length}`);

        return res.json({
            status: 'success',
            text: resultText
        });
    } catch (err) {
        console.error('❌ Gagal menjalankan OCR via API:', err.message);
        return res.status(500).json({ status: 'error', text: '', error: err.message });
    }
});

// Mendukung panggilan ke '/resize-image' maupun '/api/resize-image'
app.post(['/resize-image', '/api/resize-image'], async (req, res) => {
    try {
        const { base64 } = req.body;
        if (!base64) {
            return res.status(400).json({ success: false, error: 'Base64 image is required' });
        }

        const cleanBase64 = base64.replace(/^data:image\/[a-z]+;base64,/, '');
        const imgBuffer = Buffer.from(cleanBase64, 'base64');

        const resizedBuffer = await sharp(imgBuffer)
            .resize({ width: 400, withoutEnlargement: true })
            .jpeg({ quality: 70 })
            .toBuffer();

        return res.json({
            success: true,
            resizedBase64: resizedBuffer.toString('base64')
        });
    } catch (err) {
        console.error('❌ Error resize:', err.message);
        return res.status(500).json({ success: false, error: err.message });
    }
});

// ============================================================================
// 3. ENDPOINT PENGIRIMAN PESAN KE WA (Dipanggil oleh n8n)
// ============================================================================
let isWaConnected = false; // Flag status koneksi riil

app.post('/api/send', async (req, res) => {
    try {
        if (!sock || !isWaConnected) {
            console.warn('⚠️ [/api/send] Ditolak karena koneksi WA belum berstatus OPEN.');
            return res.status(503).json({
                status: 'error',
                message: 'Koneksi WhatsApp belum siap / sedang menyambungkan ulang.'
            });
        }

        const { to, text, media } = req.body;
        if (!to) {
            return res.status(400).json({ status: 'error', message: 'Target tujuan "to" wajib diisi.' });
        }

        const targetJid = formatJid(to);
        let sentMessage = null;

        if (!media || !media.data) {
            sentMessage = await sock.sendMessage(targetJid, { text: text || '' });
            console.log(`📤 [n8n -> WA] Teks terkirim ke ${targetJid}`);
        } else {
            const cleanBase64 = media.data.includes(',') ? media.data.split(',')[1] : media.data;
            const mediaBuffer = Buffer.from(cleanBase64, 'base64');
            const mediaType = media.type || 'document';

            let messagePayload = {};
            if (mediaType === 'image') {
                messagePayload = {
                    image: mediaBuffer,
                    caption: text || media.caption || '',
                    mimetype: media.mimetype || 'image/jpeg'
                };
            } else {
                messagePayload = {
                    document: mediaBuffer,
                    fileName: media.filename || 'document.pdf',
                    mimetype: media.mimetype || 'application/pdf',
                    caption: text || media.caption || ''
                };
            }

            sentMessage = await sock.sendMessage(targetJid, messagePayload);
            console.log(`📤 [n8n -> WA] Media (${mediaType}) terkirim ke ${targetJid}`);
        }

        // Anti-Loop Cache
        if (sentMessage?.key?.id) {
            sentByBotMessageIds.add(sentMessage.key.id);
            setTimeout(() => {
                sentByBotMessageIds.delete(sentMessage.key.id);
            }, 10 * 60 * 1000);
        }

        return res.json({ status: 'success', message: 'Pesan berhasil diproses dan dikirim ke WA.' });

    } catch (err) {
        console.error('❌ Gagal mengirim pesan dari n8n:', err.message);
        return res.status(500).json({ status: 'error', error: err.message });
    }
});

// ============================================================================
// 4. KONEKSI BAILEYS & FORWARDING KE n8n
// ============================================================================
let isConnecting = false;

async function startBot() {
    if (isConnecting) return;
    isConnecting = true;

    try {
        // Gunakan path absolut agar tidak nyasar saat auto-boot via PM2
        const authPath = path.join(__dirname, 'baileys_auth_info');
        const { state, saveCreds } = await useMultiFileAuthState(authPath);

        // Bersihkan listener lama jika ini adalah proses reconnect
        if (sock?.ev) {
            sock.ev.removeAllListeners();
        }

        sock = makeWASocket({
            auth: state,
            logger: pino({ level: 'silent' }),
            printQRInTerminal: false
        });

        sock.ev.on('creds.update', saveCreds);

        sock.ev.on('connection.update', (update) => {
            const { connection, lastDisconnect, qr } = update;

            if (qr) {
                console.log('⚡ Scan QR Code berikut untuk menyambungkan Baileys:');
                qrcode.generate(qr, { small: true });
            }

            if (connection === 'close') {
                isWaConnected = false;
                isConnecting = false;
                const statusCode = (lastDisconnect?.error)?.output?.statusCode;
                const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
                console.log(`🔌 Koneksi terputus (Code: ${statusCode}), mencoba ulang dalam 5 detik...`, shouldReconnect);
                
                // Beri jeda 5 detik agar jaringan siap dan tidak terjadi infinite loop
                if (shouldReconnect) {
                    setTimeout(() => startBot(), 5000);
                }
            } else if (connection === 'open') {
                isWaConnected = true;
                isConnecting = false;
                console.log('✅ WhatsApp Baileys Gateway Siap & Terhubung!');
            }
        });

        sock.ev.on('messages.upsert', async (m) => {
            try {
                const msg = m.messages[0];
                if (!msg || !msg.message) return;

                if (sentByBotMessageIds.has(msg.key.id)) {
                    console.log(`🤖 [Anti-Loop] Pesan ${msg.key.id} berasal dari n8n. Dilewati.`);
                    sentByBotMessageIds.delete(msg.key.id);
                    return;
                }

                const from = msg.key.remoteJid;
                if (!from || from === 'status@broadcast') return;

                const isGroup = from.endsWith('@g.us');
                const senderPhone = from.split('@')[0];

                const myJid = sock.user?.id ? sock.user.id.split(':')[0] + '@s.whatsapp.net' : '';
                const myLid = sock.user?.lid ? sock.user.lid.split(':')[0] + '@lid' : '';
                const isSelfChat = Boolean(msg.key.fromMe && !isGroup && (
                    from === myJid ||
                    from === myLid ||
                    (sock.user?.id && from.includes(sock.user.id.split(':')[0]))
                ));

                const content = msg.message?.ephemeralMessage?.message || msg.message?.viewOnceMessage?.message || msg.message;
                if (!content) return;

                let mediaPayload = null;
                let textBody = content?.conversation || content?.extendedTextMessage?.text || '';
                const messageType = Object.keys(content)[0];

                if (messageType === 'imageMessage') {
                    const imgObj = content.imageMessage;
                    textBody = (imgObj.caption || '').trim();
                    const b64 = await downloadMediaAsBase64(imgObj, 'image');
                    if (b64) {
                        mediaPayload = {
                            type: 'image',
                            mimetype: imgObj.mimetype || 'image/jpeg',
                            data: b64,
                            filename: 'image.jpg'
                        };
                    }
                } else if (messageType === 'documentMessage') {
                    const docObj = content.documentMessage;
                    textBody = (docObj.caption || '').trim();
                    const b64 = await downloadMediaAsBase64(docObj, 'document');
                    if (b64) {
                        mediaPayload = {
                            type: 'document',
                            mimetype: docObj.mimetype || 'application/pdf',
                            data: b64,
                            filename: docObj.fileName || 'document.pdf'
                        };
                    }
                }

                const payload = {
                    id: msg.key.id,
                    from: from,
                    senderPhone: senderPhone,
                    senderName: msg.pushName || 'User',
                    fromMe: msg.key.fromMe,
                    isGroup: isGroup,
                    isSelfChat: isSelfChat,
                    body: textBody,
                    messageType: messageType,
                    media: mediaPayload,
                    timestamp: msg.messageTimestamp,
                    rawMessage: msg
                };

                await axios.post(N8N_WEBHOOK_URL, payload, {
                    headers: { 'Content-Type': 'application/json' },
                    maxContentLength: Infinity,
                    maxBodyLength: Infinity
                });

                console.log(`📥 Pesan [${messageType}] dari ${from} (Self: ${isSelfChat}) berhasil diteruskan ke n8n.`);

            } catch (error) {
                console.error('❌ Error forwarding to n8n:', error?.message);
            }
        });
    } catch (err) {
        isConnecting = false;
        console.error('❌ Gagal menginisialisasi bot, mencoba ulang dalam 5 detik:', err.message);
        setTimeout(() => startBot(), 5000);
    }
}

// Jalankan server Express terlebih dahulu di 0.0.0.0, baru inisialisasi bot
app.listen(port, '0.0.0.0', () => {
    console.log(`🌐 Server Gateway Aktif di http://0.0.0.0:${port}`);
    startBot();
});

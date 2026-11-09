// ============================================================================
// KONFIGURASI PROYEK
// ============================================================================
const CONFIG = {
  DRIVE_FOLDER_ID: "1gr_ttFwQgoa97o9PymCXb8Ax2KpqQSUy",   // ID Folder arsip file Drive
  SPREADSHEET_ID: "1klJfg4WiJ2RT9remxg1LJz9QOUhZ9abAWFVQ5LuosY4",       // ID Google Sheets kamu
  SHEETS: {
    CONTACTS: "contact",
    MANUAL: "manual broadcast",
    AUTO: "automatic broadcast"
  }
};

// ============================================================================
// ENDPOINT GET (PENARIKAN DATA UNTUK N8N & PENCARIAN FILE DRIVE)
// ============================================================================
function doGet(e) {
  try {
    const action = e.parameter.action || '';
    const query = e.parameter.q || '';
    const bodyFrom = e.parameter.pengirim || '';

    // -------------------------------------------------------------
    // 1. AMBIL BROADCAST MANUAL
    // Dipanggil n8n via: ?action=getManualBroadcast
    // -------------------------------------------------------------
    if (action === 'getManualBroadcast') {
      const ss = SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID);
      const manualSheet = ss.getSheetByName(CONFIG.SHEETS.MANUAL);
      
      const targetKategori = manualSheet.getRange('A2').getValue().toString().trim();
      const template = manualSheet.getRange('B2').getValue().toString().trim();
      
      const contacts = getFilteredContacts(targetKategori);
      return jsonResponse({
        success: true,
        type: 'MANUAL',
        target: targetKategori,
        template: template,
        count: contacts.length,
        contacts: contacts
      });
    }

    // -------------------------------------------------------------
    // 2. AMBIL BROADCAST OTOMATIS (WAKTU SEKARANG)
    // Dipanggil n8n berkala via: ?action=getAutoBroadcast
    // -------------------------------------------------------------
    if (action === 'getAutoBroadcast') {
      const readyBroadcasts = getScheduledBroadcastsForNow();
      return jsonResponse({
        success: true,
        type: 'AUTOMATIC',
        count: readyBroadcasts.length,
        items: readyBroadcasts
      });
    }

    // -------------------------------------------------------------
    // 3. CEK REMINDER DOWNTIME PRTG
    // Dipanggil n8n berkala via: ?action=checkPrtgReminders
    // -------------------------------------------------------------
    if (action === 'checkPrtgReminders') {
      return checkPrtgReminders();
    }

    // -------------------------------------------------------------
    // 4. CARI & UNDUH FILE DRIVE (!kirim <nama file>)
    // Dipanggil bot via: ?q=nama_file
    // -------------------------------------------------------------
    if (query) {
      const targetFolder = DriveApp.getFolderById(CONFIG.DRIVE_FOLDER_ID);
      const searchQuery = "title contains '" + query.replace(/'/g, "\\'") + "' and trashed = false";
      const files = targetFolder.searchFiles(searchQuery);

      if (files.hasNext()) {
        const file = files.next();
        const blob = file.getBlob();
        const fileSize = file.getSize();

        // Batasi ukuran file (maksimal 25 MB)
        if (fileSize > 25 * 1024 * 1024) {
          return jsonResponse({ 
            found: false, 
            text: "Ukuran file terlalu besar (" + Math.round(fileSize / (1024 * 1024)) + " MB). Maksimal 25 MB." 
          });
        }

        return jsonResponse({
          found: true,
          fileName: file.getName(),
          mimeType: file.getMimeType(),
          fileSize: fileSize,
          base64: Utilities.base64Encode(blob.getBytes()),
          to: bodyFrom,
          text: "Berikut file yang kamu minta:\n*" + file.getName() + "*"
        });
      } else {
        return jsonResponse({ 
          found: false, 
          to: bodyFrom,
          text: "File *" + query + "* tidak ditemukan di folder arsip." 
        });
      }
    }

    return jsonResponse({ error: true, text: "Parameter tidak dikenali." });

  } catch (err) {
    return jsonResponse({ error: true, text: err.toString() });
  }
}

// ============================================================================
// ENDPOINT POST: LOG PRTG, GOOGLE TASKS, & GOOGLE CALENDAR
// ============================================================================
function doPost(e) {
  try {
    const data = JSON.parse(e.postData.contents);

    // -------------------------------------------------------------
    // 1. LOG PRTG (Wajib ditaruh paling atas sebelum Calendar/Tasks)
    // -------------------------------------------------------------
    if (data.action === 'logPrtg') {
      return handlePrtgWebhook(data);
    }

    const type = (data.type || 'EVENT').toUpperCase();
    const title = data.title || 'Tanpa Judul';
    const description = data.description || '';
    const location = data.location || '';

    // -------------------------------------------------------------
    // 2. GOOGLE TASKS
    // -------------------------------------------------------------
    if (type === 'TASK') {
      const taskListId = '@default';
      const dueDate = data.endTime ? new Date(data.endTime) : (data.startTime ? new Date(data.startTime) : new Date());
      const rfcDueDate = dueDate.toISOString();

      let notes = '';
      if (location) notes += `Tautan / Lokasi: ${location}\n\n`;
      if (description) notes += `Deskripsi:\n${description}`;
      notes = notes.trim();

      const existingTasks = Tasks.Tasks.list(taskListId, { showCompleted: false, showHidden: false });
      let isTaskDuplicate = false;
      if (existingTasks.items && existingTasks.items.length > 0) {
        isTaskDuplicate = existingTasks.items.some(task => {
          const sameTitle = (task.title || '').trim().toLowerCase() === title.trim().toLowerCase();
          let sameDue = true;
          if (task.due && rfcDueDate) sameDue = new Date(task.due).toDateString() === dueDate.toDateString();
          return sameTitle && sameDue;
        });
      }

      if (isTaskDuplicate) return jsonResponse({ status: 'SKIPPED', message: 'Task duplikat' });

      const newTask = Tasks.newTask();
      newTask.title = title;
      newTask.notes = notes;
      newTask.due = rfcDueDate;
      const createdTask = Tasks.Tasks.insert(newTask, taskListId);

      return jsonResponse({ status: 'SUCCESS', type: 'TASK', taskId: createdTask.id });
    }

    // -------------------------------------------------------------
    // 3. GOOGLE CALENDAR
    // -------------------------------------------------------------
    const startTime = new Date(data.startTime);
    const endTime = new Date(data.endTime);
    const calendar = CalendarApp.getDefaultCalendar();

    const existingEvents = calendar.getEvents(startTime, endTime);
    const isEventDuplicate = existingEvents.some(event => {
      return event.getTitle().trim().toLowerCase() === title.trim().toLowerCase() &&
             event.getStartTime().getTime() === startTime.getTime();
    });

    if (isEventDuplicate) return jsonResponse({ status: 'SKIPPED', message: 'Agenda duplikat' });

    const newEvent = calendar.createEvent(title, startTime, endTime, { description: description, location: location });
    return jsonResponse({ status: 'SUCCESS', type: 'EVENT', eventId: newEvent.getId() });

  } catch (error) {
    return jsonResponse({ status: 'ERROR', error: error.toString() });
  }
}

// ============================================================================
// LOGIKA PENGECEKAN BROADCAST OTOMATIS (HARI & JAM)
// ============================================================================
function getScheduledBroadcastsForNow() {
  const ss = SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID);
  const autoSheet = ss.getSheetByName(CONFIG.SHEETS.AUTO);
  if (!autoSheet) return [];

  const data = autoSheet.getDataRange().getValues();
  if (data.length <= 1) return [];

  const now = new Date();
  const currentDay = now.getDay(); // 0 = Minggu, 1 = Senin, dst.
  const currentDayCol = (currentDay === 0) ? 7 : currentDay; // Kolom B=1 (Senin) .. H=7 (Minggu)
  const currentTimeStr = Utilities.formatDate(now, "Asia/Jakarta", "HH:mm");

  const results = [];

  for (let i = 1; i < data.length; i++) {
    const row = data[i];
    const target = String(row[0]).trim();
    const isTodayChecked = Boolean(row[currentDayCol]);
    
    let jam = row[8];
    if (jam instanceof Date) {
      jam = Utilities.formatDate(jam, "Asia/Jakarta", "HH:mm");
    } else {
      jam = String(jam).trim();
    }

    const pesan = String(row[9]).trim();
    const status = String(row[10]).trim().toLowerCase();

    // Cocokkan status aktif, centang hari ini, dan kesamaan jam
    if (status === 'aktif' && isTodayChecked && jam === currentTimeStr) {
      const contacts = getFilteredContacts(target);
      if (contacts.length > 0) {
        results.push({
          rowId: i + 1,
          target: target,
          jam: jam,
          template: pesan,
          contacts: contacts
        });
      }
    }
  }

  return results;
}

// =========================================================================
// FUNGSI PENCATAT LOG PRTG (Dipanggil saat Webhook PRTG masuk: DOWN / UP)
// =========================================================================
function handlePrtgWebhook(payload) {
  const ss = SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID);
  let sheet = ss.getSheetByName('log_prtg');
  
  // Otomatis buat sheet jika belum ada
  if (!sheet) {
    sheet = ss.insertSheet('log_prtg');
    sheet.appendRow(['device_id', 'status', 'waktu_down', 'waktu_up', 'total_durasi', 'last_reminded_min', 'chat_id']);
  }

  const device = String(payload.device || 'Unknown Device').trim();
  const status = String(payload.status || '').trim().toUpperCase(); // 'DOWN' atau 'UP'
  const chatId = String(payload.chat_id || '').trim();
  const now = new Date();
  const nowMs = now.getTime();
  const jamStr = Utilities.formatDate(now, "Asia/Jakarta", "dd/MM/yyyy HH:mm:ss");

  const data = sheet.getDataRange().getValues();

  // --- KASUS A: JARINGAN DOWN (Selalu buat baris baru di atas) ---
  if (status === 'DOWN') {
    for (let i = data.length - 1; i >= 1; i--) {
      if (String(data[i][0]).trim() === device && String(data[i][2]).toUpperCase() === 'DOWN') {
        return jsonResponse({ success: true, message: 'Device sudah berstatus DOWN di log.' });
      }
    }
    sheet.insertRowAfter(1); 
    sheet.getRange(2, 1, 1, 7).setValues([[device, 'DOWN', nowMs, '', '', 0, chatId]]);

    return jsonResponse({ success: true, message: 'Log DOWN berhasil dicatat.' });
  }

  // --- KASUS B: JARINGAN KEMBALI UP ---
  if (status === 'UP') {
    // Cari dari baris paling bawah, log DOWN milik device ini yang belum UP
    for (let i = data.length - 1; i >= 1; i--) {
      if (String(data[i][0]).trim() === device && String(data[i][1]).toUpperCase() === 'DOWN') {
        const downMs = Number(data[i][2]);
        const diffMinutes = Math.max(1, Math.floor((nowMs - downMs) / 60000));
        
        const jam = Math.floor(diffMinutes / 60);
        const menit = diffMinutes % 60;
        const durasiStr = jam > 0 ? `${jam} Jam ${menit} Menit` : `${menit} Menit`;

        // Update baris tersebut menjadi UP
        const rowNum = i + 1;
        sheet.getRange(rowNum, 2).setValue('UP');        // Kolom B: status
        sheet.getRange(rowNum, 4).setValue(nowMs);       // Kolom D: waktu_up
        sheet.getRange(rowNum, 5).setValue(durasiStr);   // Kolom E: total_durasi

        return jsonResponse({
          success: true,
          send_wa: true,
          to: chatId || data[i][6],
          text: `✅ *RECOVERY JARINGAN UP*\n\n📡 *Jaringan:* ${device}\n🕒 *Waktu Up:* ${jamStr} WIB\n⏱️ *Total Downtime:* ${durasiStr}`
        });
      }
    }

    // Jika tiba-tiba ada sinyal UP tapi sebelumnya tidak tercatat DOWN
    return jsonResponse({
      success: true,
      send_wa: true,
      to: chatId,
      text: `✅ *INFO JARINGAN UP*\n\n📡 *Jaringan:* ${device}\n🕒 *Waktu Up:* ${jamStr} WIB`
    });
  }

  return jsonResponse({ success: false, message: 'Status tidak dikenali (harus DOWN atau UP)' });
}

// =========================================================================
// FUNGSI PENGECEK REMINDER (Dipanggil tiap 1 menit oleh Schedule Trigger)
// =========================================================================
function checkPrtgReminders() {
  const ss = SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID);
  const sheet = ss.getSheetByName('log_prtg');
  if (!sheet) return jsonResponse({ count: 0, items: [] });

  const data = sheet.getDataRange().getValues();
  const now = new Date().getTime();
  const remindersToSend = [];

  for (let i = 1; i < data.length; i++) {
    const row = data[i];
    const device = row[0];
    const status = String(row[1]).toUpperCase();
    const downTime = Number(row[2]);
    const lastReminded = Number(row[5] || 0);
    const chatId = row[6];

    if (status === 'DOWN' && downTime) {
      const diffMinutes = Math.floor((now - downTime) / 60000);
      
      let nextMilestone = null;
      if (lastReminded < 5 && diffMinutes >= 5) nextMilestone = 5;
      else if (lastReminded < 10 && diffMinutes >= 10) nextMilestone = 10;
      else if (lastReminded < 15 && diffMinutes >= 15) nextMilestone = 15;
      else if (lastReminded < 30 && diffMinutes >= 30) nextMilestone = 30;
      else if (diffMinutes >= 60) {
        const currentHourMilestone = Math.floor(diffMinutes / 60) * 60;
        if (currentHourMilestone > lastReminded) {
          nextMilestone = currentHourMilestone;
        }
      }

      if (nextMilestone !== null) {
        sheet.getRange(i + 1, 6).setValue(nextMilestone);
        
        const labelWaktu = nextMilestone >= 60 
          ? `${nextMilestone / 60} Jam (${diffMinutes} menit)` 
          : `${nextMilestone} Menit`;

        const jamDownStr = Utilities.formatDate(new Date(downTime), "Asia/Jakarta", "HH:mm");

        remindersToSend.push({
          to: chatId,
          text: `⚠️ *REMINDER DOWNTIME (${labelWaktu})*\n\n📡 *Jaringan:* ${device}\n🔴 *Status:* Masih DOWN sejak pukul ${jamDownStr} WIB.`
        });
      }
    }
  }

  return jsonResponse({
    count: remindersToSend.length,
    items: remindersToSend
  });
}

// ============================================================================
// HELPER DATA KONTAK & FORMAT JSON
// ============================================================================
function getFilteredContacts(targetKategori) {
  const ss = SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID);
  const sheet = ss.getSheetByName(CONFIG.SHEETS.CONTACTS);
  const data = sheet.getDataRange().getValues();
  const contacts = [];
  const filter = (targetKategori || '').toLowerCase().trim();

  for (let i = 1; i < data.length; i++) {
    const row = data[i];
    const nama = String(row[0]).trim();
    const nomor = String(row[1]).trim();
    const kategori = String(row[2]).trim();
    const status = String(row[3]).trim().toLowerCase();

    if (status === 'aktif' || status === '') {
      const matchKategori = (!filter || filter === 'semua' || 
        kategori.toLowerCase().split(',').map(s => s.trim()).includes(filter) ||
        nomor === filter);

      if (matchKategori && nomor) {
        contacts.push({ nama: nama, nomor: nomor, kategori: kategori });
      }
    }
  }
  return contacts;
}

function jsonResponse(data) {
  return ContentService.createTextOutput(JSON.stringify(data))
    .setMimeType(ContentService.MimeType.JSON);
}


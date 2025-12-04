// bot.js
import express from "express";
import TelegramBot from "node-telegram-bot-api";
import pkg from "pg";
const { Pool } = pkg;

// ================== CONFIG ==================
const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const URL = process.env.APP_URL;
const PORT = process.env.PORT || 3000;
const DATABASE_URL = process.env.DATABASE_URL;
// CHANNEL_ID is your storage channel - files ALWAYS forwarded here
const CHANNEL_ID = process.env.CHANNEL_ID ? parseInt(process.env.CHANNEL_ID, 10) : -1003155277985;

// =============== EDIT THESE GROUP IDS AS NEEDED ===============
// Keep them as you provided — change here if you move groups.
const GROUPS = {
  // 1. Edited Sermon Video Group:
  EDITED_SERMON_VIDEO: -4744650276,
  // 2. Unedited Sermon Video Group:
  UNEDITED_SERMON_VIDEO: -4992287277,
  // 3. Edited Prophecy Video Group:
  EDITED_PROPHECY_VIDEO: -5077930825,
  // 4. Unedited Prophecy Video Group:
  UNEDITED_PROPHECY_VIDEO: -5081170727,
  // 5. Sermon Audio Group:
  SERMON_AUDIO_GROUP: -5012235102,
  // Storage channel (already set as CHANNEL_ID above)
  STORAGE_CHANNEL: CHANNEL_ID
};
// =============================================================

// Admins (BigInt)
const ADMINS = [6776845536n, 7311852471n]; // keep your registered admin users here

if (!TOKEN || !URL || !DATABASE_URL) {
  console.error("❌ Missing required environment variables (TELEGRAM_BOT_TOKEN, APP_URL, DATABASE_URL).");
  process.exit(1);
}

// ================== POSTGRES ==================
const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// Perform startup DB init in an IIFE
(async () => {
  try {
    await pool.query("SELECT 1");
    console.log("✅ Connected to Postgres");

    // ensure base table exists (with category, upload_date, publish_date columns)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS files (
        id SERIAL PRIMARY KEY,
        chat_id BIGINT NOT NULL,
        message_id BIGINT NOT NULL,
        caption TEXT NOT NULL,
        real_filename TEXT,
        file_type TEXT NOT NULL,
        file_extension TEXT,
        file_id TEXT NOT NULL,
        edited BOOLEAN DEFAULT false,
        published BOOLEAN DEFAULT false,
        visible BOOLEAN DEFAULT true,
        uploaded_by BIGINT,
        category TEXT,
        upload_date TIMESTAMP,
        publish_date TIMESTAMP,
        created_at TIMESTAMP DEFAULT NOW(),
        UNIQUE(chat_id, message_id, file_id)
      );
    `);

    // ensure columns exist (safe to run multiple times)
    await pool.query(`ALTER TABLE files ADD COLUMN IF NOT EXISTS category TEXT;`);
    await pool.query(`ALTER TABLE files ADD COLUMN IF NOT EXISTS upload_date TIMESTAMP;`);
    await pool.query(`ALTER TABLE files ADD COLUMN IF NOT EXISTS publish_date TIMESTAMP;`);

    console.log("✅ DB schema ensured.");
  } catch (err) {
    console.error("❌ Postgres init failed:", err);
    process.exit(1);
  }
})();

// ================== BOT INIT ==================
const bot = new TelegramBot(TOKEN);
bot.setWebHook(`${URL}/webhook`);

// ================== EXPRESS INIT ==================
const app = express();
app.use(express.json());

// ================== HELPER MAPS ==================
// awaitingCaption: promptMessageId -> { originalMessage, promptChatId }
// awaitingReply: promptMessageId -> { type: 'editname'|'publishSchedule'|'uploadDate', fileId, extra... }
const awaitingCaption = new Map();
const awaitingReply = new Map(); // generic replies for several flows
// temporary in-memory store for partial upload date selections: fileId -> { day, month }
const awaitingUploadDate = new Map();

// ================== HELPERS ==================
const isAdmin = (userId) => {
  try {
    return ADMINS.some(a => BigInt(userId) === a);
  } catch {
    return false;
  }
};

const detectFileInfo = (msg) => {
  if (msg.document) {
    const name = msg.document.file_name || "untitled";
    const ext = name.includes(".") ? name.split(".").pop().toLowerCase() : "";
    return { file_type: "document", file_id: msg.document.file_id, file_name: name, extension: ext };
  }
  if (msg.video) {
    const name = msg.video.file_name || `video-${msg.message_id}`;
    const ext = name.includes(".") ? name.split(".").pop().toLowerCase() : "mp4";
    return { file_type: "video", file_id: msg.video.file_id, file_name: name, extension: ext };
  }
  if (msg.audio) {
    const name = msg.audio.file_name || `audio-${msg.message_id}`;
    const ext = name.includes(".") ? name.split(".").pop().toLowerCase() : "m4a";
    return { file_type: "audio", file_id: msg.audio.file_id, file_name: name, extension: ext };
  }
  return null;
};

// ================== DB OPERATIONS ==================
const insertFileRow = async ({ msg, captionOverride = null, uploadedBy = null }) => {
  const info = detectFileInfo(msg);
  if (!info) return null;

  const caption = captionOverride ?? (msg.caption || info.file_name || "untitled");
  const real_filename = msg.document?.file_name ?? caption;
  const res = await pool.query(`
    INSERT INTO files
      (chat_id, message_id, caption, real_filename, file_type, file_extension, file_id, uploaded_by)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
    RETURNING *;
  `, [msg.chat.id, msg.message_id, caption, real_filename, info.file_type, info.extension, info.file_id, uploadedBy ?? msg.from?.id ?? null]);

  return res.rows[0];
};

const updateFile = async (id, fields = {}) => {
  const keys = Object.keys(fields);
  if (keys.length === 0) return null;
  const set = keys.map((k, i) => `${k} = $${i + 1}`).join(", ");
  const values = keys.map(k => fields[k]);
  const q = `UPDATE files SET ${set} WHERE id = $${keys.length + 1} RETURNING *`;
  const res = await pool.query(q, [...values, id]);
  return res.rows[0];
};

const fetchFile = async (id) => {
  const res = await pool.query("SELECT * FROM files WHERE id = $1", [id]);
  return res.rows[0] ?? null;
};

const findFileByMessage = async (chatId, messageId, fileId) => {
  // Helpful when admin replies to a message in a chat and you want the db row
  const res = await pool.query("SELECT * FROM files WHERE chat_id = $1 AND message_id = $2 AND file_id = $3 LIMIT 1", [chatId, messageId, fileId]);
  return res.rows[0] ?? null;
};

const searchFiles = async (queryText, requesterIsAdmin) => {
  const q = `%${queryText}%`;
  const sql = requesterIsAdmin
    ? "SELECT * FROM files WHERE LOWER(caption) LIKE $1 ORDER BY created_at DESC LIMIT 50"
    : "SELECT * FROM files WHERE visible = TRUE AND LOWER(caption) LIKE $1 ORDER BY created_at DESC LIMIT 50";
  const res = await pool.query(sql, [q]);
  return res.rows;
};

// ================== INLINE KEYBOARDS & FLOWS ==================
// Category keyboard (user clicks one)
const sendCategoryKeyboard = async (chatId, fileRow) => {
  const keyboard = {
    reply_markup: {
      inline_keyboard: [
        [
          { text: "Sermon", callback_data: `cat|sermon|${fileRow.id}` },
          { text: "Prophecy", callback_data: `cat|prophecy|${fileRow.id}` }
        ]
      ]
    }
  };
  await bot.sendMessage(chatId, `Which category is "${fileRow.caption}"?`, keyboard);
};

// Edited / Unedited keyboard
const sendEditedKeyboard = async (chatId, fileRow) => {
  const keyboard = {
    reply_markup: {
      inline_keyboard: [
        [
          { text: "Edited", callback_data: `class|edited|${fileRow.id}` },
          { text: "Unedited", callback_data: `class|unedited|${fileRow.id}` }
        ]
      ]
    }
  };
  await bot.sendMessage(chatId, `Is "${fileRow.caption}" edited or unedited?`, keyboard);
};

// Publish keyboard (admin option)
const sendPublishedKeyboard = async (chatId, fileRow) => {
  const keyboard = {
    reply_markup: {
      inline_keyboard: [
        [
          { text: "Publish now", callback_data: `publish|now|${fileRow.id}` },
          { text: "Schedule (pick date)", callback_data: `publish|schedule|${fileRow.id}` }
        ]
      ]
    }
  };
  await bot.sendMessage(chatId, `When should "${fileRow.caption}" be published?`, keyboard);
};

// Admin action menu (Edit this file -> admin actions shown)
const sendAdminFileActions = async (chatId, fileRow) => {
  const buttons = [
    [{ text: "Edit caption", callback_data: `admin|editname|${fileRow.id}` }],
    [{ text: fileRow.edited ? (fileRow.published ? "Mark Unpublished" : "Mark Published") : "Mark Published (edited only)", callback_data: `admin|togglepublished|${fileRow.id}` }],
    [{ text: fileRow.visible ? "Hide from users" : "Unhide (visible)", callback_data: `admin|togglevisible|${fileRow.id}` }],
    [{ text: "Set publish date", callback_data: `admin|setpublishdate|${fileRow.id}` }],
    [{ text: "Set upload date", callback_data: `admin|setuploaddate|${fileRow.id}` }],
    [{ text: "Delete (DB only)", callback_data: `admin|delete|${fileRow.id}` }]
  ];
  await bot.sendMessage(chatId,
    `File details:\n\nTitle: ${fileRow.caption}\nType: ${fileRow.file_type}\nCategory: ${fileRow.category || "(not set)"}\nEdited: ${fileRow.edited}\nPublished: ${fileRow.published}\nVisible: ${fileRow.visible}\nFilename: ${fileRow.real_filename || "(none)"}\nUploaded by: ${fileRow.uploaded_by}\nStored id: ${fileRow.id}`,
    { reply_markup: { inline_keyboard: buttons }, parse_mode: "Markdown" }
  );
};

// Upload-date inline flows (Day -> Month -> Year)
const sendDayKeyboard = async (chatId, fileId) => {
  // many buttons — arrange in rows of 7 for readability
  const rows = [];
  let row = [];
  for (let d = 1; d <= 31; d++) {
    row.push({ text: String(d), callback_data: `uday|${d}|${fileId}` });
    if (row.length === 7) {
      rows.push(row);
      row = [];
    }
  }
  if (row.length) rows.push(row);

  await bot.sendMessage(chatId, "Select upload DAY (1-31):", { reply_markup: { inline_keyboard: rows } });
};

const MONTHS = [
  ["Jan","1"],["Feb","2"],["Mar","3"],["Apr","4"],["May","5"],["Jun","6"],
  ["Jul","7"],["Aug","8"],["Sep","9"],["Oct","10"],["Nov","11"],["Dec","12"]
];

const sendMonthKeyboard = async (chatId, fileId) => {
  const rows = [];
  let row = [];
  for (const [label, val] of MONTHS) {
    row.push({ text: label, callback_data: `umonth|${val}|${fileId}` });
    if (row.length === 4) { rows.push(row); row = []; }
  }
  if (row.length) rows.push(row);
  await bot.sendMessage(chatId, "Select upload MONTH:", { reply_markup: { inline_keyboard: rows } });
};

const sendYearKeyboard = async (chatId, fileId) => {
  // customize the range if needed
  const start = 2000;
  const end = 2035;
  const rows = [];
  let row = [];
  for (let y = start; y <= end; y++) {
    row.push({ text: String(y), callback_data: `uyear|${y}|${fileId}` });
    if (row.length === 5) { rows.push(row); row = []; }
  }
  if (row.length) rows.push(row);
  await bot.sendMessage(chatId, "Select upload YEAR:", { reply_markup: { inline_keyboard: rows } });
};

// ================== FORWARDING LOGIC ==================
// Decide which group to forward to based on file type, category and edited flag
const determineTargetGroup = (fileRow) => {
  const type = fileRow.file_type; // "video" | "audio" | "document"
  const cat = (fileRow.category || "").toLowerCase();

  if (type === "video") {
    if (cat === "sermon") return fileRow.edited ? GROUPS.EDITED_SERMON_VIDEO : GROUPS.UNEDITED_SERMON_VIDEO;
    if (cat === "prophecy") return fileRow.edited ? GROUPS.EDITED_PROPHECY_VIDEO : GROUPS.UNEDITED_PROPHECY_VIDEO;
    // default fallback
    return GROUPS.EDITED_SERMON_VIDEO;
  }

  if (type === "audio") {
    // audio routing currently goes to SERMON_AUDIO_GROUP by default
    return GROUPS.SERMON_AUDIO_GROUP;
  }

  // documents & others fallback to storage only (don't spam groups)
  return null;
};

const forwardToGroups = async (fileRow) => {
  // ALWAYS forward to STORAGE channel immediately when we first save the file
  // (this function will be used to forward to the target group later,
  //  but storage forwarding is already performed when saving.)
  const targetGroup = determineTargetGroup(fileRow);
  if (!targetGroup) {
    console.log("No group determined for file id", fileRow.id, "- not forwarding to additional group.");
    return;
  }

  try {
    if (fileRow.file_type === "document") {
      await bot.sendDocument(targetGroup, fileRow.file_id, { caption: fileRow.caption });
    } else if (fileRow.file_type === "video") {
      await bot.sendVideo(targetGroup, fileRow.file_id, { caption: fileRow.caption });
    } else if (fileRow.file_type === "audio") {
      await bot.sendAudio(targetGroup, fileRow.file_id, { caption: fileRow.caption });
    } else {
      await bot.sendMessage(targetGroup, `Saved file: ${fileRow.caption}`);
    }
    console.log(`Forwarded file id ${fileRow.id} to group ${targetGroup}`);
  } catch (err) {
    console.error("Failed to forward to target group:", err);
  }
};

// ================== WEBHOOK (Express) ==================
app.post("/webhook", (req, res) => {
  try {
    bot.processUpdate(req.body);
    res.sendStatus(200);
  } catch (err) {
    console.error("Webhook processing failed:", err);
    res.sendStatus(500);
  }
});

// ================== START BOT ==================
bot.onText(/\/start/, (msg) => {
  const welcome = isAdmin(msg.from.id)
    ? "🎉 Welcome Admin. Send media to save, classify, and search files."
    : "🎉 Welcome. You can search files here; uploading is for admins only.";
  bot.sendMessage(msg.chat.id, welcome);
});

// Helpful: show group id when bot sees a group (commented out sending — avoid spam)
bot.on("message", (msg) => {
  try {
    if (msg.chat && (msg.chat.type === "group" || msg.chat.type === "supergroup")) {
      console.log("GROUP ID:", msg.chat.id);
      // If you want the bot to announce group id, uncomment:
      // bot.sendMessage(msg.chat.id, `🆔 Group ID: ${msg.chat.id}`);
    }
  } catch (err) {
    // ignore
  }
});

// ================== MESSAGE HANDLER (main) ==================
bot.on("message", async (msg) => {
  try {
    const requesterId = msg.from?.id;
    const chatId = msg.chat.id;

    // ignore commands here (start handled above)
    if (msg.text?.startsWith("/")) return;

    // === If admin replies to an existing file message in-group: show full details + "Edit this file?" button ===
    if (msg.reply_to_message && isAdmin(requesterId)) {
      const replied = msg.reply_to_message;
      const fileCandidate = replied.document || replied.video || replied.audio;
      if (fileCandidate) {
        // Try to find DB row matching that original message (chat + message + file_id)
        const dbRow = await findFileByMessage(replied.chat.id, replied.message_id, fileCandidate.file_id);
        if (dbRow) {
          // send file details and an "Edit this file?" inline button (admins only)
          const keyboard = {
            reply_markup: {
              inline_keyboard: [
                [{ text: "Edit this file?", callback_data: `admin|openedit|${dbRow.id}` }]
              ]
            }
          };
          await bot.sendMessage(chatId, `File found in DB:\n\nTitle: ${dbRow.caption}\nType: ${dbRow.file_type}\nCategory: ${dbRow.category || "(not set)"}\nEdited: ${dbRow.edited}\nPublished: ${dbRow.published}\nVisible: ${dbRow.visible}\nFilename: ${dbRow.real_filename || "(none)"}\nUploaded by: ${dbRow.uploaded_by}\nStored id: ${dbRow.id}`, keyboard);
          // stop further processing for this message (admin reply handled)
          return;
        }
      }
    }

    // === Replies to prompts (caption prompt + generic awaitingReply flows) ===
    if (msg.reply_to_message) {
      const replyId = msg.reply_to_message.message_id;

      // Caption flow (when we asked for caption)
      if (awaitingCaption.has(replyId)) {
        const original = awaitingCaption.get(replyId);
        const captionText = (msg.text || "").trim();
        if (!captionText) return bot.sendMessage(chatId, "❌ Caption cannot be empty. Please send a valid caption.");

        try {
          // Insert into DB and forward to storage channel immediately (storage always gets a copy)
          const inserted = await insertFileRow({ msg: original.originalMessage, captionOverride: captionText, uploadedBy: requesterId });
          awaitingCaption.delete(replyId);

          // Forward to storage channel (only once)
          if (original.originalMessage.document) await bot.sendDocument(GROUPS.STORAGE_CHANNEL, original.originalMessage.document.file_id, { caption: captionText });
          if (original.originalMessage.video) await bot.sendVideo(GROUPS.STORAGE_CHANNEL, original.originalMessage.video.file_id, { caption: captionText });
          if (original.originalMessage.audio) await bot.sendAudio(GROUPS.STORAGE_CHANNEL, original.originalMessage.audio.file_id, { caption: captionText });

          await bot.sendMessage(chatId, `✅ "${captionText}" saved ✔️`);

          // Start sequential inline question flow: Category -> Edited -> Upload date...
          // Ask CATEGORY first:
          await sendCategoryKeyboard(chatId, inserted);

          // Note: do NOT call sendEditedKeyboard or forward yet. We'll prompt next after category callback.
          console.log("Indexed with caption (reply flow):", inserted.id);
        } catch (err) {
          console.error("Caption reply insert failed:", err);
          return bot.sendMessage(chatId, "❌ Failed to save the file. Try again.");
        }
        return;
      }

      // Generic awaitingReply flows (edit name, publish schedule input, etc.)
      if (awaitingReply.has(replyId)) {
        const payload = awaitingReply.get(replyId);
        // Edit filename reply
        if (payload.type === "editname" && payload.fileId) {
          const newName = (msg.text || "").trim();
          if (!newName) return bot.sendMessage(chatId, "❌ Filename cannot be empty.");
          try {
            const updated = await updateFile(payload.fileId, { real_filename: newName, caption: newName });
            awaitingReply.delete(replyId);
            await bot.sendMessage(chatId, `✅ Filename updated: "${newName}"`);
            await sendAdminFileActions(chatId, updated);
          } catch (err) {
            console.error("Filename reply update failed:", err);
            return bot.sendMessage(chatId, "❌ Failed to update filename.");
          }
          return;
        }

        // Publish schedule reply (admin enters "YYYY-MM-DD HH:MM" or we could ask sequentially — for simplicity accept ISO)
        if (payload.type === "publishSchedule" && payload.fileId) {
          const val = (msg.text || "").trim();
          // try to parse as ISO datetime
          const dt = new Date(val);
          if (isNaN(dt.getTime())) {
            return bot.sendMessage(chatId, "❌ Invalid date format. Use YYYY-MM-DD HH:MM (24h). Example: 2025-12-25 14:30");
          }
          try {
            const updated = await updateFile(payload.fileId, { publish_date: dt, published: false });
            awaitingReply.delete(replyId);
            await bot.sendMessage(chatId, `✅ Publish date set: ${dt.toISOString()}`);
            await sendAdminFileActions(chatId, updated);
          } catch (err) {
            console.error("Publish schedule save failed:", err);
            return bot.sendMessage(chatId, "❌ Failed to set publish date.");
          }
          return;
        }

        // Admin set upload date by free text (not used in main flow) - not implemented by default
        // Add other awaitingReply types here as needed
      }
    }

    // === Media handling (group or private) ===
    const mediaMsg = msg.document || msg.video || msg.audio;
    if (mediaMsg) {
      // only allow admins to save files
      if (!isAdmin(requesterId)) {
        return bot.sendMessage(chatId, "❌ Only bot admins can save files. You may search files though.");
      }

      // If no caption, ask for caption via reply flow
      if (!msg.caption) {
        const prompt = await bot.sendMessage(chatId, "📌 Please send a caption for this file so it can be saved. Reply to this message with the caption.");
        // store original message for later insertion
        awaitingCaption.set(prompt.message_id, { originalMessage: msg, promptChatId: chatId });
        console.log("Awaiting caption for message", msg.message_id, "mapped to prompt", prompt.message_id);
        return;
      }

      // If caption provided, insert immediately and forward to storage channel (single copy)
      try {
        const inserted = await insertFileRow({ msg, captionOverride: msg.caption, uploadedBy: requesterId });

        // Forward to storage channel (only once)
        if (msg.document) await bot.sendDocument(GROUPS.STORAGE_CHANNEL, msg.document.file_id, { caption: msg.caption });
        if (msg.video) await bot.sendVideo(GROUPS.STORAGE_CHANNEL, msg.video.file_id, { caption: msg.caption });
        if (msg.audio) await bot.sendAudio(GROUPS.STORAGE_CHANNEL, msg.audio.file_id, { caption: msg.caption });

        await bot.sendMessage(chatId, `✅ "${msg.caption}" saved ✔️`);

        // Start the sequential inline question flow: ask CATEGORY now
        await sendCategoryKeyboard(chatId, inserted);

        console.log("Admin upload indexed:", inserted.id);
      } catch (err) {
        console.error("Media insert failed:", err);
        return bot.sendMessage(chatId, "❌ Failed to save file. Try again.");
      }
      return;
    }

    // === Private search (non-media text) ===
    if (msg.chat.type === "private" && msg.text) {
      const query = msg.text.trim().toLowerCase();
      if (!query) return;

      const results = await searchFiles(query, isAdmin(requesterId));
      if (!results.length) return bot.sendMessage(chatId, `❌ No files found matching "${msg.text}".`);

      const keyboard = results.map(r => [{ text: r.caption.length > 50 ? r.caption.slice(0, 50) + "…" : r.caption, callback_data: `get|${r.id}` }]);
      await bot.sendMessage(chatId, `🔎 Search results for "${msg.text}":`, { reply_markup: { inline_keyboard: keyboard } });
    }
  } catch (err) {
    console.error("Message handler error:", err);
  }
});

// ================== CALLBACK HANDLER ==================
bot.on("callback_query", async (cb) => {
  const data = cb.data || "";
  const parts = data.split("|");
  const action = parts[0];
  // sometimes cb.message is undefined (rare), fallback to cb.from.id
  const chatId = cb.message?.chat?.id ?? cb.from.id;

  try {
    // ---------- CATEGORY ----------
    // cat|<category>|<fileId>
    if (action === "cat") {
      const category = parts[1];
      const fileId = parseInt(parts[2], 10);
      if (!fileId) {
        await bot.answerCallbackQuery(cb.id, { text: "Invalid file." });
        return;
      }

      const updated = await updateFile(fileId, { category });
      await bot.answerCallbackQuery(cb.id, { text: `Category set to ${category}` });
      await bot.sendMessage(chatId, `✅ "${updated.caption}" category set to *${category}*.`, { parse_mode: "Markdown" });

      // After category set, ask Edited/Unedited next (sequential)
      await sendEditedKeyboard(chatId, updated);
      return;
    }

    // ---------- CLASSIFICATION (edited/unedited) ----------
    // class|edited|<fileId>
    if (action === "class") {
      const which = parts[1]; // "edited" or "unedited"
      const fileId = parseInt(parts[2], 10);
      if (!fileId) {
        await bot.answerCallbackQuery(cb.id, { text: "Invalid file." });
        return;
      }

      const editedValue = which === "edited";
      const updated = await updateFile(fileId, { edited: editedValue });
      await bot.answerCallbackQuery(cb.id, { text: `Marked as ${which}` });
      await bot.sendMessage(chatId, `✅ File "${updated.caption}" marked as *${which}*.`, { parse_mode: "Markdown" });

      // After marking edited/unedited, ask for upload date sequentially:
      // Day -> Month -> Year
      // store nothing yet; use awaitingUploadDate map to collect day/month/year
      awaitingUploadDate.set(fileId, {});

      await sendDayKeyboard(chatId, fileId);
      return;
    }

    // ---------- UPLOAD DATE: DAY ----------
    // uday|<day>|<fileId>
    if (action === "uday") {
      const day = parseInt(parts[1], 10);
      const fileId = parseInt(parts[2], 10);
      if (!fileId || !day) { await bot.answerCallbackQuery(cb.id, { text: "Invalid selection." }); return; }

      awaitingUploadDate.set(fileId, { day });
      await bot.answerCallbackQuery(cb.id, { text: `Day selected: ${day}` });
      await sendMonthKeyboard(chatId, fileId);
      return;
    }

    // ---------- UPLOAD DATE: MONTH ----------
    // umonth|<month>|<fileId>
    if (action === "umonth") {
      const month = parseInt(parts[1], 10); // 1..12
      const fileId = parseInt(parts[2], 10);
      if (!fileId || !month) { await bot.answerCallbackQuery(cb.id, { text: "Invalid selection." }); return; }

      const state = awaitingUploadDate.get(fileId) || {};
      state.month = month;
      awaitingUploadDate.set(fileId, state);
      await bot.answerCallbackQuery(cb.id, { text: `Month selected` });
      await sendYearKeyboard(chatId, fileId);
      return;
    }

    // ---------- UPLOAD DATE: YEAR ----------
    // uyear|<year>|<fileId>
    if (action === "uyear") {
      const year = parseInt(parts[1], 10);
      const fileId = parseInt(parts[2], 10);
      if (!fileId || !year) { await bot.answerCallbackQuery(cb.id, { text: "Invalid selection." }); return; }

      const state = awaitingUploadDate.get(fileId) || {};
      if (!state.day || !state.month) {
        // missing previous steps — ask day again
        awaitingUploadDate.set(fileId, {}); // reset
        await bot.answerCallbackQuery(cb.id, { text: "Please select day and month first." });
        await sendDayKeyboard(chatId, fileId);
        return;
      }

      // construct upload date (local midnight)
      // Note: months in JS Date are 0-indexed
      const dt = new Date(Date.UTC(year, state.month - 1, state.day, 0, 0, 0));
      // Save upload_date to DB
      const updated = await updateFile(fileId, { upload_date: dt });
      awaitingUploadDate.delete(fileId);

      await bot.answerCallbackQuery(cb.id, { text: `Upload date set: ${year}-${state.month}-${state.day}` });
      await bot.sendMessage(chatId, `✅ "${updated.caption}" upload date set to ${year}-${state.month}-${state.day}.`);

      // Now that we have category (should already exist), edited (set), and upload_date, forward to the determined group.
      const fresh = await fetchFile(fileId);
      if (fresh) {
        // Forward to target group (storage already has a copy)
        await forwardToGroups(fresh);
      }
      return;
    }

    // ---------- PUBLISH ----------
    // publish|now|<fileId> OR publish|schedule|<fileId>
    if (action === "publish") {
      const choice = parts[1];
      const fileId = parseInt(parts[2], 10);
      if (!fileId) return bot.answerCallbackQuery(cb.id, { text: "Invalid file." });

      if (choice === "now") {
        const updated = await updateFile(fileId, { published: true });
        await bot.answerCallbackQuery(cb.id, { text: "Published now." });
        await bot.sendMessage(chatId, `✅ "${updated.caption}" marked as published.`);
      } else if (choice === "schedule") {
        // schedule flow: ask admin to reply with a date/time (we accept "YYYY-MM-DD HH:MM")
        const prompt = await bot.sendMessage(chatId, "📆 Reply to this message with the publish date/time (YYYY-MM-DD HH:MM).");
        awaitingReply.set(prompt.message_id, { type: "publishSchedule", fileId });
        await bot.answerCallbackQuery(cb.id, { text: "Send publish date by replying to the prompt." });
      }
      return;
    }

    // ---------- GET (send file to requester) ----------
    // get|<fileId>
    if (action === "get") {
      const fileId = parseInt(parts[1], 10);
      if (!fileId) return bot.answerCallbackQuery(cb.id, { text: "Invalid file." });

      const file = await fetchFile(fileId);
      if (!file) {
        await bot.answerCallbackQuery(cb.id, { text: "File not found." });
        return;
      }

      await bot.answerCallbackQuery(cb.id);
      if (file.file_type === "document") {
        await bot.sendDocument(chatId, file.file_id, { caption: file.caption });
      } else if (file.file_type === "video") {
        await bot.sendVideo(chatId, file.file_id, { caption: file.caption });
      } else if (file.file_type === "audio") {
        await bot.sendAudio(chatId, file.file_id, { caption: file.caption });
      } else {
        await bot.sendMessage(chatId, `File: ${file.caption}`);
      }
      return;
    }

    // ---------- ADMIN ACTIONS ----------
    // admin|openedit|id  OR admin|editname|id  etc.
    if (action === "admin") {
      // ensure only admins use admin actions
      if (!isAdmin(cb.from.id)) {
        await bot.answerCallbackQuery(cb.id, { text: "Admins only." });
        return;
      }

      const sub = parts[1];
      const fileId = parseInt(parts[2], 10);
      if (!fileId) return bot.answerCallbackQuery(cb.id, { text: "Invalid file." });

      const file = await fetchFile(fileId);
      if (!file) {
        await bot.answerCallbackQuery(cb.id, { text: "File not found." });
        return;
      }

      switch (sub) {
        case "openedit": {
          // open admin menu (Edit this file was clicked)
          await bot.answerCallbackQuery(cb.id);
          await sendAdminFileActions(chatId, file);
          break;
        }

        case "editname": {
          // ask admin to reply to this message with new filename
          const prompt = await bot.sendMessage(chatId, `✏️ Reply to this message with the new caption/filename for "${file.caption}":`);
          awaitingReply.set(prompt.message_id, { type: "editname", fileId: file.id });
          await bot.answerCallbackQuery(cb.id, { text: "Reply with new filename." });
          break;
        }

        case "togglepublished": {
          // toggle only if file.edited === true (as your earlier logic desired)
          if (!file.edited) {
            await bot.answerCallbackQuery(cb.id, { text: "File not marked edited. Mark as edited first." });
            return;
          }
          const updated = await updateFile(file.id, { published: !file.published });
          await bot.answerCallbackQuery(cb.id, { text: `Published set to ${updated.published}` });
          await sendAdminFileActions(chatId, updated);
          break;
        }

        case "togglevisible": {
          const updated = await updateFile(file.id, { visible: !file.visible });
          await bot.answerCallbackQuery(cb.id, { text: `Visible set to ${updated.visible}` });
          await sendAdminFileActions(chatId, updated);
          break;
        }

        case "setpublishdate": {
          // Provide the publish keyboard
          await bot.answerCallbackQuery(cb.id);
          await sendPublishedKeyboard(chatId, file);
          break;
        }

        case "setuploaddate": {
          // Admin chooses upload date via same Day->Month->Year flow as regular flow
          awaitingUploadDate.set(file.id, {});
          await bot.answerCallbackQuery(cb.id);
          await sendDayKeyboard(chatId, file.id);
          break;
        }

        case "delete": {
          await pool.query("DELETE FROM files WHERE id = $1", [file.id]);
          await bot.answerCallbackQuery(cb.id, { text: "File deleted from DB" });
          await bot.sendMessage(chatId, `🗑️ File "${file.caption}" deleted from database.`);
          break;
        }

        default:
          await bot.answerCallbackQuery(cb.id, { text: "Unknown admin action" });
      }
      return;
    }

    // ---------- FALLBACK ----------
    await bot.answerCallbackQuery(cb.id, { text: "Unknown action." });
  } catch (err) {
    console.error("Callback error:", err, "data:", data);
    try { await bot.answerCallbackQuery(cb.id, { text: "An error occurred." }); } catch { /* ignore */ }
  }
});

// ================== START SERVER ==================
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`📡 Webhook set at ${URL}/webhook`);
});

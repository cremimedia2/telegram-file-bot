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
const CHANNEL_ID = process.env.CHANNEL_ID ? parseInt(process.env.CHANNEL_ID, 10) : -1003155277985;

// Admins (you gave these)
const ADMINS = [6776845536n, 7311852471n]; // use BigInt for user ids when comparing

if (!TOKEN || !URL || !DATABASE_URL) {
  console.error("❌ Missing required environment variables. Ensure TELEGRAM_BOT_TOKEN, APP_URL, DATABASE_URL are set.");
  process.exit(1);
}

// ================== POSTGRES (AIVEN friendly) ==================
const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false } // Accept Aiven certs (common setup)
});

try {
  // test connection (top-level await)
  await pool.query("SELECT 1");
  console.log("✅ Connected to Postgres");
} catch (err) {
  console.error("❌ Postgres connection failed:", err);
  process.exit(1);
}

// Ensure table exists. We'll create a robust schema.
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
  created_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(chat_id, message_id, file_id)
);
`);

// ================== BOT INIT ==================
const bot = new TelegramBot(TOKEN);
bot.setWebHook(`${URL}/webhook`);

// ================== EXPRESS INIT ==================
const app = express();
app.use(express.json());

// Small helper maps for awaiting responses
const awaitingCaption = new Map(); // promptMessageId -> { originalMessage }
const awaitingFilename = new Map(); // promptMessageId -> { fileRowId } or originalMessage
const awaitingAction = new Map(); // callback flows where we expect text replies, keyed by prompt msg id

// Helper: check admin
function isAdmin(userId) {
  // ensure BigInt comparision if we stored admins as BigInt
  try {
    return ADMINS.some(a => BigInt(userId) === a);
  } catch {
    return ADMINS.some(a => Number(userId) === Number(a));
  }
}

// Helper: determine file type/extension
function detectFileInfo(msg) {
  if (msg.document) {
    const name = msg.document.file_name || "untitled";
    const ext = (name.includes(".") ? name.split(".").pop().toLowerCase() : "");
    return { file_type: "document", file_id: msg.document.file_id, file_name: name, extension: ext };
  }
  if (msg.video) {
    // video may not have filename; fallback to message_id
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
}

// Store single file row into DB, return inserted row
async function insertFileRow({ msg, captionOverride = null, uploadedBy = null }) {
  const info = detectFileInfo(msg);
  if (!info) return null;

  const caption = captionOverride ?? (msg.caption || info.file_name || "untitled");
  const real_filename = msg.document?.file_name ?? (caption && caption); // prefer document name for documents
  const query = `
    INSERT INTO files
      (chat_id, message_id, caption, real_filename, file_type, file_extension, file_id, uploaded_by)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
    RETURNING *;
  `;
  const values = [msg.chat.id, msg.message_id, caption, real_filename, info.file_type, info.extension, info.file_id, uploadedBy ?? msg.from?.id ?? null];
  const res = await pool.query(query, values);
  return res.rows[0];
}

// Update file flags helper
async function updateFile(id, fields = {}) {
  const keys = Object.keys(fields);
  if (keys.length === 0) return;
  const set = keys.map((k, i) => `${k} = $${i + 1}`).join(", ");
  const values = keys.map(k => fields[k]);
  const q = `UPDATE files SET ${set} WHERE id = $${keys.length + 1} RETURNING *`;
  const res = await pool.query(q, [...values, id]);
  return res.rows[0];
}

// Query helper for searches (admins see everything, others only visible)
async function searchFiles(queryText, requesterIsAdmin) {
  const q = `%${queryText}%`;
  if (requesterIsAdmin) {
    const res = await pool.query("SELECT * FROM files WHERE LOWER(caption) LIKE $1 ORDER BY created_at DESC LIMIT 50", [q]);
    return res.rows;
  } else {
    const res = await pool.query("SELECT * FROM files WHERE visible = TRUE AND LOWER(caption) LIKE $1 ORDER BY created_at DESC LIMIT 50", [q]);
    return res.rows;
  }
}

// Send inline keyboard for classification (Edited / Unedited)
async function sendClassificationKeyboard(chatId, fileRow) {
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
  await bot.sendMessage(chatId, `Choose classification for: "${fileRow.caption}"`, keyboard);
}

// Send publish keyboard
async function sendPublishedKeyboard(chatId, fileRow) {
  const keyboard = {
    reply_markup: {
      inline_keyboard: [
        [
          { text: "Published ✅", callback_data: `publish|yes|${fileRow.id}` },
          { text: "Not published ❌", callback_data: `publish|no|${fileRow.id}` }
        ]
      ]
    }
  };
  await bot.sendMessage(chatId, `Is "${fileRow.caption}" published?`, keyboard);
}

// Admin-only: show file details + admin actions inline
async function sendAdminFileActions(chatId, fileRow) {
  const buttons = [];
  // Edit filename (available for unedited files)
  buttons.push([{ text: "Edit file name", callback_data: `admin|editname|${fileRow.id}` }]);
  // Toggle published (only meaningful for edited files)
  buttons.push([{ text: fileRow.edited ? (fileRow.published ? "Mark Unpublished" : "Mark Published") : "Mark Published (edited only)", callback_data: `admin|togglepublished|${fileRow.id}` }]);
  // Hide/unhide
  buttons.push([{ text: fileRow.visible ? "Hide from users" : "Unhide (visible)", callback_data: `admin|togglevisible|${fileRow.id}` }]);
  // Delete
  buttons.push([{ text: "Delete (DB only)", callback_data: `admin|delete|${fileRow.id}` }]);

  await bot.sendMessage(chatId, `File details:\n\nTitle: ${fileRow.caption}\nType: ${fileRow.file_type}\nEdited: ${fileRow.edited}\nPublished: ${fileRow.published}\nVisible: ${fileRow.visible}\nFilename: ${fileRow.real_filename || "(none)"}\nUploaded by: ${fileRow.uploaded_by}\nStored id: ${fileRow.id}`, {
    reply_markup: { inline_keyboard: buttons.flat() ? buttons : [] }
  });
}

// ================== WEBHOOK ==================
app.post("/webhook", (req, res) => {
  try {
    bot.processUpdate(req.body);
    res.sendStatus(200);
  } catch (err) {
    console.error("Failed to process update:", err);
    res.sendStatus(500);
  }
});

// ================== START MESSAGE ==================
bot.onText(/\/start/, (msg) => {
  console.log("Start from", msg.from.id);
  const isAdm = isAdmin(msg.from.id);
  const welcome = isAdm
    ? "🎉 Welcome Admin. Use me to manage uploads, classify and search files.\n\nSend media (admins only) or type a search term."
    : "🎉 Welcome. Use this bot in private to search files. Uploading is for admins only.";
  bot.sendMessage(msg.chat.id, welcome);
});

// ================== MAIN MESSAGE HANDLER ==================
bot.on("message", async (msg) => {
  console.log("Received message:", msg.message_id, "from", msg.from?.id, "chat", msg.chat?.id, "type", msg.chat?.type);

  const requesterId = msg.from?.id;
  const chatId = msg.chat.id;

  // ignore bot commands (handled by onText)
  if (msg.text && msg.text.startsWith("/")) return;

  // 1) If this is a reply to a prompt asking for caption or filename
  if (msg.reply_to_message) {
    const replyId = msg.reply_to_message.message_id;

    // caption flow
    if (awaitingCaption.has(replyId)) {
      const original = awaitingCaption.get(replyId); // { originalMessage, promptChatId }
      const captionText = (msg.text || "").trim();
      if (!captionText) return bot.sendMessage(chatId, "❌ Caption cannot be empty. Please send a valid caption.");

      // insert into DB
      try {
        const inserted = await insertFileRow({ msg: original.originalMessage, captionOverride: captionText, uploadedBy: requesterId });
        awaitingCaption.delete(replyId);

        // forward to storage channel
        if (original.originalMessage.document) await bot.sendDocument(CHANNEL_ID, original.originalMessage.document.file_id, { caption: captionText });
        if (original.originalMessage.video) await bot.sendVideo(CHANNEL_ID, original.originalMessage.video.file_id, { caption: captionText });
        if (original.originalMessage.audio) await bot.sendAudio(CHANNEL_ID, original.originalMessage.audio.file_id, { caption: captionText });

        await bot.sendMessage(chatId, `✅ "${captionText}" saved ✔️`);
        // ask classification inline
        await sendClassificationKeyboard(chatId, inserted);
        console.log("Indexed with caption (reply flow):", inserted.id);
      } catch (err) {
        console.error("DB insert error (caption reply):", err);
        return bot.sendMessage(chatId, "❌ Failed to save the file. Try again.");
      }
      return;
    }

    // filename flow for unedited (awaitingFilename)
    if (awaitingFilename.has(replyId)) {
      const record = awaitingFilename.get(replyId); // { fileRowId }
      const fileRowId = record.fileRowId;
      const newName = (msg.text || "").trim();
      if (!newName) return bot.sendMessage(chatId, "❌ Filename cannot be empty.");

      try {
        const updated = await updateFile(fileRowId, { real_filename: newName, caption: newName });
        awaitingFilename.delete(replyId);
        await bot.sendMessage(chatId, `✅ Filename saved: "${newName}"`);
        // present admin actions
        await sendAdminFileActions(chatId, updated);
      } catch (err) {
        console.error("DB update error (filename reply):", err);
        return bot.sendMessage(chatId, "❌ Failed to update filename. Try again.");
      }
      return;
    }
  }

  // 2) Group or supergroup media messages:
  if (msg.chat.type && msg.chat.type.includes("group")) {
    // only admins can save/upload (per A:1)
    const senderIsAdmin = isAdmin(requesterId);

    // if media posted
    if (msg.document || msg.video || msg.audio) {
      if (!senderIsAdmin) {
        console.log("Non-admin tried to upload in group:", requesterId);
        // do not forward, just ignore or optionally send a polite message (we'll politely notify)
        return bot.sendMessage(chatId, "❌ Only bot admins can save files. If you are an admin, please use your admin account.");
      }

      // admin posted media
      // if there's no caption -> ask for caption
      if (!msg.caption) {
        const prompt = await bot.sendMessage(chatId, "📌 Please send a caption for this file so it can be saved. Reply to this message with the caption.");
        // save mapping from prompt message id to the original message
        awaitingCaption.set(prompt.message_id, { originalMessage: msg, promptChatId: chatId });
        console.log("Awaiting caption for message", msg.message_id, "mapped to prompt", prompt.message_id);
        return;
      }

      // we have caption, insert and forward
      try {
        const inserted = await insertFileRow({ msg, captionOverride: msg.caption, uploadedBy: requesterId });
        // forward to storage channel
        if (msg.document) await bot.sendDocument(CHANNEL_ID, msg.document.file_id, { caption: msg.caption });
        if (msg.video) await bot.sendVideo(CHANNEL_ID, msg.video.file_id, { caption: msg.caption });
        if (msg.audio) await bot.sendAudio(CHANNEL_ID, msg.audio.file_id, { caption: msg.caption });

        await bot.sendMessage(chatId, `✅ "${msg.caption}" saved ✔️`);
        // ask classification
        await sendClassificationKeyboard(chatId, inserted);
        console.log("Indexed & forwarded from group:", inserted.id);
      } catch (err) {
        console.error("DB insert error (group media):", err);
        return bot.sendMessage(chatId, "❌ Failed to save file. Try again.");
      }
      return;
    }

    // if admin tags bot in a reply to a prior message (admin wants to save an old message)
    if (msg.reply_to_message && isAdmin(requesterId)) {
      const target = msg.reply_to_message;
      if (!(target.document || target.video || target.audio)) {
        return bot.sendMessage(chatId, "❌ The replied message does not contain a supported file.");
      }

      // if target has no caption -> ask for caption then save via awaitingCaption
      if (!target.caption) {
        const prompt = await bot.sendMessage(chatId, "📌 Please send a caption for the replied file so it can be saved. Reply to this message with the caption.");
        awaitingCaption.set(prompt.message_id, { originalMessage: target, promptChatId: chatId });
        return;
      }

      // store immediately
      try {
        const inserted = await insertFileRow({ msg: target, captionOverride: target.caption, uploadedBy: requesterId });

        // forward to storage channel
        if (target.document) await bot.sendDocument(CHANNEL_ID, target.document.file_id, { caption: target.caption });
        if (target.video) await bot.sendVideo(CHANNEL_ID, target.video.file_id, { caption: target.caption });
        if (target.audio) await bot.sendAudio(CHANNEL_ID, target.audio.file_id, { caption: target.caption });

        await bot.sendMessage(chatId, `✅ "${target.caption}" saved ✔️`);
        await sendClassificationKeyboard(chatId, inserted);
        console.log("Indexed & forwarded (reply-to) id:", inserted.id);
      } catch (err) {
        console.error("DB insert error (reply-to):", err);
        return bot.sendMessage(chatId, "❌ Failed to save file. Try again.");
      }
      return;
    }

    // otherwise ignore group text messages
    return;
  }

  // 3) Private chat (admin uploads and user searches)
  if (msg.chat.type === "private") {
    // Uploads: only allow admins to upload media via private chat
    if (msg.document || msg.video || msg.audio) {
      if (!isAdmin(requesterId)) {
        return bot.sendMessage(chatId, "❌ Only admins may upload files to storage. You may search for files though.");
      }

      // Admin upload via private chat
      if (!msg.caption) {
        const prompt = await bot.sendMessage(chatId, "📌 Please send a caption for this file so it can be saved. Reply to this message with the caption.");
        awaitingCaption.set(prompt.message_id, { originalMessage: msg, promptChatId: chatId });
        return;
      }

      try {
        const inserted = await insertFileRow({ msg, captionOverride: msg.caption, uploadedBy: requesterId });
        // forward to storage channel
        if (msg.document) await bot.sendDocument(CHANNEL_ID, msg.document.file_id, { caption: msg.caption });
        if (msg.video) await bot.sendVideo(CHANNEL_ID, msg.video.file_id, { caption: msg.caption });
        if (msg.audio) await bot.sendAudio(CHANNEL_ID, msg.audio.file_id, { caption: msg.caption });

        await bot.sendMessage(chatId, `✅ "${msg.caption}" saved ✔️`);
        await sendClassificationKeyboard(chatId, inserted);
        console.log("Admin private upload indexed:", inserted.id);
      } catch (err) {
        console.error("DB insert error (admin private upload):", err);
        return bot.sendMessage(chatId, "❌ Failed to save file. Try again.");
      }
      return;
    }

    // Search: textual messages in private are treated as search queries
    if (msg.text) {
      const query = msg.text.trim().toLowerCase();
      if (!query) return;

      const results = await searchFiles(query, isAdmin(requesterId));
      if (!results || results.length === 0) {
        return bot.sendMessage(chatId, `❌ No files found matching "${msg.text}".`);
      }

      // Build keyboard: show caption (short)
      const keyboard = results.map(r => [{
        text: r.caption.length > 50 ? r.caption.slice(0, 50) + "…" : r.caption,
        callback_data: `get|${r.id}`
      }]);

      await bot.sendMessage(chatId, `🔎 Search results for "${msg.text}":`, {
        reply_markup: { inline_keyboard: keyboard }
      });
      return;
    }

    // otherwise ignore
    return;
  }
});

// ================== CALLBACKS ==================
bot.on("callback_query", async (cb) => {
  const data = cb.data || "";
  const parts = data.split("|");
  const action = parts[0];

  try {
    if (action === "class") {
      // class|edited|<fileRowId>  OR class|unedited|<fileRowId>
      const which = parts[1];
      const fileId = parseInt(parts[2], 10);
      const row = (await pool.query("SELECT * FROM files WHERE id=$1", [fileId])).rows[0];
      if (!row) return bot.answerCallbackQuery(cb.id, { text: "File not found." });

      if (!isAdmin(cb.from.id)) return bot.answerCallbackQuery(cb.id, { text: "Only admins can classify." });

      if (which === "edited") {
        await updateFile(fileId, { edited: true });
        await bot.answerCallbackQuery(cb.id, { text: "Marked as edited." });
        // ask published question
        await sendPublishedKeyboard(cb.message.chat.id, row);
      } else {
        // unedited
        await updateFile(fileId, { edited: false });
        await bot.answerCallbackQuery(cb.id, { text: "Marked as unedited." });
        // ask for filename (if none)
        const fresh = (await pool.query("SELECT * FROM files WHERE id=$1", [fileId])).rows[0];
        if (!fresh.real_filename) {
          const prompt = await bot.sendMessage(cb.message.chat.id, "Please reply to this message with the filename to save for this unedited file.");
          // store mapping between prompt message and fileRowId
          awaitingFilename.set(prompt.message_id, { fileRowId: fileId });
        } else {
          await sendAdminFileActions(cb.message.chat.id, fresh);
        }
      }
      return;
    }

    if (action === "publish") {
      // publish|yes|<fileRowId> OR publish|no|id
      const val = parts[1];
      const fileId = parseInt(parts[2], 10);
      const row = (await pool.query("SELECT * FROM files WHERE id=$1", [fileId])).rows[0];
      if (!row) return bot.answerCallbackQuery(cb.id, { text: "File not found." });
      if (!isAdmin(cb.from.id)) return bot.answerCallbackQuery(cb.id, { text: "Only admins can set publish status." });

      const published = val === "yes";
      await updateFile(fileId, { published });
      await bot.answerCallbackQuery(cb.id, { text: published ? "Marked published." : "Marked not published." });
      const fresh = (await pool.query("SELECT * FROM files WHERE id=$1", [fileId])).rows[0];
      await sendAdminFileActions(cb.message.chat.id, fresh);
      return;
    }

    if (action === "get") {
      // get|<fileRowId> -> send file details to requester (private chat)
      const fileId = parseInt(parts[1], 10);
      const row = (await pool.query("SELECT * FROM files WHERE id=$1", [fileId])).rows[0];
      if (!row) return bot.answerCallbackQuery(cb.id, { text: "File not found." });

      // Permission: regular users only see visible files (search already filtered), admin sees all
      if (!row.visible && !isAdmin(cb.from.id)) return bot.answerCallbackQuery(cb.id, { text: "File not available." });

      // send file depending on file_type (the file is stored on Telegram; we use file_id)
      if (row.file_type === "document") await bot.sendDocument(cb.message.chat.id, row.file_id, { caption: row.caption });
      if (row.file_type === "video") await bot.sendVideo(cb.message.chat.id, row.file_id, { caption: row.caption });
      if (row.file_type === "audio") await bot.sendAudio(cb.message.chat.id, row.file_id, { caption: row.caption });

      // if admin, show admin actions
      if (isAdmin(cb.from.id)) await sendAdminFileActions(cb.message.chat.id, row);
      await bot.answerCallbackQuery(cb.id);
      return;
    }

    if (action === "admin") {
      // admin|editname|id  OR admin|togglepublished|id OR admin|togglevisible|id OR admin|delete|id
      if (!isAdmin(cb.from.id)) return bot.answerCallbackQuery(cb.id, { text: "Admins only." });

      const sub = parts[1];
      const fileId = parseInt(parts[2], 10);
      const row = (await pool.query("SELECT * FROM files WHERE id=$1", [fileId])).rows[0];
      if (!row) return bot.answerCallbackQuery(cb.id, { text: "File not found." });

      if (sub === "editname") {
        // ask admin to reply with new filename
        const prompt = await bot.sendMessage(cb.message.chat.id, "Reply to this message with the new filename to set for the file.");
        awaitingFilename.set(prompt.message_id, { fileRowId: fileId });
        await bot.answerCallbackQuery(cb.id, { text: "Send new filename." });
        return;
      }

      if (sub === "togglepublished") {
        // toggle only if edited
        if (!row.edited) {
          await bot.answerCallbackQuery(cb.id, { text: "File not marked edited. Mark as edited first." });
          return;
        }
        const newPublished = !row.published;
        await updateFile(fileId, { published: newPublished });
        await bot.answerCallbackQuery(cb.id, { text: newPublished ? "Marked published." : "Marked unpublished." });
        const fresh = (await pool.query("SELECT * FROM files WHERE id=$1", [fileId])).rows[0];
        await sendAdminFileActions(cb.message.chat.id, fresh);
        return;
      }

      if (sub === "togglevisible") {
        const newVis = !row.visible;
        await updateFile(fileId, { visible: newVis });
        await bot.answerCallbackQuery(cb.id, { text: newVis ? "File is now visible to users." : "File hidden from users." });
        const fresh = (await pool.query("SELECT * FROM files WHERE id=$1", [fileId])).rows[0];
        await sendAdminFileActions(cb.message.chat.id, fresh);
        return;
      }

      if (sub === "delete") {
        // B: delete only from DB
        await pool.query("DELETE FROM files WHERE id=$1", [fileId]);
        await bot.answerCallbackQuery(cb.id, { text: "Deleted from database." });
        await bot.sendMessage(cb.message.chat.id, `🗑️ File (id: ${fileId}) deleted from DB.`);
        return;
      }
    }

    // fallback
    await bot.answerCallbackQuery(cb.id, { text: "Unknown action." });
  } catch (err) {
    console.error("callback handling error:", err, "data:", data);
    try { await bot.answerCallbackQuery(cb.id, { text: "An error occurred. See logs." }); } catch {}
  }
});

// ================== START SERVER ==================
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`📡 Webhook set: ${URL}/webhook`);
});

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

// Admins (BigInt for safety)
const ADMINS = [6776845536n, 7311852471n];

if (!TOKEN || !URL || !DATABASE_URL) {
  console.error("❌ Missing required environment variables.");
  process.exit(1);
}

// ================== POSTGRES ==================
const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// Wrap async init in IIFE
(async () => {
  try {
    await pool.query("SELECT 1");
    console.log("✅ Connected to Postgres");

    // Ensure table exists
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
  } catch (err) {
    console.error("❌ Postgres connection failed:", err);
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
const awaitingCaption = new Map(); 
const awaitingFilename = new Map(); 

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
  if (!keys.length) return;

  const set = keys.map((k, i) => `${k} = $${i + 1}`).join(", ");
  const values = keys.map(k => fields[k]);
  const q = `UPDATE files SET ${set} WHERE id = $${keys.length + 1} RETURNING *`;
  const res = await pool.query(q, [...values, id]);
  return res.rows[0];
};

const searchFiles = async (queryText, requesterIsAdmin) => {
  const q = `%${queryText}%`;
  const sql = requesterIsAdmin
    ? "SELECT * FROM files WHERE LOWER(caption) LIKE $1 ORDER BY created_at DESC LIMIT 50"
    : "SELECT * FROM files WHERE visible = TRUE AND LOWER(caption) LIKE $1 ORDER BY created_at DESC LIMIT 50";
  const res = await pool.query(sql, [q]);
  return res.rows;
};

// ================== INLINE KEYBOARDS ==================
const sendClassificationKeyboard = async (chatId, fileRow) => {
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
};

const sendPublishedKeyboard = async (chatId, fileRow) => {
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
};

const sendAdminFileActions = async (chatId, fileRow) => {
  const buttons = [
    [{ text: "Edit file name", callback_data: `admin|editname|${fileRow.id}` }],
    [{ text: fileRow.edited ? (fileRow.published ? "Mark Unpublished" : "Mark Published") : "Mark Published (edited only)", callback_data: `admin|togglepublished|${fileRow.id}` }],
    [{ text: fileRow.visible ? "Hide from users" : "Unhide (visible)", callback_data: `admin|togglevisible|${fileRow.id}` }],
    [{ text: "Delete (DB only)", callback_data: `admin|delete|${fileRow.id}` }]
  ];

  await bot.sendMessage(chatId, 
    `File details:\n\nTitle: ${fileRow.caption}\nType: ${fileRow.file_type}\nEdited: ${fileRow.edited}\nPublished: ${fileRow.published}\nVisible: ${fileRow.visible}\nFilename: ${fileRow.real_filename || "(none)"}\nUploaded by: ${fileRow.uploaded_by}\nStored id: ${fileRow.id}`,
    { reply_markup: { inline_keyboard: buttons } }
  );
};

// ================== WEBHOOK ==================
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
    : "🎉 Welcome. You can search files here, uploading is for admins only.";
  bot.sendMessage(msg.chat.id, welcome);
});

// ================== MESSAGE HANDLER ==================
bot.on("message", (msg) => {
  if (msg.chat.type.endsWith("group")) {
    console.log("GROUP ID:", msg.chat.id);
    bot.sendMessage(msg.chat.id, `🆔 Group ID: ${msg.chat.id}`);
  }
});

bot.on("message", async (msg) => {
  const requesterId = msg.from?.id;
  const chatId = msg.chat.id;

  if (msg.text?.startsWith("/")) return; // ignore commands

  // === Reply flows ===
  if (msg.reply_to_message) {
    const replyId = msg.reply_to_message.message_id;

    if (awaitingCaption.has(replyId)) {
      const original = awaitingCaption.get(replyId);
      const captionText = (msg.text || "").trim();
      if (!captionText) return bot.sendMessage(chatId, "❌ Caption cannot be empty.");

      try {
        const inserted = await insertFileRow({ msg: original.originalMessage, captionOverride: captionText, uploadedBy: requesterId });
        awaitingCaption.delete(replyId);

        // forward to channel
        if (original.originalMessage.document) await bot.sendDocument(CHANNEL_ID, original.originalMessage.document.file_id, { caption: captionText });
        if (original.originalMessage.video) await bot.sendVideo(CHANNEL_ID, original.originalMessage.video.file_id, { caption: captionText });
        if (original.originalMessage.audio) await bot.sendAudio(CHANNEL_ID, original.originalMessage.audio.file_id, { caption: captionText });

        await bot.sendMessage(chatId, `✅ "${captionText}" saved ✔️`);
        await sendClassificationKeyboard(chatId, inserted);
      } catch (err) {
        console.error("Caption reply insert failed:", err);
        return bot.sendMessage(chatId, "❌ Failed to save file.");
      }
      return;
    }

    if (awaitingFilename.has(replyId)) {
      const { fileRowId } = awaitingFilename.get(replyId);
      const newName = (msg.text || "").trim();
      if (!newName) return bot.sendMessage(chatId, "❌ Filename cannot be empty.");

      try {
        const updated = await updateFile(fileRowId, { real_filename: newName, caption: newName });
        awaitingFilename.delete(replyId);
        await bot.sendMessage(chatId, `✅ Filename updated: "${newName}"`);
        await sendAdminFileActions(chatId, updated);
      } catch (err) {
        console.error("Filename reply update failed:", err);
        return bot.sendMessage(chatId, "❌ Failed to update filename.");
      }
      return;
    }
  }

  // === Group & Private Media Handling ===
  const mediaMsg = msg.document || msg.video || msg.audio;
  if (mediaMsg) {
    if (!isAdmin(requesterId)) return bot.sendMessage(chatId, "❌ Only admins can upload files.");

    if (!msg.caption) {
      const prompt = await bot.sendMessage(chatId, "📌 Please send a caption for this file.");
      awaitingCaption.set(prompt.message_id, { originalMessage: msg, promptChatId: chatId });
      return;
    }

    try {
      const inserted = await insertFileRow({ msg, captionOverride: msg.caption, uploadedBy: requesterId });

      // forward
      if (msg.document) await bot.sendDocument(CHANNEL_ID, msg.document.file_id, { caption: msg.caption });
      if (msg.video) await bot.sendVideo(CHANNEL_ID, msg.video.file_id, { caption: msg.caption });
      if (msg.audio) await bot.sendAudio(CHANNEL_ID, msg.audio.file_id, { caption: msg.caption });

      await bot.sendMessage(chatId, `✅ "${msg.caption}" saved ✔️`);
      await sendClassificationKeyboard(chatId, inserted);
    } catch (err) {
      console.error("Media insert failed:", err);
      return bot.sendMessage(chatId, "❌ Failed to save file.");
    }
    return;
  }

  // === Private search ===
  if (msg.chat.type === "private" && msg.text) {
    const query = msg.text.trim().toLowerCase();
    if (!query) return;

    const results = await searchFiles(query, isAdmin(requesterId));
    if (!results.length) return bot.sendMessage(chatId, `❌ No files found matching "${msg.text}".`);

    const keyboard = results.map(r => [{ text: r.caption.length > 50 ? r.caption.slice(0, 50) + "…" : r.caption, callback_data: `get|${r.id}` }]);
    await bot.sendMessage(chatId, `🔎 Search results for "${msg.text}":`, { reply_markup: { inline_keyboard: keyboard } });
  }
});

// ================== CALLBACK HANDLER ==================
bot.on("callback_query", async (cb) => {
  const data = cb.data || "";
  const parts = data.split("|");
  const action = parts[0];
  const chatId = cb.message?.chat?.id;

  try {
    // ================= CLASSIFICATION =================
    if (action === "class") {
      const type = parts[1]; // "edited" or "unedited"
      const fileId = parseInt(parts[2], 10);
      if (!fileId) return;

      const updated = await updateFile(fileId, { edited: type === "edited" });
      await bot.answerCallbackQuery(cb.id, { text: `Marked as ${type}` });
      await bot.sendMessage(chatId, `✅ File "${updated.caption}" marked as ${type}`);
      return;
    }

    // ================= PUBLISH =================
    if (action === "publish") {
      const choice = parts[1]; // "yes" or "no"
      const fileId = parseInt(parts[2], 10);
      if (!fileId) return;

      const updated = await updateFile(fileId, { published: choice === "yes" });
      await bot.answerCallbackQuery(cb.id, { text: `Set published = ${choice}` });
      await bot.sendMessage(chatId, `✅ File "${updated.caption}" published status updated.`);
      return;
    }

    // ================= GET FILE =================
    if (action === "get") {
      const fileId = parseInt(parts[1], 10);
      if (!fileId) return;

      const rows = await pool.query("SELECT * FROM files WHERE id = $1", [fileId]);
      if (!rows.rows.length) {
        await bot.answerCallbackQuery(cb.id, { text: "File not found." });
        return;
      }

      const file = rows.rows[0];

      await bot.answerCallbackQuery(cb.id);
      if (file.file_type === "document") {
        await bot.sendDocument(chatId, file.file_id, { caption: file.caption });
      } else if (file.file_type === "video") {
        await bot.sendVideo(chatId, file.file_id, { caption: file.caption });
      } else if (file.file_type === "audio") {
        await bot.sendAudio(chatId, file.file_id, { caption: file.caption });
      }
      return;
    }

    // ================= ADMIN ACTIONS =================
    if (action === "admin") {
      const subAction = parts[1]; // editname | togglepublished | togglevisible | delete
      const fileId = parseInt(parts[2], 10);
      if (!fileId) return;

      const rows = await pool.query("SELECT * FROM files WHERE id = $1", [fileId]);
      if (!rows.rows.length) {
        await bot.answerCallbackQuery(cb.id, { text: "File not found." });
        return;
      }
      const file = rows.rows[0];

      switch (subAction) {
        case "editname": {
          const prompt = await bot.sendMessage(chatId, `✏️ Reply with new filename for "${file.caption}":`);
          awaitingFilename.set(prompt.message_id, { fileRowId: file.id });
          await bot.answerCallbackQuery(cb.id);
          break;
        }

        case "togglepublished": {
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

    // ================= UNKNOWN ACTION =================
    await bot.answerCallbackQuery(cb.id, { text: "Unknown action." });
  } catch (err) {
    console.error("Callback error:", err, "data:", data);
    try { await bot.answerCallbackQuery(cb.id, { text: "An error occurred." }); } catch {}
  }
});


// ================== START SERVER ==================
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`📡 Webhook set at ${URL}/webhook`);
});

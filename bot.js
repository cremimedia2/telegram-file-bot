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
// CHANNEL_ID is your storage channel - files always forwarded here
const CHANNEL_ID = process.env.CHANNEL_ID ? parseInt(process.env.CHANNEL_ID, 10) : -1003155277985;

// =============== EDIT THESE GROUP IDS AS NEEDED ===============
// (you provided these — change them here if you move groups)
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

    // ensure base table exists
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
        category TEXT,            -- e.g. "sermon" or "prophecy"
        upload_date TIMESTAMP,    -- optional: when file was uploaded (user input)
        publish_date TIMESTAMP,   -- optional: when to publish
        created_at TIMESTAMP DEFAULT NOW(),
        UNIQUE(chat_id, message_id, file_id)
      );
    `);

    // in case table existed previously without some columns, add them if missing
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
// awaitingFilename: promptMessageId -> { fileRowId }
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

const searchFiles = async (queryText, requesterIsAdmin) => {
  const q = `%${queryText}%`;
  const sql = requesterIsAdmin
    ? "SELECT * FROM files WHERE LOWER(caption) LIKE $1 ORDER BY created_at DESC LIMIT 50"
    : "SELECT * FROM files WHERE visible = TRUE AND LOWER(caption) LIKE $1 ORDER BY created_at DESC LIMIT 50";
  const res = await pool.query(sql, [q]);
  return res.rows;
};

// ================== INLINE KEYBOARDS & FLOWS ==================

// After saving, we'll prompt for category and edited state (as inline buttons).
// These helper functions send inline buttons (answers are in callbacks).

const sendCategoryKeyboard = async (chatId, fileRow) => {
  // For video/audio we present category options (sermon/prophecy).
  // You can change options here or add more categories.
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

const sendPublishedKeyboard = async (chatId, fileRow) => {
  const keyboard = {
    reply_markup: {
      inline_keyboard: [
        [
          { text: "Publish now", callback_data: `publish|now|${fileRow.id}` },
          { text: "Schedule (ask date)", callback_data: `publish|schedule|${fileRow.id}` }
        ]
      ]
    }
  };
  await bot.sendMessage(chatId, `When should "${fileRow.caption}" be published?`, keyboard);
};

// Admin action menu (keeps previous behaviour)
const sendAdminFileActions = async (chatId, fileRow) => {
  const buttons = [
    [{ text: "Edit file name", callback_data: `admin|editname|${fileRow.id}` }],
    [{ text: fileRow.edited ? (fileRow.published ? "Mark Unpublished" : "Mark Published") : "Mark Published (edited only)", callback_data: `admin|togglepublished|${fileRow.id}` }],
    [{ text: fileRow.visible ? "Hide from users" : "Unhide (visible)", callback_data: `admin|togglevisible|${fileRow.id}` }],
    [{ text: "Delete (DB only)", callback_data: `admin|delete|${fileRow.id}` }]
  ];
  await bot.sendMessage(chatId,
    `File details:\n\nTitle: ${fileRow.caption}\nType: ${fileRow.file_type}\nCategory: ${fileRow.category || "(not set)"}\nEdited: ${fileRow.edited}\nPublished: ${fileRow.published}\nVisible: ${fileRow.visible}\nFilename: ${fileRow.real_filename || "(none)"}\nUploaded by: ${fileRow.uploaded_by}\nStored id: ${fileRow.id}`,
    { reply_markup: { inline_keyboard: buttons } }
  );
};

// ================== FORWARDING LOGIC ==================

// Decide which group to forward to based on file type, category and edited flag.
// Adjust mapping above in GROUPS if you want different targets.
const determineTargetGroup = (fileRow) => {
  // fileRow: an object from DB containing file_type, category, edited, etc.
  const type = fileRow.file_type; // "video" | "audio" | "document"
  const cat = (fileRow.category || "").toLowerCase();

  if (type === "video") {
    if (cat === "sermon") return fileRow.edited ? GROUPS.EDITED_SERMON_VIDEO : GROUPS.UNEDITED_SERMON_VIDEO;
    if (cat === "prophecy") return fileRow.edited ? GROUPS.EDITED_PROPHECY_VIDEO : GROUPS.UNEDITED_PROPHECY_VIDEO;
    // default fallback
    return GROUPS.EDITED_SERMON_VIDEO;
  }

  if (type === "audio") {
    // using category if provided, otherwise default to sermon audio group
    if (cat === "prophecy") {
      // if you had a prophecy audio group, you would route there; currently using sermon audio group
      return GROUPS.SERMON_AUDIO_GROUP;
    }
    return GROUPS.SERMON_AUDIO_GROUP;
  }

  // documents & others fallback to storage only (don't spam groups)
  return null;
};

const forwardToGroups = async (fileRow) => {
  // Always forward to STORAGE channel
  try {
    if (fileRow.file_type === "document") {
      await bot.sendDocument(GROUPS.STORAGE_CHANNEL, fileRow.file_id, { caption: fileRow.caption });
    } else if (fileRow.file_type === "video") {
      await bot.sendVideo(GROUPS.STORAGE_CHANNEL, fileRow.file_id, { caption: fileRow.caption });
    } else if (fileRow.file_type === "audio") {
      await bot.sendAudio(GROUPS.STORAGE_CHANNEL, fileRow.file_id, { caption: fileRow.caption });
    } else {
      // unknown type: just send caption note
      await bot.sendMessage(GROUPS.STORAGE_CHANNEL, `Saved file: ${fileRow.caption}`);
    }
  } catch (err) {
    console.error("Failed to forward to storage channel:", err);
  }

  // Determine a single target group (if any) and forward there as well
  const targetGroup = determineTargetGroup(fileRow);
  if (!targetGroup) {
    console.log("No group determined for file id", fileRow.id, "- not forwarding to groups.");
    return;
  }

  try {
    if (fileRow.file_type === "document") {
      await bot.sendDocument(targetGroup, fileRow.file_id, { caption: fileRow.caption });
    } else if (fileRow.file_type === "video") {
      await bot.sendVideo(targetGroup, fileRow.file_id, { caption: fileRow.caption });
    } else if (fileRow.file_type === "audio") {
      await bot.sendAudio(targetGroup, fileRow.file_id, { caption: fileRow.caption });
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

// Small helper to show group id when bot added in groups (handy to get IDs)
// It will respond with group ID when it sees a message in a group.
// Keep or remove as you like.
bot.on("message", (msg) => {
  try {
    if (msg.chat && (msg.chat.type === "group" || msg.chat.type === "supergroup")) {
      console.log("GROUP ID:", msg.chat.id);
      // DON'T spam the group; only send on admin request.
      // If you'd like the bot to announce the group ID, uncomment the next line:
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

    // === Replies to caption / filename prompts ===
    if (msg.reply_to_message) {
      const replyId = msg.reply_to_message.message_id;

      // caption flow
      if (awaitingCaption.has(replyId)) {
        const original = awaitingCaption.get(replyId); // { originalMessage, promptChatId }
        const captionText = (msg.text || "").trim();
        if (!captionText) return bot.sendMessage(chatId, "❌ Caption cannot be empty. Please send a valid caption.");

        try {
          const inserted = await insertFileRow({ msg: original.originalMessage, captionOverride: captionText, uploadedBy: requesterId });
          awaitingCaption.delete(replyId);

          // forward to storage channel
          if (original.originalMessage.document) await bot.sendDocument(GROUPS.STORAGE_CHANNEL, original.originalMessage.document.file_id, { caption: captionText });
          if (original.originalMessage.video) await bot.sendVideo(GROUPS.STORAGE_CHANNEL, original.originalMessage.video.file_id, { caption: captionText });
          if (original.originalMessage.audio) await bot.sendAudio(GROUPS.STORAGE_CHANNEL, original.originalMessage.audio.file_id, { caption: captionText });

          await bot.sendMessage(chatId, `✅ "${captionText}" saved ✔️`);

          // Send inline question flow (category + edited). These calls send inline keyboards.
          await sendCategoryKeyboard(chatId, inserted);
          await sendEditedKeyboard(chatId, inserted);

          console.log("Indexed with caption (reply flow):", inserted.id);
        } catch (err) {
          console.error("Caption reply insert failed:", err);
          return bot.sendMessage(chatId, "❌ Failed to save the file. Try again.");
        }
        return;
      }

      // filename flow
      if (awaitingFilename.has(replyId)) {
        const record = awaitingFilename.get(replyId);
        const fileRowId = record.fileRowId;
        const newName = (msg.text || "").trim();
        if (!newName) return bot.sendMessage(chatId, "❌ Filename cannot be empty.");

        try {
          const updated = await updateFile(fileRowId, { real_filename: newName, caption: newName });
          awaitingFilename.delete(replyId);
          await bot.sendMessage(chatId, `✅ Filename saved: "${newName}"`);
          await sendAdminFileActions(chatId, updated);
        } catch (err) {
          console.error("DB update error (filename reply):", err);
          return bot.sendMessage(chatId, "❌ Failed to update filename. Try again.");
        }
        return;
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
        awaitingCaption.set(prompt.message_id, { originalMessage: msg, promptChatId: chatId });
        console.log("Awaiting caption for message", msg.message_id, "mapped to prompt", prompt.message_id);
        return;
      }

      // If caption provided, insert immediately
      try {
        const inserted = await insertFileRow({ msg, captionOverride: msg.caption, uploadedBy: requesterId });

        // Forward to storage channel
        if (msg.document) await bot.sendDocument(GROUPS.STORAGE_CHANNEL, msg.document.file_id, { caption: msg.caption });
        if (msg.video) await bot.sendVideo(GROUPS.STORAGE_CHANNEL, msg.video.file_id, { caption: msg.caption });
        if (msg.audio) await bot.sendAudio(GROUPS.STORAGE_CHANNEL, msg.audio.file_id, { caption: msg.caption });

        await bot.sendMessage(chatId, `✅ "${msg.caption}" saved ✔️`);

        // Start the inline question flow (category + edited)
        await sendCategoryKeyboard(chatId, inserted);
        await sendEditedKeyboard(chatId, inserted);

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
  // sometimes cb.message is undefined (rare), so fallback to cb.from.id
  const chatId = cb.message?.chat?.id ?? cb.from.id;

  try {
    // ---------- CATEGORY ----------
    // cat|<category>|<fileId>
    if (action === "cat") {
      const category = parts[1]; // e.g. "sermon" or "prophecy"
      const fileId = parseInt(parts[2], 10);
      if (!fileId) {
        await bot.answerCallbackQuery(cb.id, { text: "Invalid file." });
        return;
      }

      const updated = await updateFile(fileId, { category });
      await bot.answerCallbackQuery(cb.id, { text: `Category set to ${category}` });
      await bot.sendMessage(chatId, `✅ "${updated.caption}" category set to *${category}*.`, { parse_mode: "Markdown" });

      // After category is set, check if edited value exists; if both present, forward.
      const fresh = await fetchFile(fileId);
      if (fresh && typeof fresh.edited === "boolean") {
        // we can forward automatically now
        await forwardToGroups(fresh);
      }
      return;
    }

    // ---------- CLASSIFICATION (edited/unedited) ----------
    // class|edited|<fileId>  OR class|unedited|<fileId>
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

      // After marking edited/unedited, try to forward if category exists
      const fresh = await fetchFile(fileId);
      if (fresh && fresh.category) {
        await forwardToGroups(fresh);
      } else {
        // if category not set yet, remind user to set category
        await sendCategoryKeyboard(chatId, updated);
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
        // schedule flow: ask admin to reply with a date
        const prompt = await bot.sendMessage(chatId, "📆 Reply to this message with the publish date/time (YYYY-MM-DD HH:MM) for scheduling.");
        // We'll store mapping so the reply handler can interpret it (re-using awaitingFilename map)
        awaitingFilename.set(prompt.message_id, { publishScheduleFor: fileId });
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
    // admin|editname|id  OR admin|togglepublished|id etc.
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
        case "editname": {
          const prompt = await bot.sendMessage(chatId, `✏️ Reply to this message with the new filename for "${file.caption}":`);
          awaitingFilename.set(prompt.message_id, { fileRowId: file.id });
          await bot.answerCallbackQuery(cb.id, { text: "Reply with new filename." });
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

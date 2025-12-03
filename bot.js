import express from "express";
import TelegramBot from "node-telegram-bot-api";
import pkg from "pg";
const { Pool } = pkg;

// ================= CONFIG =================
const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const URL = process.env.APP_URL;
const PORT = process.env.PORT || 3000;
const DATABASE_URL = process.env.DATABASE_URL; // Aiven Postgres
const CHANNEL_ID = process.env.CHANNEL_ID || -1003155277985;

if (!TOKEN || !URL || !DATABASE_URL) {
  console.error("❌ Missing required environment variables. Make sure TELEGRAM_BOT_TOKEN, APP_URL, DATABASE_URL are set.");
  process.exit(1);
}

// ================= POSTGRES =================
const pool = new Pool({ connectionString: DATABASE_URL, ssl: { rejectUnauthorized: false } });

// Initialize table
await pool.query(`
CREATE TABLE IF NOT EXISTS files (
    id SERIAL PRIMARY KEY,
    chat_id BIGINT NOT NULL,
    message_id BIGINT NOT NULL,
    caption TEXT NOT NULL,
    file_type TEXT NOT NULL,
    file_id TEXT NOT NULL
);
`);

// ================= BOT =================
const bot = new TelegramBot(TOKEN);
bot.setWebHook(`${URL}/webhook`);

// ================= EXPRESS =================
const app = express();
app.use(express.json());

// ================= CAPTION PROMPT STORE =================
const awaitingCaption = {}; // replyMessageId -> { chatId, fileMessage }

// ================= STORE FILE =================
async function storeFile(msg, captionOverride) {
  const caption = captionOverride || msg.caption || "untitled";
  const files = [];

  if (msg.document) files.push({ type: "document", file_id: msg.document.file_id, name: msg.document.file_name });
  if (msg.video) files.push({ type: "video", file_id: msg.video.file_id, name: msg.video.file_name || "video" });
  if (msg.audio) files.push({ type: "audio", file_id: msg.audio.file_id, name: msg.audio.file_name || "audio" });

  for (const file of files) {
    await pool.query(
      "INSERT INTO files(chat_id, message_id, caption, file_type, file_id) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING",
      [msg.chat.id, msg.message_id, caption, file.type, file.file_id]
    );
  }

  console.log(`📥 Indexed message: ${msg.message_id} - "${caption}"`);
  return files;
}

// ================= WEBHOOK =================
app.post("/webhook", (req, res) => {
  bot.processUpdate(req.body);
  res.sendStatus(200);
});

// ================= START COMMAND =================
bot.onText(/\/start/, (msg) => {
  bot.sendMessage(msg.chat.id, "🎉 WELCOME TO SHAREGRACE MEDIA BOT!\nSend audio/video files or search the storage.");
});

// ================= MAIN MESSAGE HANDLER =================
bot.on("message", async (msg) => {
  const chatId = msg.chat.id;

  // Ignore commands
  if (msg.text && msg.text.startsWith("/")) return;

  // ----- Handle replies to caption prompt -----
  if (msg.reply_to_message && awaitingCaption[msg.reply_to_message.message_id]) {
    const { fileMessage } = awaitingCaption[msg.reply_to_message.message_id];
    const caption = msg.text.trim();
    if (!caption) return bot.sendMessage(chatId, "❌ Caption cannot be empty. Send a valid caption.");

    await storeFile(fileMessage, caption);
    delete awaitingCaption[msg.reply_to_message.message_id];

    // Forward to storage channel
    if (fileMessage.document) await bot.sendDocument(CHANNEL_ID, fileMessage.document.file_id, { caption });
    if (fileMessage.video) await bot.sendVideo(CHANNEL_ID, fileMessage.video.file_id, { caption });
    if (fileMessage.audio) await bot.sendAudio(CHANNEL_ID, fileMessage.audio.file_id, { caption });

    return bot.sendMessage(chatId, `✅ "${caption}" saved ✔️`);
  }

  // ----- GROUP FILE HANDLER -----
  if (msg.chat.type.includes("group") && chatId !== CHANNEL_ID) {
    if (msg.document || msg.video || msg.audio) {
      if (!msg.caption) {
        const prompt = await bot.sendMessage(chatId, "📌 Please send a caption for this file so it can be saved.");
        awaitingCaption[prompt.message_id] = { chatId, fileMessage: msg };
        return;
      } else {
        await storeFile(msg);
        if (msg.document) await bot.sendDocument(CHANNEL_ID, msg.document.file_id, { caption: msg.caption });
        if (msg.video) await bot.sendVideo(CHANNEL_ID, msg.video.file_id, { caption: msg.caption });
        if (msg.audio) await bot.sendAudio(CHANNEL_ID, msg.audio.file_id, { caption: msg.caption });

        return console.log(`📤 Forwarded & indexed file from group: ${msg.message_id}`);
      }
    }

    // Bot tagged in a reply
    if (msg.reply_to_message && msg.entities?.some(e => e.type === "mention" && msg.text.includes("@CREMIMEDIA_Bot"))) {
      const target = msg.reply_to_message;
      if (!target.document && !target.video && !target.audio)
        return bot.sendMessage(chatId, `❌ File not recognized. Please retry.`);

      if (!target.caption) {
        const prompt = await bot.sendMessage(chatId, "📌 Please send a caption for this file so it can be saved.");
        awaitingCaption[prompt.message_id] = { chatId, fileMessage: target };
      } else {
        await storeFile(target);
        if (target.document) await bot.sendDocument(CHANNEL_ID, target.document.file_id, { caption: target.caption });
        if (target.video) await bot.sendVideo(CHANNEL_ID, target.video.file_id, { caption: target.caption });
        if (target.audio) await bot.sendAudio(CHANNEL_ID, target.audio.file_id, { caption: target.caption });
        bot.sendMessage(chatId, `✅ "${target.caption}" saved ✔️`);
      }

      return;
    }
  }

  // ----- PRIVATE CHAT: UPLOAD / SEARCH -----
  if (msg.chat.type === "private") {
    const handleMedia = async (type, fileId, title) => {
      await bot[type](CHANNEL_ID, fileId, { caption: title });
      await storeFile({ chat: { id: chatId }, message_id: Date.now(), [type.replace("send","").toLowerCase()]: { file_id: fileId, file_name: title } }, title);
      bot.sendMessage(chatId, `✅ ${type.replace("send", "")} "${title}" uploaded!`);
    };

    if (msg.document) return handleMedia("sendDocument", msg.document.file_id, msg.document.file_name || "untitled");
    if (msg.video) return handleMedia("sendVideo", msg.video.file_id, msg.video.file_name || "untitled");
    if (msg.audio) return handleMedia("sendAudio", msg.audio.file_id, msg.audio.file_name || "untitled");

    // Search files
    if (msg.text) {
      const query = msg.text.trim().toLowerCase();
      const { rows } = await pool.query("SELECT * FROM files WHERE LOWER(caption) LIKE $1", [`%${query}%`]);

      if (rows.length === 0) return bot.sendMessage(chatId, `❌ No files found matching "${msg.text}".`);

      const keyboard = rows.map(r => [{ text: r.caption.length > 50 ? r.caption.slice(0,50) + "…" : r.caption, callback_data: `${r.chat_id}|${r.message_id}` }]);
      bot.sendMessage(chatId, `🔎 Search results for "${msg.text}":`, { reply_markup: { inline_keyboard: keyboard } });
    }
  }
});

// ================= CALLBACK HANDLER =================
bot.on("callback_query", async (cb) => {
  const chatId = cb.message.chat.id;
  const [sourceChat, messageId] = cb.data.split("|");

  const { rows } = await pool.query("SELECT * FROM files WHERE chat_id=$1 AND message_id=$2", [sourceChat, messageId]);
  if (rows.length === 0) return bot.sendMessage(chatId, "❌ File not found.");

  for (const file of rows) {
    if (file.file_type === "document") await bot.sendDocument(chatId, file.file_id, { caption: file.caption });
    if (file.file_type === "video") await bot.sendVideo(chatId, file.file_id, { caption: file.caption });
    if (file.file_type === "audio") await bot.sendAudio(chatId, file.file_id, { caption: file.caption });
  }
});

// ================= START SERVER =================
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`📡 Webhook set: ${URL}/webhook`);
});

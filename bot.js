import express from "express";
import TelegramBot from "node-telegram-bot-api";
import pkg from "pg";

const { Client } = pkg;

// === CONFIGURATION ===
const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const URL = process.env.APP_URL;
const PORT = process.env.PORT || 3000;

if (!TOKEN || !URL) {
  console.error("❌ Error: TELEGRAM_BOT_TOKEN or APP_URL is missing.");
  process.exit(1);
}

// === STORAGE CHANNEL ID ===
const CHANNEL_ID = -1003155277985;

// === INIT BOT ===
const bot = new TelegramBot(TOKEN);
bot.setWebHook(`${URL}/webhook`);

// === INIT EXPRESS ===
const app = express();
app.use(express.json());

// === AWAITING CAPTION STORE ===
const awaitingCaption = {}; // replyMessageId -> { chatId, fileMessage }

// === POSTGRES CONNECTION ===
const client = new Client({
  connectionString: process.env.DATABASE_URL || "postgres://avnadmin:AVNS_KbOyO3XI_DJVvRApxSs@pg-28d6d267-cremimedia2.j.aivencloud.com:21144/defaultdb?sslmode=require",
});
await client.connect();

// === CREATE TABLE IF NOT EXISTS ===
await client.query(`
CREATE TABLE IF NOT EXISTS files (
  id SERIAL PRIMARY KEY,
  chat_id BIGINT NOT NULL,
  message_id BIGINT NOT NULL,
  caption TEXT NOT NULL,
  file_type TEXT NOT NULL,
  file_id TEXT NOT NULL,
  created_at TIMESTAMP DEFAULT NOW()
)
`);

// === STORE MESSAGE FUNCTION ===
const storeMessageDB = async (msg) => {
  if (!msg?.message_id || !msg?.chat) return;

  const files = [];
  if (msg.document) files.push({ type: "document", file_id: msg.document.file_id, name: msg.document.file_name });
  if (msg.video) files.push({ type: "video", file_id: msg.video.file_id, name: msg.video.file_name || "video" });
  if (msg.audio) files.push({ type: "audio", file_id: msg.audio.file_id, name: msg.audio.file_name || "audio" });

  const caption = msg.caption || msg.text || "";

  for (const file of files) {
    await client.query(
      `INSERT INTO files (chat_id, message_id, caption, file_type, file_id)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (chat_id,message_id,file_id) DO NOTHING`,
      [msg.chat.id, msg.message_id, caption, file.type, file.file_id]
    );
  }

  console.log(`📥 Indexed message: ${msg.message_id} - "${caption}"`);
};

// === WEBHOOK HANDLER ===
app.post("/webhook", (req, res) => {
  bot.processUpdate(req.body);
  res.sendStatus(200);
});

// === WELCOME MESSAGE ===
bot.onText(/\/start/, (msg) => {
  bot.sendMessage(
    msg.chat.id,
    "🎉 WELCOME TO SHAREGRACE MEDIA BOT!\n\nSend audio/video files or search the storage."
  );
});

// ==========================================================
// 1️⃣ GROUP MEDIA HANDLER
// ==========================================================
bot.on("message", async (msg) => {
  const chatId = msg.chat.id;

  // Ignore commands
  if (msg.text && msg.text.startsWith("/")) return;

  // Handle replies to bot asking for captions
  if (msg.reply_to_message && awaitingCaption[msg.reply_to_message.message_id]) {
    const { fileMessage } = awaitingCaption[msg.reply_to_message.message_id];
    const caption = msg.text.trim();
    if (!caption) return bot.sendMessage(chatId, "❌ Caption cannot be empty.");

    await storeMessageDB({ ...fileMessage, caption });
    delete awaitingCaption[msg.reply_to_message.message_id];

    await bot.sendMessage(chatId, `✅ "${caption}" saved ✔️`);

    // Forward to storage channel
    for (const file of fileMessage.document ? [{ type: "document", file: fileMessage.document }] :
      fileMessage.video ? [{ type: "video", file: fileMessage.video }] :
      fileMessage.audio ? [{ type: "audio", file: fileMessage.audio }] : []) {

      if (file.type === "document") await bot.sendDocument(CHANNEL_ID, file.file_id, { caption });
      if (file.type === "video") await bot.sendVideo(CHANNEL_ID, file.file_id, { caption });
      if (file.type === "audio") await bot.sendAudio(CHANNEL_ID, file.file_id, { caption });
    }
    return;
  }

  // Only handle group messages
  if (msg.chat.type.includes("group") && chatId !== CHANNEL_ID) {
    if (msg.document || msg.video || msg.audio) {
      if (!msg.caption) {
        const prompt = await bot.sendMessage(chatId, "📌 Please send a caption for this file.");
        awaitingCaption[prompt.message_id] = { chatId, fileMessage: msg };
        return;
      } else {
        await storeMessageDB(msg);

        // Forward to storage channel
        for (const file of msg.document ? [{ type: "document", file: msg.document }] :
          msg.video ? [{ type: "video", file: msg.video }] :
          msg.audio ? [{ type: "audio", file: msg.audio }] : []) {

          if (file.type === "document") await bot.sendDocument(CHANNEL_ID, file.file_id, { caption: msg.caption });
          if (file.type === "video") await bot.sendVideo(CHANNEL_ID, file.file_id, { caption: msg.caption });
          if (file.type === "audio") await bot.sendAudio(CHANNEL_ID, file.file_id, { caption: msg.caption });
        }

        console.log(`📤 Forwarded & indexed file from group: ${msg.message_id}`);
        return;
      }
    }

    // Bot tagged on a reply
    if (msg.reply_to_message && msg.entities?.some(e => e.type === "mention" && msg.text.includes("@CREMIMEDIA_Bot"))) {
      const target = msg.reply_to_message;

      if (target.document || target.video || target.audio) {
        if (!target.caption) {
          const prompt = await bot.sendMessage(chatId, "📌 Please send a caption for this file.");
          awaitingCaption[prompt.message_id] = { chatId, fileMessage: target };
        } else {
          await storeMessageDB(target);

          for (const file of target.document ? [{ type: "document", file: target.document }] :
            target.video ? [{ type: "video", file: target.video }] :
            target.audio ? [{ type: "audio", file: target.audio }] : []) {

            if (file.type === "document") await bot.sendDocument(CHANNEL_ID, file.file_id, { caption: target.caption });
            if (file.type === "video") await bot.sendVideo(CHANNEL_ID, file.file_id, { caption: target.caption });
            if (file.type === "audio") await bot.sendAudio(CHANNEL_ID, file.file_id, { caption: target.caption });
          }

          await bot.sendMessage(chatId, `✅ "${target.caption}" saved ✔️`);
        }
      } else {
        await bot.sendMessage(chatId, `❌ File not recognized. Please retry.`);
      }
      return;
    }
  }

  // ==========================================================
  // PRIVATE CHAT: SEARCH & UPLOAD
  // ==========================================================
  if (msg.chat.type === "private") {
    const handleMedia = async (type, fileId, title) => {
      const sent = await bot[type](CHANNEL_ID, fileId, { caption: title });
      await storeMessageDB(sent);
      await bot.sendMessage(msg.chat.id, `✅ ${type.replace("send", "")} "${title}" uploaded!`);
    };

    if (msg.document) return await handleMedia("sendDocument", msg.document.file_id, msg.document.file_name || "untitled");
    if (msg.video) return await handleMedia("sendVideo", msg.video.file_id, msg.video.file_name || "untitled");
    if (msg.audio) return await handleMedia("sendAudio", msg.audio.file_id, msg.audio.file_name || "untitled");

    // SEARCH
    if (msg.text) {
      const query = msg.text.trim().toLowerCase();

      const res = await client.query(
        `SELECT * FROM files WHERE LOWER(caption) LIKE $1 ORDER BY created_at DESC LIMIT 50`,
        [`%${query}%`]
      );

      if (res.rows.length === 0) return bot.sendMessage(msg.chat.id, `❌ No files found matching "${msg.text}".`);

      const keyboard = res.rows.map((r) => [{
        text: r.caption.length > 50 ? r.caption.slice(0, 50) + "…" : r.caption,
        callback_data: `${r.chat_id}|${r.message_id}`
      }]);

      bot.sendMessage(msg.chat.id, `🔎 Search results for "${msg.text}":`, {
        reply_markup: { inline_keyboard: keyboard }
      });
    }
  }
});

// ==========================================================
// INLINE CALLBACK HANDLER
// ==========================================================
bot.on("callback_query", async (cb) => {
  const chatId = cb.message.chat.id;
  const [sourceChat, messageId] = cb.data.split("|");

  const res = await client.query(
    `SELECT * FROM files WHERE chat_id=$1 AND message_id=$2`,
    [sourceChat, messageId]
  );

  if (res.rows.length === 0) return bot.sendMessage(chatId, "❌ File not found.");

  for (const file of res.rows) {
    if (file.file_type === "document") await bot.sendDocument(chatId, file.file_id, { caption: file.caption });
    if (file.file_type === "video") await bot.sendVideo(chatId, file.file_id, { caption: file.caption });
    if (file.file_type === "audio") await bot.sendAudio(chatId, file.file_id, { caption: file.caption });
  }
});

// ==========================================================
// START SERVER
// ==========================================================
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`📡 Webhook set: ${URL}/webhook`);
});

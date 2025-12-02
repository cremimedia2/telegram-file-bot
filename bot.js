import express from "express";
import TelegramBot from "node-telegram-bot-api";

// === CONFIGURATION ===
const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const URL = process.env.APP_URL; // e.g., https://your-app.onrender.com
const PORT = process.env.PORT || 3000;

if (!TOKEN || !URL) {
  console.error("Error: TELEGRAM_BOT_TOKEN or APP_URL is not set.");
  process.exit(1);
}

// === CONSTANT CHANNEL ID ===
const CHANNEL_ID = -1003155277985;

// === INIT BOT ===
const bot = new TelegramBot(TOKEN);
bot.setWebHook(`${URL}/webhook`);

// === INIT EXPRESS ===
const app = express();
app.use(express.json());

// === MESSAGE STORE ===
// messageStore[messageId] = { chatId, messageId, caption, files }
const messageStore = {};

// === TELEGRAM WEBHOOK ===
app.post("/webhook", (req, res) => {
  bot.processUpdate(req.body);
  res.sendStatus(200);
});

// === WELCOME MESSAGE ===
bot.onText(/\/start/, (msg) => {
  bot.sendMessage(
    msg.chat.id,
    "🎉 WELCOME TO THE SHAREGRACE MEDIA BOT REPOSITORY!\n\nSend an audio or video file, or search for files in the channel!"
  );
});

// === STORE MESSAGE FUNCTION ===
const storeMessage = (msg) => {
  if (!msg.message_id || !msg.chat) return;

  const files = [];

  if (msg.document)
    files.push({
      type: "document",
      file_id: msg.document.file_id,
      name: msg.document.file_name
    });

  if (msg.video)
    files.push({
      type: "video",
      file_id: msg.video.file_id,
      name: msg.video.file_name || "video"
    });

  if (msg.audio)
    files.push({
      type: "audio",
      file_id: msg.audio.file_id,
      name: msg.audio.file_name || "audio"
    });

  const caption = msg.caption || msg.text || "";

  messageStore[msg.message_id] = {
    chatId: msg.chat.id,
    messageId: msg.message_id,
    caption,
    files,
  };

  console.log("Indexed:", caption);
};

// === MAIN MESSAGE HANDLER ===
bot.on("message", async (msg) => {
  const chatId = msg.chat.id;

  // Ignore commands
  if (msg.text && msg.text.startsWith("/")) return;

  // ======================================
  // 1️⃣ INDEX NEW FILES POSTED IN CHANNEL
  // ======================================
  if (chatId === CHANNEL_ID) {
    storeMessage(msg);
    return; // stop here (do not forward again)
  }

  // ======================================
  // 2️⃣ USER UPLOADS MEDIA TO THE BOT
  // BOT WILL FORWARD TO THE CHANNEL
  // ======================================
  const handleMedia = async (type, fileId, title) => {
    const sent = await bot[type](CHANNEL_ID, fileId, { caption: title });
    storeMessage(sent);

    bot.sendMessage(chatId, `✅ ${type.replace("send", "")} "${title}" uploaded to the channel!`);
  };

  if (msg.document)
    await handleMedia("sendDocument", msg.document.file_id, msg.document.file_name || "untitled");

  if (msg.video)
    await handleMedia("sendVideo", msg.video.file_id, msg.video.file_name || "untitled");

  if (msg.audio)
    await handleMedia("sendAudio", msg.audio.file_id, msg.audio.file_name || "untitled");

  // ======================================
  // 3️⃣ SEARCH FUNCTIONALITY
  // ======================================
  if (msg.text) {
    const query = msg.text.trim().toLowerCase();

    const results = Object.values(messageStore).filter((m) =>
      m.caption.toLowerCase().includes(query)
    );

    if (results.length === 0) {
      bot.sendMessage(chatId, `❌ No files found matching "${msg.text}".`);
      return;
    }

    const keyboard = results.map((m) => [{
      text: m.caption.length > 50 ? m.caption.slice(0, 50) + "…" : m.caption,
      callback_data: `${m.chatId}|${m.messageId}`
    }]);

    bot.sendMessage(chatId, `🔎 Search results for "${msg.text}":`, {
      reply_markup: { inline_keyboard: keyboard }
    });
  }
});

// === INLINE BUTTON HANDLER ===
bot.on("callback_query", async (cb) => {
  const chatId = cb.message.chat.id;
  const [sourceChat, messageId] = cb.data.split("|");

  const msg = messageStore[messageId];
  if (!msg) {
    bot.sendMessage(chatId, "❌ Message not found or not indexed.");
    return;
  }

  // Send all attached files
  for (const file of msg.files) {
    if (file.type === "document")
      await bot.sendDocument(chatId, file.file_id, { caption: file.name });

    if (file.type === "video")
      await bot.sendVideo(chatId, file.file_id, { caption: file.name });

    if (file.type === "audio")
      await bot.sendAudio(chatId, file.file_id, { caption: file.name });
  }

  // Send caption
  if (msg.caption) {
    bot.sendMessage(chatId, `📝 ${msg.caption}`);
  }
});

// === START SERVER ===
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`📡 Bot webhook set to ${URL}/webhook`);
});

import express from "express";
import TelegramBot from "node-telegram-bot-api";

// === CONFIGURATION ===
const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const URL = process.env.APP_URL; // Render app URL, e.g., https://your-app.onrender.com
const PORT = process.env.PORT || 3000;

if (!TOKEN || !URL) {
  console.error("Error: TELEGRAM_BOT_TOKEN or APP_URL is not set.");
  process.exit(1);
}

// === CONSTANT CHANNEL ID ===
const CHANNEL_ID = -1003155277985; // Your channel numeric ID

// === INIT BOT ===
const bot = new TelegramBot(TOKEN);
bot.setWebHook(`${URL}/webhook`);

// === INIT EXPRESS ===
const app = express();
app.use(express.json());

// === MESSAGE STORE ===
// In-memory store: { messageId: { chatId, messageId, caption, files } }
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
    "🎉 WELCOME TO THE SHAREGRACE MEDIA BOT REPOSITORY!\n\nWhich audio or video file would you like to get?"
  );
});

// === FUNCTION TO STORE MESSAGE INFO ===
const storeMessage = (msg) => {
  if (!msg.message_id || !msg.chat) return;

  const files = [];
  if (msg.document)
    files.push({ type: "document", file_id: msg.document.file_id, name: msg.document.file_name });
  if (msg.video)
    files.push({ type: "video", file_id: msg.video.file_id, name: msg.video.file_name || "video" });
  if (msg.audio)
    files.push({ type: "audio", file_id: msg.audio.file_id, name: msg.audio.file_name || "audio" });

  const caption = msg.caption || msg.text || "";

  messageStore[msg.message_id] = {
    chatId: msg.chat.id,
    messageId: msg.message_id,
    caption,
    files,
  };
};

// === HANDLE MEDIA UPLOAD AND SEARCH ===
bot.on("message", async (msg) => {
  const chatId = msg.chat.id;

  // Ignore commands
  if (msg.text && msg.text.startsWith("/")) return;

  // === FORWARD MEDIA TO CHANNEL ===
  const handleMedia = async (type, fileId, title) => {
    // Send media to the channel
    const sentMessage = await bot[type](CHANNEL_ID, fileId, { caption: title });

    // Store the sent message for search
    messageStore[sentMessage.message_id] = {
      chatId: CHANNEL_ID,
      messageId: sentMessage.message_id,
      caption: title,
      files: [{ type: type.replace("send", "").toLowerCase(), file_id: fileId, name: title }],
    };

    bot.sendMessage(chatId, `✅ ${type.replace("send", "")} "${title}" uploaded to the channel!`);
  };

  if (msg.document) await handleMedia("sendDocument", msg.document.file_id, msg.document.file_name || "untitled");
  if (msg.video) await handleMedia("sendVideo", msg.video.file_id, msg.video.file_name || "untitled");
  if (msg.audio) await handleMedia("sendAudio", msg.audio.file_id, msg.audio.file_name || "untitled");

  // === SEARCH FUNCTIONALITY ===
if (msg.text && !msg.text.startsWith("/")) {
  const query = msg.text.trim().toLowerCase(); // trim spaces & lowercase

  // Filter messages where the caption includes the query anywhere
  const results = Object.values(messageStore).filter((m) =>
    m.caption.toLowerCase().includes(query)
  );

  if (results.length === 0) {
    bot.sendMessage(chatId, `❌ No files found matching "${msg.text}".`);
    return;
  }

  // Build inline keyboard (max 50 chars)
  const keyboard = results.map((m) => [{
    text: m.caption.length > 50 ? m.caption.slice(0, 50) + "…" : m.caption,
    callback_data: `${m.chatId}|${m.messageId}`
  }]);

  bot.sendMessage(chatId, `🔎 Search results for "${msg.text}":`, {
    reply_markup: { inline_keyboard: keyboard }
  });
}

    // Build inline keyboard (max 50 chars)
    const keyboard = results.map((m) => [{
      text: m.caption.length > 50 ? m.caption.slice(0, 50) + "…" : m.caption,
      callback_data: `${m.chatId}|${m.messageId}`
    }]);

    bot.sendMessage(chatId, `🔎 Search results for "${msg.text}":`, {
      reply_markup: { inline_keyboard: keyboard }
    });
  }
});

// === HANDLE INLINE BUTTONS ===
bot.on("callback_query", async (callbackQuery) => {
  const chatId = callbackQuery.message.chat.id;
  const data = callbackQuery.data.split("|");
  const messageId = parseInt(data[1]);

  const msg = messageStore[messageId];
  if (!msg) {
    bot.sendMessage(chatId, "❌ Message not found or not indexed.");
    return;
  }

  // Send all attached files
  for (const file of msg.files) {
    if (file.type === "document") await bot.sendDocument(chatId, file.file_id, { caption: file.name });
    if (file.type === "video") await bot.sendVideo(chatId, file.file_id, { caption: file.name });
    if (file.type === "audio") await bot.sendAudio(chatId, file.file_id, { caption: file.name });
  }

  // Send text/caption if any
  if (msg.caption) {
    bot.sendMessage(chatId, `📝 ${msg.caption}`);
  }
});

// === START EXPRESS SERVER ===
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`📡 Bot webhook set to ${URL}/webhook`);
});

import express from "express";
import TelegramBot from "node-telegram-bot-api";

// === CONFIGURATION ===
const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const URL = process.env.APP_URL; // Render app URL, e.g., https://your-app.onrender.com
const CHANNEL = "@yourchannelusername"; // Your channel username or numeric ID
const PORT = process.env.PORT || 3000;

if (!TOKEN || !URL || !CHANNEL) {
  console.error("Error: TELEGRAM_BOT_TOKEN, APP_URL, or CHANNEL is not set.");
  process.exit(1);
}

// === INIT BOT ===
const bot = new TelegramBot(TOKEN);
bot.setWebHook(`${URL}/webhook`);

// === INIT EXPRESS ===
const app = express();
app.use(express.json());

// === MESSAGE STORE ===
// In-memory store: { messageId: { chatId, messageId, text/caption, files } }
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
  if (msg.document) files.push({ type: "document", file_id: msg.document.file_id, name: msg.document.file_name });
  if (msg.video) files.push({ type: "video", file_id: msg.video.file_id, name: msg.video.file_name || "video" });
  if (msg.audio) files.push({ type: "audio", file_id: msg.audio.file_id, name: msg.audio.file_name || "audio" });

  const caption = msg.caption || msg.text || "";

  messageStore[msg.message_id] = {
    chatId: msg.chat.id,
    messageId: msg.message_id,
    caption,
    files
  };
};

// === RECEIVE FILES FROM USERS AND STORE ===
bot.on("message", async (msg) => {
  const chatId = msg.chat.id;

  // Ignore commands
  if (msg.text && msg.text.startsWith("/")) return;

  // Forward media to the channel and store the channel message
  const handleMedia = async (type, fileId, title) => {
    const sentMessage = await bot[type](CHANNEL, fileId, { caption: title });
    storeMessage(sentMessage);
    bot.sendMessage(chatId, `✅ ${type} "${title}" uploaded to the channel!`);
  };

  if (msg.document) await handleMedia("sendDocument", msg.document.file_id, msg.document.file_name || "untitled");
  if (msg.video) await handleMedia("sendVideo", msg.video.file_id, msg.video.file_name || "untitled");
  if (msg.audio) await handleMedia("sendAudio", msg.audio.file_id, msg.audio.file_name || "untitled");

  // === SEARCH FUNCTIONALITY ===
  if (msg.text && !msg.text.startsWith("/")) {
    const query = msg.text.toLowerCase();

    // Find all messages containing the query in caption/text
    const results = Object.values(messageStore).filter((m) =>
      m.caption.toLowerCase().includes(query)
    );

    if (results.length === 0) {
      bot.sendMessage(chatId, `❌ No files found matching "${msg.text}".`);
      return;
    }

    // Build inline keyboard with previews (max 50 chars)
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
  const channelId = parseInt(data[0]);
  const messageId = parseInt(data[1]);

  // Get message from store
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
});

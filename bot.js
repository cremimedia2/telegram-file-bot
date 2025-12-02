import express from "express";
import TelegramBot from "node-telegram-bot-api";

// === CONFIGURATION ===
const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const URL = process.env.APP_URL; // Render app URL
const CHANNEL = "@yourchannelusername"; // Or numeric ID
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

// === STORE MESSAGES ===
// In-memory: { title -> { chatId, messageId, type } }
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

// === RECEIVE FILES AND STORE ===
bot.on("message", async (msg) => {
  const chatId = msg.chat.id;

  // Ignore commands
  if (msg.text && msg.text.startsWith("/")) return;

  // Forward media to the channel and store the channel messageId
  const handleMedia = async (type, fileId, title) => {
    const sentMessage = await bot[type](CHANNEL, fileId, {
      caption: title,
    });

    // Store message info for search
    messageStore[title.toLowerCase()] = {
      chatId: sentMessage.chat.id,
      messageId: sentMessage.message_id,
      type: type,
      caption: title,
    };

    bot.sendMessage(chatId, `✅ ${type} "${title}" uploaded to the channel!`);
  };

  if (msg.document) await handleMedia("sendDocument", msg.document.file_id, msg.document.file_name || "untitled");
  if (msg.video) await handleMedia("sendVideo", msg.video.file_id, msg.video.file_name || "untitled");
  if (msg.audio) await handleMedia("sendAudio", msg.audio.file_id, msg.audio.file_name || "untitled");

  // === SEARCH FUNCTIONALITY ===
  if (msg.text) {
    const query = msg.text.toLowerCase();
    const results = Object.entries(messageStore).filter(([title]) => title.includes(query));

    if (results.length === 0) {
      bot.sendMessage(chatId, `❌ No files found matching "${msg.text}".`);
      return;
    }

    // Build inline keyboard with results
    const keyboard = results.map(([title, info]) => [{
      text: title,
      callback_data: `${info.chatId}|${info.messageId}`
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

  // Forward the original channel message to the user
  await bot.forwardMessage(chatId, channelId, messageId);
});
 
// === START EXPRESS SERVER ===
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});

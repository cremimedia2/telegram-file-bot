import express from "express";
import TelegramBot from "node-telegram-bot-api";

// === CONFIGURATION ===
const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const URL = process.env.APP_URL; // Render app URL
const CHANNEL = "@yourchannelusername"; // Or use the numeric channel ID
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

// In-memory store for uploaded files (title -> file_id)
const fileStore = {};

// === TELEGRAM WEBHOOK ENDPOINT ===
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

// === RECEIVE FILES ===
bot.on("message", async (msg) => {
  const chatId = msg.chat.id;

  // Handle documents
  if (msg.document) {
    const fileId = msg.document.file_id;
    const title = msg.document.file_name || "untitled";

    // Store file in memory
    fileStore[title.toLowerCase()] = fileId;

    // Forward file to the channel
    await bot.sendDocument(CHANNEL, fileId, {
      caption: `📥 New file uploaded: ${title}`,
    });

    bot.sendMessage(chatId, `✅ File "${title}" has been uploaded to the channel!`);
  }

  // Handle videos
  if (msg.video) {
    const fileId = msg.video.file_id;
    const title = msg.video.file_name || "untitled";

    fileStore[title.toLowerCase()] = fileId;

    await bot.sendVideo(CHANNEL, fileId, {
      caption: `📥 New video uploaded: ${title}`,
    });

    bot.sendMessage(chatId, `✅ Video "${title}" has been uploaded to the channel!`);
  }

  // Handle audio
  if (msg.audio) {
    const fileId = msg.audio.file_id;
    const title = msg.audio.file_name || "untitled";

    fileStore[title.toLowerCase()] = fileId;

    await bot.sendAudio(CHANNEL, fileId, {
      caption: `📥 New audio uploaded: ${title}`,
    });

    bot.sendMessage(chatId, `✅ Audio "${title}" has been uploaded to the channel!`);
  }

  // Handle search query
  if (msg.text && !msg.text.startsWith("/")) {
    const query = msg.text.toLowerCase();
    const resultFileId = fileStore[query];

    if (resultFileId) {
      bot.sendDocument(chatId, resultFileId, {
        caption: `📁 Here is the file you searched for: ${msg.text}`,
      });
    } else {
      bot.sendMessage(chatId, `❌ Sorry, no file found with the title "${msg.text}".`);
    }
  }
});

// === START EXPRESS SERVER ===
app.listen(PORT, () => {
  console.log(`🚀 Server is running on port ${PORT}`);
});

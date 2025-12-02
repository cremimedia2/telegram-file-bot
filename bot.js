import express from "express";
import TelegramBot from "node-telegram-bot-api";

// Telegram Bot Token and App URL from Render environment variables
const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const URL = process.env.APP_URL; // e.g., https://your-render-url.onrender.com
const PORT = process.env.PORT || 3000;

if (!TOKEN || !URL) {
  console.error("Error: TELEGRAM_BOT_TOKEN or APP_URL is not set.");
  process.exit(1);
}

// Initialize bot without polling (webhook only)
const bot = new TelegramBot(TOKEN);
bot.setWebHook(`${URL}/webhook`);

const app = express();
app.use(express.json());

// Telegram webhook endpoint
app.post("/webhook", (req, res) => {
  bot.processUpdate(req.body);
  res.sendStatus(200);
});

// Example /start command
bot.onText(/\/start/, (msg) => {
  bot.sendMessage(msg.chat.id, "🚀 Hello! I am running on Render via webhook!");
});

// Listen on the Render port
app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});

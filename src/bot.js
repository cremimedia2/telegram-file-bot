import express from "express";
import TelegramBot from "node-telegram-bot-api";

const TOKEN = process.env.TELEGRAM_BOT_TOKEN; // Set this in Render environment variables
const PORT = process.env.PORT || 3000;       // Render assigns a port
const URL = process.env.APP_URL;             // e.g., https://telegram-bot-render-7mx0.onrender.com

const bot = new TelegramBot(TOKEN);
bot.setWebHook(`${URL}/webhook`);

const app = express();
app.use(express.json());

// Telegram webhook endpoint
app.post("/webhook", (req, res) => {
  bot.processUpdate(req.body);
  res.sendStatus(200);
});

// Example command
bot.onText(/\/start/, (msg) => {
  bot.sendMessage(msg.chat.id, "Hello! I am live via webhook on Render!");
});

app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});

import { Telegraf } from "telegraf";
import dotenv from "dotenv";

dotenv.config(); // Load BOT_TOKEN from .env

const bot = new Telegraf(process.env.BOT_TOKEN);

// Simple greeting response
bot.hears(/hello/i, (ctx) => {
  ctx.reply("Welcome to CREMI Media Repository. What would you like to search for?");
});

// Start command
bot.start((ctx) => {
  ctx.reply("Hello! Welcome to CREMI Media Repository. Type 'hello' to begin.");
});

// Launch bot
bot.launch();
console.log("Bot is running...");


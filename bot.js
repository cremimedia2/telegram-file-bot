import TelegramBot from "node-telegram-bot-api";
import fs from "fs";

// ===============================
// CONFIG
// ===============================
const TOKEN = "YOUR_BOT_TOKEN";
const CHANNEL_ID = -1002410872941; // Replace with your numeric channel ID

const bot = new TelegramBot(TOKEN, { polling: true });

// Load or create DB
let db = { files: [] };
if (fs.existsSync("db.json")) {
  db = JSON.parse(fs.readFileSync("db.json"));
}

// Save DB
function saveDB() {
  fs.writeFileSync("db.json", JSON.stringify(db, null, 2));
}

// ===============================
// LOG CHANNEL UPDATES
// ===============================
bot.on("channel_post", async (msg) => {
  console.log("📩 NEW CHANNEL MESSAGE RECEIVED!");
  console.log(JSON.stringify(msg, null, 2));

  if (msg.chat.id !== CHANNEL_ID) return;

  let caption = msg.caption || "";
  let fileId = null;
  let fileName = null;

  // Detect file types
  if (msg.document) {
    fileId = msg.document.file_id;
    fileName = msg.document.file_name;
  }
  if (msg.video) {
    fileId = msg.video.file_id;
    fileName = msg.video.file_name || "video.mp4";
  }
  if (msg.audio) {
    fileId = msg.audio.file_id;
    fileName = msg.audio.file_name || "audio.mp3";
  }

  // If it's a file, save to DB
  if (fileId) {
    db.files.push({
      fileId,
      fileName,
      caption,
      originalMessageId: msg.message_id
    });

    saveDB();

    console.log("✅ FILE SAVED TO DB:", fileName);
  }
});

// ===============================
// SEARCH SYSTEM
// ===============================
bot.on("message", async (msg) => {
  if (!msg.text) return;

  const text = msg.text.trim();
  const chatId = msg.chat.id;

  // Only respond to users, not channels
  if (msg.chat.type === "private") {
    if (text.startsWith("/search")) {
      const query = text.replace("/search", "").trim().toLowerCase();

      if (!query) {
        bot.sendMessage(chatId, "🔎 *Usage:* /search keyword", { parse_mode: "Markdown" });
        return;
      }

      // Partial match search
      const results = db.files.filter((item) =>
        (item.caption && item.caption.toLowerCase().includes(query)) ||
        (item.fileName && item.fileName.toLowerCase().includes(query))
      );

      if (results.length === 0) {
        bot.sendMessage(chatId, `❌ No files found matching "*${query}*".`, {
          parse_mode: "Markdown"
        });
        return;
      }

      // Build response
      let reply = `🔍 *Results for:* ${query}\n\n`;

      results.forEach((item, index) => {
        reply += `📁 *${index + 1}. ${item.fileName}*\n`;
        reply += `🔗 https://t.me/c/${String(CHANNEL_ID).slice(4)}/${item.originalMessageId}\n\n`;
      });

      bot.sendMessage(chatId, reply, { parse_mode: "Markdown" });
    }
  }
});

// ===============================
// STARTUP MESSAGE
// ===============================
console.log("🤖 Bot is running...");

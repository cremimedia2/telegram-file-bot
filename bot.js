import express from "express";
import TelegramBot from "node-telegram-bot-api";

// === CONFIGURATION ===
const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const URL = process.env.APP_URL;
const PORT = process.env.PORT || 3000;

if (!TOKEN || !URL) {
  console.error("❌ Error: TELEGRAM_BOT_TOKEN or APP_URL is missing.");
  process.exit(1);
}

// === CHANNEL & GROUP CONFIG ===
const STORAGE_CHANNEL_ID = -1003155277985; // Channel for storing files
const ALLOWED_FILE_TYPES = ["document", "audio", "video"]; // Only index these

// === INIT BOT ===
const bot = new TelegramBot(TOKEN);
bot.setWebHook(`${URL}/webhook`);

// === INIT EXPRESS ===
const app = express();
app.use(express.json());

// === MESSAGE STORE ===
const messageStore = {}; // messageId -> { chatId, messageId, caption, files }

// === STORE MESSAGE FUNCTION ===
const storeMessage = (msg) => {
  if (!msg?.message_id || !msg?.chat) return;

  const files = [];

  if (msg.document) files.push({ type: "document", file_id: msg.document.file_id, name: msg.document.file_name });
  if (msg.video) files.push({ type: "video", file_id: msg.video.file_id, name: msg.video.file_name || "video" });
  if (msg.audio) files.push({ type: "audio", file_id: msg.audio.file_id, name: msg.audio.file_name || "audio" });

  // Only store if it has allowed file types
  if (files.length === 0) return;

  const caption = msg.caption || msg.text || "";

  messageStore[msg.message_id] = {
    chatId: msg.chat.id,
    messageId: msg.message_id,
    caption,
    files,
  };

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
    "🎉 WELCOME TO SHAREGRACE MEDIA BOT!\n\nSend audio/video files here or search the group/channel.\n\nReply to a file in the group and tag me to save it!"
  );
});

// ==========================================================
// 1️⃣ GROUP MEDIA INDEXING & TAGGING
// ==========================================================
bot.on("message", async (msg) => {
  const chatId = msg.chat.id;

  // Ignore commands
  if (msg.text && msg.text.startsWith("/")) return;

  // -----------------------------
  // ✅ Group messages
  // -----------------------------
  if (msg.chat.type.includes("group")) {
    // 1️⃣ Auto-index allowed files
    if (msg.document || msg.video || msg.audio) storeMessage(msg);

    // 2️⃣ Tag bot to save & forward
    if (
      msg.reply_to_message &&
      msg.entities?.some(e => e.type === "mention" && msg.text.includes("@CREMIMEDIA_Bot"))
    ) {
      const target = msg.reply_to_message;

      if (target.document || target.video || target.audio) {
        try {
          // Forward to storage channel
          if (target.document) await bot.sendDocument(STORAGE_CHANNEL_ID, target.document.file_id, { caption: target.document.file_name });
          if (target.video) await bot.sendVideo(STORAGE_CHANNEL_ID, target.video.file_id, { caption: target.video.file_name || "video" });
          if (target.audio) await bot.sendAudio(STORAGE_CHANNEL_ID, target.audio.file_id, { caption: target.audio.file_name || "audio" });

          storeMessage(target);

          await bot.sendMessage(chatId, `✅ "${target.caption || target.document?.file_name || "untitled"}" saved ✔️`);
          console.log(`📤 Forwarded & indexed file from group: ${target.message_id}`);
        } catch (err) {
          console.error("❌ Error forwarding file:", err);
          await bot.sendMessage(chatId, `❌ Failed to save file. Please retry.`);
        }
      } else {
        await bot.sendMessage(chatId, `❌ File not recognized. Please reply to a valid media file.`);
      }
    }

    return; // stop processing further for group
  }

  // -----------------------------
  // ✅ Private chat
  // -----------------------------
  if (msg.chat.type === "private") {

    // 1️⃣ Forward uploaded media to storage channel + group
    const handleMedia = async (type, fileId, title) => {
      try {
        const sentToChannel = await bot[type](STORAGE_CHANNEL_ID, fileId, { caption: title });
        storeMessage(sentToChannel);
        await bot.sendMessage(msg.chat.id, `✅ ${type.replace("send", "")} "${title}" uploaded to the channel!`);
      } catch (err) {
        console.error("❌ Error forwarding media:", err);
        await bot.sendMessage(msg.chat.id, `❌ Failed to upload "${title}".`);
      }
    };

    if (msg.document) return await handleMedia("sendDocument", msg.document.file_id, msg.document.file_name || "untitled");
    if (msg.video) return await handleMedia("sendVideo", msg.video.file_id, msg.video.file_name || "untitled");
    if (msg.audio) return await handleMedia("sendAudio", msg.audio.file_id, msg.audio.file_name || "untitled");

    // 2️⃣ Search (partial word match)
    if (msg.text) {
      const query = msg.text.trim().toLowerCase();

      const results = Object.values(messageStore).filter((m) => (m.caption || "").toLowerCase().includes(query));

      if (results.length === 0) return bot.sendMessage(chatId, `❌ No files found matching "${msg.text}".`);

      const keyboard = results.map((m) => [
        { text: m.caption.length > 50 ? m.caption.slice(0, 50) + "…" : m.caption, callback_data: `${m.chatId}|${m.messageId}` },
      ]);

      return bot.sendMessage(chatId, `🔎 Search results for "${msg.text}":`, {
        reply_markup: { inline_keyboard: keyboard },
      });
    }
  }
});

// ==========================================================
// 2️⃣ INLINE CALLBACK HANDLER
// ==========================================================
bot.on("callback_query", async (cb) => {
  const chatId = cb.message.chat.id;
  const [sourceChat, messageId] = cb.data.split("|");
  const msg = messageStore[messageId];

  if (!msg) return bot.sendMessage(chatId, "❌ Message not found or not indexed.");

  for (const file of msg.files) {
    if (file.type === "document") await bot.sendDocument(chatId, file.file_id, { caption: file.name });
    if (file.type === "video") await bot.sendVideo(chatId, file.file_id, { caption: file.name });
    if (file.type === "audio") await bot.sendAudio(chatId, file.file_id, { caption: file.name });
  }

  if (msg.caption) bot.sendMessage(chatId, `📝 ${msg.caption}`);
});

// ==========================================================
// 3️⃣ START SERVER
// ==========================================================
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`📡 Webhook set: ${URL}/webhook`);
});

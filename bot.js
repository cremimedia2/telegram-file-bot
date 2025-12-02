import express from "express";
import TelegramBot from "node-telegram-bot-api";

// === CONFIGURATION ===
const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const URL = process.env.APP_URL;
const PORT = process.env.PORT || 3000;

if (!TOKEN || !URL) {
  console.error("❌ TELEGRAM_BOT_TOKEN or APP_URL missing.");
  process.exit(1);
}

// === CHANNEL ID ===
const CHANNEL_ID = -1003155277985;

// === INIT BOT ===
const bot = new TelegramBot(TOKEN);
bot.setWebHook(`${URL}/webhook`);

// === INIT EXPRESS ===
const app = express();
app.use(express.json());

// === MESSAGE STORE ===
const messageStore = {}; // { messageId: { chatId, messageId, caption, files } }

// === WEBHOOK HANDLER ===
app.post("/webhook", (req, res) => {
  bot.processUpdate(req.body);
  res.sendStatus(200);
});

// === STORE MESSAGE ===
const storeMessage = (msg) => {
  if (!msg?.message_id || !msg?.chat) return;

  const files = [];
  if (msg.document)
    files.push({ type: "document", file_id: msg.document.file_id, name: msg.document.file_name });
  if (msg.video)
    files.push({ type: "video", file_id: msg.video.file_id, name: msg.video.file_name || "video" });
  if (msg.audio)
    files.push({ type: "audio", file_id: msg.audio.file_id, name: msg.audio.file_name || "audio" });

  const caption = msg.caption || msg.text || "";

  messageStore[msg.message_id] = { chatId: msg.chat.id, messageId: msg.message_id, caption, files };
  console.log("📦 Indexed message:", msg.message_id, caption);
};

// === WELCOME MESSAGE ===
bot.onText(/\/start/, (msg) => {
  bot.sendMessage(
    msg.chat.id,
    "🎉 WELCOME TO SHAREGRACE MEDIA BOT!\n\n" +
    "Upload files here to store them in the channel or search files using text queries.\n" +
    "In the group, tag me on a file to save it."
  );
});

// === MAIN MESSAGE HANDLER ===
bot.on("message", async (msg) => {
  const chatId = msg.chat.id;

  // Ignore commands
  if (msg.text && msg.text.startsWith("/")) return;

  // =============================
  // 1️⃣ HANDLE GROUP TAGS ONLY
  // =============================
  if (
    chatId !== CHANNEL_ID && // not channel
    msg.chat.type.includes("group") &&
    msg.reply_to_message &&
    msg.entities?.some(e => e.type === "mention" && msg.text.includes("@CREMIMEDIA_Bot"))
  ) {
    const target = msg.reply_to_message;

    if (target.document || target.video || target.audio) {
      storeMessage(target);

      // Forward copy to storage channel
      for (const file of target.document ? [{ type: "document", file: target.document }] :
                                         target.video ? [{ type: "video", file: target.video }] :
                                         target.audio ? [{ type: "audio", file: target.audio }] : []) {
        if (file.type === "document")
          await bot.sendDocument(CHANNEL_ID, file.file.file_id, { caption: file.file.file_name });
        if (file.type === "video")
          await bot.sendVideo(CHANNEL_ID, file.file.file_id, { caption: file.file.file_name || "video" });
        if (file.type === "audio")
          await bot.sendAudio(CHANNEL_ID, file.file.file_id, { caption: file.file.file_name || "audio" });
      }

      await bot.sendMessage(
        chatId,
        `✅ "${target.caption || target.document?.file_name || "untitled"}" saved ✔️`
      );
    } else {
      await bot.sendMessage(chatId, `❌ File not recognized. Please retry.`);
    }

    return;
  }

  // =============================
  // 2️⃣ HANDLE PRIVATE CHAT
  // =============================
  if (chatId !== CHANNEL_ID && msg.chat.type === "private") {
    // Forward media uploads to channel
    const handleMedia = async (type, fileId, title) => {
      const sent = await bot[type](CHANNEL_ID, fileId, { caption: title });
      storeMessage(sent);
      await bot.sendMessage(chatId, `✅ ${type.replace("send", "")} "${title}" uploaded to the channel!`);
    };

    if (msg.document)
      return await handleMedia("sendDocument", msg.document.file_id, msg.document.file_name || "untitled");
    if (msg.video)
      return await handleMedia("sendVideo", msg.video.file_id, msg.video.file_name || "untitled");
    if (msg.audio)
      return await handleMedia("sendAudio", msg.audio.file_id, msg.audio.file_name || "untitled");

    // =============================
    // Search functionality
    // =============================
    if (msg.text) {
      const query = msg.text.trim().toLowerCase();
      const results = Object.values(messageStore).filter(m => m.caption.toLowerCase().includes(query));

      if (results.length === 0) {
        return bot.sendMessage(chatId, `❌ No files found matching "${msg.text}".`);
      }

      const keyboard = results.map(m => [{
        text: m.caption.length > 50 ? m.caption.slice(0, 50) + "…" : m.caption,
        callback_data: `${m.chatId}|${m.messageId}`
      }]);

      return bot.sendMessage(chatId, `🔎 Search results for "${msg.text}":`, {
        reply_markup: { inline_keyboard: keyboard }
      });
    }
  }
});

// === HANDLE CALLBACKS ===
bot.on("callback_query", async (cb) => {
  const chatId = cb.message.chat.id;
  const [sourceChat, messageId] = cb.data.split("|");

  const msg = messageStore[messageId];
  if (!msg) return bot.sendMessage(chatId, "❌ Message not found or not indexed.");

  for (const file of msg.files) {
    if (file.type === "document")
      await bot.sendDocument(chatId, file.file_id, { caption: file.name });
    if (file.type === "video")
      await bot.sendVideo(chatId, file.file_id, { caption: file.name });
    if (file.type === "audio")
      await bot.sendAudio(chatId, file.file_id, { caption: file.name });
  }

  if (msg.caption) bot.sendMessage(chatId, `📝 ${msg.caption}`);
});

// === START SERVER ===
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`📡 Webhook set: ${URL}/webhook`);
});

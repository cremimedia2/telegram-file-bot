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

// === CHANNEL ID ===
const CHANNEL_ID = -1003155277985; // Your storage channel ID

// === INIT BOT ===
const bot = new TelegramBot(TOKEN);
bot.setWebHook(`${URL}/webhook`);

// === INIT EXPRESS ===
const app = express();
app.use(express.json());

// === MESSAGE STORE ===
const messageStore = {};

// === WEBHOOK HANDLER ===
app.post("/webhook", (req, res) => {
  bot.processUpdate(req.body);
  res.sendStatus(200);
});

// === STORE MESSAGE FUNCTION ===
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
    "🎉 WELCOME TO SHAREGRACE MEDIA BOT!\n\nSend media files to me or tag me on a message in the group to index it."
  );
});

// === MAIN MESSAGE HANDLER ===
bot.on("message", async (msg) => {
  const chatId = msg.chat.id;

  // Ignore commands
  if (msg.text && msg.text.startsWith("/")) return;

  // 1️⃣ Handle bot mentions on a reply message in the group
  if (
    chatId !== CHANNEL_ID &&           // Only in the group (not channel)
    msg.reply_to_message &&            // Must be a reply
    msg.entities?.some(e => e.type === "mention" && msg.text.includes("@CREMIMEDIA_Bot"))
  ) {
    const target = msg.reply_to_message;

    if (target.document || target.video || target.audio) {
      storeMessage(target);

      // Forward copy to channel
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

      // Reply in group
      await bot.sendMessage(
        chatId,
        `✅ "${target.caption || target.document?.file_name || "untitled"}" saved ✔️`
      );
    } else {
      await bot.sendMessage(chatId, `❌ File not recognized. Please retry.`);
    }

    return;
  }

  // 2️⃣ Handle user uploads directly to bot → forward to channel
  if (chatId !== CHANNEL_ID) {
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
  }
});

// === START SERVER ===
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`📡 Webhook set: ${URL}/webhook`);
});

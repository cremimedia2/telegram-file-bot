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
const CHANNEL_ID = -1003155277985; // Your storage channel

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

  if (msg.document)
    files.push({ type: "document", file_id: msg.document.file_id, name: msg.document.file_name });

  if (msg.video)
    files.push({ type: "video", file_id: msg.video.file_id, name: msg.video.file_name || "video" });

  if (msg.audio)
    files.push({ type: "audio", file_id: msg.audio.file_id, name: msg.audio.file_name || "audio" });

  const caption = msg.caption || msg.text || "";

  messageStore[msg.message_id] = { chatId: msg.chat.id, messageId: msg.message_id, caption, files };

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
    "🎉 WELCOME TO SHAREGRACE MEDIA BOT!\n\n"

  );
});

// ==========================================================
// 1️⃣ INDEX ALL MEDIA IN GROUP
// ==========================================================
bot.on("message", async (msg) => {
  const chatId = msg.chat.id;

  // Ignore commands
  if (msg.text && msg.text.startsWith("/")) return;

  // Only handle group messages
  if (msg.chat.type.includes("group") && chatId !== CHANNEL_ID) {
    
    // Auto-index media
    if (msg.document || msg.video || msg.audio) {
      storeMessage(msg);
    }

    // Handle explicit tag @bot on a reply
    if (
      msg.reply_to_message &&
      msg.entities?.some(e => e.type === "mention" && msg.text.includes("@CREMIMEDIA_Bot"))
    ) {
      const target = msg.reply_to_message;

      if (target.document || target.video || target.audio) {
        // Forward to storage channel
        for (const file of target.document ? [{ type: "document", file: target.document }] :
                                           target.video ? [{ type: "video", file: target.video }] :
                                           target.audio ? [{ type: "audio", file: target.audio }] : []) {
          if (file.type === "document")
            await bot.sendDocument(CHANNEL_ID, file.file_id, { caption: file.file_name });
          if (file.type === "video")
            await bot.sendVideo(CHANNEL_ID, file.file_id, { caption: file.file_name || "video" });
          if (file.type === "audio")
            await bot.sendAudio(CHANNEL_ID, file.file_id, { caption: file.file_name || "audio" });
        }

        await bot.sendMessage(
          chatId,
          `✅ "${target.caption || target.document?.file_name || "untitled"}" saved ✔️`
        );
        storeMessage(target); // Index it after forwarding
      } else {
        await bot.sendMessage(chatId, `❌ File not recognized. Please retry.`);
      }
    }

    return; // Do nothing else in the group
  }

  // ==========================================================
  // 2️⃣ PRIVATE CHAT: SEARCH & UPLOAD
  // ==========================================================
  if (chatId !== CHANNEL_ID && msg.chat.type === "private") {

    // Handle media uploads → forward to storage channel
    const handleMedia = async (type, fileId, title) => {
      const sent = await bot[type](CHANNEL_ID, fileId, { caption: title });
      storeMessage(sent);

      await bot.sendMessage(chatId, `✅ ${type.replace("send", "")} "${title}" uploaded to the channel!`);
    };

    if (msg.document) return await handleMedia("sendDocument", msg.document.file_id, msg.document.file_name || "untitled");
    if (msg.video) return await handleMedia("sendVideo", msg.video.file_id, msg.video.file_name || "untitled");
    if (msg.audio) return await handleMedia("sendAudio", msg.audio.file_id, msg.audio.file_name || "untitled");

// PRIVATE CHAT SEARCH FUNCTION
if (msg.text) {
  const query = msg.text.trim().toLowerCase();

  const results = Object.values(messageStore).filter((m) => {
    // Split caption into words, remove punctuation
    const words = (m.caption || "")
      .toLowerCase()
      .replace(/[^\w\s]/g, "")
      .split(/\s+/);
    return words.includes(query); // Match whole word
  });

  if (results.length === 0) {
    return bot.sendMessage(chatId, `❌ No files found matching "${msg.text}".`);
  }

  const keyboard = results.map((m) => [
    {
      text: m.caption.length > 50 ? m.caption.slice(0, 50) + "…" : m.caption,
      callback_data: `${m.chatId}|${m.messageId}`,
    },
  ]);

  bot.sendMessage(chatId, `🔎 Search results for "${msg.text}":`, {
    reply_markup: { inline_keyboard: keyboard },
  });
}

  }
});

// ==========================================================
// 3️⃣ INLINE CALLBACK HANDLER
// ==========================================================
bot.on("callback_query", async (cb) => {
  const chatId = cb.message.chat.id;
  const [sourceChat, messageId] = cb.data.split("|");
  const msg = messageStore[messageId];

  if (!msg) return bot.sendMessage(chatId, "❌ Message not found or not indexed.");

  // Send all files
  for (const file of msg.files) {
    if (file.type === "document") await bot.sendDocument(chatId, file.file_id, { caption: file.name });
    if (file.type === "video") await bot.sendVideo(chatId, file.file_id, { caption: file.name });
    if (file.type === "audio") await bot.sendAudio(chatId, file.file_id, { caption: file.name });
  }

  if (msg.caption) bot.sendMessage(chatId, `📝 ${msg.caption}`);
});

// ==========================================================
// 4️⃣ START SERVER
// ==========================================================
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`📡 Webhook set: ${URL}/webhook`);
});

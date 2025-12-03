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

// === STORAGE CHANNEL ID ===
const CHANNEL_ID = -1003155277985;

// === INIT BOT ===
const bot = new TelegramBot(TOKEN);
bot.setWebHook(`${URL}/webhook`);

// === INIT EXPRESS ===
const app = express();
app.use(express.json());

// === MESSAGE STORE ===
const messageStore = {}; // messageId -> { chatId, messageId, caption, files }

// === AWAITING CAPTION STORE ===
const awaitingCaption = {}; // replyMessageId -> { chatId, fileMessage }

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
    "🎉 WELCOME TO SHAREGRACE MEDIA BOT!\n\nSend audio/video files or search the storage."
  );
});

// ==========================================================
// 1️⃣ GROUP MEDIA HANDLER
// ==========================================================
bot.on("message", async (msg) => {
  const chatId = msg.chat.id;

  // Ignore commands
  if (msg.text && msg.text.startsWith("/")) return;

  // ==========================================
  // Handle replies to bot asking for captions
  // ==========================================
  if (msg.reply_to_message && awaitingCaption[msg.reply_to_message.message_id]) {
    const { fileMessage } = awaitingCaption[msg.reply_to_message.message_id];
    const caption = msg.text.trim();

    if (!caption) {
      return bot.sendMessage(chatId, "❌ Caption cannot be empty. Please send a valid caption.");
    }

    // Save file with user-provided caption
    storeMessage({ ...fileMessage, caption });

    delete awaitingCaption[msg.reply_to_message.message_id];

    await bot.sendMessage(chatId, `✅ "${caption}" saved ✔️`);

    // Forward to storage channel
    for (const file of messageStore[fileMessage.message_id].files) {
      if (file.type === "document")
        await bot.sendDocument(CHANNEL_ID, file.file_id, { caption });
      if (file.type === "video")
        await bot.sendVideo(CHANNEL_ID, file.file_id, { caption });
      if (file.type === "audio")
        await bot.sendAudio(CHANNEL_ID, file.file_id, { caption });
    }

    return;
  }

  // ==========================================
  // Only handle group messages (not private)
  // ==========================================
  if (msg.chat.type.includes("group") && chatId !== CHANNEL_ID) {
    // Only index files with audio/video
    if (msg.document || msg.video || msg.audio) {
      if (!msg.caption) {
        // Ask user for a caption
        const prompt = await bot.sendMessage(
          chatId,
          "📌 Please send a caption for this file so it can be saved."
        );

        awaitingCaption[prompt.message_id] = { chatId, fileMessage: msg };
        return;
      } else {
        storeMessage(msg);

        // Forward to storage channel
        for (const file of msg.document ? [{ type: "document", file: msg.document }] :
          msg.video ? [{ type: "video", file: msg.video }] :
          msg.audio ? [{ type: "audio", file: msg.audio }] : []) {

          if (file.type === "document")
            await bot.sendDocument(CHANNEL_ID, file.file_id, { caption: msg.caption });
          if (file.type === "video")
            await bot.sendVideo(CHANNEL_ID, file.file_id, { caption: msg.caption });
          if (file.type === "audio")
            await bot.sendAudio(CHANNEL_ID, file.file_id, { caption: msg.caption });
        }

        console.log(`📤 Forwarded & indexed file from group: ${msg.message_id}`);
        return;
      }
    }

    // Handle bot tagged on a replied message
    if (msg.reply_to_message && msg.entities?.some(e => e.type === "mention" && msg.text.includes("@CREMIMEDIA_Bot"))) {
      const target = msg.reply_to_message;

      if (target.document || target.video || target.audio) {
        if (!target.caption) {
          const prompt = await bot.sendMessage(chatId, "📌 Please send a caption for this file so it can be saved.");
          awaitingCaption[prompt.message_id] = { chatId, fileMessage: target };
        } else {
          storeMessage(target);

          // Forward to storage channel
          for (const file of target.document ? [{ type: "document", file: target.document }] :
            target.video ? [{ type: "video", file: target.video }] :
            target.audio ? [{ type: "audio", file: target.audio }] : []) {

            if (file.type === "document")
              await bot.sendDocument(CHANNEL_ID, file.file_id, { caption: target.caption });
            if (file.type === "video")
              await bot.sendVideo(CHANNEL_ID, file.file_id, { caption: target.caption });
            if (file.type === "audio")
              await bot.sendAudio(CHANNEL_ID, file.file_id, { caption: target.caption });
          }

          await bot.sendMessage(chatId, `✅ "${target.caption}" saved ✔️`);
        }
      } else {
        await bot.sendMessage(chatId, `❌ File not recognized. Please retry.`);
      }

      return;
    }
  }

  // ==========================================================
  // 2️⃣ PRIVATE CHAT: SEARCH & UPLOAD
  // ==========================================================
  if (msg.chat.type === "private") {
    // Handle uploads → forward to storage channel
    const handleMedia = async (type, fileId, title) => {
      const sent = await bot[type](CHANNEL_ID, fileId, { caption: title });
      storeMessage(sent);

      await bot.sendMessage(msg.chat.id, `✅ ${type.replace("send", "")} "${title}" uploaded to the channel!`);
    };

    if (msg.document) return await handleMedia("sendDocument", msg.document.file_id, msg.document.file_name || "untitled");
    if (msg.video) return await handleMedia("sendVideo", msg.video.file_id, msg.video.file_name || "untitled");
    if (msg.audio) return await handleMedia("sendAudio", msg.audio.file_id, msg.audio.file_name || "untitled");

    // SEARCH FUNCTION
    if (msg.text) {
      const query = msg.text.trim().toLowerCase();

      const results = Object.values(messageStore).filter((m) => {
        const words = (m.caption || "")
          .toLowerCase()
          .replace(/[^\w\s]/g, "")
          .split(/\s+/);
        return words.includes(query);
      });

      if (results.length === 0) return bot.sendMessage(msg.chat.id, `❌ No files found matching "${msg.text}".`);

      const keyboard = results.map((m) => [{
        text: m.caption.length > 50 ? m.caption.slice(0, 50) + "…" : m.caption,
        callback_data: `${m.chatId}|${m.messageId}`
      }]);

      bot.sendMessage(msg.chat.id, `🔎 Search results for "${msg.text}":`, {
        reply_markup: { inline_keyboard: keyboard }
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

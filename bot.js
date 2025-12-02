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
const CHANNEL_ID = -1003155277985;

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

// === WELCOME MESSAGE ===
bot.onText(/\/start/, (msg) => {
  bot.sendMessage(
    msg.chat.id,
    "🎉 WELCOME TO SHAREGRACE MEDIA BOT!\n\nSend audio/video files or search the channel.\nYou can also *tag me on any message in the channel* to index it!"
  );
});

// === STORE MESSAGE FUNCTION ===
const storeMessage = (msg) => {
  if (!msg?.message_id || !msg?.chat) return;

  const files = [];

  if (msg.document)
    files.push({
      type: "document",
      file_id: msg.document.file_id,
      name: msg.document.file_name,
    });

  if (msg.video)
    files.push({
      type: "video",
      file_id: msg.video.file_id,
      name: msg.video.file_name || "video",
    });

  if (msg.audio)
    files.push({
      type: "audio",
      file_id: msg.audio.file_id,
      name: msg.audio.file_name || "audio",
    });

  const caption = msg.caption || msg.text || "";

  messageStore[msg.message_id] = {
    chatId: msg.chat.id,
    messageId: msg.message_id,
    caption,
    files,
  };

  console.log("📦 Indexed message:", msg.message_id, caption);
};

// ==========================================================
// 1️⃣ HANDLE TAGGING BOT ON CHANNEL POST
// ==========================================================
bot.on("channel_post", async (msg) => {
  // Auto-index any new messages in the channel
  storeMessage(msg);
  console.log("📥 New channel post indexed:", msg.message_id);
});

// ==========================================================
// 2️⃣ HANDLE MENTIONS / REPLY TAGS IN CHANNEL
// ==========================================================
bot.on("message", async (msg) => {
  if (
    msg.chat.id === CHANNEL_ID &&
    msg.reply_to_message &&
    msg.entities &&
    msg.entities.some(
      (e) =>
        e.type === "mention" &&
        msg.text.includes("@CREMIMEDIA_Bot")
    )
  ) {
    const target = msg.reply_to_message;

    console.log("📌 Bot was tagged. Indexing old message:", target.message_id);

    storeMessage(target);

    if (target.document || target.video || target.audio) {
      await bot.sendMessage(
        CHANNEL_ID,
        `✅ "${target.caption || target.document?.file_name || "untitled"}" saved ✔️`
      );
    } else {
      await bot.sendMessage(
        CHANNEL_ID,
        `❌ File not recognized. Please retry.`
      );
    }

    return;
  }
});

// ==========================================================
// 3️⃣ HANDLE USER UPLOADS TO BOT → FORWARD TO CHANNEL
// ==========================================================
bot.on("message", async (msg) => {
  const chatId = msg.chat.id;

  // Ignore commands
  if (msg.text && msg.text.startsWith("/")) return;

  // Ignore channel messages handled above
  if (chatId === CHANNEL_ID) return;

  // Forward media
  const handleMedia = async (type, fileId, title) => {
    const sent = await bot[type](CHANNEL_ID, fileId, { caption: title });
    storeMessage(sent);

    await bot.sendMessage(
      chatId,
      `✅ ${type.replace("send", "")} "${title}" uploaded to the channel!`
    );
  };

  if (msg.document)
    return await handleMedia("sendDocument", msg.document.file_id, msg.document.file_name || "untitled");

  if (msg.video)
    return await handleMedia("sendVideo", msg.video.file_id, msg.video.file_name || "untitled");

  if (msg.audio)
    return await handleMedia("sendAudio", msg.audio.file_id, msg.audio.file_name || "untitled");

  // Search functionality
  if (msg.text) {
    const query = msg.text.trim().toLowerCase();

    const results = Object.values(messageStore).filter((m) =>
      m.caption.toLowerCase().includes(query)
    );

    if (results.length === 0) {
      return bot.sendMessage(chatId, `❌ No files found matching "${msg.text}".`);
    }

    const keyboard = results.map((m) => [{
      text: m.caption.length > 50 ? m.caption.slice(0, 50) + "…" : m.caption,
      callback_data: `${m.chatId}|${m.messageId}`,
    }]);

    bot.sendMessage(chatId, `🔎 Search results for "${msg.text}":`, {
      reply_markup: { inline_keyboard: keyboard },
    });
  }
});

// ==========================================================
// 4️⃣ HANDLE INLINE CALLBACK
// ==========================================================
bot.on("callback_query", async (cb) => {
  const chatId = cb.message.chat.id;
  const [sourceChat, messageId] = cb.data.split("|");

  const msg = messageStore[messageId];

  if (!msg) {
    return bot.sendMessage(chatId, "❌ Message not found or not indexed.");
  }

  for (const file of msg.files) {
    if (file.type === "document")
      await bot.sendDocument(chatId, file.file_id, { caption: file.name });
    if (file.type === "video")
      await bot.sendVideo(chatId, file.file_id, { caption: file.name });
    if (file.type === "audio")
      await bot.sendAudio(chatId, file.file_id, { caption: file.name });
  }

  if (msg.caption) {
    bot.sendMessage(chatId, `📝 ${msg.caption}`);
  }
});

// ==========================================================
// 5️⃣ START SERVER
// ==========================================================
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`📡 Webhook set: ${URL}/webhook`);
});

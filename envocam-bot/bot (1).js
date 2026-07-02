const { Telegraf, Markup } = require('telegraf');
const fetch = require('node-fetch'); // Ensure fetch helper is available if Node version < 18
const db = require('./db');
const ai = require('./ai');

const BOT_TOKEN = process.env.BOT_TOKEN;
if (!BOT_TOKEN) {
  console.error("FATAL ERROR: BOT_TOKEN is missing!");
  process.exit(1);
}

const bot = new Telegraf(BOT_TOKEN, {
  handlerTimeout: Infinity // Allow long processes without timing out
});

const ADMIN_IDS = (process.env.ADMIN_IDS || "").split(',').map(id => id.trim()).filter(Boolean);

// Temporary state variables for current operational processes
const adminStates = {};

// Process level safety listeners
process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});
process.on('uncaughtException', (error) => {
  console.error('Uncaught Exception caught:', error);
});

// Helper: Uzbek/Russian auto-language detection rule
function detectLanguage(text) {
  if (/[\u049B\u0493\u04B3\u04AF]/i.test(text)) return 'uz'; // Unique Uzbek Cyrillic letters
  if (/o['`’ ]/i.test(text)) return 'uz'; // Uzbek latin apostrophe character check
  if ((text.match(/[\u0430-\u044F]/g) || []).length > 3) return 'ru'; // Standard Cyrillic density
  return 'uz';
}

// Download Telegram file helper
async function getTelegramFileAsBase64(fileId) {
  const fileInfo = await bot.telegram.getFile(fileId);
  const fileUrl = `https://api.telegram.org/file/bot${BOT_TOKEN}/${fileInfo.file_path}`;
  const response = await fetch(fileUrl);
  const arrayBuffer = await response.arrayBuffer();
  return Buffer.from(arrayBuffer).toString('base64');
}

// Helper logic: Simulates delayed, human-like interactive typing
async function sendHumanDelayedResponses(ctx, text, isImage = false, customChatId = null) {
  const targetId = customChatId || ctx.chat.id;
  const connectionId = ctx.businessConnectionId || ctx.update?.business_message?.business_connection_id;

  const minDelay = isImage ? 25000 : 15000;
  const maxDelay = isImage ? 70000 : 50000;
  const chosenDelay = Math.floor(Math.random() * (maxDelay - minDelay + 1)) + minDelay;

  // Set typing activity state
  try {
    if (connectionId) {
      await bot.telegram.sendChatAction(targetId, 'typing', { business_connection_id: connectionId });
    } else {
      await ctx.sendChatAction('typing');
    }
  } catch (err) {
    console.error('Error sending chat action:', err);
  }

  await new Promise(res => setTimeout(res, chosenDelay));

  // Explode thoughts via specified delimiter "###"
  const thoughts = text.split('###').map(p => p.trim()).filter(Boolean);

  for (const part of thoughts) {
    const opts = connectionId ? { business_connection_id: connectionId } : {};
    await bot.telegram.sendMessage(targetId, part, opts);
    await new Promise(res => setTimeout(res, 2000)); // Minor natural reading gap
  }
}

// Ensure the request has not been processed already (Deduplication check)
function isDuplicateMessage(messageId) {
  const config = db.getConfig();
  if (config.processedMessages.includes(messageId)) {
    return true;
  }
  config.processedMessages.push(messageId);
  // Keep log buffer bounded
  if (config.processedMessages.length > 10000) {
    config.processedMessages.shift();
  }
  db.saveConfig(config);
  return false;
}

// Handle registering business connection status updates
bot.on('business_connection', async (ctx) => {
  const conn = ctx.businessConnection;
  const config = db.getConfig();
  config.businessOwners[conn.user_id] = conn.id;
  db.saveConfig(config);
});


// ==========================================
// ADMIN INTERFACES & WORKFLOW
// ==========================================

function isAdmin(ctx) {
  const userId = String(ctx.from?.id);
  return ADMIN_IDS.includes(userId);
}

// Panel Base command
bot.command('panel', async (ctx) => {
  if (!isAdmin(ctx)) return;
  return showAdminMainMenu(ctx);
});

function showAdminMainMenu(ctx) {
  const keyboard = Markup.inlineKeyboard([
    [Markup.button.callback('📦 Modellar ro\'yxati', 'admin_models'), Markup.button.callback('➕ Yangi model qo\'shish', 'admin_add_model')],
    [Markup.button.callback('👥 Mijozlar soni', 'admin_cust_count'), Markup.button.callback('📢 Hammaga xabar', 'admin_broadcast')]
  ]);
  const text = "EnvoCam Admin boshqaruv paneli:";
  if (ctx.callbackQuery) {
    return ctx.editMessageText(text, keyboard);
  }
  return ctx.reply(text, keyboard);
}

// Handle interactions
bot.on('callback_query', async (ctx) => {
  if (!isAdmin(ctx)) return ctx.answerCbQuery("Ruxsat berilmagan!");
  const data = ctx.callbackQuery.data;

  if (data === 'admin_main') {
    adminStates[ctx.from.id] = null;
    return showAdminMainMenu(ctx);
  }

  if (data === 'admin_models') {
    const models = db.getModels();
    if (models.length === 0) {
      return ctx.editMessageText("Hozircha birorta ham model mavjud emas.", Markup.inlineKeyboard([
        [Markup.button.callback('⬅️ Orqaga', 'admin_main')]
      ]));
    }
    const buttons = models.map(m => [Markup.button.callback(m.name, `model_view:${m.name}`)]);
    buttons.push([Markup.button.callback('⬅️ Orqaga', 'admin_main')]);
    return ctx.editMessageText("Boshqarish uchun modelni tanlang:", Markup.inlineKeyboard(buttons));
  }

  if (data.startsWith('model_view:')) {
    const modelName = data.split(':')[1];
    const model = db.findModelByName(modelName);
    if (!model) return ctx.answerCbQuery("Model topilmadi");

    const imagesCount = model.images?.length || 0;
    const manualCount = model.manualImages?.length || 0;
    const appCount = model.appScreenshots?.length || 0;
    const videoCount = model.videoGuides?.length || 0;
    const hasVoice = model.reviewVoiceFileId ? "OK" : "Yo'q";
    const hasVideo = model.reviewVideoFileId ? "OK" : "Yo'q";

    const keyboard = Markup.inlineKeyboard([
      [Markup.button.callback(`Rasmlar (${imagesCount})`, `edit_cat:${model.name}:images`), Markup.button.callback(`Yo'riqnoma (${manualCount})`, `edit_cat:${model.name}:manualImages`)],
      [Markup.button.callback(`Ilova (${appCount})`, `edit_cat:${model.name}:appScreenshots`), Markup.button.callback(`Video (${videoCount})`, `edit_cat:${model.name}:videoGuides`)],
      [Markup.button.callback(`Sharh ovoz: ${hasVoice}`, `edit_cat:${model.name}:reviewVoiceFileId`), Markup.button.callback(`Sharh video: ${hasVideo}`, `edit_cat:${model.name}:reviewVideoFileId`)],
      [Markup.button.callback('❌ Kanalni uzish', `disconnect_chan:${model.name}`)],
      [Markup.button.callback('⬅️ Orqaga', 'admin_models')]
    ]);

    return ctx.editMessageText(`Model sahifasi: *${model.name}*\nKanal ID: \`${model.channelId || 'Ulanmagan'}\``, { parse_mode: 'Markdown', ...keyboard });
  }

  if (data.startsWith('edit_cat:')) {
    const [_, modelName, category] = data.split(':');
    const model = db.findModelByName(modelName);
    if (!model) return ctx.answerCbQuery();

    let count = 0;
    if (Array.isArray(model[category])) count = model[category].length;
    else if (model[category]) count = 1;

    adminStates[ctx.from.id] = { state: 'ADD_CONTENT', modelName, category };

    return ctx.editMessageText(
      `Model: *${model.name}* — Kategoriya: *${category}*\nHozirda elementlar soni: ${count}.\n\nYangi material qo'shish uchun uni shu yerga yuboring (Rasm, Video yoki Ovozli xabar).`,
      {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('✅ Tayyor', `model_view:${model.name}`)],
          [Markup.button.callback('⬅️ Orqaga', `model_view:${model.name}`)]
        ])
      }
    );
  }

  if (data.startsWith('disconnect_chan:')) {
    const modelName = data.split(':')[1];
    return ctx.editMessageText(`Haqiqatan ham *${modelName}* modelidan kanalni uzmoqchimisiz?`, {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('Ha, uzish', `confirm_disconn:${modelName}`)],
        [Markup.button.callback('Yo\'q, bekor qilish', `model_view:${modelName}`)]
      ])
    });
  }

  if (data.startsWith('confirm_disconn:')) {
    const modelName = data.split(':')[1];
    const models = db.getModels();
    const model = models.find(m => m.name === modelName);
    if (model) {
      model.channelId = null;
      db.saveModels(models);
    }
    return ctx.editMessageText(`Kanal muvaffaqiyatli uzildi.`, Markup.inlineKeyboard([
      [Markup.button.callback('⬅️ Modelga qaytish', `model_view:${modelName}`)]
    ]));
  }

  if (data === 'admin_add_model') {
    adminStates[ctx.from.id] = { state: 'AWAITING_MODEL_NAME' };
    return ctx.editMessageText("Iltimos, yangi model nomini kiriting:", Markup.inlineKeyboard([
      [Markup.button.callback('⬅️ Orqaga', 'admin_main')]
    ]));
  }

  if (data.startsWith('connect_method:')) {
    const [_, modelName, method] = data.split(':');
    if (method === 'chat_id') {
      adminStates[ctx.from.id] = { state: 'AWAITING_CHAT_ID', modelName };
      return ctx.editMessageText("Kanal yopiq bo'lsa, botni u yerga admin qilib qo'shing, keyin kanal Chat ID raqamini yuboring:", Markup.inlineKeyboard([
        [Markup.button.callback('⬅️ Orqaga', 'admin_models')]
      ]));
    } else {
      adminStates[ctx.from.id] = { state: 'AWAITING_CHANNEL_LINK', modelName };
      return ctx.editMessageText("Kanal ommaviy havolasini kiriting (Masalan, @kanal_user yoki link):", Markup.inlineKeyboard([
        [Markup.button.callback('⬅️ Orqaga', 'admin_models')]
      ]));
    }
  }

  if (data === 'admin_cust_count') {
    const customers = db.getCustomers();
    return ctx.editMessageText(`Tizimdagi jami mijozlar soni: ${customers.length} nafar.`, Markup.inlineKeyboard([
      [Markup.button.callback('⬅️ Orqaga', 'admin_main')]
    ]));
  }

  if (data === 'admin_broadcast') {
    adminStates[ctx.from.id] = { state: 'AWAITING_BROADCAST_TEXT' };
    return ctx.editMessageText("Barcha foydalanuvchilarga yuboriladigan xabar matnini kiriting:", Markup.inlineKeyboard([
      [Markup.button.callback('⬅️ Orqaga', 'admin_main')]
    ]));
  }

  if (data === 'confirm_broadcast') {
    const state = adminStates[ctx.from.id];
    if (!state || !state.text) return ctx.answerCbQuery("Xatolik yuz berdi");

    ctx.answerCbQuery("Yuborish boshlandi...");
    ctx.editMessageText("Xabar yuborilmoqda...");

    const customers = db.getCustomers();
    let sentCount = 0;

    for (const customer of customers) {
      try {
        if (customer.businessConnectionId) {
          // Send on behalf of business personal account
          await bot.telegram.sendMessage(customer.chatId, state.text, {
            business_connection_id: customer.businessConnectionId
          });
        } else {
          await bot.telegram.sendMessage(customer.chatId, state.text);
        }
        sentCount++;
      } catch (err) {
        console.error(`Failed to send broadcast to ${customer.chatId}:`, err);
      }
      // Anti-flood rate limit
      await new Promise(res => setTimeout(res, 2500));
    }

    adminStates[ctx.from.id] = null;
    return ctx.reply(`Xabar muvaffaqiyatli tarqatildi. Qabul qildi: ${sentCount}/${customers.length}`);
  }
});


// ==========================================
// TEXT MESSAGE ROUTING (ADMIN STATES & CLIENT QUERIES)
// ==========================================

bot.on(['message', 'business_message'], async (ctx) => {
  const msg = ctx.message || ctx.businessMessage;
  if (!msg) return;

  // Deduplication check
  if (isDuplicateMessage(msg.message_id)) return;

  // Rule: Do'kon egasining o'z xabarlari qayta ishlanmaydi
  const config = db.getConfig();
  const personalOwners = Object.keys(config.businessOwners);
  if (personalOwners.includes(String(msg.from?.id))) {
    return;
  }

  // Admin interaction state flow
  if (isAdmin(ctx) && adminStates[msg.from.id]) {
    const state = adminStates[msg.from.id];

    if (state.state === 'AWAITING_MODEL_NAME') {
      const name = msg.text.trim();
      const models = db.getModels();
      if (models.some(m => m.name.toLowerCase() === name.toLowerCase())) {
        return ctx.reply("Bunday model allaqachon mavjud. Boshqa nom kiriting:");
      }
      const newModel = {
        name,
        channelId: null,
        images: [],
        manualImages: [],
        appScreenshots: [],
        videoGuides: [],
        reviewVoiceFileId: null,
        reviewVideoFileId: null
      };
      models.push(newModel);
      db.saveModels(models);

      adminStates[msg.from.id] = { state: 'CHOOSE_CONN_METHOD', modelName: name };
      return ctx.reply(`Model yaratildi: *${name}*\nKanalni ulash usulini tanlang:`, {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('Havola orqali', `connect_method:${name}:link`), Markup.button.callback('Chat ID orqali', `connect_method:${name}:chat_id`)]
        ])
      });
    }

    if (state.state === 'AWAITING_CHANNEL_LINK' || state.state === 'AWAITING_CHAT_ID') {
      const input = msg.text.trim();
      let targetChatId = input;
      if (state.state === 'AWAITING_CHANNEL_LINK') {
        if (!input.startsWith('@') && !input.startsWith('-100')) {
          targetChatId = '@' + input;
        }
      }

      try {
        const chat = await ctx.telegram.getChat(targetChatId);
        const models = db.getModels();
        const mIdx = models.findIndex(m => m.name === state.modelName);
        if (mIdx !== -1) {
          models[mIdx].channelId = String(chat.id);
          db.saveModels(models);
          adminStates[msg.from.id] = null;
          return ctx.reply(`Kanal muvaffaqiyatli ulandi! Kanal ID: \`${chat.id}\``, {
            parse_mode: 'Markdown',
            ...Markup.inlineKeyboard([[Markup.button.callback('⬅️ Modelga o\'tish', `model_view:${state.modelName}`)]])
          });
        }
      } catch (e) {
        return ctx.reply(`Kanal topilmadi yoki bot u yerda admin emas. Qayta urinib ko'ring:`);
      }
    }

    if (state.state === 'ADD_CONTENT') {
      const models = db.getModels();
      const model = models.find(m => m.name === state.modelName);
      if (!model) return;

      const category = state.category;
      let saved = false;

      if (category === 'images' && msg.photo) {
        const fileId = msg.photo[msg.photo.length - 1].file_id;
        const caption = msg.caption || '';
        model.images.push({ file_id: fileId, caption });
        saved = true;
      } else if (category === 'videoGuides' && msg.video) {
        const fileId = msg.video.file_id;
        const caption = msg.caption || '';
        model.videoGuides.push({ file_id: fileId, caption });
        saved = true;
      } else if (category === 'reviewVoiceFileId' && msg.voice) {
        model.reviewVoiceFileId = msg.voice.file_id;
        saved = true;
      } else if (category === 'reviewVideoFileId' && msg.video) {
        model.reviewVideoFileId = msg.video.file_id;
        saved = true;
      } else if ((category === 'manualImages' || category === 'appScreenshots') && msg.photo) {
        const fileId = msg.photo[msg.photo.length - 1].file_id;
        const caption = msg.caption || '';
        await ctx.reply("Rasm yuklab olinmoqda va tahlil qilinmoqda (Claude OCR)...");
        try {
          const base64 = await getTelegramFileAsBase64(fileId);
          const ocrText = await ai.extractTextFromImage(base64);
          model[category].push({
            file_id: fileId,
            caption,
            extractedText: ocrText
          });
          saved = true;
        } catch (err) {
          return ctx.reply("Rasmdan matn ajratishda xatolik yuz berdi. Iltimos qayta urining.");
        }
      }

      if (saved) {
        db.saveModels(models);
        return ctx.reply("Material muvaffaqiyatli saqlandi! Qo'shishni davom ettirishingiz yoki 'Tayyor' tugmasini bosishingiz mumkin.");
      } else {
        return ctx.reply("Yuborilgan format ushbu kategoriya uchun mos emas.");
      }
    }

    if (state.state === 'AWAITING_BROADCAST_TEXT') {
      const text = msg.text.trim();
      adminStates[msg.from.id] = { state: 'CONFIRM_BROADCAST', text };
      return ctx.reply(`Barcha foydalanuvchilarga yuborishni tasdiqlaysizmi?\n\n*Xabar:* \n${text}`, {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('Ha, yuborish', 'confirm_broadcast'), Markup.button.callback('Bekor qilish', 'admin_main')]
        ])
      });
    }

    return; // Block execution
  }

  // ==========================================
  // CUSTOMER CHAT FLOW INTERACTION
  // ==========================================

  const customerChatId = msg.chat.id;
  let customer = db.getCustomer(customerChatId);

  // Initialize customer entry if new
  if (!customer) {
    customer = {
      chatId: String(customerChatId),
      language: 'uz',
      lastModelName: null,
      businessConnectionId: msg.business_connection_id || null,
      hasGreeted: false,
      askedForPhotoOnce: false,
      awaitingConnectionConfirm: false,
      connectionFollowupSentAt: null,
      reviewSent: false,
      lastProcessedMessageId: msg.message_id,
      firstSeen: new Date().toISOString(),
      lastSeen: new Date().toISOString(),
      lastVideoSentAt: null
    };
  } else {
    customer.lastSeen = new Date().toISOString();
    customer.lastProcessedMessageId = msg.message_id;
    if (msg.business_connection_id) {
      customer.businessConnectionId = msg.business_connection_id;
    }
  }

  // Handle Photo message types
  if (msg.photo) {
    const fileId = msg.photo[msg.photo.length - 1].file_id;
    await ctx.sendChatAction('typing');

    const base64 = await getTelegramFileAsBase64(fileId);
    const models = db.getModels();
    const modelNames = models.map(m => m.name);

    const result = await ai.matchPhotoToModel(base64, modelNames);

    if (result.status === 'matched') {
      const selectedModel = db.findModelByName(result.model);
      if (selectedModel) {
        customer.lastModelName = selectedModel.name;
        customer.awaitingConnectionConfirm = true;
        db.saveCustomer(customer);

        // Confirm identity message
        const confirmText = customer.language === 'uz'
          ? `Kamerangiz modeli muvaffaqiyatli aniqlandi: ${selectedModel.name} ### Quyida sizga birinchi video-yo'riqnomani yuboraman ### Uni diqqat bilan tomosha qilib, kamerani ulashga harakat qilib ko'ring.`
          : `Модель вашей камеры успешно определена: ${selectedModel.name} ### Ниже я отправлю вам первую видеоинструкцию ### Пожалуйста, внимательно посмотрите ее и попробуйте подключить камеру.`;

        await sendHumanDelayedResponses(ctx, confirmText, true);

        // Check and send video asset if setup guides exist
        if (selectedModel.videoGuides && selectedModel.videoGuides.length > 0) {
          const guide = selectedModel.videoGuides[0];
          const opts = customer.businessConnectionId ? { business_connection_id: customer.businessConnectionId } : {};
          if (guide.caption) opts.caption = guide.caption;

          await bot.telegram.sendVideo(customerChatId, guide.file_id, opts);

          customer.lastVideoSentAt = new Date().toISOString();
          db.saveCustomer(customer);
        }
        return;
      }
    }

    if (result.status === 'unclear') {
      if (!customer.askedForPhotoOnce) {
        customer.askedForPhotoOnce = true;
        db.saveCustomer(customer);
        const replyText = customer.language === 'uz'
          ? "Yorug' joyda, model yozuvi ko'rinadigan qilib qayta rasm yuboring"
          : "Пожалуйста, отправьте фото еще раз при хорошем освещении, чтобы было видно название модели";
        return sendHumanDelayedResponses(ctx, replyText, true);
      }
    }

    // fallback / no_match
    const noMatchText = customer.language === 'uz'
      ? "Bu kamera uchun qo'llanma tez orada tayyorlanadi, biroz sabr qiling"
      : "Инструкция для этой камеры скоро будет готова, пожалуйста, наберитесь терпения";
    return sendHumanDelayedResponses(ctx, noMatchText, true);
  }

  // Handle Voice message types
  if (msg.voice) {
    const replyText = customer.language === 'uz'
      ? "Kechirasiz, hozircha matn ko'rinishida yozsangiz tushunarli bo'ladi."
      : "Извините, на данный момент мне удобнее, если вы напишете текстом.";
    return sendHumanDelayedResponses(ctx, replyText, false);
  }

  // Handle Text message types
  if (msg.text) {
    const text = msg.text.trim();
    const detectedLang = detectLanguage(text);
    customer.language = detectedLang;

    // Fast-track hook checks for specific successful connections
    const lowercaseText = text.toLowerCase();
    const successKeywords = ['uladim', 'boldi', 'bo\'ldi', 'ishlayapti', 'rahmat', 'подключил', 'работает', 'спасибо'];
    const matchesSuccess = successKeywords.some(kw => lowercaseText.includes(kw));

    if (matchesSuccess && customer.lastModelName) {
      const model = db.findModelByName(customer.lastModelName);
      if (model && model.reviewVoiceFileId) {
        const textReply = customer.language === 'uz'
          ? "Sizga foydali bo'lganidan xursandman! ### Quyidagi ovozli xabarni tinglang va video sharhni ko'ring."
          : "Рад, что вам это помогло! ### Пожалуйста, прослушайте голосовое сообщение и посмотрите видеообзор.";
        await sendHumanDelayedResponses(ctx, textReply, false);

        const opts = customer.businessConnectionId ? { business_connection_id: customer.businessConnectionId } : {};
        await bot.telegram.sendVoice(customerChatId, model.reviewVoiceFileId, opts);
        if (model.reviewVideoFileId) {
          await bot.telegram.sendVideo(customerChatId, model.reviewVideoFileId, opts);
        }
        customer.reviewSent = true;
        db.saveCustomer(customer);
        return;
      }
    }

    // Determine Intent with Claude
    const analysis = await ai.detectUserIntent(text);

    if (analysis.intent === 'gratitude') {
      const resp = customer.language === 'uz' ? "Arzimaydi. Savol bo'lsa yozing." : "Не за что. Если возникнут вопросы, пишите.";
      await sendHumanDelayedResponses(ctx, resp, false);
      return;
    }

    if (analysis.intent === 'cannot_send_photo') {
      const resp = customer.language === 'uz'
        ? "Tushunarli, kamerangiz qaysi model ekanini so'z bilan yozing"
        : "Понимаю, напишите словами, какая у вас модель камеры";
      await sendHumanDelayedResponses(ctx, resp, false);
      return;
    }

    // Process Q&A Question intent
    let kbText = "";
    if (customer.lastModelName) {
      const model = db.findModelByName(customer.lastModelName);
      if (model) {
        kbText += `Model: ${model.name}\n`;
        model.manualImages.forEach(m => { kbText += `Yo'riqnoma: ${m.extractedText}\n`; });
        model.appScreenshots.forEach(s => { kbText += `Ilova: ${s.extractedText}\n`; });
      }
    } else {
      // General overview mapping fallback
      const models = db.getModels();
      kbText = `Mavjud kamera modellarimiz: ${models.map(m => m.name).join(', ')}`;
    }

    const includeGreeting = !customer.hasGreeted;
    const responseText = await ai.generateCustomerResponse(text, kbText, customer.language, includeGreeting);

    if (includeGreeting) {
      customer.hasGreeted = true;
      db.saveCustomer(customer);
    }

    await sendHumanDelayedResponses(ctx, responseText, false);

    // Prompt for Photo on first text interaction if model isn't set yet
    if (!customer.lastModelName && !customer.askedForPhotoOnce) {
      customer.askedForPhotoOnce = true;
      db.saveCustomer(customer);
      const photoPrompt = customer.language === 'uz'
        ? "Kamerangiz modelini aniqroq aniqlashim uchun, uning rasmini yubora olasizmi?"
        : "Чтобы я мог точнее определить модель вашей камеры, не могли бы вы прислать ее фото?";
      await sendHumanDelayedResponses(ctx, photoPrompt, false);
    }
  }
});


// ==========================================
// BACKGROUND AUTOMATED CRON TASKS
// ==========================================

// Checks background processes state queues every 15 minutes
setInterval(async () => {
  try {
    const customers = db.getCustomers();
    const now = Date.now();

    for (const customer of customers) {
      // Check 1: Inactive Video guide followup checker (1 hour)
      if (customer.lastVideoSentAt && !customer.connectionFollowupSentAt) {
        const videoSentTime = new Date(customer.lastVideoSentAt).getTime();
        const differenceHours = (now - videoSentTime) / (1000 * 60 * 60);

        if (differenceHours >= 1.0) {
          const checkText = customer.language === 'uz'
            ? "Kamerani ulay oldingizmi? Qiyinchilik bo'lsa yozing"
            : "У вас получилось подключить камеру? Если возникли трудности, напишите";

          const opts = customer.businessConnectionId ? { business_connection_id: customer.businessConnectionId } : {};
          await bot.telegram.sendMessage(customer.chatId, checkText, opts);

          customer.connectionFollowupSentAt = new Date().toISOString();
          db.saveCustomer(customer);
        }
      }

      // Check 2: Automatic Review Request Dispatcher (10 hours elapsed context)
      if (!customer.reviewSent && customer.lastModelName) {
        const lastMessageTime = new Date(customer.lastSeen).getTime();
        const differenceHours = (now - lastMessageTime) / (1000 * 60 * 60);

        if (differenceHours >= 10.0) {
          const model = db.findModelByName(customer.lastModelName);
          if (model && model.reviewVoiceFileId) {
            const opts = customer.businessConnectionId ? { business_connection_id: customer.businessConnectionId } : {};

            await bot.telegram.sendVoice(customer.chatId, model.reviewVoiceFileId, opts);
            if (model.reviewVideoFileId) {
              await bot.telegram.sendVideo(customer.chatId, model.reviewVideoFileId, opts);
            }

            customer.reviewSent = true;
            db.saveCustomer(customer);
          }
        }
      }
    }
  } catch (err) {
    console.error('Error running background loop job tasks:', err);
  }
}, 15 * 60 * 1000);


// ==========================================
// TELEGRAM UPDATE INSTANTIATION
// ==========================================

bot.launch().then(() => {
  console.log("EnvoCam Telegram Bot successfully connected and launched.");
});

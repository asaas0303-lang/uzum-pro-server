// bot.js — EnvoCam yordamchi bot
// Bosqich 1: /yangi_model buyrug'i orqali model yaratish + kanalni unga bog'lash
//            va kanaldagi postlarni avtomatik o'qib bazaga saqlash.
// Keyingi bosqichda: Business xabarlarga AI javob qismi qo'shiladi.

require('dotenv').config();
const { Telegraf } = require('telegraf');
const db = require('./db');
const ai = require('./ai');
const queueLib = require('./queue');
const { startReviewScheduler } = require('./reviewScheduler');

const BOT_TOKEN = process.env.BOT_TOKEN;
if (!BOT_TOKEN) {
  console.error('XATOLIK: BOT_TOKEN topilmadi. .env faylida yoki Railway Variables ichida belgilang.');
  process.exit(1);
}

const bot = new Telegraf(BOT_TOKEN, { handlerTimeout: Infinity });

// Dastur kutilmagan xatolik tufayli "yiqilib" qayta ishga tushib qolmasligi uchun —
// bu xato bo'lganda mijozga ikki marta bir xil xabar yuborilishiga olib kelardi.
process.on('unhandledRejection', (err) => {
  console.error('Ushlanmagan xatolik (unhandledRejection):', err);
});
process.on('uncaughtException', (err) => {
  console.error('Ushlanmagan xatolik (uncaughtException):', err);
});

// Faqat sizga (admin) ruxsat berish uchun — o'z Telegram ID'ingizni shu yerga yozasiz.
// ID'ingizni bilmasangiz, botga /id buyrug'ini yuborib aniqlab olasiz.
const ADMIN_IDS = (process.env.ADMIN_IDS || '').split(',').map(s => s.trim()).filter(Boolean);

function isAdmin(ctx) {
  if (ADMIN_IDS.length === 0) return true; // hali sozlanmagan bo'lsa, hammaga ruxsat (boshlanishda)
  return ADMIN_IDS.includes(String(ctx.from.id));
}

// Suhbat holatini saqlash uchun oddiy xotira (kichik loyiha uchun yetarli)
// sessions[userId] = { step: 'waiting_name' | 'waiting_link', modelName: '...' }
const sessions = {};

bot.command('id', (ctx) => {
  ctx.reply(`Sizning Telegram ID: ${ctx.from.id}`);
});

bot.command('yangi_model', (ctx) => {
  if (!isAdmin(ctx)) return;
  sessions[ctx.from.id] = { step: 'waiting_name' };
  ctx.reply('📷 Yangi model qo\'shamiz.\n\nModel nomini yuboring (masalan: EnvoCam Mini-X1):');
});

bot.command('modellar', (ctx) => {
  if (!isAdmin(ctx)) return;
  const models = db.getAllModels();
  const names = Object.keys(models);
  if (names.length === 0) {
    return ctx.reply('Hozircha hech qanday model qo\'shilmagan.');
  }
  let text = '📋 Mavjud modellar:\n\n';
  for (const name of names) {
    const m = models[name];
    text += `• ${name}\n   Kanal: ${m.channelId ? '✅ ulangan' : '❌ ulanmagan'}\n   Rasmlar: ${m.images.length}, Yo'riqnoma: ${(m.manualImages || []).length}, Ilova skrinshot: ${m.appScreenshots.length}, Matn: ${m.textGuides.length}, Video: ${m.videoGuides.length}\n   Sharh ovoz: ${m.reviewVoiceFileId ? '✅' : '❌'}, Sharh video: ${m.reviewVideoFileId ? '✅' : '❌'}\n\n`;
  }
  ctx.reply(text);
});

// Taklif-havola (t.me/+...) orqali kanalni topib bo'lmagan hollar uchun —
// kanal Chat ID'sini to'g'ridan-to'g'ri qo'lda kiritib bog'lash imkoni.
// Chat ID'ni topish uchun: kanalga bitta post yuboring, keyin Railway
// Deploy Logs'da "Bog'lanmagan kanaldan post keldi: -100..." qatorini ko'rasiz.
bot.command('kanal_bog_la', (ctx) => {
  if (!isAdmin(ctx)) return;
  const parts = ctx.message.text.split(' ').filter(Boolean);
  // /kanal_bog_la Model Nomi -1001234567890  -> oxirgisi ID, qolgani model nomi
  if (parts.length < 3) {
    return ctx.reply(
      '❗ Foydalanish: /kanal_bog_la Model Nomi -1001234567890\n\n' +
      '(Model nomidan keyin, oxiriga kanal Chat ID\'sini yozing)'
    );
  }
  const chatId = parts[parts.length - 1];
  const modelName = parts.slice(1, -1).join(' ');

  if (!/^-?\d+$/.test(chatId)) {
    return ctx.reply('❌ Oxirgi qism raqamli Chat ID bo\'lishi kerak (masalan: -1001234567890).');
  }

  db.linkChannelToModel(chatId, modelName);
  ctx.reply(`🎉 "${modelName}" modeli ${chatId} kanaliga bog'landi.\n\nEndi kanalga ma'lumot joylashtirishni boshlang.`);
});

// Oddiy matn xabarlarni boshqarish (suhbat oqimi uchun)
bot.on('text', async (ctx, next) => {
  const session = sessions[ctx.from.id];
  if (!session) return next();

  if (session.step === 'waiting_name') {
    const modelName = ctx.message.text.trim();
    db.createModel(modelName);
    session.modelName = modelName;
    session.step = 'waiting_link';
    return ctx.reply(
      `✅ Model nomi saqlandi: "${modelName}"\n\n` +
      `Endi shu modelga tegishli kanal havolasini yuboring.\n\n` +
      `⚠️ Eslatma: bot kanalga admin qilib qo'shilgan bo'lishi shart, va bu xabarni yuborgandan KEYIN kanalga ma'lumot joylashtiring (eski postlarni bot ko'rmaydi).`
    );
  }

  if (session.step === 'waiting_link') {
    const link = ctx.message.text.trim();
    let chatRef = link;
    const match = link.match(/t\.me\/(.+)$/);
    if (match) chatRef = '@' + match[1];
    if (!chatRef.startsWith('@') && !chatRef.startsWith('-')) chatRef = '@' + chatRef;

    try {
      const chat = await ctx.telegram.getChat(chatRef);
      db.linkChannelToModel(chat.id, session.modelName);
      delete sessions[ctx.from.id];
      return ctx.reply(
        `🎉 Tayyor! "${session.modelName}" modeli kanal bilan bog'landi.\n\n` +
        `Endi kanalga rasm, video, matn joylashtirishni boshlang — bot ularni avtomatik o'qiydi.\n\n` +
        `Eslatma: yopiq (private) kanal bo'lsa, ba'zan getChat bot qo'shilgandan keyin ham xato berishi mumkin — agar shu xabar chiqsa, kanalda biror narsa post qilib ko'ring, keyin qaytadan urinib ko'ramiz.`
      );
    } catch (err) {
      console.error(err);
      return ctx.reply(
        '❌ Kanalni topa olmadim. Tekshiring:\n' +
        '1) Bot shu kanalga admin qilib qo\'shilganmi?\n' +
        '2) Havola to\'g\'ri yuborilganmi?\n\n' +
        'Qaytadan kanal havolasini yuboring, yoki /yangi_model bilan qaytadan boshlang.'
      );
    }
  }

  return next();
});

// Kanaldagi har bir yangi post kelganda — qaysi modelga tegishli ekanini aniqlab,
// turi bo'yicha bazaga saqlaymiz. Caption'dagi teglar orqali aniq ajratiladi:
// RASM: / YORIQNOMA: / VIDEO: / ILOVA: / SHARH: / SHARH VIDEO:
bot.on('channel_post', async (ctx) => {
  const post = ctx.channelPost;
  const channelId = post.chat.id;
  const model = db.getModelByChannelId(channelId);

  if (!model) {
    console.log(`Bog'lanmagan kanaldan post keldi: ${channelId} — e'tiborga olinmadi.`);
    return;
  }

  const caption = (post.caption || post.text || '').trim();
  const lowerCaption = caption.toLowerCase();

  try {
    if (post.photo && post.photo.length > 0) {
      const fileId = post.photo[post.photo.length - 1].file_id;

      const isManual = lowerCaption.includes('yoriqnoma') || lowerCaption.includes('yo\'riqnoma') || lowerCaption.includes('qollanma rasm');
      const isApp = lowerCaption.includes('ilova') || lowerCaption.includes('skrinshot') || lowerCaption.includes('skreenshot');

      if (isManual || isApp) {
        // Rasm ichidagi matnni bir martalik tahlil qilib bazaga saqlaymiz
        let extractedText = '';
        try {
          const fileLink = await ctx.telegram.getFileLink(fileId);
          const imageRes = await fetch(fileLink.href);
          const buffer = await imageRes.arrayBuffer();
          const base64Image = Buffer.from(buffer).toString('base64');
          extractedText = await ai.extractTextFromImage({ base64Image, mediaType: 'image/jpeg', hint: caption });
        } catch (err) {
          console.error('Rasm matnini ajratishda xatolik:', err.message);
        }

        if (isManual) {
          db.addManualImageToModel(model.name, fileId, caption, extractedText);
          console.log(`[${model.name}] yo'riqnoma rasmi saqlandi (matn ajratildi)`);
        } else {
          db.addAppScreenshotToModel(model.name, fileId, caption, extractedText);
          console.log(`[${model.name}] ilova skrinshoti saqlandi (matn ajratildi)`);
        }
      } else {
        db.addImageToModel(model.name, fileId, caption);
        console.log(`[${model.name}] tashqi ko'rinish rasmi saqlandi`);
      }
    } else if (post.video) {
      if (lowerCaption.includes('sharh video') || lowerCaption.includes('sharh qollanma')) {
        db.setReviewVideo(model.name, post.video.file_id);
        console.log(`[${model.name}] sharh-video qo'llanmasi saqlandi`);
      } else {
        db.addVideoGuideToModel(model.name, post.video.file_id, caption);
        console.log(`[${model.name}] video qo'llanma saqlandi`);
      }
    } else if (post.voice || post.audio) {
      const fileId = post.voice ? post.voice.file_id : post.audio.file_id;
      if (lowerCaption.includes('sharh')) {
        db.setReviewVoice(model.name, fileId);
        console.log(`[${model.name}] sharh so'rash ovozi saqlandi`);
      }
    } else if (post.text) {
      db.addTextGuideToModel(model.name, post.text, '');
      console.log(`[${model.name}] matnli qo'llanma saqlandi`);
    }
  } catch (err) {
    console.error('Post saqlashda xatolik:', err);
  }
});

// Business ulanish o'rnatilganda — egasining (sizning) user ID'sini saqlaymiz,
// shunda keyinchalik sizning o'z xabarlaringizni mijoz xabari deb aralashtirmaymiz.
bot.on('business_connection', (ctx) => {
  const conn = ctx.update.business_connection;
  console.log('Business ulanish:', JSON.stringify(conn));
  try {
    if (conn.user && conn.id) {
      db.setBusinessOwner(conn.id, conn.user.id);
    }
  } catch (err) {
    console.error('Business owner saqlashda xatolik:', err);
  }
});

bot.on('business_message', async (ctx) => {
  const msg = ctx.update.business_message;

  try {
    // Agar bu xabarni SIZ (do'kon egasi) o'zingiz business ilovasi orqali
    // yozgan bo'lsangiz — buni mijoz xabari deb hisoblamaymiz, AI javob bermaydi.
    const ownerId = db.getBusinessOwner(msg.business_connection_id);
    if (ownerId && String(msg.from.id) === String(ownerId)) {
      return;
    }

    const from = msg.from;
    const existingCustomer = db.getCustomer(msg.chat.id);

    // Telegram ba'zan bir xabarni qaytadan yuborishi mumkin (masalan dastur
    // qayta ishga tushganda) — shu xabarni ikkinchi marta qayta ishlamaymiz.
    if (existingCustomer && existingCustomer.lastProcessedMessageId === msg.message_id) {
      return;
    }

    const language = ai.detectLanguage(msg.text || msg.caption || '') || (existingCustomer && existingCustomer.language) || 'uz';

    const customer = db.upsertCustomer({
      chatId: msg.chat.id,
      firstName: from.first_name,
      lastName: from.last_name,
      username: from.username,
      businessConnectionId: msg.business_connection_id,
      language,
      lastProcessedMessageId: msg.message_id
    });

    if (msg.photo && msg.photo.length > 0) {
      await handleCustomerPhoto(ctx, msg, customer);
      return;
    }

    if (msg.voice) {
      await handleCustomerVoice(ctx, msg, customer);
      return;
    }

    if (msg.text) {
      await handleCustomerText(ctx, msg, customer);
      return;
    }
  } catch (err) {
    console.error('Business xabarni qayta ishlashda xatolik:', err);
  }
});

// Mijoz kamera rasmi yuborganda: modelni aniqlab, video qo'llanma (caption bilan
// birga) yuboradi. Agar rasm xira bo'lsa qayta so'raydi, agar model bazada
// umuman yo'q bo'lsa (hali tayyorlanmagan) — shu haqida xabar beradi.
async function handleCustomerPhoto(ctx, msg, customer) {
  const models = db.getAllModels();
  const modelNames = Object.keys(models);
  if (modelNames.length === 0) return;

  const fileId = msg.photo[msg.photo.length - 1].file_id;
  const fileLink = await ctx.telegram.getFileLink(fileId);
  const imageRes = await fetch(fileLink.href);
  const buffer = await imageRes.arrayBuffer();
  const base64Image = Buffer.from(buffer).toString('base64');

  const { status, modelName } = await ai.identifyModelFromImage({
    base64Image,
    mediaType: 'image/jpeg',
    modelNames
  });

  const humanDelay = queueLib.randomDelay(25000, 70000);
  const hasGreeted = customer.hasGreeted;

  if (status === 'unclear') {
    const text = await ai.craftUnclearImageMessage({ language: customer.language, hasGreeted });
    await queueLib.enqueue(() => sendBiz(ctx, msg, { text }), { humanDelayMs: humanDelay });
    db.upsertCustomer({ chatId: msg.chat.id, hasGreeted: true, businessConnectionId: msg.business_connection_id });
    return;
  }

  if (status === 'no_match' || !modelName || !models[modelName]) {
    const text = await ai.craftModelNotReadyMessage({ language: customer.language, hasGreeted });
    await queueLib.enqueue(() => sendBiz(ctx, msg, { text }), { humanDelayMs: humanDelay });
    db.upsertCustomer({ chatId: msg.chat.id, hasGreeted: true, businessConnectionId: msg.business_connection_id });
    return;
  }

  const model = models[modelName];

  // Agar shu model uchun hali video qo'llanma tayyor bo'lmasa
  if (!model.videoGuides || model.videoGuides.length === 0) {
    const text = await ai.craftModelNotReadyMessage({ language: customer.language, hasGreeted });
    await queueLib.enqueue(() => sendBiz(ctx, msg, { text }), { humanDelayMs: humanDelay });
    db.upsertCustomer({ chatId: msg.chat.id, hasGreeted: true, lastModelName: modelName, businessConnectionId: msg.business_connection_id });
    return;
  }

  db.upsertCustomer({
    chatId: msg.chat.id,
    lastModelName: modelName,
    businessConnectionId: msg.business_connection_id,
    awaitingConnectionConfirm: true,
    connectionFollowupSentAt: null
  });

  await queueLib.enqueue(async () => {
    const greetPrefix = !hasGreeted
      ? (customer.language === 'ru' ? 'Здравствуйте. ' : 'Assalomu alaykum. ')
      : '';
    const confirmText = customer.language === 'ru'
      ? `${greetPrefix}Это камера ${modelName}. Сейчас отправлю видео-инструкцию.`
      : `${greetPrefix}Bu — ${modelName} kamerasi. Hozir video qo'llanmani yuboraman.`;
    await sendBiz(ctx, msg, { text: confirmText });
    await new Promise(r => setTimeout(r, queueLib.randomDelay(1000, 2000)));

    const video = model.videoGuides[0];
    await sendBiz(ctx, msg, { video: video.file_id, caption: video.caption || '' });
  }, { humanDelayMs: humanDelay });

  db.upsertCustomer({ chatId: msg.chat.id, hasGreeted: true, businessConnectionId: msg.business_connection_id });
}

async function handleCustomerText(ctx, msg, customer) {
  const models = db.getAllModels();
  const modelName = customer.lastModelName;
  const model = modelName ? models[modelName] : null;
  const hasGreeted = customer.hasGreeted;
  const humanDelay = queueLib.randomDelay(15000, 50000);

  // Mijoz "ulay oldim" / mamnunlik bildirishi mumkin — shunda sharhni so'raymiz
  if (model && customer.awaitingConnectionConfirm) {
    const success = await ai.detectConnectionSuccess({ text: msg.text, language: customer.language });
    if (success) {
      await sendReviewRequest(ctx, msg, customer, model);
      db.upsertCustomer({ chatId: msg.chat.id, awaitingConnectionConfirm: false, businessConnectionId: msg.business_connection_id });
      return;
    }
  }

  if (!model) {
    const intent = await ai.classifyCustomerIntent({ text: msg.text });

    if (intent === 'gratitude') {
      const text = customer.language === 'ru'
        ? 'Пожалуйста. Если будут вопросы, пишите в любое время.'
        : 'Arzimaydi. Savol bo\'lsa, istalgan vaqtda yozing.';
      await queueLib.enqueue(() => sendBiz(ctx, msg, { text }), { humanDelayMs: humanDelay });
      db.upsertCustomer({ chatId: msg.chat.id, hasGreeted: true, businessConnectionId: msg.business_connection_id });
      return;
    }

    // Mijoz aniq savol so'rayapti (model noma'lum bo'lsa ham) — boshqa
    // kameralar uchun yozilgan umumiy ma'lumotdan foydalanib, real javob
    // beramiz, va shu bilan birga rasmni ham (faqat bir marta) so'raymiz.
    const allModels = Object.values(models);
    const parts = await ai.answerGeneralCameraQuestion({
      question: msg.text,
      allModels,
      language: customer.language,
      hasGreeted,
      shouldAskForPhoto: !customer.askedForPhotoOnce
    });

    await queueLib.enqueue(async () => {
      for (const part of parts) {
        await sendBiz(ctx, msg, { text: part });
        if (parts.length > 1) await new Promise(r => setTimeout(r, queueLib.randomDelay(1200, 2500)));
      }
    }, { humanDelayMs: humanDelay });

    db.upsertCustomer({ chatId: msg.chat.id, hasGreeted: true, askedForPhotoOnce: true, businessConnectionId: msg.business_connection_id });
    return;
  }

  const parts = await ai.answerCustomerQuestion({
    question: msg.text,
    model,
    language: customer.language,
    hasGreeted
  });

  await queueLib.enqueue(async () => {
    for (const part of parts) {
      await sendBiz(ctx, msg, { text: part });
      if (parts.length > 1) await new Promise(r => setTimeout(r, queueLib.randomDelay(1200, 2500)));
    }
  }, { humanDelayMs: humanDelay });

  db.upsertCustomer({ chatId: msg.chat.id, hasGreeted: true, businessConnectionId: msg.business_connection_id });
}

async function handleCustomerVoice(ctx, msg, customer) {
  const humanDelay = queueLib.randomDelay(15000, 40000);
  const text = customer.language === 'ru'
    ? 'Простите, сейчас мне удобнее понять текстовое сообщение — не могли бы вы написать словами?'
    : 'Kechirasiz, hozircha matn ko\'rinishida yozsangiz menga tushunarliroq bo\'lardi.';
  await queueLib.enqueue(() => sendBiz(ctx, msg, { text }), { humanDelayMs: humanDelay });
}

// Sharh so'rash (ovozli xabar + "qanday sharh yozish" videosi) — mijoz ulanishni
// tasdiqlaganda yoki 10 soat javob bermaganda (reviewScheduler.js orqali) chaqiriladi
async function sendReviewRequest(ctx, msg, customer, model) {
  if (!model.reviewVoiceFileId) return;
  await sendBiz(ctx, msg, { voice: model.reviewVoiceFileId });
  if (model.reviewVideoFileId) {
    await new Promise(r => setTimeout(r, queueLib.randomDelay(1000, 2000)));
    await sendBiz(ctx, msg, { video: model.reviewVideoFileId });
  }
  db.markReviewSent(msg.chat.id);
}

// Business ulanish orqali xabar yuborish (matn/video/ovoz, caption bilan)
async function sendBiz(ctx, originalMsg, { text, video, voice, caption }) {
  const chatId = originalMsg.chat.id;
  const businessConnectionId = originalMsg.business_connection_id;
  const base = { chat_id: chatId };
  if (businessConnectionId) base.business_connection_id = businessConnectionId;

  if (text) {
    await ctx.telegram.callApi('sendMessage', { ...base, text });
  }
  if (video) {
    const payload = { ...base, video };
    if (caption) payload.caption = caption;
    await ctx.telegram.callApi('sendVideo', payload);
  }
  if (voice) {
    await ctx.telegram.callApi('sendVoice', { ...base, voice });
  }
}

// Mijozlar sonini ko'rish
bot.command('mijozlar', (ctx) => {
  if (!isAdmin(ctx)) return;
  const count = db.getCustomerCount();
  ctx.reply(`📊 Bazada jami ${count} ta mijoz bor.`);
});

// Hammaga bir vaqtda xabar yuborish (Business orqali, shaxsiy profil nomidan)
const broadcastSessions = {};

bot.command('hammaga_xabar', (ctx) => {
  if (!isAdmin(ctx)) return;
  broadcastSessions[ctx.from.id] = { step: 'waiting_text' };
  ctx.reply('📢 Barcha mijozlarga yuboriladigan xabar matnini yuboring:');
});

bot.on('text', async (ctx, next) => {
  const bSession = broadcastSessions[ctx.from.id];
  if (bSession && bSession.step === 'waiting_text') {
    const text = ctx.message.text;
    delete broadcastSessions[ctx.from.id];
    const customers = db.getAllCustomers();
    await ctx.reply(`⏳ ${customers.length} ta mijozga xabar yuborilmoqda...`);

    let success = 0;
    let failed = 0;
    for (const customer of customers) {
      try {
        if (customer.businessConnectionId) {
          // Business ulanish orqali — shaxsiy profil nomidan yuboriladi
          await ctx.telegram.callApi('sendMessage', {
            chat_id: customer.chatId,
            text: text,
            business_connection_id: customer.businessConnectionId
          });
        } else {
          await ctx.telegram.sendMessage(customer.chatId, text);
        }
        success++;
      } catch (err) {
        failed++;
        console.error(`Mijoz ${customer.chatId} ga yuborilmadi:`, err.message);
      }
      // Telegram tezlik cheklovi uchun kichik kutish
      await new Promise(resolve => setTimeout(resolve, 50));
    }

    return ctx.reply(`✅ Tugadi.\nMuvaffaqiyatli: ${success}\nXato: ${failed}`);
  }
  return next();
});

bot.launch();
console.log('Bot ishga tushdi (polling rejimida).');
startReviewScheduler(bot.telegram);

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));

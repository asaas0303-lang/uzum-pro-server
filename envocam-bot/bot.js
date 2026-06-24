// bot.js — EnvoCam yordamchi bot
// Bosqich 1: /yangi_model buyrug'i orqali model yaratish + kanalni unga bog'lash
//            va kanaldagi postlarni avtomatik o'qib bazaga saqlash.
// Keyingi bosqichda: Business xabarlarga AI javob qismi qo'shiladi.

require('dotenv').config();
const { Telegraf } = require('telegraf');
const db = require('./db');

const BOT_TOKEN = process.env.BOT_TOKEN;
if (!BOT_TOKEN) {
  console.error('XATOLIK: BOT_TOKEN topilmadi. .env faylida yoki Railway Variables ichida belgilang.');
  process.exit(1);
}

const bot = new Telegraf(BOT_TOKEN);

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
    text += `• ${name}\n   Kanal: ${m.channelId ? '✅ ulangan' : '❌ ulanmagan'}\n   Rasmlar: ${m.images.length}, Skrinshotlar: ${m.appScreenshots.length}, Matn: ${m.textGuides.length}, Video: ${m.videoGuides.length}\n\n`;
  }
  ctx.reply(text);
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
// turi bo'yicha (rasm / video / matn) bazaga saqlaymiz.
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
      if (lowerCaption.includes('ilova') || lowerCaption.includes('skrinshot') || lowerCaption.includes('skreenshot')) {
        db.addAppScreenshotToModel(model.name, fileId, caption);
        console.log(`[${model.name}] ilova skrinshoti saqlandi`);
      } else {
        db.addImageToModel(model.name, fileId, caption);
        console.log(`[${model.name}] tashqi ko'rinish rasmi saqlandi`);
      }
    } else if (post.video) {
      db.addVideoGuideToModel(model.name, post.video.file_id, caption);
      console.log(`[${model.name}] video qo'llanma saqlandi`);
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

// Business ulanish va xabarlarni vaqtincha konsolga chiqarib tekshiramiz
bot.on('business_connection', (ctx) => {
  console.log('Business ulanish:', JSON.stringify(ctx.update.business_connection));
});

bot.on('business_message', (ctx) => {
  const msg = ctx.update.business_message;
  console.log('Business xabar keldi:', JSON.stringify(msg));
});

bot.launch();
console.log('Bot ishga tushdi (polling rejimida).');

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));

// bot.js — EnvoCam yordamchi bot

require('dotenv').config();
const { Telegraf } = require('telegraf');
const db = require('./db');

const BOT_TOKEN = process.env.BOT_TOKEN;
if (!BOT_TOKEN) {
  console.error('XATOLIK: BOT_TOKEN topilmadi.');
  process.exit(1);
}

const bot = new Telegraf(BOT_TOKEN);

const ADMIN_IDS = (process.env.ADMIN_IDS || '').split(',').map(s => s.trim()).filter(Boolean);

function isAdmin(ctx) {
  if (ADMIN_IDS.length === 0) return true;
  return ADMIN_IDS.includes(String(ctx.from.id));
}

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

bot.on('text', async (ctx, next) => {
  const session = sessions[ctx.from.id];
  if (!session) return next();

  if (session.step === 'waiting_name') {
    const modelName = ctx.message.text.trim();
    db.createModel(modelName);
    session.modelName = modelName;
    session.step = 'waiting_link';
    return ctx.reply(
      `✅ Model nomi saq

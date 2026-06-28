// reviewScheduler.js — Mijoz bilan yozishma tugab, 10 soat o'tgandan keyin
// avtomatik ravishda sharh so'rash xabari + ovozli xabar yuborish.

const db = require('./db');
const { enqueue } = require('./queue');

const TEN_HOURS_MS = 10 * 60 * 60 * 1000;
const CHECK_INTERVAL_MS = 15 * 60 * 1000; // har 15 daqiqada tekshiradi

function startReviewScheduler(telegram) {
  setInterval(async () => {
    try {
      await checkAndSendReviews(telegram);
    } catch (err) {
      console.error('Sharh tekshiruvida xatolik:', err);
    }
  }, CHECK_INTERVAL_MS);
  console.log('Sharh so\'rash rejasi ishga tushdi (har 15 daqiqada tekshiradi).');
}

async function checkAndSendReviews(telegram) {
  const customers = db.getAllCustomers();
  const now = Date.now();

  for (const customer of customers) {
    if (customer.reviewSent) continue;
    if (!customer.lastModelName) continue;

    const lastSeenMs = new Date(customer.lastSeen).getTime();
    if (now - lastSeenMs < TEN_HOURS_MS) continue;

    const models = db.getAllModels();
    const model = models[customer.lastModelName];
    if (!model || !model.reviewVoiceFileId) continue;

    const text = customer.language === 'ru'
      ? 'Здравствуйте! Камера вам пригодилась? Если все хорошо, не могли бы вы оставить короткий отзыв о товаре — это очень поможет нам \uD83D\uDE4F'
      : 'Assalomu alaykum! Kamerani ishlatib ko\'rdingizmi, hammasi yaxshi-yu? Iltimos, mahsulotga qisqacha sharh qoldirsangiz, bizga juda yordam bo\'lardi \uD83D\uDE4F';

    try {
      await enqueue(async () => {
        await sendBusinessMessage(telegram, customer, text);
        await sendBusinessVoice(telegram, customer, model.reviewVoiceFileId);
      }, { humanDelayMs: 0 });

      db.markReviewSent(customer.chatId);
      console.log(`[${customer.chatId}] sharh so'rash xabari yuborildi`);
    } catch (err) {
      console.error(`[${customer.chatId}] sharh xabarini yuborishda xatolik:`, err.message);
    }
  }
}

async function sendBusinessMessage(telegram, customer, text) {
  if (customer.businessConnectionId) {
    return telegram.callApi('sendMessage', {
      chat_id: customer.chatId,
      text,
      business_connection_id: customer.businessConnectionId
    });
  }
  return telegram.sendMessage(customer.chatId, text);
}

async function sendBusinessVoice(telegram, customer, voiceFileId) {
  if (customer.businessConnectionId) {
    return telegram.callApi('sendVoice', {
      chat_id: customer.chatId,
      voice: voiceFileId,
      business_connection_id: customer.businessConnectionId
    });
  }
  return telegram.sendVoice(customer.chatId, voiceFileId);
}

module.exports = { startReviewScheduler, sendBusinessMessage, sendBusinessVoice };

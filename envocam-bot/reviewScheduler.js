// reviewScheduler.js — Fon rejimida ishlaydigan ikkita vazifa:
// 1) Video yuborilgandan keyin, mijoz javob bermasa, "ulay oldingizmi" deb so'rash
// 2) Yozishma tugab 10 soat o'tgandan keyin, sharh so'rash

const db = require('./db');
const ai = require('./ai');
const { enqueue, randomDelay } = require('./queue');

const TEN_HOURS_MS = 10 * 60 * 60 * 1000;
const CONNECTION_FOLLOWUP_DELAY_MS = 60 * 60 * 1000;
const CHECK_INTERVAL_MS = 15 * 60 * 1000;

function startReviewScheduler(telegram) {
  setInterval(async () => {
    try {
      await checkConnectionFollowups(telegram);
      await checkAndSendReviews(telegram);
    } catch (err) {
      console.error('Fon vazifasida xatolik:', err);
    }
  }, CHECK_INTERVAL_MS);
  console.log('Fon vazifalari ishga tushdi (har 15 daqiqada tekshiradi).');
}

async function checkConnectionFollowups(telegram) {
  const customers = db.getAllCustomers();
  const now = Date.now();

  for (const customer of customers) {
    if (!customer.awaitingConnectionConfirm) continue;
    if (customer.connectionFollowupSentAt) continue;

    const lastSeenMs = new Date(customer.lastSeen).getTime();
    if (now - lastSeenMs < CONNECTION_FOLLOWUP_DELAY_MS) continue;

    try {
      const text = await ai.craftConnectionFollowup({ language: customer.language });
      await enqueue(() => sendBusinessMessage(telegram, customer, text), { humanDelayMs: 0 });
      db.upsertCustomer({ chatId: customer.chatId, connectionFollowupSentAt: new Date().toISOString() });
      console.log(`[${customer.chatId}] ulanish so'rovi yuborildi`);
    } catch (err) {
      console.error(`[${customer.chatId}] ulanish so'rovini yuborishda xatolik:`, err.message);
    }
  }
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
      ? 'Здравствуйте. Камера вам пригодилась? Если все хорошо, не могли бы вы оставить короткий отзыв о товаре — это очень поможет нам.'
      : 'Assalomu alaykum. Kamerani ishlatib ko\'rdingizmi, hammasi yaxshi-yu? Iltimos, mahsulotga qisqacha sharh qoldirsangiz, bizga juda yordam bo\'lardi.';

    try {
      await enqueue(async () => {
        await sendBusinessMessage(telegram, customer, text);
        await new Promise(r => setTimeout(r, randomDelay(1000, 2000)));
        await sendBusinessVoice(telegram, customer, model.reviewVoiceFileId);
        if (model.reviewVideoFileId) {
          await new Promise(r => setTimeout(r, randomDelay(1000, 2000)));
          await sendBusinessVideo(telegram, customer, model.reviewVideoFileId);
        }
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

async function sendBusinessVideo(telegram, customer, videoFileId) {
  if (customer.businessConnectionId) {
    return telegram.callApi('sendVideo', {
      chat_id: customer.chatId,
      video: videoFileId,
      business_connection_id: customer.businessConnectionId
    });
  }
  return telegram.sendVideo(customer.chatId, videoFileId);
}

module.exports = { startReviewScheduler };

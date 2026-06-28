// db.js — Oddiy JSON-fayl asosidagi baza. Keyinchalik Postgres/Supabase'ga
// ko'chirish oson bo'lishi uchun barcha o'qish/yozish shu fayl orqali bo'ladi.

const fs = require('fs');
const path = require('path');

const DB_PATH = path.join(__dirname, 'data', 'models.json');

function ensureDb() {
  const dir = path.dirname(DB_PATH);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  if (!fs.existsSync(DB_PATH)) {
    fs.writeFileSync(DB_PATH, JSON.stringify({ models: {}, pendingLinks: {}, customers: {} }, null, 2));
  }
}

function readDb() {
  ensureDb();
  const db = JSON.parse(fs.readFileSync(DB_PATH, 'utf-8'));
  if (!db.customers) db.customers = {};
  return db;
}

function writeDb(db) {
  fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2));
}

// Yangi model yaratish (hali bo'sh, kanal ulanmagan)
function createModel(modelName) {
  const db = readDb();
  if (!db.models[modelName]) {
    db.models[modelName] = {
      name: modelName,
      channelId: null,
      images: [],          // tashqi ko'rinish rasmlari [{file_id, caption}]
      appScreenshots: [],  // ilova ichki tuzilishi skrinshotlari [{file_id, caption}]
      textGuides: [],       // matnli qo'llanmalar [{text, caption}]
      videoGuides: [],      // video qo'llanmalar [{file_id, caption}]
      reviewVoiceFileId: null // sharh so'rash uchun tayyor ovozli xabar
    };
    writeDb(db);
  }
  return db.models[modelName];
}

function linkChannelToModel(channelId, modelName) {
  const db = readDb();
  createModel(modelName); // mavjud bo'lmasa yaratadi (db ni qayta o'qib bo'lgach yozadi)
  const fresh = readDb();
  fresh.models[modelName].channelId = String(channelId);
  // pendingLinks orqali tez qidirish: channelId -> modelName
  fresh.pendingLinks[String(channelId)] = modelName;
  writeDb(fresh);
}

function getModelByChannelId(channelId) {
  const db = readDb();
  const modelName = db.pendingLinks[String(channelId)];
  if (!modelName) return null;
  return db.models[modelName];
}

function addImageToModel(modelName, fileId, caption) {
  const db = readDb();
  db.models[modelName].images.push({ file_id: fileId, caption: caption || '' });
  writeDb(db);
}

function addAppScreenshotToModel(modelName, fileId, caption) {
  const db = readDb();
  db.models[modelName].appScreenshots.push({ file_id: fileId, caption: caption || '' });
  writeDb(db);
}

function addTextGuideToModel(modelName, text, caption) {
  const db = readDb();
  db.models[modelName].textGuides.push({ text, caption: caption || '' });
  writeDb(db);
}

function addVideoGuideToModel(modelName, fileId, caption) {
  const db = readDb();
  db.models[modelName].videoGuides.push({ file_id: fileId, caption: caption || '' });
  writeDb(db);
}

function setReviewVoice(modelName, fileId) {
  const db = readDb();
  db.models[modelName].reviewVoiceFileId = fileId;
  writeDb(db);
}

function getAllModels() {
  const db = readDb();
  return db.models;
}

// Mijozni bazaga saqlash/yangilash. businessConnectionId — bot orqali shaxsiy
// profilga keyinroq xabar yuborish uchun kerak bo'ladi.
function upsertCustomer({ chatId, firstName, lastName, username, businessConnectionId }) {
  const db = readDb();
  const id = String(chatId);
  const existing = db.customers[id] || {};
  db.customers[id] = {
    chatId: id,
    firstName: firstName || existing.firstName || '',
    lastName: lastName || existing.lastName || '',
    username: username || existing.username || '',
    businessConnectionId: businessConnectionId || existing.businessConnectionId || null,
    firstSeen: existing.firstSeen || new Date().toISOString(),
    lastSeen: new Date().toISOString()
  };
  writeDb(db);
}

function getAllCustomers() {
  const db = readDb();
  return Object.values(db.customers);
}

function getCustomerCount() {
  const db = readDb();
  return Object.keys(db.customers).length;
}

module.exports = {
  createModel,
  linkChannelToModel,
  getModelByChannelId,
  addImageToModel,
  addAppScreenshotToModel,
  addTextGuideToModel,
  addVideoGuideToModel,
  setReviewVoice,
  getAllModels,
  upsertCustomer,
  getAllCustomers,
  getCustomerCount
};

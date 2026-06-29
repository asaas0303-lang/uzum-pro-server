// db.js — Oddiy JSON-fayl asosidagi baza.

const fs = require('fs');
const path = require('path');

const DB_PATH = path.join(__dirname, 'data', 'models.json');

function ensureDb() {
  const dir = path.dirname(DB_PATH);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  if (!fs.existsSync(DB_PATH)) {
    fs.writeFileSync(DB_PATH, JSON.stringify({ models: {}, pendingLinks: {}, customers: {}, businessOwners: {} }, null, 2));
  }
}

function readDb() {
  ensureDb();
  const db = JSON.parse(fs.readFileSync(DB_PATH, 'utf-8'));
  if (!db.customers) db.customers = {};
  if (!db.businessOwners) db.businessOwners = {};
  return db;
}

function writeDb(db) {
  fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2));
}

function createModel(modelName) {
  const db = readDb();
  if (!db.models[modelName]) {
    db.models[modelName] = {
      name: modelName,
      channelId: null,
      images: [],
      manualImages: [],
      appScreenshots: [],
      textGuides: [],
      videoGuides: [],
      reviewVoiceFileId: null,
      reviewVideoFileId: null
    };
    writeDb(db);
  }
  return db.models[modelName];
}

function linkChannelToModel(channelId, modelName) {
  createModel(modelName);
  const db = readDb();
  db.models[modelName].channelId = String(channelId);
  db.pendingLinks[String(channelId)] = modelName;
  writeDb(db);
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

function addManualImageToModel(modelName, fileId, caption, extractedText) {
  const db = readDb();
  db.models[modelName].manualImages.push({ file_id: fileId, caption: caption || '', extractedText: extractedText || '' });
  writeDb(db);
}

function addAppScreenshotToModel(modelName, fileId, caption, extractedText) {
  const db = readDb();
  db.models[modelName].appScreenshots.push({ file_id: fileId, caption: caption || '', extractedText: extractedText || '' });
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

function setReviewVideo(modelName, fileId) {
  const db = readDb();
  db.models[modelName].reviewVideoFileId = fileId;
  writeDb(db);
}

function getAllModels() {
  const db = readDb();
  return db.models;
}

function upsertCustomer(data) {
  const db = readDb();
  const id = String(data.chatId);
  const existing = db.customers[id] || {};
  db.customers[id] = {
    chatId: id,
    firstName: data.firstName || existing.firstName || '',
    lastName: data.lastName || existing.lastName || '',
    username: data.username || existing.username || '',
    businessConnectionId: data.businessConnectionId || existing.businessConnectionId || null,
    language: data.language || existing.language || 'uz',
    lastModelName: data.lastModelName !== undefined ? data.lastModelName : (existing.lastModelName || null),
    hasGreeted: data.hasGreeted !== undefined ? data.hasGreeted : (existing.hasGreeted || false),
    awaitingConnectionConfirm: data.awaitingConnectionConfirm !== undefined ? data.awaitingConnectionConfirm : (existing.awaitingConnectionConfirm || false),
    connectionFollowupSentAt: data.connectionFollowupSentAt !== undefined ? data.connectionFollowupSentAt : (existing.connectionFollowupSentAt || null),
    askedForPhotoOnce: data.askedForPhotoOnce !== undefined ? data.askedForPhotoOnce : (existing.askedForPhotoOnce || false),
    lastProcessedMessageId: data.lastProcessedMessageId !== undefined ? data.lastProcessedMessageId : (existing.lastProcessedMessageId || null),
    reviewSent: existing.reviewSent || false,
    reviewFollowupSent: existing.reviewFollowupSent || false,
    firstSeen: existing.firstSeen || new Date().toISOString(),
    lastSeen: new Date().toISOString()
  };
  writeDb(db);
  return db.customers[id];
}

function getCustomer(chatId) {
  const db = readDb();
  return db.customers[String(chatId)] || null;
}

function markReviewSent(chatId) {
  const db = readDb();
  const id = String(chatId);
  if (db.customers[id]) {
    db.customers[id].reviewSent = true;
    db.customers[id].reviewSentAt = new Date().toISOString();
    writeDb(db);
  }
}

function markReviewFollowupSent(chatId) {
  const db = readDb();
  const id = String(chatId);
  if (db.customers[id]) {
    db.customers[id].reviewFollowupSent = true;
    writeDb(db);
  }
}

function getAllCustomers() {
  const db = readDb();
  return Object.values(db.customers);
}

function getCustomerCount() {
  const db = readDb();
  return Object.keys(db.customers).length;
}

function setBusinessOwner(businessConnectionId, ownerUserId) {
  const db = readDb();
  db.businessOwners[businessConnectionId] = String(ownerUserId);
  writeDb(db);
}

function getBusinessOwner(businessConnectionId) {
  const db = readDb();
  return db.businessOwners[businessConnectionId] || null;
}

module.exports = {
  createModel,
  linkChannelToModel,
  getModelByChannelId,
  addImageToModel,
  addManualImageToModel,
  addAppScreenshotToModel,
  addTextGuideToModel,
  addVideoGuideToModel,
  setReviewVoice,
  setReviewVideo,
  getAllModels,
  upsertCustomer,
  getCustomer,
  getAllCustomers,
  getCustomerCount,
  markReviewSent,
  markReviewFollowupSent,
  setBusinessOwner,
  getBusinessOwner
};

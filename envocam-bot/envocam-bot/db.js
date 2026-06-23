// db.js — Oddiy JSON-fayl asosidagi baza.

const fs = require('fs');
const path = require('path');

const DB_PATH = path.join(__dirname, 'data', 'models.json');

function ensureDb() {
  if (!fs.existsSync(DB_PATH)) {
    fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
    fs.writeFileSync(DB_PATH, JSON.stringify({ models: {}, pendingLinks: {} }, null, 2));
  }
}

function readDb() {
  ensureDb();
  return JSON.parse(fs.readFileSync(DB_PATH, 'utf-8'));
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
      appScreenshots: [],
      textGuides: [],
      videoGuides: [],
      reviewVoiceFileId: null
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

module.exports = {
  createModel,
  linkChannelToModel,
  getModelByChannelId,
  addImageToModel,
  addAppScreenshotToModel,
  addTextGuideToModel,
  addVideoGuideToModel,
  setReviewVoice,
  getAllModels
};

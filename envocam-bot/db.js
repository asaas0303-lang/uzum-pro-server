const fs = require('fs');
const path = require('path');

// Determine path to persistent data directory
let dataDir = '/data';
try {
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }
} catch (e) {
  // Fallback for local development environments
  dataDir = path.join(__dirname, 'data');
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }
}

const MODELS_FILE = path.join(dataDir, 'models.json');
const CUSTOMERS_FILE = path.join(dataDir, 'customers.json');
const CONFIG_FILE = path.join(dataDir, 'config.json');

// Helper to safely read files
function readJSON(filePath, defaultData = []) {
  try {
    if (!fs.existsSync(filePath)) {
      fs.writeFileSync(filePath, JSON.stringify(defaultData, null, 2));
      return defaultData;
    }
    const content = fs.readFileSync(filePath, 'utf-8');
    return JSON.parse(content || JSON.stringify(defaultData));
  } catch (err) {
    console.error(`Error reading ${filePath}:`, err);
    return defaultData;
  }
}

// Helper to safely write files
function writeJSON(filePath, data) {
  try {
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
  } catch (err) {
    console.error(`Error writing ${filePath}:`, err);
  }
}

// Model Operations
function getModels() {
  return readJSON(MODELS_FILE, []);
}

function saveModels(models) {
  writeJSON(MODELS_FILE, models);
}

function findModelByName(name) {
  const models = getModels();
  return models.find(m => m.name.toLowerCase() === name.toLowerCase());
}

function findModelByChannelId(channelId) {
  const models = getModels();
  return models.find(m => String(m.channelId) === String(channelId));
}

// Customer Operations
function getCustomers() {
  return readJSON(CUSTOMERS_FILE, []);
}

function saveCustomers(customers) {
  writeJSON(CUSTOMERS_FILE, customers);
}

function getCustomer(chatId) {
  const customers = getCustomers();
  return customers.find(c => String(c.chatId) === String(chatId));
}

function saveCustomer(customerData) {
  const customers = getCustomers();
  const idx = customers.findIndex(c => String(c.chatId) === String(customerData.chatId));
  if (idx !== -1) {
    customers[idx] = { ...customers[idx], ...customerData };
  } else {
    customers.push(customerData);
  }
  saveCustomers(customers);
}

// Config/Meta operations (e.g. tracking processed message IDs, business owner connections)
function getConfig() {
  return readJSON(CONFIG_FILE, { processedMessages: [], businessOwners: {} });
}

function saveConfig(config) {
  writeJSON(CONFIG_FILE, config);
}

module.exports = {
  getModels,
  saveModels,
  findModelByName,
  findModelByChannelId,
  getCustomers,
  getCustomer,
  saveCustomer,
  getConfig,
  saveConfig
};

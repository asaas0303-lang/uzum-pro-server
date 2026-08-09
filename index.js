import 'dotenv/config';
import express from 'express';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { GoogleGenAI } from '@google/genai';
import cron from 'node-cron';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// 18-C1: Uzum bilimlar bazasi (knowledge/uzum-rules.md) — AI kontekstiga qo'shiladi. Bir marta o'qib keshlanadi.
let _knowledgeBaseCache = null;
function loadKnowledgeBase() {
  if (_knowledgeBaseCache !== null) return _knowledgeBaseCache;
  try {
    _knowledgeBaseCache = fs.readFileSync(path.join(__dirname, 'knowledge', 'uzum-rules.md'), 'utf8');
  } catch (err) {
    console.warn('[KB] Bilimlar bazasi o\'qilmadi:', err.message);
    _knowledgeBaseCache = '';
  }
  return _knowledgeBaseCache;
}

// 19-E: Biznes/moliya tamoyillari (knowledge/biznes-tamoyillari.md) — xuddi uzum-rules.md kabi keshlanib, AI kontekstiga qo'shiladi.
let _businessPrinciplesCache = null;
function loadBusinessPrinciples() {
  if (_businessPrinciplesCache !== null) return _businessPrinciplesCache;
  try {
    _businessPrinciplesCache = fs.readFileSync(path.join(__dirname, 'knowledge', 'biznes-tamoyillari.md'), 'utf8');
  } catch (err) {
    console.warn('[KB] Biznes tamoyillari o\'qilmadi:', err.message);
    _businessPrinciplesCache = '';
  }
  return _businessPrinciplesCache;
}

// 19-H: VAQTINCHALIK qisqartirish — to'liq faylni har chaqiruvda yuborish Gemini javob vaqtini
// uzaytirgan (26-81s). Qo'lda tanlangan eng muhim qismlar: "qanday ishlatish" qo'llanmasi (7-bo'lim,
// doim kerak) + eng ko'p qo'llaniladigan 4 tamoyil. Relevance/so'rovga-qarab-tanlash algoritmi EMAS —
// bilim bazasi yana kattalashsa, shunday mexanizm kerak bo'ladi, hozircha bu yetarli.
let _businessPrinciplesCondensedCache = null;
function loadBusinessPrinciplesCondensed() {
  if (_businessPrinciplesCondensedCache !== null) return _businessPrinciplesCondensedCache;
  const full = loadBusinessPrinciples();
  const pick = (heading) => {
    const m = full.match(new RegExp(heading + '[\\s\\S]*?(?=\\n### |\\n## |$)'));
    return m ? m[0].trim() : '';
  };
  const parts = [
    pick('### 1\\.1'), // Qarz — erkinlikni cheklaydi
    pick('### 1\\.3'), // Qarzdan qutulish formulasi
    pick('### 2\\.5'), // Marja aylanmadan muhim
    pick('### 5\\.5'), // "Bugungi 3 ta ish" usuli
    pick('## 7\\. AI MASLAHATCHI UCHUN') // qo'llash qo'llanmasi — fayl oxirigacha
  ].filter(Boolean);
  _businessPrinciplesCondensedCache = parts.join('\n\n');
  return _businessPrinciplesCondensedCache;
}

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

// 12A: pul/son yaxlitlash — YAGONA funksiya. toLocaleString('uz-UZ') kasr sonda vergulni O'NLIK
// ajratkich sifatida ishlatadi (121.111 -> "121,111"), bu ming ajratkichiga o'xshab noto'g'ri o'qiladi.
// Shuning uchun HAR DOIM avval Math.round(). Butun serverda FAQAT shu funksiya ishlatilsin.
function fmtMoney(n) {
  return Math.round(n || 0).toLocaleString('uz-UZ');
}

// ============ DISK SAQLASH (2.2) ============
// DATA_DIR — Railway'da Volume ulanadigan yo'l. Default ./data (lokal test uchun).
// DIQQAT: Railway'da Volume ulanmasa, ./data har redeploy'da o'chadi (efemer).
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');
const SNAPSHOTS_FILE = path.join(DATA_DIR, 'snapshots.json');
const PROBLEMS_FILE = path.join(DATA_DIR, 'problems.json'); // 18-D0: faol muammo holati (takroriy ogohlantirmaslik uchun)
const INVOICE_STATE_FILE = path.join(DATA_DIR, 'invoice_state.json'); // 19-B: { deducted:[invoiceId], acceptedNotified:[invoiceId] } — bir yuk xatini ikki marta qayta ishlamaslik uchun
const SNAPSHOT_RETENTION_DAYS = 60;

function ensureDataDir() {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  } catch (err) {
    console.error('[DISK] DATA_DIR yaratishda xato (davom etamiz):', err.message);
  }
}

function readJsonFile(file, fallback) {
  try {
    if (!fs.existsSync(file)) return fallback;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    console.error(`[DISK] ${path.basename(file)} o'qishda xato (fallback ishlatildi):`, err.message);
    return fallback;
  }
}

function writeJsonFile(file, data) {
  try {
    ensureDataDir();
    fs.writeFileSync(file, JSON.stringify(data, null, 2));
    return true;
  } catch (err) {
    console.error(`[DISK] ${path.basename(file)} yozishda xato (crash bo'lmaydi):`, err.message);
    return false;
  }
}

// Catch-up uchun: kunlik hisobot oxirgi qachon muvaffaqiyatli yuborilgani (sana) diskda kuzatiladi
const REPORT_META_FILE = path.join(DATA_DIR, 'report_meta.json');
function getLastReportDate() {
  const meta = readJsonFile(REPORT_META_FILE, null);
  return meta ? meta.lastReportDate : null;
}
function setLastReportDate(date) {
  writeJsonFile(REPORT_META_FILE, { lastReportDate: date });
}

// 19-F: Kunlik vazifalar xotirasi — POYDEVOR QATLAMI. Ertalabki xabar/AI/tugma HALI yo'q (keyingi bosqich),
// faqat saqlash/o'qish. Tuzilma: { "YYYY-MM-DD": [{ id, text, status, createdAt, updatedAt }, ...] }.
// status: "kutilmoqda" | "bajarildi" | "ertaga" | "imkonsiz".
const DAILY_TASKS_FILE = path.join(DATA_DIR, 'daily-tasks.json');
const DAILY_TASKS_RETENTION_DAYS = 60; // snapshot naqshiga o'xshab — ixtiyoriy tozalash
const DAILY_TASK_STATUSES = ['kutilmoqda', 'bajarildi', 'ertaga', 'imkonsiz'];

function getDailyTasks(sana) {
  const all = readJsonFile(DAILY_TASKS_FILE, {});
  return all[sana] || [];
}

function getRecentTasks(kunSoni) {
  const all = readJsonFile(DAILY_TASKS_FILE, {});
  const cutoff = new Date(Date.now() - kunSoni * 86400000).toISOString().slice(0, 10);
  const result = {};
  for (const d of Object.keys(all).sort()) { if (d >= cutoff) result[d] = all[d]; }
  return result;
}

// Himoya: mavjud (bo'sh bo'lmagan) kunni bo'sh massiv bilan tasodifan almashtirib qo'ymaslik
// (settings.json/finance-data'dagi bo'sh-yozuv himoyasi bilan bir xil naqsh).
function saveDailyTasks(sana, vazifalar) {
  const all = readJsonFile(DAILY_TASKS_FILE, {});
  const currentlyHasData = (all[sana] || []).length > 0;
  const willBeEmpty = !Array.isArray(vazifalar) || vazifalar.length === 0;
  if (willBeEmpty && currentlyHasData) {
    console.warn(`[DAILY-TASKS] RAD ETILDI: "${sana}" bo'sh yuborildi (${all[sana].length} ta yozuv bor edi) — himoya.`);
    return false;
  }
  all[sana] = vazifalar;
  const cutoff = new Date(Date.now() - DAILY_TASKS_RETENTION_DAYS * 86400000).toISOString().slice(0, 10);
  for (const d of Object.keys(all)) { if (d < cutoff) delete all[d]; }
  return writeJsonFile(DAILY_TASKS_FILE, all);
}

function updateTaskStatus(sana, taskId, yangiHolat) {
  if (!DAILY_TASK_STATUSES.includes(yangiHolat)) {
    console.warn(`[DAILY-TASKS] Noto'g'ri holat: "${yangiHolat}"`);
    return false;
  }
  const all = readJsonFile(DAILY_TASKS_FILE, {});
  const kunVazifalari = all[sana];
  const task = kunVazifalari && kunVazifalari.find(t => t.id === taskId);
  if (!task) return false;
  task.status = yangiHolat;
  task.updatedAt = Date.now();
  return writeJsonFile(DAILY_TASKS_FILE, all);
}

// Diagnostika: joriy deploy qaysi Git commit'dan ekanini va APP_URL qanday sozlanganini ko'rsatadi
app.get('/version', (req, res) => {
  res.json({ commit: process.env.RAILWAY_GIT_COMMIT_SHA || null, appUrl: process.env.APP_URL || null });
});

// In-memory sync cache from frontend to allow Bot commands to use the actual customized states
let syncedState = {
  productTypes: [
    { id: 't1', name: 'A9 kamera', stock: 400, cost: 45000 },
    { id: 't2', name: 'X5 kamera', stock: 300, cost: 95000 },
    { id: 't3', name: 'To\'rt burchak', stock: 150, cost: 180000 }
  ],
  skuMappings: {
    '5501': 't1', '5502': 't1', '5503': 't1',
    '5601': 't2', '5602': 't2',
    '5701': 't3', '5702': 't3'
  },
  costs: {}, // ad spends e.g. { skuId: 10000 }
  productSettings: {}, // 3.4: mahsulot (productId) darajasidagi sozlama — barcha ranglarga meros bo'ladi
  shops: [
    { shopId: 61122, shopTitle: 'kamera' },
    { shopId: 48589, shopTitle: 'Jaydari Bozor' },
    { shopId: 63592, shopTitle: 'Nurli' }
  ],
  activeShop: 61122,
  products: [], // real Uzum product cards synced from frontend (dashboard.html state.cachedUzumProducts)
  orders: [], // real Uzum finance orders synced from frontend (dashboard.html state.orders)
  expenses: [], // real Uzum finance expenses synced from frontend (dashboard.html state.expenses)
  // 18-A: yangi MOLIYA ma'lumotlari (foydalanuvchi qo'lda kiritadi, Uzum'nikidan alohida). Diskda saqlanadi.
  withdrawals: [], // { id, date, amount, shopId?, note, status: 'kutilmoqda'|'keldi' } — Uzum'dan yechib olingan pul
  userExpenses: [], // { id, date, amount, category, note } — real xarajatlar (ijara/ish haqi/transport...). "expenses" nomi Uzum uchun band.
  credits: [], // { id, name, totalAmount, remainingAmount, monthlyPayment, nextPaymentDate:'YYYY-MM-DD', interestRate?, endDate?, remainingPayments?, type:'fixed'|'decreasing'|'annuity', note } — eski kreditlarda paymentDay (1-28) bo'lishi mumkin, creditDaysUntilDue() orqaga moslikni saqlaydi
  goals: [] // { id, type:'monthly_turnover', target, createdDate, milestones:[] } — moliyaviy maqsad
};

// Faqat foydalanuvchi sozlamalari diskda saqlanadi (2.1: sotuv/mahsulot ma'lumoti jonli tortiladi, saqlanmaydi)
// 18-A: moliya ma'lumotlari (withdrawals/userExpenses/credits/goals) ham SHU YERDA — mavjud himoya ostida saqlanadi.
const SETTINGS_KEYS = ['productTypes', 'skuMappings', 'costs', 'shops', 'activeShop', 'productSettings', 'withdrawals', 'userExpenses', 'credits', 'goals'];
const SETTINGS_BACKUP_FILE = path.join(DATA_DIR, 'settings.backup.json');
const SETTINGS_BACKUP_RETENTION_DAYS = 7;

// Sozlama "bo'sh" (foydali ma'lumot yo'q) — 0 do'kon VA 0 productType bo'lsa
function isSettingsEmpty(s) {
  if (!s) return true;
  const shops = s.shops || [];
  const types = s.productTypes || [];
  return shops.length === 0 && types.length === 0;
}

function currentSettings() {
  const settings = {};
  for (const k of SETTINGS_KEYS) settings[k] = syncedState[k];
  return settings;
}

// C: yozishdan oldin oldingi nusxani settings.backup.json ga, kuniga bir marta sana bilan zaxira
function backupSettings() {
  try {
    if (!fs.existsSync(SETTINGS_FILE)) return;
    const prev = fs.readFileSync(SETTINGS_FILE, 'utf8');
    fs.writeFileSync(SETTINGS_BACKUP_FILE, prev); // har doim oxirgi nusxa
    // kunlik sana bilan zaxira
    const dated = path.join(DATA_DIR, `settings.${todayTashkent()}.json`);
    if (!fs.existsSync(dated)) fs.writeFileSync(dated, prev);
    // 7 kundan eski sanali zaxiralarni tozalaymiz
    const cutoff = new Date(Date.now() - SETTINGS_BACKUP_RETENTION_DAYS * 86400000).toISOString().slice(0, 10);
    for (const f of fs.readdirSync(DATA_DIR)) {
      const m = f.match(/^settings\.(\d{4}-\d{2}-\d{2})\.json$/);
      if (m && m[1] < cutoff) { try { fs.unlinkSync(path.join(DATA_DIR, f)); } catch {} }
    }
  } catch (err) {
    console.error('[SETTINGS] Zaxira olishda xato (davom etamiz):', err.message);
  }
}

// B (server himoya): mavjud sozlama ustiga bo'sh sozlama YOZILMAYDI
function saveSettings() {
  const settings = currentSettings();
  if (isSettingsEmpty(settings)) {
    const existing = readJsonFile(SETTINGS_FILE, null);
    if (existing && !isSettingsEmpty(existing)) {
      console.warn('[SETTINGS] RAD ETILDI: bo\'sh sozlama mavjud sozlama ustiga yozilmadi (himoya).');
      return;
    }
  }
  backupSettings(); // C: avval zaxira
  const ok = writeJsonFile(SETTINGS_FILE, settings);
  if (ok) console.log(`[SETTINGS] Saqlandi: ${(settings.shops||[]).length} do'kon, ${(settings.productTypes||[]).length} productType.`);
}

let settingsLoadedFromDisk = false;
// A: startupda aniq log — nechta do'kon/productType yuklandi, topilmasa OGOHLANTIRISH
function loadSettings() {
  const settings = readJsonFile(SETTINGS_FILE, null);
  if (settings && !isSettingsEmpty(settings)) {
    for (const k of SETTINGS_KEYS) {
      if (settings[k] !== undefined) syncedState[k] = settings[k];
    }
    settingsLoadedFromDisk = true;
    console.log(`[SETTINGS] Diskdan yuklandi: ${(settings.shops||[]).length} do'kon, ${(settings.productTypes||[]).length} productType, ${Object.keys(settings.skuMappings||{}).length} SKU bog'lanish.`);
  } else if (settings && isSettingsEmpty(settings)) {
    console.warn('[SETTINGS] OGOHLANTIRISH: settings.json topildi lekin BO\'SH (0 do\'kon, 0 productType) — default ishlatiladi. Zaxiradan tiklash kerak bo\'lishi mumkin.');
  } else {
    console.warn('[SETTINGS] OGOHLANTIRISH: settings.json topilmadi — default ishlatiladi (birinchi ishga tushirish bo\'lishi mumkin).');
  }
}

// Fallback high-fidelity Uzum Mock Data to allow beautiful demo interaction instantly
const MOCK_SHOPS = [
  { shopId: 61122, shopTitle: 'Uzum Pro Store' },
  { shopId: 72540, shopTitle: 'Smart Gadgets Market' }
];

const MOCK_PRODUCTS_61122 = [
  {
    productId: 1001,
    title: "Mini Wi-Fi Kamera A9 HD",
    status: { value: "APPROVED" },
    category: { title: "Elektronika" },
    photos: [{ photoKey: "https://images.uzum.uz/cr6bepdb99oncqgfsfhg/original.jpg" }],
    skuList: [
      { skuId: 5501, skuTitle: "Mini WiFi Kamera (Oq)", availableAmount: 48, purchasePrice: 129000, skuCode: "A9-WHITE" },
      { skuId: 5502, skuTitle: "Yashirin Kamera HD (Qora)", availableAmount: 0, purchasePrice: 139000, skuCode: "A9-BLACK" },
      { skuId: 5503, skuTitle: "Kuzatuv WiFi Kamerasi 1080P", availableAmount: 11, purchasePrice: 149000, skuCode: "A9-PRO" }
    ]
  },
  {
    productId: 1002,
    title: "X5 Mikro Professional Kamera",
    status: { value: "APPROVED" },
    category: { title: "Aksessuarlar" },
    photos: [{ photoKey: "https://images.uzum.uz/cpcr0ejfrsgv72ugb1gg/original.jpg" }],
    skuList: [
      { skuId: 5601, skuTitle: "X5 Mini Mikro HD kamera", availableAmount: 120, purchasePrice: 249000, skuCode: "X5-BASIC" },
      { skuId: 5602, skuTitle: "X5 Portativ Aqlli Kamera", availableAmount: 4, purchasePrice: 269000, skuCode: "X5-BANNED" }
    ]
  },
  {
    productId: 1003,
    title: "To'rt Burchak Uy Kuzatuv Kamera",
    status: { value: "APPROVED" },
    category: { title: "Elektronika" },
    photos: [{ photoKey: "https://images.uzum.uz/cqglis7hgbv72ugcligg/original.jpg" }],
    skuList: [
      { skuId: 5701, skuTitle: "To'rtburchak Simsiz Smart Kamera", availableAmount: 5, purchasePrice: 389000, skuCode: "TB-SMART" },
      { skuId: 5702, skuTitle: "Kvadrat Kamera Magnitli", availableAmount: 15, purchasePrice: 199000, skuCode: "TB-MAGNETIC" }
    ]
  }
];

const MOCK_PRODUCTS_72540 = [
  {
    productId: 2001,
    title: "Simsiz Audio Quloqchinlar Sport v2",
    status: { value: "APPROVED" },
    category: { title: "Elektronika" },
    photos: [{ photoKey: "https://images.uzum.uz/cl92eplf7t884bco6m1g/original.jpg" }],
    skuList: [
      { skuId: 6601, skuTitle: "Sport Pro v2 (Sariq)", availableAmount: 34, purchasePrice: 189000, skuCode: "HP-YELLOW" },
      { skuId: 6602, skuTitle: "Sport Pro v2 (Yashil)", availableAmount: 1, purchasePrice: 189000, skuCode: "HP-GREEN" }
    ]
  }
];

const MOCK_ORDERS = [
  { orderId: 80112, skuId: 5501, title: "Mini WiFi Kamera (Oq)", price: 129000, orderDate: "2026-05-22T14:24:00Z", payout: 102070, quantity: 1, category: "Elektronika", status: "DELIVERED" },
  { orderId: 80113, skuId: 5501, title: "Mini WiFi Kamera (Oq)", price: 129000, orderDate: "2026-05-22T16:11:00Z", payout: 102070, quantity: 2, category: "Elektronika", status: "DELIVERED" },
  { orderId: 80114, skuId: 5601, title: "X5 Mini Mikro HD kamera", price: 249000, orderDate: "2026-05-22T18:05:00Z", payout: 181750, quantity: 3, category: "Aksessuarlar", status: "DELIVERED" },
  { orderId: 80115, skuId: 5701, title: "To'rtburchak Simsiz Smart Kamera", price: 389000, orderDate: "2026-05-22T19:40:00Z", payout: 314870, quantity: 1, category: "Elektronika", status: "DELIVERED" },
  { orderId: 80116, skuId: 5503, title: "Kuzatuv WiFi Kamerasi 1080P", price: 149000, orderDate: "2026-05-21T09:12:00Z", payout: 118670, quantity: 1, category: "Elektronika", status: "DELIVERED" },
  { orderId: 80117, skuId: 5702, title: "Kvadrat Kamera Magnitli", price: 199000, orderDate: "2026-05-21T11:45:00Z", payout: 153000, quantity: 1, category: "Elektronika", status: "DELIVERED" }
];

const MOCK_EXPENSES = [
  { expenseId: 201, type: "STORAGE", amount: 230000, title: "Omborda saqlash xarajati" },
  { expenseId: 202, type: "LOGISTICS", amount: 450000, title: "Tovarlarni yetkazib berish xarajati" },
  { expenseId: 203, type: "MARKETING", amount: 550000, title: "Uzum reklamasi xarajati" }
];

const MOCK_RETURNS = [
  { returnId: 3001, skuId: 5501, productTitle: "Mini WiFi Kamera (Oq)", price: 129000, returnDate: "2026-05-21T10:00:00Z", status: "ACCEPTED", defectReason: "Sifatsiz mahsulot (kamera ishlamadi)" },
  { returnId: 3002, skuId: 5702, productTitle: "Kvadrat Kamera Magnitli", price: 199000, returnDate: "2026-05-22T15:30:00Z", status: "ACCEPTED", defectReason: "Noto'g'ri rang kelgan" }
];

// Tokenni bitta joydan olamiz
function getAuthToken(req) {
  return req.headers['authorization'] || process.env.UZUM_TOKEN || null;
}

// GET so'rovlar uchun — MUHIM: Content-Type YO'Q!
function getGetHeaders(req) {
  const token = getAuthToken(req);
  return token ? { 'Authorization': token } : {};
}

// POST so'rovlar uchun — Content-Type kerak
function getPostHeaders(req) {
  const token = getAuthToken(req);
  return token ? { 'Authorization': token, 'Content-Type': 'application/json' } : {};
}

// Production'da hech qachon soxta (mock) ma'lumot ko'rsatilmasin. Faqat lokal
// test uchun DEMO_MODE=true o'rnatilganda mock fallback ishlaydi.
const DEMO_MODE = process.env.DEMO_MODE === 'true';

// Uzum chaqiruvi muvaffaqiyatsiz bo'lganda aniq xato qaytaradi (jim mock'ga tushmaydi)
function sendUzumError(res, detail) {
  return res.status(502).json({ error: 'UZUM_API_ERROR', detail: String(detail).slice(0, 500), source: 'error' });
}

// Real Uzum product javobini frontend/hisobot kutgan (mock) shaklga keltiradi.
// Real Uzum maydonlari mock'dan farq qiladi (quantityAvailable, price, category string va h.k.)
function normalizeUzumProducts(data) {
  const rawList = data.productList || data.payload || [];
  const list = Array.isArray(rawList) ? rawList : [];
  const normalized = list.map(p => ({
    productId: p.productId,
    title: p.title || p.skuTitle || '',
    status: p.status || { value: 'UNKNOWN' },
    category: typeof p.category === 'string' ? { title: p.category } : (p.category || { title: 'Boshqa' }),
    photos: [{ photoKey: uzumImageUrl(p.previewImg || p.image) }],
    // Mahsulot darajasidagi API komissiyasi (commissionDto min==max) — SKU'da bo'lmasa zaxira sifatida
    skuList: (p.skuList || []).map(s => ({
      skuId: s.skuId,
      skuTitle: s.skuTitle || s.skuFullTitle || s.productTitle || 'SKU',
      // 13.1: Uzum RUN_OUT holatidagi SKU'larda quantityAvailable manfiy (masalan -1) qaytarishi mumkin.
      // Bu yagona normalizatsiya nuqtasi — shu yerda 0'ga cheklansak, butun tizim (backend hisob-kitoblari
      // va frontend, chunki u ham shu javobni iste'mol qiladi) avtomatik to'g'irlanadi.
      availableAmount: Math.max(0, s.quantityAvailable != null ? s.quantityAvailable : 0),
      purchasePrice: s.price != null ? s.price : (s.purchasePrice || 0),
      skuCode: s.sellerItemCode || s.article || String(s.barcode || s.skuId),
      image: uzumImageUrl(s.previewImage || s.photo || s.image), // SKU darajasidagi rasm (3.3)
      commissionApi: resolveApiCommission(s, p), // API komissiyasi: SKU commission -> commissionDto (3.1)
      quantitySold: s.quantitySold != null ? s.quantitySold : 0, // umriy cumulative — snapshot diff uchun
      quantityReturned: s.quantityReturned != null ? s.quantityReturned : 0, // umriy cumulative — snapshot diff uchun
      quantityMissing: s.quantityMissing != null ? s.quantityMissing : 0, // 8.1: Uzum'ning o'z "yo'qolgan" hisoblagichi
      quantityDefected: s.quantityDefected != null ? s.quantityDefected : 0, // 8.1: nikohli/brak hisoblagichi
      dimensionMm: resolveDimensionMm(s.skuDimension), // 4.1: API'dan uzunlik/kenglik/balandlik (mm), bo'lmasa null
      rank: (s.rankInfo && s.rankInfo.rank) || (p.rankInfo && p.rankInfo.rank) || null // 5.2: ABC toifasi
    }))
  }));
  return { payload: normalized };
}

// 4.1: Uzum API skuDimension {length,width,height} millimetrda qaytaradi (tasdiqlangan: kichik
// buyumlarda ~50-110mm oralig'i — santimetr bo'lsa hajm mantiqsiz katta chiqadi). Nol/yo'q bo'lsa null.
function resolveDimensionMm(dim) {
  if (!dim) return null;
  const l = Number(dim.length) || 0, w = Number(dim.width) || 0, h = Number(dim.height) || 0;
  if (l <= 0 || w <= 0 || h <= 0) return null;
  return { length: l, width: w, height: h };
}

// API'dan komissiya foizini oladi: (b) SKU darajasidagi commission, (c) mahsulot commissionDto (min==max). Yo'q bo'lsa null.
function resolveApiCommission(sku, product) {
  if (sku.commission != null) return Number(sku.commission);
  const dto = product.commissionDto;
  if (dto && dto.minCommission != null && dto.maxCommission != null) {
    return (Number(dto.minCommission) + Number(dto.maxCommission)) / 2;
  }
  return null;
}

// Uzum rasm URL'ini yasaydi. Sinovdan o'tgan format: /t_product_240_high.jpg (240px, ~20KB, kartochka uchun).
// Suffikssiz bazaviy URL (https://images.uzum.uz/<key>) 404 beradi — suffiks majburiy.
function uzumImageUrl(key) {
  if (!key) return '';
  // https://images.uzum.uz/<key> (suffikssiz) bo'lsa suffiks qo'shamiz
  const m = String(key).match(/^https?:\/\/images\.uzum\.uz\/([^/]+)\/?$/);
  if (m) return `https://images.uzum.uz/${m[1]}/t_product_240_high.jpg`;
  if (/^https?:\/\//.test(key)) return key; // allaqachon suffiksli to'liq URL
  return `https://images.uzum.uz/${key}/t_product_240_high.jpg`;
}

// Real Uzum /shop/:id/return javobi mijoz qaytarishi EMAS — bu FBS ombor
// logistikasi yozuvlari (id, status, type, ombor manzili). SKU, mahsulot nomi,
// narx va sabab matni bu endpointda UMUMAN YO'Q — Uzum API'da mavjud emas.
// Xavfsiz defaultlar bilan frontend kutgan shaklga keltiramiz, hech narsa o'ylab topilmaydi.
function normalizeUzumReturns(data) {
  const rawList = data.payload || data.returnList || [];
  const list = Array.isArray(rawList) ? rawList : [];
  return {
    payload: list.map(r => ({
      returnId: r.id,
      skuId: null, // Uzum bu endpointda SKU bermaydi
      productTitle: r.externalNumber ? `Qaytarish #${r.externalNumber}` : `Qaytarish #${r.id || ''}`,
      price: 0, // Uzum bu endpointda narx bermaydi
      returnDate: r.dateCreated ? new Date(r.dateCreated).toISOString() : null,
      status: r.status || 'UNKNOWN',
      defectReason: r.type ? `Turi: ${r.type}` : 'Sabab ko\'rsatilmagan'
    }))
  };
}

// Real MIJOZ qaytarishlari — /v1/return (2.4). Bu endpointda returnItems[] bor:
// skuId, skuTitle, productTitle, purchasePrice. Bare massiv qaytaradi, har yozuvda shopId bor.
// shopIds filtri server tomonda ishlamaydi — client-side filtrlanadi.
function normalizeCustomerReturns(data, shopIdFilter) {
  const list = Array.isArray(data) ? data : (data.payload || data.returnList || []);
  const rows = [];
  (Array.isArray(list) ? list : []).forEach(r => {
    if (shopIdFilter && String(r.shopId) !== String(shopIdFilter)) return; // client-side filter
    const items = r.returnItems || [];
    if (items.length === 0) {
      rows.push({
        returnId: r.id, skuId: null,
        productTitle: `Qaytarish #${r.id || ''}`,
        price: 0, amount: r.totalAmount || 0,
        returnDate: r.dateCreated ? new Date(r.dateCreated).toISOString() : null,
        status: r.status || 'UNKNOWN', shopId: r.shopId, shopTitle: r.shopTitle,
        defectReason: r.type ? `Turi: ${r.type}` : 'Sabab ko\'rsatilmagan'
      });
    } else {
      items.forEach(it => rows.push({
        returnId: r.id, skuId: it.skuId,
        productTitle: it.productTitle || it.skuTitle || `Qaytarish #${r.id || ''}`,
        price: it.purchasePrice || 0, amount: it.amount || 0,
        returnDate: r.dateCreated ? new Date(r.dateCreated).toISOString() : null,
        status: r.status || 'UNKNOWN', shopId: r.shopId, shopTitle: r.shopTitle,
        defectReason: r.type ? `Turi: ${r.type}` : 'Sabab ko\'rsatilmagan'
      }));
    }
  });
  return { payload: rows };
}

// Uzum finance endpointlari sanani epoch millisekundda kutadi (YYYY-MM-DD emas).
// Frontend YYYY-MM-DD yuboradi — shuni millisga aylantiramiz.
function financeQueryToMillis(query) {
  const params = new URLSearchParams(query);
  for (const key of ['dateFrom', 'dateTo']) {
    const val = params.get(key);
    if (val && /^\d{4}-\d{2}-\d{2}$/.test(val)) {
      // dateTo uchun kun oxirini olamiz (23:59:59.999), dateFrom uchun kun boshini
      const suffix = key === 'dateTo' ? 'T23:59:59.999Z' : 'T00:00:00.000Z';
      const millis = new Date(val + suffix).getTime();
      if (!Number.isNaN(millis)) params.set(key, String(millis));
    }
  }
  return params.toString();
}

// ============ UMUMIY UZUM FETCH (2.5: rate-limit + xato markazlashtirilgan) ============
const UZUM_BASE = 'https://api-seller.uzum.uz/api/seller-openapi';

// Server tomonda UZUM_TOKEN bilan so'rov. Rate-limit header'larini loglaydi, 429 ni alohida ushlaydi.
async function uzumGet(pathAndQuery, token) {
  token = token || process.env.UZUM_TOKEN;
  if (!token) return { ok: false, status: 0, error: "UZUM_TOKEN yo'q" };
  let response;
  try {
    response = await fetch(`${UZUM_BASE}${pathAndQuery}`, { headers: { 'Authorization': token } });
  } catch (err) {
    return { ok: false, status: 0, error: err.message };
  }
  // 2.5: kunlik limit diagnostikasi
  const remainingDay = response.headers.get('x-ratelimit-remaining-per-day');
  const limitDay = response.headers.get('x-ratelimit-limit-per-day');
  if (remainingDay != null) {
    const rem = Number(remainingDay), lim = Number(limitDay);
    if (lim > 0 && rem / lim < 0.1) console.warn(`[RATELIMIT] Kunlik limit 10% dan kam: ${rem}/${lim}`);
  }
  if (response.status === 429) {
    console.error('[RATELIMIT] 429 — Uzum limiti tugadi:', pathAndQuery);
    return { ok: false, status: 429, error: "Rate limit (429) — keyinroq urinib ko'ring" };
  }
  const text = await response.text();
  let data = null;
  try { data = JSON.parse(text); } catch { /* JSON emas */ }
  if (!response.ok) {
    return { ok: false, status: response.status, error: (data?.errors?.[0]?.message) || text.slice(0, 300), data };
  }
  return { ok: true, status: 200, data };
}

// 2.5: mahsulotlar uchun qisqa muddatli kesh (bir xil ma'lumotni qayta-qayta so'ramaslik)
const productCache = new Map(); // shopId -> { at, value }
const PRODUCT_CACHE_MS = 5 * 60 * 1000;

async function fetchLiveShopProducts(shopId, token) {
  const key = String(shopId);
  const cached = productCache.get(key);
  if (cached && Date.now() - cached.at < PRODUCT_CACHE_MS) return cached.value;
  const r = await uzumGet(`/v1/product/shop/${shopId}?page=0&size=100`, token);
  if (!r.ok && DEMO_MODE) {
    // Lokal test: token yo'q/xato bo'lsa mock (allaqachon normalizatsiyalangan shakl) bilan oqimni sinash
    const mock = String(shopId) === '72540' ? MOCK_PRODUCTS_72540 : MOCK_PRODUCTS_61122;
    return { ok: true, products: mock, source: 'mock' };
  }
  const value = r.ok
    ? { ok: true, products: normalizeUzumProducts(r.data).payload }
    : { ok: false, status: r.status, error: r.error };
  if (r.ok) productCache.set(key, { at: Date.now(), value });
  return value;
}

// ============ KUNLIK SNAPSHOT (sotuv tezligini kuzatish) ============
// snapshots.json shakli: { "<shopId>": { "YYYY-MM-DD": { "<skuId>": {sold, returned, available} } } }
function loadSnapshots() { return readJsonFile(SNAPSHOTS_FILE, {}); }

// Asia/Tashkent (UTC+5) bo'yicha bugungi sana YYYY-MM-DD
function todayTashkent() {
  return new Date(Date.now() + 5 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

// Asia/Tashkent bo'yicha joriy sana + soat + daqiqa (catch-up uchun)
function tashkentTimeParts() {
  const iso = new Date(Date.now() + 5 * 60 * 60 * 1000).toISOString();
  const [date, time] = iso.split('T');
  const [hh, mm] = time.split(':');
  return { date, hour: Number(hh), minute: Number(mm) };
}

// Bugungi snapshot sozlangan do'konlarning HECH BIRIDA yo'qmi?
function todaysSnapshotMissing() {
  const shops = syncedState.shops || [];
  if (shops.length === 0) return false; // sozlangan do'kon yo'q — tekshiradigan narsa yo'q
  const snapshots = loadSnapshots();
  const today = todayTashkent();
  return !shops.some(s => snapshots[s.shopId] && snapshots[s.shopId][today]);
}

// Har SKU uchun quantitySold/quantityReturned/available ni sana bilan diskka saqlaydi.
// 14A2: ixtiyoriy shopId — berilsa faqat o'sha do'kon yangilanadi (masalan "Bugun" so'rovi uchun,
// boshqa do'konlarga keraksiz Uzum API chaqiruvi qilinmasin).
async function captureSnapshot(onlyShopId) {
  console.log(`[SNAPSHOT] Boshlandi: ${new Date().toISOString()}${onlyShopId ? ` (faqat shop ${onlyShopId})` : ''}`);
  const snapshots = loadSnapshots();
  const date = todayTashkent();
  let savedShops = 0;
  const shopsToCapture = onlyShopId ? (syncedState.shops || []).filter(s => String(s.shopId) === String(onlyShopId)) : (syncedState.shops || []);
  for (const shop of shopsToCapture) {
    const shopId = shop.shopId;
    const r = await fetchLiveShopProducts(shopId);
    if (!r.ok) { console.warn(`[SNAPSHOT] Shop ${shopId} olinmadi: ${r.error}`); continue; }
    const skus = {};
    r.products.forEach(p => (p.skuList || []).forEach(s => {
      skus[s.skuId] = { sold: s.quantitySold || 0, returned: s.quantityReturned || 0, available: Math.max(0, s.availableAmount || 0) }; // 13.1: manfiy zaxira 0
    }));
    if (!snapshots[shopId]) snapshots[shopId] = {};
    snapshots[shopId][date] = skus;
    savedShops++;
  }
  // 60 kundan eski snapshotlarni tozalaymiz
  const cutoff = new Date(Date.now() - SNAPSHOT_RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  for (const shopId of Object.keys(snapshots)) {
    for (const d of Object.keys(snapshots[shopId])) {
      if (d < cutoff) delete snapshots[shopId][d];
    }
  }
  writeJsonFile(SNAPSHOTS_FILE, snapshots);
  console.log(`[SNAPSHOT] Tugadi: ${savedShops} do'kon, sana ${date}`);
  return { date, savedShops };
}

// 14: Berilgan do'kon uchun oxirgi ikki snapshot farqini "kechagi sotuv/qaytarish" sifatida qaytaradi.
// Snapshot yetarli bo'lmasa (< 2), null qaytadi — hisobot buni ANIQ belgilaydi.
//
// quantitySold Uzum'da NET hisoblagich — qaytarish bo'lganda KAMAYADI (tasdiqlangan: production'da
// bir nechta SKU'da quantityReturned > quantitySold, va kunlik xom delta manfiy chiqishi kuzatildi).
// Shuning uchun ikkita alohida qiymat hisoblanadi:
//   - GROSS (soldDelta = max(0, raw_sold_delta + returned_delta)) — SANOQ uchun, Uzum kabinetidagi
//     "necha dona sotildi" bilan solishtirish uchun (qaytarish shu kuni bo'lsa raw_sold's manfiyligini
//     returned_delta bekor qiladi — production'da kamera/Jaydari uchun aynan mos tekshirildi).
//   - NET (netSoldDelta = max(0, raw_sold_delta)) — PUL (daromad/foyda) uchun: qaytarilgan tovar
//     daromad/foyda bermaydi, shuning uchun faqat "saqlangan" (qaytarilmagan) birliklar hisoblanadi.
function getDailyDelta(shopId) {
  const snapshots = loadSnapshots();
  const shopSnaps = snapshots[shopId] || {};
  const dates = Object.keys(shopSnaps).sort();
  if (dates.length < 2) return { ready: false, snapshotCount: dates.length };
  const prev = shopSnaps[dates[dates.length - 2]];
  const curr = shopSnaps[dates[dates.length - 1]];
  const perSku = {};
  let totalSold = 0, totalSoldNet = 0, totalReturned = 0;
  for (const skuId of Object.keys(curr)) {
    const c = curr[skuId], p = prev[skuId] || { sold: 0, returned: 0 };
    const rawSoldDelta = (c.sold || 0) - (p.sold || 0); // manfiy bo'lishi mumkin (qaytarish net'ni kamaytiradi)
    const returnedDelta = Math.max(0, (c.returned || 0) - (p.returned || 0)); // hisoblagich reset'idan himoya
    const netSoldDelta = Math.max(0, rawSoldDelta);
    const grossSoldDelta = Math.max(0, rawSoldDelta + returnedDelta);
    perSku[skuId] = { soldDelta: grossSoldDelta, netSoldDelta, returnedDelta };
    totalSold += grossSoldDelta;
    totalSoldNet += netSoldDelta;
    totalReturned += returnedDelta;
  }
  return { ready: true, snapshotCount: dates.length, fromDate: dates[dates.length - 2], toDate: dates[dates.length - 1], totalSold, totalSoldNet, totalReturned, perSku };
}

// 5.1: Berilgan do'kon uchun so'nggi N kunlik (yoki mavjud bo'lganicha) SKU bo'yicha o'rtacha kunlik sotuv.
// Ikkita snapshot yetarli emas — kamida shu bor snapshotlar orasidagi haqiqiy kun oralig'iga bo'linadi.
function averageDailySales(shopId, days) {
  const snapshots = loadSnapshots();
  const shopSnaps = snapshots[shopId] || {};
  const dates = Object.keys(shopSnaps).sort();
  if (dates.length < 2) return { ready: false, perSku: {} };
  const window = dates.slice(-Math.min(days + 1, dates.length));
  if (window.length < 2) return { ready: false, perSku: {} };
  const first = shopSnaps[window[0]];
  const last = shopSnaps[window[window.length - 1]];
  const spanDays = window.length - 1;
  const perSku = {};
  const allSkuIds = new Set([...Object.keys(first), ...Object.keys(last)]);
  for (const skuId of allSkuIds) {
    const f = first[skuId] || { sold: 0 };
    const l = last[skuId] || { sold: 0 };
    const soldDelta = Math.max(0, (l.sold || 0) - (f.sold || 0));
    perSku[skuId] = soldDelta / spanDays;
  }
  return { ready: true, spanDays, fromDate: window[0], toDate: window[window.length - 1], perSku };
}

// B-bosqich: Uzum rasmiy "aylanma kunlari" — oxirgi 15 kunlik O'RTACHA qoldiq ÷ O'RTACHA kunlik sotuv.
// Bu kalendar yoshi EMAS: qoldiq sotuv tezligiga nisbatan necha kunga yetishini bildiradi (saqlash tarifi
// shu ko'rsatkichga qarab bosqichlanadi). Snapshot: { sold(kumulyativ), returned, available }.
// Qaytadi: { days, partial, noSales }. days=Infinity — oxirgi 15 kunda sotuv yo'q (Uzum: 361+ toifa).
// days=null — do'kon uchun snapshot tarixi umuman yo'q. partial=true — 15 kunlik tarix hali to'liq emas.
function computeTurnoverDays(shopId, skuId, snapshots) {
  snapshots = snapshots || loadSnapshots();
  const shopSnaps = snapshots[shopId] || {};
  const dates = Object.keys(shopSnaps).sort();
  const window = dates.slice(-15); // oxirgi 15 kun (mavjud bo'lganicha)
  if (window.length === 0) return { days: null, partial: true, noSales: false };
  // O'rtacha qoldiq — window ichida SKU uchragan kunlar bo'yicha
  let sumAvail = 0, availDays = 0;
  for (const d of window) {
    const rec = shopSnaps[d][skuId];
    if (rec && rec.available != null) { sumAvail += Math.max(0, rec.available); availDays++; }
  }
  const avgAvail = availDays > 0 ? sumAvail / availDays : 0;
  // O'rtacha kunlik sotuv: (oxirgi.sold − birinchi.sold) / span — averageDailySales bilan bir xil usul
  const spanDays = window.length - 1;
  const firstSold = (shopSnaps[window[0]][skuId] || {}).sold || 0;
  const lastSold = (shopSnaps[window[window.length - 1]][skuId] || {}).sold || 0;
  const avgSold = spanDays >= 1 ? Math.max(0, lastSold - firstSold) / spanDays : 0;
  const partial = window.length < 15;
  if (avgSold <= 0) return { days: Infinity, partial, noSales: true }; // sotuvsiz → 361+ toifa (Uzum qoidasi)
  return { days: avgAvail / avgSold, partial, noSales: false };
}

// 5.1/5.2/5.3/5.4: Har SKU uchun zaxira kunlari, ABC toifa, nolikvid va Xitoy buyurtma nuqtasi belgisi.
// Jonli mahsulot ro'yxati + snapshot tarixidan hisoblanadi. Sotuv tarixi yo'q bo'lsa aniq "hisoblab bo'lmaydi" qaytadi.
async function computeSkuMetrics(shopId) {
  const prod = await fetchLiveShopProducts(shopId);
  if (!prod.ok) return { ok: false, error: prod.error };
  const avg7 = averageDailySales(shopId, 7);
  const avg30 = averageDailySales(shopId, 30);
  const perSku = {};
  prod.products.forEach(p => (p.skuList || []).forEach(sku => {
    const avail = Math.max(0, sku.availableAmount || 0); // 13.1: manfiy zaxira 0
    const a7 = avg7.ready ? avg7.perSku[sku.skuId] : undefined;
    const a30 = avg30.ready ? avg30.perSku[sku.skuId] : undefined;
    const stockDays7 = (a7 != null && a7 > 0) ? avail / a7 : null;
    const stockDays30 = (a30 != null && a30 > 0) ? avail / a30 : null;
    // 5.4: Xitoy buyurtma nuqtasi — eng ishonchli mavjud ko'rsatkich (30 kunlik, bo'lmasa 7 kunlik)
    const stockDaysBest = stockDays30 != null ? stockDays30 : stockDays7;
    // 5.3: nolikvid — 30 kunlik oyna to'liq va aniq shu SKU uchun ma'lum, oxirgi 30 kunda 0 sotilgan, hozir zaxirasi bor
    const isDeadStock = avg30.ready && a30 != null && a30 === 0 && avail > 0;
    perSku[sku.skuId] = {
      productId: p.productId,
      avgDaily7: a7 != null ? a7 : null,
      avgDaily30: a30 != null ? a30 : null,
      stockDays7, stockDays30,
      canCompute: stockDaysBest != null,
      needsReorder: stockDaysBest != null && stockDaysBest <= 35, // 5.4: 28 kun yo'l + 7 kun zaxira
      isDeadStock,
      daysSinceLastSale: isDeadStock ? daysSinceLastSale(shopId, String(sku.skuId)) : null, // B3
      rank: sku.rank || null // 5.2
    };
  }));
  return { ok: true, ready7: avg7.ready, ready30: avg30.ready, spanDays7: avg7.spanDays || 0, spanDays30: avg30.spanDays || 0, perSku };
}

// B1/14A1: Moliya bo'limi uchun N kunlik (yoki mavjud snapshot oralig'icha) xulosa.
// finance/orders bu hisobda doim bo'sh qaytadi — shuning uchun snapshot delta'dan hisoblanadi
// (kunlik hisobotda ishlatilgan mantiq bilan bir xil, faqat 1 kun o'rniga butun oyna bo'yicha).
// days — so'ralgan davr uzunligi (masalan 7 = "1 hafta", 30 = "30 kun"). Snapshot tarixi qisqaroq
// bo'lsa, mavjud bo'lganicha hisoblanadi va requestedDays/actualSpanDays orqali aniq belgilanadi.
async function computeFinanceSummary(shopId, days = 30) {
  const prod = await fetchLiveShopProducts(shopId);
  if (!prod.ok) return { ok: false, error: prod.error };
  const snapshots = loadSnapshots();
  const shopSnaps = snapshots[shopId] || {};
  const dates = Object.keys(shopSnaps).sort();
  if (dates.length < 2) return { ok: true, ready: false, snapshotCount: dates.length, requestedDays: days };

  const window = dates.slice(-(days + 1));
  const first = shopSnaps[window[0]];
  const last = shopSnaps[window[window.length - 1]];
  const spanDays = window.length - 1;

  // 14: SANOQ (soldTotal) = GROSS — Uzum bilan solishtirish uchun. PUL (totalSales/Payout/...) = NET —
  // qaytarilgan tovar daromad/foyda bermaydi. Sabab: quantitySold Uzum'da NET hisoblagich (qaytarishda
  // kamayadi), shuning uchun sanoq uchun qaytarishni qo'shib qaytarib olamiz: gross = net_delta + returned_delta.
  let totalSales = 0, totalPayout = 0, totalMappedCostSum = 0, totalShipping = 0, totalStorage = 0, totalMarketingVal = 0;
  let soldTotal = 0, soldTotalNet = 0, returnedTotal = 0, unmapped = 0;
  const allSkuIds = new Set([...Object.keys(first), ...Object.keys(last)]);
  for (const skuId of allSkuIds) {
    const f = first[skuId] || { sold: 0, returned: 0 };
    const l = last[skuId] || { sold: 0, returned: 0 };
    const rawSoldDelta = (l.sold || 0) - (f.sold || 0);
    const returnedDelta = Math.max(0, (l.returned || 0) - (f.returned || 0));
    const netSoldDelta = Math.max(0, rawSoldDelta);
    const grossSoldDelta = Math.max(0, rawSoldDelta + returnedDelta);
    if (netSoldDelta === 0 && grossSoldDelta === 0) continue;
    soldTotal += grossSoldDelta;
    soldTotalNet += netSoldDelta; // 14: to'g'ri "sof" jami — gross-returned taxminidan farqli, aggregatsiyada aniq
    returnedTotal += returnedDelta;
    if (netSoldDelta === 0) continue; // pulga ta'siri yo'q (hammasi qaytarilgan)
    const { sku, product } = findSkuInProducts(prod.products, skuId);
    if (!sku) continue;
    const price = sku.purchasePrice || 0;
    const productId = product ? product.productId : null;
    const commission = price * (commissionPct(skuId, sku, productId) / 100);
    const logi = resolveLogistics(skuId, productId, sku).val;
    const turnover = computeTurnoverDays(shopId, skuId, snapshots).days;
    const stor = resolveStorage(skuId, productId, sku, turnover).val;
    const tInfo = resolveTannarx(skuId, productId);

    totalSales += price * netSoldDelta;
    totalPayout += (price - commission) * netSoldDelta;
    totalShipping += logi * netSoldDelta;
    totalStorage += stor * netSoldDelta;
    if (tInfo.source === 'unmapped') { unmapped++; continue; }
    totalMappedCostSum += tInfo.tannarx * netSoldDelta;
  }
  // Reklama: kunlik byudjet * span kun, faqat shu davrda SOF sotuvi bo'lgan SKU'lar uchun
  // (qaytarilgan tovar foyda bermagan — reklama shunday hisobda samarasiz hisoblanishi mantiqiy)
  for (const skuId of Object.keys(syncedState.costs)) {
    const dailyBudget = (syncedState.costs[skuId] || {}).budget || 0;
    if (dailyBudget <= 0) continue;
    const f = first[skuId] || { sold: 0 };
    const l = last[skuId] || { sold: 0 };
    if (Math.max(0, (l.sold || 0) - (f.sold || 0)) > 0) totalMarketingVal += dailyBudget * spanDays;
  }
  const totalProfit = totalPayout - totalShipping - totalStorage - totalMarketingVal - totalMappedCostSum;
  return {
    ok: true, ready: true, spanDays, fromDate: window[0], toDate: window[window.length - 1],
    requestedDays: days, actualSpanDays: spanDays, partial: spanDays < days, // 14A1: so'ralganidan kam bo'lsa aniq belgilanadi
    totalSales, totalPayout, totalMappedCostSum, totalShipping, totalStorage, totalMarketingVal, totalProfit,
    soldTotal, soldTotalNet, returnedTotal, unmapped
  };
}

// 14A2: "Bugun" (joriy kun, hozirgacha). Snapshot kuniga bir marta (04:50) olinadi, shuning uchun
// so'rov kelganda darhol yangi snapshot olinadi (cron kutmasdan), so'ng eng oxirgi ikkita sana
// (bugun va kecha) orasidagi farq hisoblanadi — bu computeFinanceSummary(shopId, 1) bilan aynan bir
// xil matematika (oxirgi 2 snapshot orasidagi gross/net/returned), faqat oldindan yangilangan holda.
// fetchLiveShopProducts'ning 5 daqiqalik keshi tufayli qisqa vaqt ichida qayta so'ralsa ortiqcha
// Uzum API chaqiruvi bo'lmaydi.
async function getTodaySoFarDelta(shopId) {
  const cap = await captureSnapshot(shopId);
  if (!cap.savedShops) return { ok: false, error: "Do'kon ma'lumoti olinmadi — snapshot yangilanmadi" };
  const fin = await computeFinanceSummary(shopId, 1);
  if (!fin.ok) return fin;
  return { ...fin, asOf: new Date().toISOString() }; // "hozirgacha" belgisi — to'liq kunlik EMAS
}

// ============ 18-FIX: finance/orders REAL-VAQTLI SOTUV MANBAI ============
// Diagnostika (2026-07-31) isbotladi: v1/finance/orders REAL vaqtli buyurtmalarni beradi — snapshot
// delta EMAS (u faqat QABUL QILINGACH o'sadi, shu sabab bot "1 dona", Uzum sayti "10+ buyurtma" edi).
// QOIDALAR (diagnostikadan):
//  - shopIds SHART (yo'q bo'lsa 403). Har do'kon alohida.
//  - Sana filtri (dateFrom/dateTo) ISHLAMAYDI — har qanday formatda bo'sh qaytadi. Shuning uchun
//    SANASIZ olamiz va client-side `date` (Tashkent kuni, UTC+5) bo'yicha filtrlaymiz — soatgacha aniq.
//  - status: CANCELED = bekor (sanoq va puldan CHIQADI, returnCause "Отменён до получения"),
//    qolgani (PROCESSING/TO_WITHDRAW/CREATED/DELIVERED...) = haqiqiy sotuv.
//  - Maydonlar: sellPrice=DONA narxi; commission/logisticDeliveryFee/sellerProfit=QATOR JAMISI (×amount);
//    purchasePrice=DONA tannarxi (Uzum); sellerProfit = sellPrice×amount − commission − logistics (aniq).
//  - orderId:null yozuvlar (ombor operatsiyalari) chetlab o'tiladi.
const FIN_ORDERS_TTL_MS = 5 * 60 * 1000; // rate-limit himoyasi: har do'kon 5 daqiqada bir marta so'raladi
const _finOrdersCache = {}; // shopId -> { at, orders }
async function fetchFinanceOrders(shopId) {
  const key = String(shopId);
  const now = Date.now();
  const cached = _finOrdersCache[key];
  if (cached && (now - cached.at) < FIN_ORDERS_TTL_MS) return { ok: true, orders: cached.orders, cached: true };
  const all = [];
  const size = 200;
  for (let page = 0; page < 6; page++) { // 6×200=1200 buyurtma — 30+ kunni qoplaydi
    const r = await uzumGet(`/v1/finance/orders?shopIds=${key}&page=${page}&size=${size}`, process.env.UZUM_TOKEN);
    if (!r.ok) {
      if (all.length) break; // qisman ma'lumot bor — shuni ishlatamiz (rate-limit yoki oxirgi sahifa xatosi)
      return { ok: false, status: r.status, error: r.error || `Uzum ${r.status}` };
    }
    const d = r.data || {};
    const orders = d.payload?.orders || d.orderItems || (Array.isArray(d.payload) ? d.payload : []);
    all.push(...orders);
    if (orders.length < size) break; // oxirgi sahifa
  }
  _finOrdersCache[key] = { at: now, orders: all };
  return { ok: true, orders: all, cached: false };
}

// Ixtiyoriy ms → Tashkent (UTC+5) kuni "YYYY-MM-DD"
function tashDayOf(ms) { return new Date((ms || 0) + 5 * 60 * 60 * 1000).toISOString().slice(0, 10); }
// Bugundan n kun oldingi Tashkent kuni "YYYY-MM-DD"
function tashDayMinus(n) { return new Date(Date.now() + 5 * 60 * 60 * 1000 - n * 86400000).toISOString().slice(0, 10); }

// period → [fromDay, toDay] (Tashkent kuni, inklyuziv)
function periodToDayRange(period) {
  const today = todayTashkent();
  if (period === 'today') return { fromDay: today, toDay: today, spanDays: 1 };
  if (period === 'yesterday') { const y = tashDayMinus(1); return { fromDay: y, toDay: y, spanDays: 1 }; }
  if (period === 'week') return { fromDay: tashDayMinus(6), toDay: today, spanDays: 7 };
  if (period === 'month') return { fromDay: tashDayMinus(29), toDay: today, spanDays: 30 };
  if (period === 'thismonth') { // joriy kalendar oy boshidan bugungacha (maqsad uchun)
    const fromDay = today.slice(0, 8) + '01';
    return { fromDay, toDay: today, spanDays: parseInt(today.slice(8, 10), 10) };
  }
  return null;
}

// Tannarx manbasi qatori (hisobot uchun): nechta SKU foydalanuvchi tannarxi, nechta Uzum tannarxi.
function costSourceLine(cs) {
  if (!cs) return '';
  const parts = [];
  if (cs.userSkus) parts.push(`${cs.userSkus} ta sizning tannarx`);
  if (cs.uzumSkus) parts.push(`${cs.uzumSkus} ta Uzum tannarxi`);
  if (cs.unknownSkus) parts.push(`${cs.unknownSkus} ta tannarx noma'lum`);
  return parts.length ? `🏷️ Foyda hisobida: ${parts.join(', ')}` : '';
}

// finance/orders SKU'sini jonli mahsulot SKU'siga bog'laydi va tannarx manbasini aniqlaydi.
// finance/orders'da skuId YO'Q — faqat productId + skuTitle ("JAYDAR-MINIK-КРАСН"), jonli skuTitle esa
// faqat rang ("КРАСН"). Shuning uchun productId + rang-suffiks bo'yicha bog'laymiz (skuId → skuMappings).
function normSkuText(s) { return String(s || '').toUpperCase().replace(/[^A-ZА-Я0-9]/g, ''); }
function buildSkuMatcher(products) {
  const byProduct = {}; // productId -> [{skuId, ntitle}]
  products.forEach(p => (p.skuList || []).forEach(s => {
    (byProduct[p.productId] = byProduct[p.productId] || []).push({ skuId: s.skuId, ntitle: normSkuText(s.skuTitle) });
  }));
  return function matchSkuId(productId, skuTitle) {
    const cands = byProduct[productId];
    if (!cands) return null;
    const fn = normSkuText(skuTitle);
    let m = cands.filter(c => c.ntitle && (fn.endsWith(c.ntitle) || fn.includes(c.ntitle)));
    if (m.length === 0 && cands.length === 1) m = cands; // mahsulotda yagona SKU bo'lsa — bir xil
    return m.length === 1 ? m[0].skuId : null;
  };
}

// TANNARX USTUVORLIGI (foydalanuvchi qoidasi): 1) foydalanuvchi bu SKU'ga tannarx kiritgan bo'lsa (mapping/
// qo'lda) → SIZNING tannarx; 2) kiritmagan bo'lsa → Uzum purchasePrice; 3) ikkalasi ham yo'q → noma'lum.
// HAMMA tovar foydaga kiradi — faqat tannarx MANBASI har xil.
function resolveOrderCost(order, matchSkuId) {
  const skuId = matchSkuId(order.productId, order.skuTitle);
  const t = resolveTannarx(skuId, order.productId);
  if (t.source !== 'unmapped') return { perUnit: t.tannarx, source: 'user' };
  if (order.purchasePrice > 0) return { perUnit: order.purchasePrice, source: 'uzum' };
  return { perUnit: 0, source: 'unknown' };
}

// finance/orders'dan sotuv/daromad/foyda — client-side sana filtri bilan. Tannarx yuqoridagi ustuvorlik bo'yicha.
async function computeSalesFromOrders(shopId, period) {
  const range = period && /^\d{4}-\d{2}-\d{2}$/.test(period) ? null : periodToDayRange(period);
  const { fromDay, toDay, spanDays } = range || { fromDay: period, toDay: period, spanDays: 1 };
  if (!fromDay) return { ok: false, error: `Noma'lum davr: ${period}` };
  const fo = await fetchFinanceOrders(shopId);
  if (!fo.ok) return { ok: false, error: fo.error, status: fo.status };
  const prod = await fetchLiveShopProducts(shopId); // SKU bog'lash (tannarx uchun) — 5 daq kesh
  const products = prod.ok ? prod.products : [];
  const matchSkuId = buildSkuMatcher(products);

  const inRange = fo.orders.filter(o => o.orderId != null && o.date != null);
  const dayOrders = inRange.filter(o => { const d = tashDayOf(o.date); return d >= fromDay && d <= toDay; });
  const canceled = dayOrders.filter(o => o.status === 'CANCELED');
  const valid = dayOrders.filter(o => o.status !== 'CANCELED');

  let units = 0, revenue = 0, commissionTotal = 0, logisticsTotal = 0, payout = 0, cost = 0;
  const userSkus = new Set(), uzumSkus = new Set(), unknownSkus = new Set(); // tannarx manbasi bo'yicha (aniq SKU)
  const perSku = {};
  for (const o of valid) {
    const amount = o.amount || 0;
    const c = resolveOrderCost(o, matchSkuId);
    const orderCost = c.perUnit * amount;
    const k = o.skuTitle || String(o.productId);
    if (c.source === 'user') userSkus.add(k); else if (c.source === 'uzum') uzumSkus.add(k); else unknownSkus.add(k);
    units += amount;
    revenue += (o.sellPrice || 0) * amount;
    commissionTotal += o.commission || 0;
    logisticsTotal += o.logisticDeliveryFee || 0;
    payout += o.sellerProfit || 0;
    cost += orderCost;
    if (!perSku[k]) perSku[k] = { title: k, units: 0, revenue: 0, payout: 0, profit: 0, costSource: c.source };
    perSku[k].units += amount;
    perSku[k].revenue += (o.sellPrice || 0) * amount;
    perSku[k].payout += o.sellerProfit || 0;
    perSku[k].profit += (o.sellerProfit || 0) - orderCost;
  }
  const profit = payout - cost;
  return {
    ok: true, ready: true, source: 'finance-orders', period, fromDay, toDay, spanDays,
    orders: valid.length, canceledCount: canceled.length, units,
    revenue, commissionTotal, logisticsTotal, payout, cost, profit,
    // tannarx manbasi bo'yicha (aniq SKU soni) — ko'rsatish uchun
    costSource: { userSkus: userSkus.size, uzumSkus: uzumSkus.size, unknownSkus: unknownSkus.size },
    perSku,
    // eski renderer'lar bilan moslik uchun alias'lar (aniq, "kamida" emas):
    totalSales: revenue, totalProfit: profit, soldTotal: units, soldTotalNet: units,
    actualSpanDays: spanDays, requestedDays: spanDays, partial: false,
    fromDate: fromDay, toDate: toDay
  };
}

// 14A3: barcha davrlar uchun YAGONA javob shakli — bot va dashboard bir xil renderer ishlatsin.
// period: today | yesterday | week | month
async function computePeriodReport(shopId, period) {
  const shop = (syncedState.shops || []).find(s => String(s.shopId) === String(shopId));
  const shopTitle = shop ? shop.shopTitle : `Shop ${shopId}`;
  // 18-FIX: SOTUV/DAROMAD endi finance/orders'dan (real vaqtli, aniq) — snapshot delta EMAS.
  if (!['today', 'yesterday', 'week', 'month'].includes(period)) return { ok: false, error: `Noma'lum davr: ${period}` };
  const fin = await computeSalesFromOrders(shopId, period);
  if (!fin.ok) return fin;
  return { ...fin, period, shopId: shop ? shop.shopId : shopId, shopTitle };
}

// B3: berilgan SKU oxirgi marta necha kun oldin sotilgani (snapshot tarixidan). Umuman sotuv
// ko'rinmasa (butun saqlangan tarix davomida) — null qaytadi, "taxmin qilinmaydi".
function daysSinceLastSale(shopId, skuId) {
  const snapshots = loadSnapshots();
  const shopSnaps = snapshots[shopId] || {};
  const dates = Object.keys(shopSnaps).sort();
  if (dates.length < 2) return null;
  let lastSaleDate = null;
  for (let i = 1; i < dates.length; i++) {
    const prev = shopSnaps[dates[i - 1]][skuId];
    const curr = shopSnaps[dates[i]][skuId];
    if (!curr) continue;
    const soldDelta = (curr.sold || 0) - ((prev && prev.sold) || 0);
    if (soldDelta > 0) lastSaleDate = dates[i];
  }
  if (!lastSaleDate) return null;
  const diffMs = new Date(todayTashkent()) - new Date(lastSaleDate);
  return Math.round(diffMs / (24 * 60 * 60 * 1000));
}

// E: Keyingi 30 kunlik bashorat — 7 va 30 kunlik o'rtacha sotuvning O'RTACHASI (bir kunlik sakrash
// bashoratni buzmasin), faqat hozir zaxirasi bor SKU'lar hisobga olinadi. Ishonch darajasi umumiy
// snapshot tarixi uzunligiga qarab belgilanadi (E2, majburiy).
function forecastConfidence(snapshotDays) {
  if (snapshotDays < 7) return { level: 'none', pct: null };
  if (snapshotDays <= 14) return { level: 'low', pct: 40 };
  if (snapshotDays <= 30) return { level: 'medium', pct: 25 };
  return { level: 'good', pct: 15 };
}

async function computeForecast(shopId) {
  const prod = await fetchLiveShopProducts(shopId);
  if (!prod.ok) return { ok: false, error: prod.error };
  const snapshots = loadSnapshots();
  const shopSnaps = snapshots[shopId] || {};
  const snapshotDays = Object.keys(shopSnaps).length;
  const confidence = forecastConfidence(snapshotDays);
  if (confidence.level === 'none') {
    return { ok: true, ready: false, snapshotDays, confidence: confidence.level };
  }

  const avg7 = averageDailySales(shopId, 7);
  const avg30 = averageDailySales(shopId, 30);
  let dailySales = 0, dailyProfit = 0;
  prod.products.forEach(p => (p.skuList || []).forEach(sku => {
    if ((sku.availableAmount || 0) <= 0) return; // faqat zaxirasi bor SKU'lar
    const a7 = avg7.ready ? avg7.perSku[sku.skuId] : undefined;
    const a30 = avg30.ready ? avg30.perSku[sku.skuId] : undefined;
    let avgDaily;
    if (a7 != null && a30 != null) avgDaily = (a7 + a30) / 2;
    else if (a7 != null) avgDaily = a7;
    else if (a30 != null) avgDaily = a30;
    else return;
    if (avgDaily <= 0) return;

    const price = sku.purchasePrice || 0;
    const productId = p.productId;
    const commission = price * (commissionPct(sku.skuId, sku, productId) / 100);
    const logi = resolveLogistics(sku.skuId, productId, sku).val;
    const turnover = computeTurnoverDays(shopId, sku.skuId, snapshots).days;
    const stor = resolveStorage(sku.skuId, productId, sku, turnover).val;
    const tInfo = resolveTannarx(sku.skuId, productId);
    const profitPerUnit = price - commission - logi - stor - tInfo.tannarx;

    dailySales += avgDaily * price;
    dailyProfit += avgDaily * profitPerUnit;
  }));

  return {
    ok: true, ready: true, snapshotDays, confidence: confidence.level, confidencePct: confidence.pct,
    forecastSales: dailySales * 30, forecastProfit: dailyProfit * 30
  };
}

// 1. Service: State sync for Bot calculations
app.post('/api/sync-state', (req, res) => {
  const { productTypes, skuMappings, costs, shops, activeShop, productSettings, products, orders, expenses } = req.body;

  // B (server himoya): kelayotgan sozlama BO'SH (0 do'kon, 0 productType) bo'lsa,
  // va bizda mavjud sozlama bo'lsa — RAD ETAMIZ (bo'sh state saqlangan ma'lumotni o'chirmasin).
  const incomingHasSettings = productTypes !== undefined || shops !== undefined;
  if (incomingHasSettings) {
    const incomingEmpty = (shops !== undefined ? shops.length === 0 : (syncedState.shops||[]).length === 0)
                       && (productTypes !== undefined ? productTypes.length === 0 : (syncedState.productTypes||[]).length === 0);
    if (incomingEmpty && !isSettingsEmpty(currentSettings())) {
      console.warn('[SETTINGS] RAD ETILDI: frontend bo\'sh sozlama yubordi, mavjud sozlama saqlanib qoldi.');
      // Faqat jonli ma'lumotni yangilaymiz, sozlamaga tegmaymiz
      if (products) syncedState.products = products;
      if (orders) syncedState.orders = orders;
      if (expenses) syncedState.expenses = expenses;
      return res.json({ success: true, rejected: 'empty-settings', message: "Bo'sh sozlama rad etildi, mavjudi saqlandi." });
    }
  }

  let settingsChanged = false;
  if (productTypes) { syncedState.productTypes = productTypes; settingsChanged = true; }
  if (skuMappings) { syncedState.skuMappings = skuMappings; settingsChanged = true; }
  if (costs) { syncedState.costs = costs; settingsChanged = true; }
  if (shops) { syncedState.shops = shops; settingsChanged = true; }
  if (activeShop) { syncedState.activeShop = activeShop; settingsChanged = true; }
  if (productSettings) { syncedState.productSettings = productSettings; settingsChanged = true; }
  if (products) syncedState.products = products;
  if (orders) syncedState.orders = orders;
  if (expenses) syncedState.expenses = expenses;
  // Faqat sozlamalar o'zgarganda diskga yozamiz (2.2) — sotuv/mahsulot ma'lumoti saqlanmaydi
  if (settingsChanged) saveSettings();
  res.json({ success: true, message: "State synced successfully server-side." });
});

// B: frontend yuklanishda serverdagi sozlamalarni O'QIYDI (bo'sh localStorage ustidan yozmasin)
app.get('/api/settings', (req, res) => {
  res.json(currentSettings());
});

// 18-A4: MOLIYA ma'lumotlarini yozish — FAQAT aniq foydalanuvchi harakati (qo'shish/o'chirish/tahrir).
// Kelgan kalitlar (withdrawals/userExpenses/credits/goals) syncedState'ga yoziladi va diskka saqlanadi
// (mavjud himoya: backupSettings + saveSettings). Sozlamalar (do'kon/tannarx)ga TEGMAYDI.
//
// XAVFSIZLIK (2026-08-02 hodisasi — haqiqiy foydalanuvchi ma'lumoti tasodifan bo'shatildi): eski
// isSettingsEmpty() himoyasi FAQAT shops/productTypes'ni tekshirar edi, moliya kalitlarini UMUMAN
// himoyalamas edi. Endi: mavjud (bo'sh bo'lmagan) massivni bo'sh massiv bilan almashtirish FAQAT
// foydalanuvchi aniq shu kalitni tozalashni tasdiqlagan bo'lsa (masalan, oxirgi yozuvni o'chirish
// tugmasi — _confirmClear ro'yxatida) ruxsat etiladi. Aks holda RAD ETILADI (409) — eskirgan tab,
// tashqi so'rov yoki diagnostika chaqiruvi haqiqiy ma'lumotni tasodifan o'chirib yubormasin.
app.post('/api/finance-data', (req, res) => {
  const FINANCE_KEYS = ['withdrawals', 'userExpenses', 'credits', 'goals'];
  const confirmClear = new Set(Array.isArray(req.body._confirmClear) ? req.body._confirmClear : []);
  const sentKeys = FINANCE_KEYS.filter(k => Array.isArray(req.body[k]));
  if (sentKeys.length === 0) return res.status(400).json({ error: "Hech qanday moliya kaliti yuborilmadi" });

  for (const k of sentKeys) {
    const willBeEmpty = req.body[k].length === 0;
    const currentlyHasData = (syncedState[k] || []).length > 0;
    if (willBeEmpty && currentlyHasData && !confirmClear.has(k)) {
      console.warn(`[FINANCE-DATA] RAD ETILDI: "${k}" bo'sh yuborildi (serverda ${syncedState[k].length} ta yozuv bor edi, tasdiqlanmagan) — himoya.`);
      return res.status(409).json({ error: `"${k}" ni bo'shatish tasdiqlanmadi — mavjud ${syncedState[k].length} ta yozuv saqlanib qoldi.`, rejectedKey: k, currentCount: syncedState[k].length });
    }
  }

  for (const k of sentKeys) syncedState[k] = req.body[k];
  saveSettings();
  res.json({ success: true, withdrawals: syncedState.withdrawals.length, userExpenses: syncedState.userExpenses.length, credits: syncedState.credits.length, goals: syncedState.goals.length });
});

// XAVFSIZLIK DIAGNOSTIKASI (vaqtinchalik): zaxira faylining moliya kalitlarini FAQAT O'QIYDI —
// syncedState'ga TEGMAYDI, saveSettings() chaqirmaydi. /restore'dan farqli — bu hech narsani yozmaydi.
app.get('/api/settings/backup-peek', (req, res) => {
  const file = (req.query.file || 'settings.backup.json').toString();
  if (!/^settings(\.\d{4}-\d{2}-\d{2})?\.(backup\.)?json$/.test(file) || file.includes('/') || file.includes('..')) {
    return res.status(400).json({ error: "Noto'g'ri fayl nomi" });
  }
  const full = path.join(DATA_DIR, file);
  const data = readJsonFile(full, null);
  if (!data) return res.status(404).json({ error: "Fayl topilmadi" });
  res.json({
    file, shops: (data.shops || []).length, productTypesCount: (data.productTypes || []).length,
    withdrawals: data.withdrawals || [], userExpenses: data.userExpenses || [],
    credits: data.credits || [], goals: data.goals || []
  });
});

// C: zaxiralar ro'yxati va tiklash
app.get('/api/settings/backups', (req, res) => {
  try {
    const files = fs.existsSync(DATA_DIR)
      ? fs.readdirSync(DATA_DIR).filter(f => /^settings(\.\d{4}-\d{2}-\d{2})?\.(backup\.)?json$/.test(f) && f !== 'settings.json')
      : [];
    res.json({ backups: files });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// C: zaxiradan tiklash — ?file=settings.backup.json yoki settings.2026-07-20.json
app.post('/api/settings/restore', (req, res) => {
  const file = (req.query.file || req.body?.file || 'settings.backup.json').toString();
  if (!/^settings(\.\d{4}-\d{2}-\d{2})?\.(backup\.)?json$/.test(file) || file.includes('/') || file.includes('..')) {
    return res.status(400).json({ error: "Noto'g'ri fayl nomi" });
  }
  const full = path.join(DATA_DIR, file);
  const data = readJsonFile(full, null);
  if (!data || isSettingsEmpty(data)) return res.status(404).json({ error: "Zaxira topilmadi yoki bo'sh" });
  for (const k of SETTINGS_KEYS) if (data[k] !== undefined) syncedState[k] = data[k];
  saveSettings();
  console.log(`[SETTINGS] Zaxiradan tiklandi: ${file}`);
  res.json({ success: true, restored: file, shops: (data.shops||[]).length, productTypes: (data.productTypes||[]).length });
});

// 19-A DIAGNOSTIKA (o'qish uchun, vaqtinchalik): Uzum TA'MINLASH (invoice) API'sini tekshirish.
// Hech narsa yozmaydi/o'zgartirmaydi — Uzum'dan RAW javobni qaytaradi (tuzilmani ko'rish uchun).
app.get('/api/uzum/invoice', async (req, res) => {
  const token = getAuthToken(req);
  if (!token) return sendUzumError(res, "UZUM_TOKEN sozlanmagan");
  const qs = new URLSearchParams(req.query).toString();
  const r = await uzumGet(`/v1/invoice${qs ? '?' + qs : ''}`, token);
  if (!r.ok) return sendUzumError(res, `Uzum ${r.status}: ${r.error}`);
  res.json({ ...r.data, source: 'live' });
});
app.get('/api/uzum/shop/:shopId/invoice', async (req, res) => {
  const token = getAuthToken(req);
  if (!token) return sendUzumError(res, "UZUM_TOKEN sozlanmagan");
  const qs = new URLSearchParams(req.query).toString();
  const r = await uzumGet(`/v1/shop/${req.params.shopId}/invoice${qs ? '?' + qs : ''}`, token);
  if (!r.ok) return sendUzumError(res, `Uzum ${r.status}: ${r.error}`);
  res.json({ ...r.data, source: 'live' });
});
app.get('/api/uzum/shop/:shopId/invoice/products', async (req, res) => {
  const token = getAuthToken(req);
  if (!token) return sendUzumError(res, "UZUM_TOKEN sozlanmagan");
  const qs = new URLSearchParams(req.query).toString();
  const r = await uzumGet(`/v1/shop/${req.params.shopId}/invoice/products${qs ? '?' + qs : ''}`, token);
  if (!r.ok) return sendUzumError(res, `Uzum ${r.status}: ${r.error}`);
  res.json({ ...r.data, source: 'live' });
});

// 2. Proxies / Mimics for Uzum Seller API
// Hech biri jim mock'ga tushmaydi: token yo'q yoki Uzum xato qaytarsa — aniq 502 xato,
// faqat DEMO_MODE=true bo'lganda mock ishlatiladi (lokal test uchun).
app.get('/api/uzum/shops', async (req, res) => {
  const headers = getGetHeaders(req);
  if (Object.keys(headers).length === 0) {
    if (DEMO_MODE) return res.json({ payload: MOCK_SHOPS, source: 'mock' });
    return sendUzumError(res, "UZUM_TOKEN sozlanmagan");
  }
  try {
    const response = await fetch('https://api-seller.uzum.uz/api/seller-openapi/v1/shops', { headers });
    if (!response.ok) {
      const text = await response.text();
      console.warn(`Uzum Shops call ${response.status}:`, text);
      if (DEMO_MODE) return res.json({ payload: MOCK_SHOPS, source: 'mock' });
      return sendUzumError(res, `Uzum ${response.status}: ${text}`);
    }
    const data = await response.json();
    // Real javob bare massiv: [{id, name}]. Frontend { payload: [...] } kutadi.
    const list = Array.isArray(data) ? data : (data.payload || []);
    return res.json({ payload: list, source: 'live' });
  } catch (err) {
    console.warn("Real Uzum Shops call failed:", err);
    if (DEMO_MODE) return res.json({ payload: MOCK_SHOPS, source: 'mock' });
    return sendUzumError(res, err.message);
  }
});

app.get('/api/uzum/product/shop/:shopId', async (req, res) => {
  const shopId = req.params.shopId;
  const headers = getGetHeaders(req);
  if (Object.keys(headers).length === 0) {
    if (DEMO_MODE) return res.json({ payload: shopId === '72540' ? MOCK_PRODUCTS_72540 : MOCK_PRODUCTS_61122, source: 'mock' });
    return sendUzumError(res, "UZUM_TOKEN sozlanmagan");
  }
  try {
    // Uzum product endpoint pagination parametrlarini majburiy talab qiladi
    const page = req.query.page || 0;
    const size = req.query.size || 100;
    const response = await fetch(`https://api-seller.uzum.uz/api/seller-openapi/v1/product/shop/${shopId}?page=${page}&size=${size}`, { headers });
    if (!response.ok) {
      const text = await response.text();
      console.warn(`Uzum Products call ${response.status}:`, text);
      if (DEMO_MODE) return res.json({ payload: shopId === '72540' ? MOCK_PRODUCTS_72540 : MOCK_PRODUCTS_61122, source: 'mock' });
      return sendUzumError(res, `Uzum ${response.status}: ${text}`);
    }
    const data = await response.json();
    // Real javobni frontend kutgan { payload: [...] } shakliga normallashtiramiz
    return res.json({ ...normalizeUzumProducts(data), source: 'live' });
  } catch (err) {
    console.warn("Real Uzum Products call failed:", err);
    if (DEMO_MODE) return res.json({ payload: shopId === '72540' ? MOCK_PRODUCTS_72540 : MOCK_PRODUCTS_61122, source: 'mock' });
    return sendUzumError(res, err.message);
  }
});

app.get('/api/uzum/finance/orders', async (req, res) => {
  const headers = getGetHeaders(req);
  if (Object.keys(headers).length === 0) {
    if (DEMO_MODE) return res.json({ payload: { orders: MOCK_ORDERS }, source: 'mock' });
    return sendUzumError(res, "UZUM_TOKEN sozlanmagan");
  }
  try {
    const query = financeQueryToMillis(new URLSearchParams(req.query).toString());
    const response = await fetch(`https://api-seller.uzum.uz/api/seller-openapi/v1/finance/orders?${query}`, { headers });
    if (!response.ok) {
      const text = await response.text();
      console.warn(`Uzum Finance Orders call ${response.status}:`, text);
      if (DEMO_MODE) return res.json({ payload: { orders: MOCK_ORDERS }, source: 'mock' });
      return sendUzumError(res, `Uzum ${response.status}: ${text}`);
    }
    const data = await response.json();
    // Real javob: { orderItems: [...] }. Frontend { payload: { orders: [...] } } kutadi.
    const orders = data.orderItems || data.payload?.orders || (Array.isArray(data.payload) ? data.payload : []);
    return res.json({ payload: { orders: Array.isArray(orders) ? orders : [] }, source: 'live' });
  } catch (err) {
    console.warn("Real Uzum Finance Orders call failed:", err);
    if (DEMO_MODE) return res.json({ payload: { orders: MOCK_ORDERS }, source: 'mock' });
    return sendUzumError(res, err.message);
  }
});

app.get('/api/uzum/finance/expenses', async (req, res) => {
  const headers = getGetHeaders(req);
  if (Object.keys(headers).length === 0) {
    if (DEMO_MODE) return res.json({ payload: MOCK_EXPENSES, source: 'mock' });
    return sendUzumError(res, "UZUM_TOKEN sozlanmagan");
  }
  try {
    const query = financeQueryToMillis(new URLSearchParams(req.query).toString());
    const response = await fetch(`https://api-seller.uzum.uz/api/seller-openapi/v1/finance/expenses?${query}`, { headers });
    if (!response.ok) {
      const text = await response.text();
      console.warn(`Uzum Finance Expenses call ${response.status}:`, text);
      if (DEMO_MODE) return res.json({ payload: MOCK_EXPENSES, source: 'mock' });
      return sendUzumError(res, `Uzum ${response.status}: ${text}`);
    }
    const data = await response.json();
    // Real javob: { payload: { payments: [...], totalElements: N } }. Frontend eData.payload ni massiv sifatida kutadi.
    const expenses = data.payload?.payments || data.payments || data.payload || data.expenses || data.expenseItems || [];
    return res.json({ payload: Array.isArray(expenses) ? expenses : [], source: 'live' });
  } catch (err) {
    console.warn("Real Uzum Finance Expenses call failed:", err);
    if (DEMO_MODE) return res.json({ payload: MOCK_EXPENSES, source: 'mock' });
    return sendUzumError(res, err.message);
  }
});

app.get('/api/uzum/shop/:shopId/return', async (req, res) => {
  const shopId = req.params.shopId;
  const headers = getGetHeaders(req);
  if (Object.keys(headers).length === 0) {
    if (DEMO_MODE) return res.json({ payload: MOCK_RETURNS, source: 'mock' });
    return sendUzumError(res, "UZUM_TOKEN sozlanmagan");
  }
  try {
    const response = await fetch(`https://api-seller.uzum.uz/api/seller-openapi/v1/shop/${shopId}/return`, { headers });
    if (!response.ok) {
      const text = await response.text();
      console.warn(`Uzum Returns call ${response.status}:`, text);
      if (DEMO_MODE) return res.json({ payload: MOCK_RETURNS, source: 'mock' });
      return sendUzumError(res, `Uzum ${response.status}: ${text}`);
    }
    const data = await response.json();
    return res.json({ ...normalizeUzumReturns(data), source: 'live' });
  } catch (err) {
    console.warn("Real Uzum Returns call failed:", err);
    if (DEMO_MODE) return res.json({ payload: MOCK_RETURNS, source: 'mock' });
    return sendUzumError(res, err.message);
  }
});

app.get('/api/uzum/fbs/orders', async (req, res) => {
  const headers = getGetHeaders(req);
  if (Object.keys(headers).length === 0) {
    if (DEMO_MODE) return res.json({ payload: [], source: 'mock' });
    return sendUzumError(res, "UZUM_TOKEN sozlanmagan");
  }
  try {
    const response = await fetch(`https://api-seller.uzum.uz/api/seller-openapi/v2/fbs/orders`, { headers });
    if (!response.ok) {
      const text = await response.text();
      console.warn(`Uzum FBS Orders call ${response.status}:`, text);
      if (DEMO_MODE) return res.json({ payload: [], source: 'mock' });
      return sendUzumError(res, `Uzum ${response.status}: ${text}`);
    }
    const data = await response.json();
    return res.json({ ...data, source: 'live' });
  } catch (err) {
    console.warn("Real Uzum FBS Orders call failed:", err);
    if (DEMO_MODE) return res.json({ payload: [], source: 'mock' });
    return sendUzumError(res, err.message);
  }
});

// 2.4: HAQIQIY mijoz qaytarishlari — /v1/return (returnItems bilan). shopId query bilan client-side filtr.
app.get('/api/uzum/return', async (req, res) => {
  const token = getAuthToken(req);
  if (!token) {
    if (DEMO_MODE) return res.json({ payload: [], source: 'mock' });
    return sendUzumError(res, "UZUM_TOKEN sozlanmagan");
  }
  const shopId = req.query.shopId;
  const page = req.query.page || 0;
  const size = req.query.size || 50;
  const r = await uzumGet(`/v1/return?page=${page}&size=${size}`, token);
  if (!r.ok) {
    if (DEMO_MODE) return res.json({ payload: [], source: 'mock' });
    return sendUzumError(res, `Uzum ${r.status}: ${r.error}`);
  }
  return res.json({ ...normalizeCustomerReturns(r.data, shopId), source: 'live' });
});

// 3. Gemini Server AI Advice Engine
// 18-C2: AI moliyaviy murabbiy uchun TO'LIQ kontekst — server tomonda yig'iladi (frontend'dan emas).
// Do'kon holati (per-SKU metrikalar), naqd oqim, kreditlar, xarajat trendi, bashorat, maqsad, Uzum muammolari.
// Token tejash uchun: eng muhim SKU'lar (A-toifa / kam zaxira / nolikvid / bloklangan) va qisqa matn.
async function buildAiContext(shopId) {
  shopId = shopId || syncedState.activeShop;
  const shop = (syncedState.shops || []).find(s => String(s.shopId) === String(shopId));
  const shopTitle = shop ? shop.shopTitle : `Shop ${shopId}`;
  const lines = [];

  const prod = await fetchLiveShopProducts(shopId);
  const metrics = await computeSkuMetrics(shopId);
  const snapshots = loadSnapshots(); // B-bosqich: saqlash tarifi uchun aylanma kunlari
  const problems = []; // D0: faol Uzum muammolari

  if (prod.ok && metrics.ok) {
    const skuRows = [];
    prod.products.forEach(p => {
      const isBanned = p.status?.value === 'PERM_BANNED';
      (p.skuList || []).forEach(sku => {
        const avail = Math.max(0, sku.availableAmount || 0);
        const m = metrics.perSku[sku.skuId] || {};
        const price = sku.purchasePrice || 0;
        const productId = p.productId;
        const commission = price * (commissionPct(sku.skuId, sku, productId) / 100);
        const logi = resolveLogistics(sku.skuId, productId, sku).val;
        const turnover = computeTurnoverDays(shopId, sku.skuId, snapshots).days;
        const stor = resolveStorage(sku.skuId, productId, sku, turnover).val;
        const tInfo = resolveTannarx(sku.skuId, productId);
        const profit = price - commission - logi - stor - tInfo.tannarx;
        const margin = price > 0 ? (profit / price) * 100 : 0;
        const stockDays = m.canCompute ? (m.stockDays30 != null ? m.stockDays30 : m.stockDays7) : null;
        skuRows.push({ title: sku.skuTitle, rank: sku.rank, avail, stockDays, avgDaily: m.avgDaily30 != null ? m.avgDaily30 : m.avgDaily7, price, profit, margin, isDeadStock: m.isDeadStock, needsReorder: m.needsReorder, isBanned, blockReason: (sku.skuBlockReason && sku.skuBlockReason.title) || (isBanned ? 'bloklangan' : null) });
        // D0 muammolar
        if (isBanned) problems.push(`🚫 ${sku.skuTitle} bloklangan${sku.skuBlockReason?.title ? ' — ' + sku.skuBlockReason.title : ''}`);
        else if (avail <= 0 && sku.rank === 'A') problems.push(`🔴 ${sku.skuTitle} (A toifa) tugadi — TOPdan tushmoqda`);
        else if (stockDays != null && stockDays < 3) problems.push(`🟠 ${sku.skuTitle} ${stockDays.toFixed(0)} kunda tugaydi`);
        if (m.isDeadStock && avail > 0) problems.push(`❄️ ${sku.skuTitle} nolikvid (${fmtMoney(tInfo.tannarx * avail)} so'm qotgan)`);
      });
    });
    // Eng muhim SKU'lar: A-toifa yoki kam zaxira yoki nolikvid yoki bloklangan
    const important = skuRows.filter(r => r.rank === 'A' || (r.stockDays != null && r.stockDays < 14) || r.isDeadStock || r.isBanned || r.needsReorder).slice(0, 20);
    lines.push(`## DO'KON: ${shopTitle}`);
    lines.push(`Muhim SKU'lar (${important.length} ta ko'rsatilyapti):`);
    important.forEach(r => {
      lines.push(`- ${r.title} | ABC:${r.rank || '?'} | zaxira:${r.avail} dona | ${r.stockDays != null ? r.stockDays.toFixed(0) + ' kunga yetadi' : 'sotuv tarixi yo\'q'} | kunlik:${r.avgDaily != null ? r.avgDaily.toFixed(1) : '?'} | narx:${fmtMoney(r.price)} | sof foyda/dona:${fmtMoney(r.profit)} (marja ${r.margin.toFixed(0)}%)${r.isDeadStock ? ' | NOLIKVID' : ''}${r.needsReorder ? ' | XITOY BUYURTMA KERAK' : ''}${r.isBanned ? ' | BLOKLANGAN' : ''}`);
    });
  } else {
    lines.push(`## DO'KON: ${shopTitle} — Uzum ma'lumoti olinmadi (${prod.error || metrics.error})`);
  }

  // 18-FIX: Oylik aylanma — finance/orders (30 kun, real vaqtli, aniq)
  const fin = await computeSalesFromOrders(shopId, 'month');
  if (fin.ok) {
    lines.push(`\n## OYLIK AYLANMA (oxirgi 30 kun, aniq):`);
    lines.push(`Sotildi: ${fin.units} dona (${fin.orders} buyurtma, ${fin.canceledCount} bekor) | Aylanma: ${fmtMoney(fin.revenue)} so'm | Uzum to'lovi: ${fmtMoney(fin.payout)} so'm | Sof foyda: ${fmtMoney(fin.profit)} so'm`);
  }

  // Bashorat
  const fc = await computeForecast(shopId);
  if (fc.ok && fc.ready) {
    lines.push(`\n## BASHORAT (keyingi 30 kun, ishonch: ${fc.confidence}):`);
    lines.push(`Kutilayotgan aylanma: ~${fmtMoney(fc.forecastSales)} so'm | sof foyda: ~${fmtMoney(fc.forecastProfit)} so'm`);
  }

  // Naqd oqim + kreditlar + xarajatlar (barcha do'konlar uchun umumiy — moliya do'konga bog'liq emas)
  const cf = await computeCashFlow();
  if (cf.ok) {
    lines.push(`\n## NAQD OQIM (bu oy, barcha do'konlar):`);
    lines.push(`Yechib olingan (keldi): ${fmtMoney(cf.withdrawnCame)} | Kutilmoqda: ${fmtMoney(cf.withdrawnPending)}`);
    lines.push(`Real xarajatlar: ${fmtMoney(cf.expensesTotal)} so'm${Object.keys(cf.expensesByCategory).length ? ' (' + Object.entries(cf.expensesByCategory).map(([c, a]) => c + ': ' + fmtMoney(a)).join(', ') + ')' : ''}`);
    lines.push(`Kredit oylik yuki: ${fmtMoney(cf.creditMonthly)} | Qolgan umumiy qarz: ${fmtMoney(cf.creditRemaining)}`);
    lines.push(`SOF NAQD OQIM: ${fmtMoney(cf.netCashFlow)} so'm (${cf.netCashFlow >= 0 ? 'FOYDA' : 'ZARAR'})`);
    if (cf.projection) lines.push(`Proyeksiya: kutilayotgan kredit ${fmtMoney(cf.projection.upcomingCredits)} vs bashorat foyda ${fmtMoney(cf.projection.expectedIncome)} → ${cf.projection.verdict}`);
  }
  // Kreditlar — keyingi to'lov sanalari
  if ((syncedState.credits || []).length) {
    lines.push(`\n## KREDITLAR:`);
    syncedState.credits.forEach(c => lines.push(`- ${c.name} (${c.type || 'fixed'}): oylik ${fmtMoney(c.monthlyPayment)}, keyingi to'lov ${c.nextPaymentDate || '?'} (${creditDaysUntilDue(c)} kundan keyin), qolgan qarz ${fmtMoney(c.remainingAmount)}`));
  }
  // Maqsad
  const goal = (syncedState.goals || [])[0];
  if (goal) lines.push(`\n## MAQSAD: oylik aylanma ${fmtMoney(goal.target)} so'm`);

  // D0 muammolar
  if (problems.length) {
    lines.push(`\n## FAOL UZUM MUAMMOLARI (${problems.length} ta):`);
    problems.slice(0, 12).forEach(p => lines.push(`- ${p}`));
  }

  // 19-D: ta'minlash (yuk xatlari) — yo'lda tovar + kompensatsiya nomzodlari (barcha do'kon uchun umumiy)
  try {
    const invSum = await computeInvoicesSummary();
    if (invSum.ok && invSum.inTransitUnits > 0) lines.push(`\n## TA'MINLASH: hozir yo'lda ${invSum.inTransitUnits} dona tovar (Uzum omboriga kirmoqda).`);
    const comp = await computeCompensationCandidates();
    if (comp.ok && comp.total.units > 0) lines.push(`## KOMPENSATSIYA NOMZODI: ~${comp.aniq.units} dona haqiqiy yo'qolgan (~${fmtMoney(comp.aniq.value)} so'm, sotuv−komissiya; qayta saralanganlar chiqarilgan)${comp.qisman.units ? ` + ${comp.qisman.units} dona qisman aniqlanmagan` : ''} — Uzum kabinetida tekshirish tavsiya etiladi (kafolatlangan emas).`);
  } catch (e) { /* invoice AI kontekstga majburiy emas */ }

  return { text: lines.join('\n'), shopTitle, hasData: prod.ok, problems };
}

// 19-G: Gemini'ni chaqirib, JSON javobni parse qiladi. maxOutputTokens aniq belgilangan (avval yo'q edi —
// uzun prompt ba'zan javobni chiqish limitiga yetkazib, JSON'ni kesib qo'yardi).
async function callGeminiJson(ai, promptText) {
  const response = await ai.models.generateContent({
    model: 'gemini-3.5-flash',
    contents: promptText,
    config: { responseMimeType: 'application/json', maxOutputTokens: 8192 }
  });
  const responseText = response.text || '';
  try {
    return JSON.parse(responseText.trim());
  } catch (parseErr) {
    const cleanText = responseText.replace(/```json/gi, '').replace(/```/g, '').trim();
    return JSON.parse(cleanText);
  }
}

// 18-C: AI MOLIYAVIY MURABBIY — eski oddiy maslahatchi butunlay qayta yozildi.
// Umumiy funksiya: ham /api/gemini/advice endpointi, ham bot /maslahat buyrug'i ishlatadi.
async function generateAiAdvice(shopId) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return { ok: false, error: "GEMINI_API_KEY sozlanmagan (Railway Variables'da bo'lishi kerak)." };
  }
  try {
    const ctx = await buildAiContext(shopId);
    const kb = loadKnowledgeBase().replace(/## 6\. RAQOBATCHILAR[\s\S]*?(?=\n## 7\.)/, ''); // raqobatchilar bo'limini token tejash uchun chiqaramiz
    const biz = loadBusinessPrinciplesCondensed();

    const ai = new GoogleGenAI({ apiKey, httpOptions: { headers: { 'User-Agent': 'aistudio-build' } } });

    const prompt = `Sen Uzum Market sotuvchisining shaxsiy MOLIYAVIY MURABBIYIsan. O'zbek tilida javob ber.
Foydalanuvchi maqsadi: "sinyapmanmi yoki botyapmanmi — aniq raqamlarda bilish" va moliyaviy erkinlikka chiqish.

QAT'IY QOIDALAR:
- Har tavsiya ANIQ PUL raqami bilan (necha so'm yutiladi/yo'qotiladi).
- Ma'lumot yo'q bo'lsa "ma'lumot yo'q" deb yoz — SOXTA RAQAM BERMA, taxmin qilma.
- "Bugungi ishlar" — eng ko'pi 3 ta, ustuvorlik bo'yicha (eng ko'p pul yo'qotilayotgani birinchi).
- Har ish: NIMA qilish + NEGA (xavf) + kechiksa NIMA bo'ladi (pul).
- Xitoy buyurtma mantig'i: zaxira_tugash_kuni = zaxira ÷ kunlik_sotuv. Yetkazish 28 kun (21 yo'l + 5 sotuvga chiqish + 2 zaxira). Agar zaxira_tugash ≤ 28 → hozir buyurtma ber, tavsiya miqdor = kunlik × 30.

=== BILIMLAR BAZASI (Uzum qoidalari) ===
${kb}

=== BIZNES VA MOLIYA TAMOYILLARI ===
${biz}

=== JORIY HOLAT (real ma'lumot) ===
${ctx.text}

Quyidagi JSON formatida javob ber (faqat toza JSON, markdown kod bloki YO'Q):
{
  "moliya_holati": "Bu oy foyda/zarar holati aniq raqamda + keyingi kredit to'lovi ogohlantirishi (agar bor bo'lsa). 2-3 jumla.",
  "bugungi_ishlar": ["1. [belgi] NIMA — nega xavfli, kechiksa qancha pul yo'qoladi", "2. ...", "3. ..."],
  "maqsad": "Agar maqsad qo'yilgan bo'lsa: hozirgi holat vs maqsad, keyingi bosqich, qachon erishish mumkin. Yo'q bo'lsa bo'sh string.",
  "xitoy_buyurtma": "Xitoydan buyurtma kerak bo'lgan SKU'lar: qaysi, qancha dona, taxminiy foyda. Yo'q bo'lsa 'Hozircha shoshilinch buyurtma kerak emas'."
}`;

    let parsedData;
    try {
      parsedData = await callGeminiJson(ai, prompt);
    } catch (firstErr) {
      // 19-G: uzunroq prompt (biznes-tamoyillari qo'shilgach) ba'zan chiqish token limitiga yetib,
      // JSON tugallanmay kesiladi. Bir marta, "qisqa yoz" ko'rsatmasi bilan qayta urinamiz.
      console.warn('[AI] Birinchi urinish JSON parse xato, qayta urinilmoqda:', firstErr.message);
      const retryPrompt = prompt + '\n\nMUHIM: Javobni albatta TO\'LIQ, QISQA va YOPIQ JSON qilib yakunlang, ortiqcha izoh yozmang.';
      parsedData = await callGeminiJson(ai, retryPrompt);
    }
    return { ok: true, data: parsedData };
  } catch (err) {
    console.error("AI murabbiy xato:", err);
    return { ok: false, error: "AI murabbiy bilan bog'lanishda xato: " + err.message };
  }
}

// 18-D1: AI murabbiy JSON javobini Telegram matniga aylantirish (/maslahat buyrug'i uchun)
function aiAdviceToText(d) {
  if (!d || typeof d !== 'object') return '⚠️ AI javobi bo\'sh.';
  const lines = ['🤖 *AI Moliyaviy Murabbiy*', ''];
  if (d.moliya_holati) { lines.push('💰 *Moliya holati:*', d.moliya_holati, ''); }
  const ishlar = Array.isArray(d.bugungi_ishlar) ? d.bugungi_ishlar.filter(Boolean) : [];
  if (ishlar.length) { lines.push('📋 *Bugungi ishlar:*'); ishlar.forEach(x => lines.push(x)); lines.push(''); }
  if (d.maqsad) { lines.push('🎯 *Maqsad:*', d.maqsad, ''); }
  if (d.xitoy_buyurtma) { lines.push('🇨🇳 *Xitoy buyurtma:*', d.xitoy_buyurtma); }
  return lines.join('\n').trim();
}

app.post('/api/gemini/advice', async (req, res) => {
  const shopId = req.body?.shopId || syncedState.activeShop;
  const result = await generateAiAdvice(shopId);
  if (result.ok) {
    res.json(result.data);
  } else {
    const code = result.error.includes('sozlanmagan') ? 400 : 500;
    res.status(code).json({ error: result.error });
  }
});

// Helper for Telegram messages
async function sendTelegramMessage(token, chatId, text, replyMarkup = null) {
  try {
    const body = {
      chat_id: chatId,
      text: text,
      parse_mode: 'Markdown',
      disable_web_page_preview: true
    };
    if (replyMarkup) {
      body.reply_markup = replyMarkup;
    }
    const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    const data = await response.json();
    if (!response.ok || !data.ok) {
      // TO'LIQ xato logi — nima uchun yetkazilmaganini aniq bilamiz
      console.error(`[TG] YUBORISH RAD ETILDI → HTTP ${response.status}, ok=${data.ok}, error_code=${data.error_code}, description="${data.description}", chat_id=${chatId}`);
      return { ok: false, status: response.status, errorCode: data.error_code, description: data.description, chatIdSent: chatId };
    }
    // TO'LIQ muvaffaqiyat logi — xabar QAYERGA ketganini aniq bilamiz
    const r = data.result || {};
    const chat = r.chat || {};
    console.log(`[TG] Yuborildi ✓ → message_id=${r.message_id}, chat.id=${chat.id}, chat.type=${chat.type}, chat.username=${chat.username || '-'}, chat.first_name="${chat.first_name || ''}"`);
    return { ok: true, messageId: r.message_id, chatId: chat.id, chatType: chat.type, chatUsername: chat.username || null, chatFirstName: chat.first_name || null };
  } catch (err) {
    console.error("[TG] sendMessage exception:", err);
    return { ok: false, exception: err.message, chatIdSent: chatId };
  }
}

// Per-SKU iqtisod (3.1): komissiya % ustuvorligi — (a) SKU qo'lda, (b) mahsulot qo'lda (3.4),
// (c) SKU/API, (d) 18% default
function commissionPct(skuId, sku, productId) {
  const c = syncedState.costs[skuId];
  if (c && c.commissionPercent != null && c.commissionPercent !== '') return Number(c.commissionPercent);
  const ps = productId != null ? (syncedState.productSettings || {})[productId] : null;
  if (ps && ps.commissionPercent != null && ps.commissionPercent !== '') return Number(ps.commissionPercent);
  if (sku && sku.commissionApi != null) return Number(sku.commissionApi);
  return 18; // oxirgi zaxira default (3.1)
}
// 4.1: Uzum'ning 2026-05-04'dan beri ishlatayotgan hajm-asosli logistika formulasi.
// 1 litrgacha 5250 so'm, har qo'shimcha litr +250 so'm, maksimal 50000 so'm. Hajm yuqoriga yaxlitlanadi.
function logisticsFormula(litr) {
  return Math.min(50000, 5250 + 250 * (Math.ceil(litr) - 1));
}

// Hajm manbai ustuvorligi (4.1): SKU qo'lda litr > mahsulot qo'lda litr > Uzum API'ning o'z
// SKU o'lchami (skuDimension, mm) > yo'q (chaqiruvchi default 1 litr ishlatadi).
// Qaytaradi: { litr, source } yoki null (hech qanday manba yo'q).
function resolveVolumeL(skuId, productId, sku) {
  const c = syncedState.costs[skuId];
  if (c && c.volumeL != null && c.volumeL !== '' && Number(c.volumeL) > 0) return { litr: Number(c.volumeL), source: 'sku-volume' };
  const ps = productId != null ? (syncedState.productSettings || {})[productId] : null;
  if (ps && ps.volumeL != null && ps.volumeL !== '' && Number(ps.volumeL) > 0) return { litr: Number(ps.volumeL), source: 'product-volume' };
  if (sku && sku.dimensionMm) {
    const { length, width, height } = sku.dimensionMm;
    const litr = (length * width * height) / 1000000; // mm³ → litr
    if (litr > 0) return { litr, source: 'api-dimension' };
  }
  return null;
}

// Logistika (3.2/4.1): SKU qo'lda narx > mahsulot qo'lda narx (3.4) > hajm (qo'lda yoki API) > default (hajm yo'q, 1 litr deb)
// Qaytaradi: { val, source, litr? }
function resolveLogistics(skuId, productId, sku) {
  const c = syncedState.costs[skuId];
  if (c && c.logisticsCost != null && c.logisticsCost !== '') return { val: Number(c.logisticsCost), source: 'sku-manual' };
  const ps = productId != null ? (syncedState.productSettings || {})[productId] : null;
  if (ps && ps.logisticsCost != null && ps.logisticsCost !== '') return { val: Number(ps.logisticsCost), source: 'product-manual' };
  const vol = resolveVolumeL(skuId, productId, sku);
  if (vol) return { val: logisticsFormula(vol.litr), source: vol.source, litr: vol.litr };
  return { val: 5250, source: 'default', litr: 1 }; // 4.1: hajm kiritilmagan — 1 litr deb hisoblanadi
}

// B-bosqich: Uzum BOSQICHLI saqlash tarifi (so'm/litr/kun), aylanma kunlariga qarab.
// STANDART tarif — maxsus (aksessuar/bolalar kiyimi/poyabzal) pasaytirilgan tariflarni AVTOMATIK
// aniqlamaymiz (kategoriya taksonomiyasi kerak, xato xavfli). Standart maxsusdan qimmatroq — foydani
// oshirib ko'rsatmaslik uchun xavfsiz tomon.
function computeStorageRate(turnoverDays) {
  if (turnoverDays == null) return 24; // tarix yo'q — eng ehtiyotkor (qimmat) toifa, foydani oshirib yubormaslik uchun
  if (turnoverDays <= 60) return 0;    // 0-60 kun bepul
  if (turnoverDays <= 180) return 12;
  if (turnoverDays <= 360) return 18;
  return 24;                           // 361+ (Infinity = sotuvsiz ham shu yerga tushadi)
}

// 4.2 / B-bosqich: Saqlash xarajati — bosqichli tarif × hajm, tovar uchun kuniga maks 5000 so'm.
// Hajm manbai resolveVolumeL bilan bir xil (qo'lda kiritilgan hajm ustuvor). Alohida "qo'lda saqlash
// narxi" maydoni yo'q — saqlash doim hajm+tarifdan hisoblanadi. turnoverDays = computeTurnoverDays(...).days.
const STORAGE_DEFAULT_DAYS = 30;
const STORAGE_MAX_SOM_PER_ITEM_DAY = 5000; // Uzum: TOVAR uchun kuniga maksimal saqlash (litr uchun emas)
function resolveStorage(skuId, productId, sku, turnoverDays) {
  const vol = resolveVolumeL(skuId, productId, sku);
  const litr = vol ? vol.litr : 1;
  const source = vol ? vol.source : 'default';
  const rate = computeStorageRate(turnoverDays);
  const perDay = Math.min(litr * rate, STORAGE_MAX_SOM_PER_ITEM_DAY); // 5000 chegara — tovar/kun
  return { val: perDay * STORAGE_DEFAULT_DAYS, source, litr, days: STORAGE_DEFAULT_DAYS, rate, perDay };
}

// 3.4/3.5: Tannarx manbai ustuvorligi — SKU qo'lda > SKU turi > mahsulot qo'lda > mahsulot turi > bog'lanmagan
function resolveTannarx(skuId, productId) {
  const skuCost = syncedState.costs[skuId];
  if (skuCost && skuCost.manualCost != null && skuCost.manualCost !== '') {
    return { tannarx: Number(skuCost.manualCost), source: 'sku-manual' };
  }
  const skuTypeId = syncedState.skuMappings[skuId];
  if (skuTypeId) {
    const type = syncedState.productTypes.find(t => t.id === skuTypeId);
    if (type) return { tannarx: type.cost, source: 'sku-type' };
  }
  const ps = productId != null ? (syncedState.productSettings || {})[productId] : null;
  if (ps) {
    if (ps.manualCost != null && ps.manualCost !== '') return { tannarx: Number(ps.manualCost), source: 'product-manual' };
    if (ps.mappedTypeId) {
      const type = syncedState.productTypes.find(t => t.id === ps.mappedTypeId);
      if (type) return { tannarx: type.cost, source: 'product-type' };
    }
  }
  return { tannarx: 0, source: 'unmapped' };
}

function findSkuInProducts(products, skuId) {
  for (const p of products) {
    const s = (p.skuList || []).find(x => String(x.skuId) === String(skuId));
    if (s) return { sku: s, product: p };
  }
  return { sku: null, product: null };
}

// 2.3: xarajatlarni SOURCE bo'yicha guruhlaydi (real type=OUTCOME/INCOME). Kategoriya o'ylab topilmaydi.
async function fetchExpensesGrouped(shopId, token) {
  const to = Date.now();
  const from = to - 30 * 24 * 60 * 60 * 1000;
  const r = await uzumGet(`/v1/finance/expenses?shopIds=${shopId}&dateFrom=${from}&dateTo=${to}&page=0&size=50`, token);
  if (!r.ok) return { ok: false, error: r.error };
  const payments = r.data.payload?.payments || [];
  const bySource = {};
  let outcomeTotal = 0, incomeTotal = 0;
  payments.forEach(p => {
    const amt = (p.amount != null ? p.amount : (p.paymentPrice || 0)) || 0;
    if (p.type === 'INCOME') { incomeTotal += amt; return; }
    const src = p.source || p.name || 'Boshqa';
    bySource[src] = (bySource[src] || 0) + amt;
    outcomeTotal += amt;
  });
  return { ok: true, bySource, outcomeTotal, incomeTotal, count: payments.length };
}

// Global Text Builder for Telegram Daily Report — jonli ma'lumot + snapshot delta (2.1)
// 18-D: bloklangan mahsulotlar nomi bilan (hozir faqat "N ta" edi — aniq emas)
function blockedProductNames(products) {
  return products.filter(p => p.status?.value === 'PERM_BANNED').map(p => p.title);
}

// 18-D3: keyingi 10 kun ichida to'lovi keladigan kreditlar (Uzum'dan pul chiqarishga ulgurish uchun ogohlantirish)
function creditWarnings() {
  const warns = [];
  (syncedState.credits || []).forEach(c => {
    const days = creditDaysUntilDue(c);
    if (days >= 0 && days <= 10) {
      warns.push(`⚠️ *${c.name}* to'lovi ${days} kundan keyin (${c.nextPaymentDate || '?'}). Summa: ${fmtMoney(c.monthlyPayment)} so'm.\n   → Uzum'dan hozir pul chiqaring — kartaga 3-4 kunda tushadi.`);
    }
  });
  return warns;
}

// 18-D2: kunlik hisobot uchun qisqa moliyaviy qator (naqd oqim + keyingi kredit)
async function financeSummaryLine() {
  const cf = await computeCashFlow();
  if (!cf.ok) return '';
  const net = cf.netCashFlow;
  let s = `💰 Bu oy: ${net >= 0 ? '+' : ''}${fmtMoney(net)} so'm (${net >= 0 ? 'foyda' : 'zarar'})`;
  // eng yaqin kredit
  let nearest = null;
  (syncedState.credits || []).forEach(c => {
    const days = creditDaysUntilDue(c);
    if (nearest === null || days < nearest.days) nearest = { name: c.name, days, amount: c.monthlyPayment };
  });
  if (nearest) s += ` · Keyingi kredit: ${nearest.name} ${nearest.days} kun (${fmtMoney(nearest.amount)})`;
  return s;
}

// 18-D1: /moliya buyrug'i matni — to'liq naqd oqim + proyeksiya + kredit ogohlantirishlari.
async function moliyaCommandText() {
  const cf = await computeCashFlow();
  if (!cf.ok) return '⚠️ Moliya ma\'lumoti olinmadi.';
  const lines = [];
  lines.push(`💰 *Moliyaviy holat* (${cf.month})`);
  lines.push('');
  lines.push('📥 *Bu oy kassa:*');
  lines.push(`   Yechib olindi (keldi): ${fmtMoney(cf.withdrawnCame)} so'm`);
  if (cf.withdrawnPending > 0) lines.push(`   Yo'lda (kutilmoqda): ${fmtMoney(cf.withdrawnPending)} so'm`);
  lines.push(`   Xarajat: −${fmtMoney(cf.expensesTotal)} so'm`);
  if (cf.creditMonthly > 0) lines.push(`   Kredit to'lovi: −${fmtMoney(cf.creditMonthly)} so'm`);
  lines.push('   ─────────────');
  const net = cf.netCashFlow;
  lines.push(`   *Sof: ${net >= 0 ? '+' : ''}${fmtMoney(net)} so'm* (${net >= 0 ? 'foyda ✅' : 'zarar 🔴'})`);
  // Umumiy qarz — bu oy oqimidan ALOHIDA (bu bir martalik "zaxira", oqim emas)
  if (cf.creditRemaining > 0) lines.push(`\n🏦 Umumiy qolgan qarz (barcha kreditlar): ${fmtMoney(cf.creditRemaining)} so'm`);

  const cats = Object.entries(cf.expensesByCategory || {}).sort((a, b) => b[1] - a[1]);
  if (cats.length) {
    lines.push('');
    lines.push('🧾 *Xarajat taqsimoti:*');
    cats.slice(0, 6).forEach(([c, v]) => lines.push(`   ${c}: ${fmtMoney(v)} so'm`));
  }

  if (cf.projection) {
    const p = cf.projection;
    lines.push('');
    lines.push('📅 *Keyingi 30 kun (proyeksiya):*');
    if (p.upcomingCredits > 0) lines.push(`   Kelayotgan kredit to'lovlari: ${fmtMoney(p.upcomingCredits)} so'm`);
    if (p.forecastReady) lines.push(`   Kutilayotgan Uzum foydasi: ${fmtMoney(p.expectedIncome)} so'm`);
    lines.push(`   ${p.verdict}`);
  }

  const warns = creditWarnings();
  if (warns.length) {
    lines.push('');
    lines.push('🏦 *Kredit ogohlantirishlari:*');
    warns.forEach(w => lines.push(w));
  }

  lines.push('');
  lines.push('/maslahat — AI murabbiy tahlili · /maqsad — maqsad holati');
  return lines.join('\n');
}

// 18-D1: /maqsad buyrug'i matni — oylik aylanma maqsadi vs joriy holat.
async function maqsadCommandText() {
  const goals = syncedState.goals || [];
  if (!goals.length) {
    return '🎯 *Maqsad qo\'yilmagan.*\n\nDashboard → Moliya bo\'limidan oylik aylanma maqsadingizni kiriting. Keyin bu yerda har kun qancha yaqinlashayotganingizni ko\'rasiz.';
  }
  const month = todayTashkent().slice(0, 7);
  const goal = goals[goals.length - 1]; // bitta faol maqsad (frontend bitta saqlaydi)
  const target = goal.target || 0;

  // 18-FIX: Joriy oy aylanmasi — finance/orders (kalendar oy boshidan bugungacha, aniq)
  let currentTurnover = 0, hasData = false;
  const day = parseInt(todayTashkent().slice(8, 10), 10) || 1;
  for (const shop of (syncedState.shops || [])) {
    const fin = await computeSalesFromOrders(shop.shopId, 'thismonth');
    if (fin.ok) { currentTurnover += (fin.revenue || 0); hasData = true; }
  }

  const lines = [];
  lines.push(`🎯 *Maqsad: ${fmtMoney(target)} so'm/oy aylanma*`);
  lines.push('');
  if (!hasData) {
    lines.push('Joriy aylanma ma\'lumoti hali yetarli emas (snapshot to\'planmoqda).');
  } else {
    const pct = target > 0 ? (currentTurnover / target * 100) : 0;
    const daysInMonth = new Date(parseInt(month.slice(0, 4)), parseInt(month.slice(5, 7)), 0).getDate();
    const projected = day > 0 ? (currentTurnover / day * daysInMonth) : 0;
    lines.push(`Bu oy ${day} kunda: ${fmtMoney(currentTurnover)} so'm (${fmtPct(pct)}%)`);
    lines.push(`Shu sur'atda oy oxiriga: ~${fmtMoney(projected)} so'm`);
    lines.push('');
    if (projected >= target) lines.push('✅ Shu sur\'atda maqsadga yetasiz — davom eting!');
    else {
      const need = target - currentTurnover;
      const daysLeft = Math.max(1, daysInMonth - day);
      lines.push(`⚠️ Yetishmayapti. Maqsad uchun qolgan ${daysLeft} kunda kuniga ~${fmtMoney(need / daysLeft)} so'm aylanma kerak.`);
    }
  }
  lines.push('');
  lines.push('/moliya — pul holati · /maslahat — AI murabbiy');
  return lines.join('\n');
}

async function generateReportText(shopId) {
  shopId = shopId || syncedState.activeShop;
  const shop = (syncedState.shops || []).find(s => String(s.shopId) === String(shopId));
  const shopTitle = shop ? shop.shopTitle : `Shop ${shopId}`;
  const todayStr = todayTashkent();
  const header = `🟣 *Uzum Pro — ${shopTitle} (${shopId})*\n📅 ${todayStr} hisoboti`;

  // Jonli mahsulotlar (syncedState'ga tayanmaydi — 2.1)
  const prod = await fetchLiveShopProducts(shopId);
  if (!prod.ok) {
    return `${header}\n\n⚠️ Uzum'dan ma'lumot olinmadi: ${prod.error}\nHisobot tuzib bo'lmadi.`;
  }
  const products = prod.products;

  // Inventar holati (jonli)
  let activeCount = products.length, outOfStock = 0, low = 0, blocked = 0;
  const urgentItems = [];
  products.forEach(p => {
    if (p.status?.value === 'PERM_BANNED') blocked++;
    (p.skuList || []).forEach(sku => {
      const qty = sku.availableAmount;
      if (qty <= 0) outOfStock++;
      else if (qty < 15) low++;
      const type = syncedState.productTypes.find(t => t.id === syncedState.skuMappings[sku.skuId]);
      if (qty <= 0 && type && type.stock > 0) {
        urgentItems.push(`${type.name}: ${sku.skuTitle} tugadi — uyda ${type.stock} dona bor`);
      }
    });
  });

  // 18-FIX: Kunlik sotuv — finance/orders'dan (real vaqtli, aniq). "kecha" = tugagan oldingi kun.
  const sales = await computeSalesFromOrders(shopId, 'yesterday');
  let salesSection;
  if (!sales.ok) {
    salesSection = `⚠️ Kechagi sotuv olinmadi: ${sales.error}`;
  } else {
    const csl = costSourceLine(sales.costSource);
    salesSection = `🛍️ Kecha sotildi: ${fmtMoney(sales.units)} dona (${fmtMoney(sales.orders)} buyurtma)${sales.canceledCount ? ` · ❌ ${fmtMoney(sales.canceledCount)} bekor` : ''}\n💰 Kecha tushum: ${fmtMoney(sales.revenue)} so'm\n🏦 Uzum to'lovi: ${fmtMoney(sales.payout)} so'm\n💵 Kecha sof foyda (tannarx ayrilgan): ${fmtMoney(sales.profit)} so'm${csl ? '\n' + csl : ''}`;
  }

  // Xarajatlar — source bo'yicha (2.3)
  const exp = await fetchExpensesGrouped(shopId, process.env.UZUM_TOKEN);
  let expenseSection;
  if (!exp.ok) {
    expenseSection = `💸 Xarajatlar: olinmadi (${exp.error})`;
  } else if (exp.count === 0) {
    expenseSection = `💸 Xarajatlar (oxirgi 30 kun): yozuv yo'q`;
  } else {
    const lines = Object.entries(exp.bySource).sort((a, b) => b[1] - a[1]).map(([src, amt]) => `  ➤ ${src}: ${fmtMoney(amt)} so'm`).join('\n');
    expenseSection = `💸 Xarajatlar (oxirgi 30 kun, jami ${fmtMoney(exp.outcomeTotal)} so'm):\n${lines}${exp.incomeTotal ? `\n  ✅ Kirim (INCOME): ${fmtMoney(exp.incomeTotal)} so'm` : ''}`;
  }

  const urgentSection = urgentItems.length
    ? `\n🚨 *ZUDLIK BILAN OMBORGA YUBORING:*\n${urgentItems.slice(0, 5).map(t => `• ${t}`).join('\n')}${urgentItems.length > 5 ? `\n• …va yana ${urgentItems.length - 5} ta` : ''}\n`
    : '';

  // 5.2/5.4: A toifadagi tugash arafasidagi tovarlar va Xitoy buyurtma nuqtasi ogohlantirishi (snapshot tarixidan)
  const metrics = await computeSkuMetrics(shopId);
  let riskSection = '';
  if (metrics.ok) {
    const aAtRisk = [];
    const reorderItems = [];
    products.forEach(p => (p.skuList || []).forEach(sku => {
      const m = metrics.perSku[sku.skuId];
      if (!m) return;
      if (sku.rank === 'A' && m.needsReorder) aAtRisk.push(sku.skuTitle);
      if (m.needsReorder) reorderItems.push(`${sku.skuTitle} (${(m.stockDays30 != null ? m.stockDays30 : m.stockDays7).toFixed(0)} kun)`);
    }));
    const parts = [];
    if (aAtRisk.length > 0) parts.push(`🟢➡️🚨 *A toifadagi ${aAtRisk.length} ta tovar tugash arafasida:*\n${aAtRisk.slice(0, 5).map(t => `• ${t}`).join('\n')}${aAtRisk.length > 5 ? `\n• …va yana ${aAtRisk.length - 5} ta` : ''}`);
    if (reorderItems.length > 0) parts.push(`🚚 *Xitoyga buyurtma bering (${reorderItems.length} ta, ~28 kun yo'l):*\n${reorderItems.slice(0, 5).map(t => `• ${t}`).join('\n')}${reorderItems.length > 5 ? `\n• …va yana ${reorderItems.length - 5} ta` : ''}`);
    if (parts.length > 0) riskSection = `\n${parts.join('\n\n')}\n`;
  }

  return `${header}

${salesSection}

${expenseSection}

📦 Tovarlar holati:
✅ Sotuvda (e'lonlar): ${activeCount} ta
❌ Tugagan SKU: ${outOfStock} ta
⚠️ Kam qolgan SKU: ${low} ta
🚫 Bloklangan: ${blocked} ta${blocked > 0 ? '\n' + blockedProductNames(products).slice(0, 5).map(t => `   • ${t}`).join('\n') + (blocked > 5 ? `\n   • …va yana ${blocked - 5} ta` : '') : ''}
${urgentSection}${riskSection}
/start — boshlash | /moliya — pul holati | /maslahat — AI murabbiy | /dashboard — mini app`;
}

// 6.1: Kunlik hisobotni yuborish — cron va qo'lda diagnostika endpoint ikkalasi ham shu funksiyani ishlatadi.
// Har bir sozlangan do'kon uchun ALOHIDA xabar yuboriladi (do'konlar aralashib ketmasin).
const ADMIN_CHAT_ID = '5155194813';

// 18-D0: bitta do'kon uchun joriy faol Uzum muammolarini keyli ro'yxatda qaytaradi.
// Har muammo: { key (barqaror identifikator, takroriy ogohlantirmaslik uchun), text (ogohlantirish matni) }.
async function detectShopProblems(shopId) {
  const out = [];
  const prod = await fetchLiveShopProducts(shopId);
  const metrics = await computeSkuMetrics(shopId);
  if (!prod.ok || !metrics.ok) return out;
  prod.products.forEach(p => {
    const isBanned = p.status?.value === 'PERM_BANNED';
    (p.skuList || []).forEach(sku => {
      const avail = Math.max(0, sku.availableAmount || 0);
      const m = metrics.perSku[sku.skuId] || {};
      const stockDays = m.canCompute ? (m.stockDays30 != null ? m.stockDays30 : m.stockDays7) : null;
      const id = sku.skuId;
      if (isBanned) {
        out.push({ key: `ban:${id}`, text: `🚫 *${sku.skuTitle}* bloklandi${sku.skuBlockReason?.title ? ' — ' + sku.skuBlockReason.title : ''}. Sababni tekshirib tuzating.` });
      } else if (avail <= 0 && sku.rank === 'A') {
        out.push({ key: `oosA:${id}`, text: `🔴 *${sku.skuTitle}* (A toifa) TUGADI — TOPdan tushmoqda. Uy zaxirasidan yoki Xitoydan zudlik bilan to'ldiring.` });
      } else if (stockDays != null && stockDays < 3) {
        out.push({ key: `low:${id}`, text: `🟠 *${sku.skuTitle}* zaxirasi ~${stockDays.toFixed(0)} kunda tugaydi (${avail} dona). Jo'natishni tayyorlang.` });
      }
    });
  });
  return out;
}

// 18-D0: barcha do'konlar bo'yicha muammolarni tekshiradi, FAQAT yangi paydo bo'lganlarini ogohlantiradi.
// Holat problems.json'da saqlanadi — bir muammo ketguncha faqat bir marta ogohlantiriladi (spam yo'q).
async function runProblemCheck() {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token || !ADMIN_CHAT_ID) return { ok: false, error: 'token/chat yo\'q' };
  // Birinchi ishga tushishda (problems.json hali yo'q) — barcha mavjud muammolar "yangi" ko'rinadi va
  // 20+ xabar toshqini bo'lardi. Shuning uchun birinchi safar FAQAT bazaviy holatni saqlaymiz, ogohlantirmaymiz.
  const firstRun = !fs.existsSync(PROBLEMS_FILE);
  const prevState = readJsonFile(PROBLEMS_FILE, {});
  const newState = {};
  let alertCount = 0;
  for (const shop of (syncedState.shops || [])) {
    const shopId = String(shop.shopId);
    let current;
    try { current = await detectShopProblems(shopId); }
    catch (e) { console.error(`[D0] ${shopId} muammo tekshiruvida xato:`, e.message); newState[shopId] = prevState[shopId] || []; continue; }
    const currentKeys = current.map(p => p.key);
    const prevKeys = prevState[shopId] || [];
    const fresh = current.filter(p => !prevKeys.includes(p.key)); // faqat yangi
    if (!firstRun && fresh.length) {
      const msg = `⚠️ *Yangi muammo* — ${shop.shopTitle}\n\n${fresh.map(p => p.text).join('\n\n')}\n\n/maslahat — AI murabbiy tahlili`;
      try { await sendTelegramMessage(token, ADMIN_CHAT_ID, msg); alertCount += fresh.length; }
      catch (e) { console.error('[D0] ogohlantirish yuborilmadi:', e.message); }
    }
    newState[shopId] = currentKeys;
  }
  writeJsonFile(PROBLEMS_FILE, newState);
  console.log(`[D0] Muammo tekshiruvi tugadi — ${firstRun ? 'birinchi run (bazaviy holat saqlandi, ogohlantirish yo\'q)' : alertCount + ' ta yangi ogohlantirish'}`);
  return { ok: true, alertCount, firstRun };
}

// ============ 19-B/C: TA'MINLASH (invoice) — avto zaxira + kompensatsiya nomzodlari ============
// Uzum /v1/invoice REAL yuk xatlarini beradi: CREATED (yaratilgan, yo'lda) -> ACCEPTED (omborda qabul qilingan).
// Har SKU: skuForInvoiceDtoList[].id = skuId (bizning skuMappings kaliti bilan bir xil — tekshirilgan),
// quantityToStock (jo'natilgan), quantityAccepted (qabul qilingan), purchasePrice (tannarx).
// MUHIM: `size>50` bo'sh qaytaradi (finance/orders'dagidek) — shuning uchun page=0,1,2... size=50 bilan sahifalaymiz.
const INVOICE_TTL_MS = 5 * 60 * 1000;
let _invoiceCache = null; // { at, invoices }
async function fetchAllInvoices() {
  const now = Date.now();
  if (_invoiceCache && (now - _invoiceCache.at) < INVOICE_TTL_MS) return { ok: true, invoices: _invoiceCache.invoices, cached: true };
  const all = [];
  for (let page = 0; page < 40; page++) { // xavfsizlik chegarasi: 40*50=2000 yuk xati
    const r = await uzumGet(`/v1/invoice?page=${page}&size=50`, process.env.UZUM_TOKEN);
    if (!r.ok) { if (all.length) break; return { ok: false, status: r.status, error: r.error || `Uzum ${r.status}` }; }
    const d = r.data;
    const list = Array.isArray(d) ? d : (d && d.payload && Array.isArray(d.payload) ? d.payload : []);
    all.push(...list);
    if (list.length < 50) break; // oxirgi sahifa
  }
  _invoiceCache = { at: now, invoices: all };
  return { ok: true, invoices: all, cached: false };
}

// Bitta yuk xatining SKU'larini uy zaxirasi turlariga (productTypes) bog'lab, tur bo'yicha jami dona qaytaradi.
// 19-FIX (2026-08-06, foydalanuvchi Uzum kabineti bilan solishtirgach TASDIQLANGAN):
//  1) API invoiceNumber'ning OXIRGI RAQAMI tekshiruv/indeks xonasi — Uzum kabineti buni KO'RSATMAYDI.
//     1100018000685 (API) -> 110001800068 (kabinet). Kabinet raqami = Math.floor(invoiceNumber/10).
//  2) dateCreated — hujjat OLDINDAN BAND/YARATILGAN sanasi, Uzum kabineti esa REAL QABUL vaqtini
//     (dateAccepted) ko'rsatadi — bular BIR NECHA KUNGACHA farq qilishi mumkin (misolda 18.12 -> 26.12,
//     8 kun farq). Foydalanuvchiga har doim dateAccepted (bor bo'lsa, Tashkent vaqti) ko'rsatiladi —
//     aks holda u Uzum'ga murojaat qilganda hujjatni sana bo'yicha topa olmaydi.
// Bu ikkalasi TASDIQLANGAN: id=1800068/1800059/1800164 uchun kabinet #110001800068/59/164,
// sana 26.12.2024 (05:19/05:23/05:39) — barchasi mos keldi.
function invoiceDisplayNumber(inv) {
  return (inv.invoiceNumber != null) ? Math.floor(inv.invoiceNumber / 10) : inv.id;
}
// Voqea vaqti (epoch ms) — tartiblash/oyna moslashtirish uchun. dateAccepted (aniq) ustuvor.
function invoiceEventMs(inv) {
  if (inv.dateAccepted) return inv.dateAccepted;
  const [dd, mm, yyyy] = String(inv.dateCreated || '').split('.').map(Number);
  return (dd && mm && yyyy) ? Date.UTC(yyyy, mm - 1, dd) : 0;
}
// Foydalanuvchiga ko'rsatiladigan sana — "DD.MM.YYYY HH:MM" (dateAccepted, Tashkent) yoki "DD.MM.YYYY" (dateCreated).
function invoiceDisplayDate(inv) {
  if (inv.dateAccepted) {
    const d = new Date(inv.dateAccepted + 5 * 3600 * 1000); // Tashkent (UTC+5)
    const p2 = n => String(n).padStart(2, '0');
    return `${p2(d.getUTCDate())}.${p2(d.getUTCMonth() + 1)}.${d.getUTCFullYear()} ${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}`;
  }
  return inv.dateCreated || '?';
}
// Hozirgi vaqt, Tashkent, "DD.MM.YYYY HH:MM". 19-D: FAQAT "bizning tizim payqagan vaqt" uchun —
// Uzum API dateCreated'da soat bermaydi (faqat sana), shuning uchun bu Uzum'ning haqiqiy yaratilish
// soati sifatida ko'rsatilmasin, "Aniqlangan" deb izohlansin.
function fmtTashkentNow() {
  const d = new Date(Date.now() + 5 * 3600 * 1000);
  const p2 = n => String(n).padStart(2, '0');
  return `${p2(d.getUTCDate())}.${p2(d.getUTCMonth() + 1)}.${d.getUTCFullYear()} ${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}`;
}
// Kun-darajasidagi guruhlash kaliti (Tashkent), "birinchi ariza/partiya" uchun — vaqtsiz, sana bo'yicha.
function invoiceDayKey(inv) {
  const ms = invoiceEventMs(inv);
  if (!ms) return inv.dateCreated || '?';
  const d = new Date(ms + (inv.dateAccepted ? 5 * 3600 * 1000 : 0));
  const p2 = n => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p2(d.getUTCMonth() + 1)}-${p2(d.getUTCDate())}`;
}

// { typeId: qty } — faqat skuMappings'da bog'langan SKU'lar (bog'lanmaganlar uy zaxirasida yo'q, e'tiborsiz).
function invoiceQtyByType(invoice, field) {
  const byType = {};
  (invoice.productForInvoiceDto || []).forEach(p => (p.skuForInvoiceDtoList || []).forEach(s => {
    const typeId = syncedState.skuMappings[String(s.id)];
    if (!typeId) return;
    byType[typeId] = (byType[typeId] || 0) + (s[field] || 0);
  }));
  return byType;
}

// 19-C: bitta ACCEPTED yuk xati bo'yicha kompensatsiya nomzodlari (quantityToStock − quantityAccepted > 0).
function invoiceMissingItems(invoice) {
  const items = [];
  (invoice.productForInvoiceDto || []).forEach(p => (p.skuForInvoiceDtoList || []).forEach(s => {
    const diff = (s.quantityToStock || 0) - (s.quantityAccepted || 0);
    if (diff > 0) items.push({ skuId: s.id, skuTitle: s.skuTitle, toStock: s.quantityToStock, accepted: s.quantityAccepted, missing: diff, purchasePrice: s.purchasePrice || 0, value: diff * (s.purchasePrice || 0) });
  }));
  return items;
}

// 19-C (qayta yozildi): KOMPENSATSIYA NOMZODLARI — SKU darajasida, RE-SORT XABARDOR, sotuv−komissiya bo'yicha.
//
// DIAGNOSTIKA (2026-08-06) rasmiy Uzum hujjatidan + real ma'lumotdan aniqladi:
//  1) Uzum kompensatsiyani SOTUV NARXI − KOMISSIYA bo'yicha to'laydi (tannarx EMAS).
//  2) Uzum aralash qutini QAYTA SARALAB, yangi yuk xatida qabul qiladi: masalan [100→0] (rad),
//     keyin bir necha kun ichida [100→100] (qabul). Bu tovar YO'QOLMAGAN — shunchaki qayta ishlangan.
//     Oddiy Σyuborilgan−Σqabul buni ushlay olmaydi (yangi toStock ikki marta sanaladi).
// Shuning uchun: har SKU uchun ACCEPTED yuk xatlarini vaqt tartibida ko'rib chiqamiz:
//  - To'liq rad [X→0] keyin (RESORT_WINDOW_DAYS ichida) to'liq qabul [Y→Y] bilan moslashsa — qaytgan (chiqariladi).
//  - Moslashuv qisman bo'lsa (Y<X) — qaytgan Y chiqariladi, qolgan (X−Y) "QISMAN aniqlanmagan" toifasiga.
//  - Qisman kamomad [X→qabul, 0<qabul<X] va umuman qayta qabul qilinmagan to'liq rad — "ANIQ" (yuqori ishonch).
const RESORT_WINDOW_DAYS = 60; // sozlanadigan: [X→0] keyin [Y→Y] shu kun ichida bo'lsa qayta saralash deb hisoblanadi

// Barcha do'kon jonli mahsulotlaridan skuId → { sell, commPct, title, shopTitle } xaritasi (sotuv−komissiya uchun)
async function buildSkuSellMap() {
  const map = {};
  for (const shop of (syncedState.shops || [])) {
    const prod = await fetchLiveShopProducts(shop.shopId);
    if (!prod.ok) continue;
    prod.products.forEach(p => (p.skuList || []).forEach(sku => {
      map[String(sku.skuId)] = {
        sell: sku.purchasePrice || 0,
        commPct: commissionPct(sku.skuId, sku, p.productId),
        title: sku.skuTitle, shopTitle: shop.shopTitle
      };
    }));
  }
  return map;
}

async function computeCompensationCandidates() {
  const fetchRes = await fetchAllInvoices();
  if (!fetchRes.ok) return { ok: false, error: fetchRes.error };
  const sellMap = await buildSkuSellMap();

  // SKU bo'yicha ACCEPTED yuk xati qatorlarini yig'amiz. Sana/raqam — invoiceDisplayDate/Number
  // (Uzum kabinetiga MOS, 2026-08-06 tasdiqlangan) orqali; tartiblash — invoiceEventMs (aniq voqea vaqti).
  const bySku = {};
  fetchRes.invoices.filter(i => i.invoiceStatus && i.invoiceStatus.value === 'ACCEPTED').forEach(inv => {
    const displayNum = invoiceDisplayNumber(inv);
    const displayDate = invoiceDisplayDate(inv);
    const dayKey = invoiceDayKey(inv);
    const eventMs = invoiceEventMs(inv);
    (inv.productForInvoiceDto || []).forEach(p => (p.skuForInvoiceDtoList || []).forEach(s => {
      const id = String(s.id);
      (bySku[id] = bySku[id] || []).push({ shopTitle: inv.shopTitle, invoiceNumber: displayNum, date: eventMs, dateStr: displayDate, dayKey, toStock: s.quantityToStock || 0, accepted: s.quantityAccepted || 0, title: s.skuTitle });
    }));
  });

  const aniqItems = [], qismanItems = [];
  for (const [id, lines] of Object.entries(bySku)) {
    lines.sort((a, b) => a.date - b.date);
    const lv = sellMap[id];
    const perUnit = lv ? lv.sell * (1 - (lv.commPct || 0) / 100) : 0;
    const title = lv ? lv.title : lines[0].title;
    const shopTitle = lines[0].shopTitle;
    const partialShort = [], fullRej = [], fullAcc = [];
    lines.forEach(L => {
      if (L.toStock > 0 && L.accepted === 0) fullRej.push({ ...L });
      else if (L.accepted === L.toStock && L.toStock > 0) fullAcc.push({ ...L, avail: L.toStock });
      else if (L.accepted > 0 && L.accepted < L.toStock) partialShort.push({ ...L, short: L.toStock - L.accepted });
    });
    // Qisman kamomad = ANIQ intake yo'qotish (partiya qabul qilingan, dona yetishmagan)
    partialShort.forEach(pS => aniqItems.push({ skuId: id, skuTitle: title, shopTitle, date: pS.dateStr, dayKey: pS.dayKey, invoiceNumber: pS.invoiceNumber, units: pS.short, perUnit, value: pS.short * perUnit, kind: 'partial-shortfall', priced: !!lv }));
    // To'liq rad: yaqin to'liq qabullar bilan (oyna ichida) ochko'zlik bilan moslashtiramiz.
    // MUHIM (2026-08-06 tasdiqlangan): Uzum bir xil qayta saralash partiyasidagi hujjatlarni har doim
    // "avval rad, keyin qabul" tartibida QAYD ETMAYDI — dateAccepted bo'yicha "qabul" hujjati "rad"
    // hujjatidan bir necha soat OLDIN qayd etilgan holatlar kuzatildi (bir xil ombor seansi). Shuning
    // uchun oyna SIMMETRIK: |farq| <= RESORT_WINDOW_DAYS, yo'nalishga qaramasdan.
    fullRej.forEach(R => {
      let remaining = R.toStock;
      for (const A of fullAcc) {
        if (Math.abs(A.date - R.date) <= RESORT_WINDOW_DAYS * 86400000 && A.avail > 0) {
          const take = Math.min(remaining, A.avail); remaining -= take; A.avail -= take;
          if (remaining === 0) break;
        }
      }
      const recovered = R.toStock - remaining;
      if (remaining === 0) return; // to'liq qayta saralangan — yo'qotish yo'q
      if (recovered > 0) qismanItems.push({ skuId: id, skuTitle: title, shopTitle, date: R.dateStr, dayKey: R.dayKey, invoiceNumber: R.invoiceNumber, orig: R.toStock, recovered, units: remaining, perUnit, value: remaining * perUnit, priced: !!lv });
      else aniqItems.push({ skuId: id, skuTitle: title, shopTitle, date: R.dateStr, dayKey: R.dayKey, invoiceNumber: R.invoiceNumber, units: R.toStock, perUnit, value: R.toStock * perUnit, kind: 'full-reject-unrecovered', priced: !!lv });
    });
  }
  aniqItems.sort((a, b) => b.value - a.value);
  qismanItems.sort((a, b) => b.value - a.value);
  const sum = arr => ({ units: arr.reduce((a, x) => a + x.units, 0), value: arr.reduce((a, x) => a + x.value, 0) });
  const aniqSum = sum(aniqItems), qismanSum = sum(qismanItems);

  // Eng katta partiya (bir KUN bo'yicha eng ko'p summa, dayKey orqali) — birinchi ariza uchun.
  // invoiceNumbers — foydalanuvchi Uzum kabinetida qidirishi uchun aniq hujjat raqamlari.
  const byDay = {};
  aniqItems.forEach(x => {
    if (!byDay[x.dayKey]) byDay[x.dayKey] = { dayKey: x.dayKey, units: 0, value: 0, skus: [], invoiceNumbers: new Set() };
    byDay[x.dayKey].units += x.units; byDay[x.dayKey].value += x.value;
    byDay[x.dayKey].skus.push(x.skuTitle); byDay[x.dayKey].invoiceNumbers.add(x.invoiceNumber);
  });
  const topBatchRaw = Object.values(byDay).sort((a, b) => b.value - a.value)[0] || null;
  const topBatch = topBatchRaw ? {
    date: topBatchRaw.dayKey.split('-').reverse().join('.'), // YYYY-MM-DD -> DD.MM.YYYY
    units: topBatchRaw.units, value: topBatchRaw.value, skus: topBatchRaw.skus,
    invoiceNumbers: [...topBatchRaw.invoiceNumbers]
  } : null;

  return {
    ok: true, windowDays: RESORT_WINDOW_DAYS,
    aniq: { count: aniqItems.length, units: aniqSum.units, value: aniqSum.value, items: aniqItems },
    qisman: { count: qismanItems.length, units: qismanSum.units, value: qismanSum.value, items: qismanItems },
    total: { units: aniqSum.units + qismanSum.units, value: aniqSum.value + qismanSum.value },
    topBatch
  };
}

// 19-D: Ta'minlashlar (yuk xatlari) ro'yxati — dashboard va AI konteksti uchun toza shakl.
// Yangi (CREATED) = yo'lda; ACCEPTED = omborda. inTransitUnits = hozir yo'lda bo'lgan dona.
async function computeInvoicesSummary() {
  const fetchRes = await fetchAllInvoices();
  if (!fetchRes.ok) return { ok: false, error: fetchRes.error };
  let inTransitUnits = 0, createdCount = 0, acceptedCount = 0, canceledCount = 0;
  const invoices = fetchRes.invoices.map(inv => {
    const status = inv.invoiceStatus && inv.invoiceStatus.value;
    if (status === 'CREATED') { createdCount++; inTransitUnits += inv.totalToStock || 0; }
    else if (status === 'ACCEPTED') acceptedCount++;
    else if (status === 'CANCELED') canceledCount++;
    const items = [];
    (inv.productForInvoiceDto || []).forEach(p => (p.skuForInvoiceDtoList || []).forEach(s => {
      items.push({ skuTitle: s.skuTitle, toStock: s.quantityToStock || 0, accepted: s.quantityAccepted || 0 });
    }));
    return {
      id: inv.id, invoiceNumber: invoiceDisplayNumber(inv), shopId: inv.shopId, shopTitle: inv.shopTitle,
      status, statusText: inv.invoiceStatus && inv.invoiceStatus.text,
      dateCreated: inv.dateCreated, // hujjat yaratilgan sana (ma'lumot uchun)
      dateAccepted: inv.dateAccepted ? invoiceDisplayDate(inv) : null, // "DD.MM.YYYY HH:MM", Tashkent — Uzum kabinetidagi sana
      displayDate: invoiceDisplayDate(inv), // asosiy ko'rsatiladigan sana (qabul qilingan bo'lsa ustuvor)
      totalToStock: inv.totalToStock || 0, totalAccepted: inv.totalAccepted || 0, items
    };
  });
  return { ok: true, count: invoices.length, createdCount, acceptedCount, canceledCount, inTransitUnits, invoices };
}

// 19-B: yangi CREATED yuk xatlari uchun uy zaxirasidan AVTOMATIK ayirish (tasdiq so'ramasdan, lekin aniq xabar bilan),
// va ACCEPTED holatga o'tganida alohida xabar (zaxiraga tegmasdan). Holat invoice_state.json'da — takror ayirmaslik.
// Birinchi ishga tushishda (fayl yo'q) — barcha mavjud yuk xatlari BAZAVIY deb belgilanadi (ayirish/xabar YO'Q).
let invoiceSyncInProgress = false; // 19-C: kunlik va 20-daqiqalik cron bir vaqtda ustma-ust tushmasin (bir xil invoice_state.json'ni o'qib-yozadi)
async function runInvoiceSync() {
  if (invoiceSyncInProgress) {
    console.log('[INVOICE] Oldingi sinxron hali tugamagan — bu chaqiruv o\'tkazib yuborildi.');
    return { ok: true, skipped: true };
  }
  invoiceSyncInProgress = true;
  try {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const fetchRes = await fetchAllInvoices();
  if (!fetchRes.ok) { console.error('[INVOICE] olinmadi:', fetchRes.error); return { ok: false, error: fetchRes.error }; }
  const invoices = fetchRes.invoices;

  const firstRun = !fs.existsSync(INVOICE_STATE_FILE);
  const st = readJsonFile(INVOICE_STATE_FILE, { deducted: [], acceptedNotified: [] });
  const deducted = new Set(st.deducted || []);
  const acceptedNotified = new Set(st.acceptedNotified || []);

  if (firstRun) {
    // Bazaviy holat: hamma narsani "ishlangan" deb belgilaymiz — eski yuk xatlari zaxirani buzmasin, toshqin bo'lmasin.
    invoices.forEach(inv => {
      deducted.add(inv.id);
      if (inv.invoiceStatus && inv.invoiceStatus.value === 'ACCEPTED') acceptedNotified.add(inv.id);
    });
    writeJsonFile(INVOICE_STATE_FILE, { deducted: [...deducted], acceptedNotified: [...acceptedNotified] });
    console.log(`[INVOICE] Birinchi run — ${invoices.length} ta yuk xati bazaviy belgilandi (ayirish/xabar yo'q).`);
    return { ok: true, firstRun: true, baselined: invoices.length };
  }

  const messages = [];
  let stockChanged = false, deductedCount = 0, acceptedCount = 0;

  for (const inv of invoices) {
    const status = inv.invoiceStatus && inv.invoiceStatus.value;
    const numLabel = invoiceDisplayNumber(inv); // Uzum kabinetidagi raqam — tekshiruv xonasisiz

    // 1) YANGI yuk xati (CREATED yoki to'g'ridan ACCEPTED) hali ayirilmagan bo'lsa — uy zaxirasidan ayir.
    // MUHIM: CANCELED (bekor qilingan) yuk xati JISMONAN jo'natilmagan — zaxiraga TEGMAYMIZ,
    // lekin foydalanuvchi bilishi uchun xabar YUBORILADI (19-D: avval bu holatda xabar umuman yo'q edi).
    if (!deducted.has(inv.id)) {
      if (status === 'CANCELED') {
        deducted.add(inv.id); // bekor qilingan — zaxiraga tegilmaydi, faqat xabar beriladi
        messages.push(
          `❌ *Yuk xati bekor qilindi*\n` +
          `➤ Raqami: #${numLabel}\n` +
          `🏬 Do'kon: ${inv.shopTitle}\n` +
          `📅 Yaratilgan: ${inv.dateCreated || '?'}`
        );
      } else {
        const byType = invoiceQtyByType(inv, 'quantityToStock');
        const lines = [];
        for (const [typeId, qty] of Object.entries(byType)) {
          const type = (syncedState.productTypes || []).find(t => t.id === typeId);
          if (!type) continue;
          const before = type.stock || 0;
          type.stock = Math.max(0, before - qty); // manfiy zaxira yo'q
          lines.push(`   ${type.name}: ${before} → ${type.stock} (−${qty})`);
          stockChanged = true;
        }
        const productNames = [...new Set((inv.productForInvoiceDto || []).map(p => p.productTitle).filter(Boolean))];
        const skuItems = [];
        (inv.productForInvoiceDto || []).forEach(p => (p.skuForInvoiceDtoList || []).forEach(s => {
          skuItems.push({ skuTitle: s.skuTitle || 'SKU', qty: s.quantityToStock || 0 });
        }));
        let msg =
          `📦 *Yangi yuk xati yaratildi!*\n` +
          `➤ Raqami: #${numLabel}\n` +
          `🏬 Do'kon: ${inv.shopTitle} (${inv.shopId})\n` +
          `📅 Sana: ${inv.dateCreated || '?'}\n` +
          `🕐 Aniqlangan: ${fmtTashkentNow()}\n` +
          `📦 Jami: ${fmtMoney(inv.totalToStock || 0)} ta — ${productNames.join(', ') || inv.shopTitle}`;
        if (skuItems.length) msg += `\n\nSKU bo'yicha:\n${skuItems.map(i => `- ${i.skuTitle}: ${fmtMoney(i.qty)} ta`).join('\n')}`;
        if (lines.length) msg += `\n\n🏠 Uy zaxirasidan ayirildi:\n${lines.join('\n')}`;
        else msg += `\n\n(Uy zaxirasiga bog'langan SKU topilmadi — zaxira o'zgarmadi)`;
        messages.push(msg);
        deducted.add(inv.id);
        deductedCount++;
      }
    }

    // 2) ACCEPTED holatga o'tgan va hali xabar berilmagan bo'lsa — alohida xabar (zaxiraga TEGMAYMIZ)
    if (status === 'ACCEPTED' && !acceptedNotified.has(inv.id)) {
      const totalToStock = inv.totalToStock || 0, totalAccepted = inv.totalAccepted || 0;
      const missing = invoiceMissingItems(inv);
      let msg =
        `✅ *Yuk xati qabul qilindi!*\n` +
        `➤ Raqami: #${numLabel}\n` +
        `🏬 Do'kon: ${inv.shopTitle}\n` +
        `📅 Yaratilgan: ${inv.dateCreated || '?'}\n` +
        `📅 Qabul qilingan: ${invoiceDisplayDate(inv)}\n` +
        `➤ Yuborilgan: ${fmtMoney(totalToStock)} ta\n` +
        `➤ Qabul qilingan: ${fmtMoney(totalAccepted)} ta\n` +
        (totalAccepted === totalToStock
          ? `💰 Umumiy qiymat: ${fmtMoney(inv.fullPrice || 0)} so'm`
          : `💰 Yuborilgan partiya qiymati (${fmtMoney(totalToStock)} ta): ${fmtMoney(inv.fullPrice || 0)} so'm`); // fullPrice — Uzum'ning o'z maydoni, jo'natilgan (quantityToStock) shipment qiymati
      if (missing.length) {
        // Bu shu yuk xatidagi FARQ (dona). Aniq kompensatsiya summasi (sotuv−komissiya, qayta saralanganlar
        // chiqarilgan holda) dashboard "Kompensatsiya nomzodlari" bo'limida — chunki farq keyingi yuk xatida
        // qayta qabul qilinishi mumkin (hali aniq yo'qolgan degani emas).
        msg += `\n\n⚠️ *Tafovutlar:*\n${missing.slice(0, 6).map(m => `- ${m.skuTitle} — ${m.accepted}/${m.toStock}`).join('\n')}\n\n→ Bu tovar keyingi yuk xatida qayta qabul qilinishi mumkin. Aniq kompensatsiya: dashboard → Moliya → Kompensatsiya nomzodlari. Uzum kabinetida sababini tekshiring — KAFOLATLANGAN pul emas.`;
      }
      messages.push(msg);
      acceptedNotified.add(inv.id);
      acceptedCount++;
    }
  }

  writeJsonFile(INVOICE_STATE_FILE, { deducted: [...deducted], acceptedNotified: [...acceptedNotified] });
  if (stockChanged) saveSettings(); // uy zaxirasi o'zgardi — diskka saqlaymiz (mavjud himoya ostida)

  if (token && ADMIN_CHAT_ID && messages.length) {
    for (const m of messages) {
      try { await sendTelegramMessage(token, ADMIN_CHAT_ID, m); }
      catch (e) { console.error('[INVOICE] xabar yuborilmadi:', e.message); }
    }
  }
  console.log(`[INVOICE] Sinxron tugadi — ${deductedCount} yangi (ayirildi), ${acceptedCount} qabul qilindi, ${messages.length} xabar.`);
  return { ok: true, firstRun: false, deductedCount, acceptedCount, messagesSent: messages.length };
  } finally {
    invoiceSyncInProgress = false;
  }
}

async function runDailyReport() {
  console.log(`[CRON] Kunlik hisobot boshlandi: ${new Date().toISOString()}`);
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    console.error('[CRON] TELEGRAM_BOT_TOKEN topilmadi — hisobot yuborilmadi.');
    return { success: false, error: "TELEGRAM_BOT_TOKEN yo'q" };
  }
  if (!ADMIN_CHAT_ID) {
    console.error('[CRON] OGOHLANTIRISH: ADMIN_CHAT_ID undefined/bo\'sh — hisobot hech kimga ketmaydi!');
    return { success: false, error: "ADMIN_CHAT_ID yo'q" };
  }
  console.log(`[CRON] Hisobot qabul qiluvchi chat_id: ${ADMIN_CHAT_ID}`);

  const shops = (syncedState.shops && syncedState.shops.length > 0) ? syncedState.shops : [{ shopId: syncedState.activeShop, shopTitle: `Shop ${syncedState.activeShop}` }];
  const results = [];
  let anyOk = false;
  for (const shop of shops) {
    try {
      const reportText = await generateReportText(shop.shopId);
      const sent = await sendTelegramMessage(token, ADMIN_CHAT_ID, reportText);
      if (!sent.ok) {
        console.error(`[CRON] ${shop.shopTitle} hisoboti yuborilmadi — Telegram API rad etdi: ${new Date().toISOString()}`);
        results.push({ shopId: shop.shopId, shopTitle: shop.shopTitle, success: false, telegram: sent });
      } else {
        console.log(`[CRON] ${shop.shopTitle} hisoboti muvaffaqiyatli yuborildi: ${new Date().toISOString()}`);
        results.push({ shopId: shop.shopId, shopTitle: shop.shopTitle, success: true, telegram: sent });
        anyOk = true;
      }
    } catch (err) {
      console.error(`[CRON] ${shop.shopTitle} hisobotida xato: ${new Date().toISOString()}`, err);
      results.push({ shopId: shop.shopId, shopTitle: shop.shopTitle, success: false, error: err.message });
    }
  }
  // 18-D2/D3: barcha do'kon hisobotlaridan keyin — bitta GLOBAL moliya xabari (naqd oqim + kredit ogohlantirishlari)
  try {
    const finLine = await financeSummaryLine();
    const warns = creditWarnings();
    // 19-D: ta'minlash qatori — yo'lda tovar + kompensatsiya nomzodlari
    let invLine = '';
    try {
      const invSum = await computeInvoicesSummary();
      const comp = await computeCompensationCandidates();
      const parts = [];
      if (invSum.ok && invSum.inTransitUnits > 0) parts.push(`📦 Yo'lda: ${fmtMoney(invSum.inTransitUnits)} dona`);
      if (comp.ok && comp.aniq.units > 0) parts.push(`⚠️ Kompensatsiya nomzodi: ${fmtMoney(comp.aniq.units)} dona (~${fmtMoney(comp.aniq.value)} so'm)${comp.qisman.units ? ` +${fmtMoney(comp.qisman.units)} qisman` : ''}`);
      if (parts.length) invLine = '\n\n' + parts.join('\n');
    } catch (e) { /* invoice majburiy emas */ }
    if (finLine || warns.length || invLine) {
      let moneyMsg = `💰 *Moliyaviy holat*\n${finLine}`;
      if (warns.length) moneyMsg += `\n\n🏦 *Kredit ogohlantirishlari:*\n${warns.join('\n')}`;
      moneyMsg += invLine;
      moneyMsg += `\n\n/moliya — batafsil · /maslahat — AI murabbiy`;
      await sendTelegramMessage(token, ADMIN_CHAT_ID, moneyMsg);
    }
  } catch (err) { console.error('[CRON] Moliya xabarida xato:', err); }

  if (anyOk) setLastReportDate(todayTashkent()); // kamida bittasi ketgan bo'lsa ham "bugun bajarildi" deb belgilanadi (catch-up uchun)
  return { success: anyOk, chatIdUsed: ADMIN_CHAT_ID, shops: results };
}

// 4. Telegram Bot Webhook Route
// 14B2: davr nomi + sana(lar) — hisobot sarlavhasida ko'rsatish uchun.
// "Bugun" uchun soat:daqiqa (asOf, Toshkent vaqti) qo'shiladi — bu HECH QACHON to'liq kunlik
// ma'lumot emasligini har doim aniq ko'rsatish uchun (14-bosqich eslatmasi).
function formatPeriodLabel(result) {
  const periodNames = { today: 'BUGUN', yesterday: 'KECHA', week: '1 HAFTA', month: '30 KUN' };
  const name = periodNames[result.period] || String(result.period || '').toUpperCase();
  if (result.period === 'today' && result.asOf) {
    const t = new Date(new Date(result.asOf).getTime() + 5 * 60 * 60 * 1000);
    const hh = String(t.getUTCHours()).padStart(2, '0');
    const mm = String(t.getUTCMinutes()).padStart(2, '0');
    return `${result.toDate || todayTashkent()} — ${name} (soat ${hh}:${mm} holatiga)`;
  }
  if (!result.fromDate || !result.toDate) return name;
  if (result.fromDate === result.toDate) return `${result.toDate} (${name})`;
  return `${result.fromDate} — ${result.toDate} (${name})`;
}

// 14B2: bot uchun qisqa davr hisoboti matni — computePeriodReport natijasidan.
function buildPeriodReportText(result) {
  const header = `🟣 *Uzum Pro — ${result.shopTitle} (${result.shopId})*\n📅 ${formatPeriodLabel(result)}`;
  // 18-FIX: finance/orders — REAL VAQTLI va ANIQ. "kamida/taxminiy/~" belgilari OLIB TASHLANDI.
  const lines = [];
  lines.push(`🛍️ Sotildi: ${fmtMoney(result.units)} dona (${fmtMoney(result.orders)} buyurtma)${result.canceledCount ? ` · ❌ ${fmtMoney(result.canceledCount)} bekor` : ''}`);
  lines.push(`💰 Tushum: ${fmtMoney(result.revenue)} so'm`);
  lines.push(`🏦 Uzum to'lovi (komissiya/logistikadan keyin): ${fmtMoney(result.payout)} so'm`);
  lines.push(`💸 Sof foyda (tannarx ayrilgan): ${fmtMoney(result.profit)} so'm`);
  lines.push(costSourceLine(result.costSource));
  if (result.period === 'today') lines.push(`\n⏳ Bugun — kun hali tugamagan, kun davomida yangilanadi`);
  lines.push(`\n📊 Manba: Uzum buyurtmalar (real vaqtli, aniq)`);
  return `${header}\n\n${lines.join('\n')}`;
}

// 14B1: do'kon tanlangach ko'rsatiladigan davr tugmalari (2x2)
function periodSelectionKeyboard(shopSel) {
  return {
    inline_keyboard: [
      [{ text: '📅 Bugun', callback_data: `period:${shopSel}:today` }, { text: '📆 Kecha', callback_data: `period:${shopSel}:yesterday` }],
      [{ text: '🗓 1 hafta', callback_data: `period:${shopSel}:week` }, { text: '🗓 30 kun', callback_data: `period:${shopSel}:month` }]
    ]
  };
}

// 6.2: tugma bosilganda Telegram loading spinnerni to'xtatadi (callback_query javobi majburiy emas, lekin UX uchun kerak)
async function answerCallbackQuery(token, callbackQueryId, text) {
  try {
    await fetch(`https://api.telegram.org/bot${token}/answerCallbackQuery`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ callback_query_id: callbackQueryId, ...(text ? { text } : {}) })
    });
  } catch (err) {
    console.error('[TG] answerCallbackQuery xato:', err);
  }
}

app.post('/api/tg-bot/webhook', async (req, res) => {
  res.sendStatus(200);

  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) return;
  const appUrl = process.env.APP_URL || '';

  // 14B1: "/hisobot" endi ikki bosqichli — avval do'kon (shop:{id|all}), keyin davr (period:{id|all}:{code})
  const cq = req.body.callback_query;
  if (cq && cq.data) {
    const chatId = cq.message?.chat?.id;
    await answerCallbackQuery(token, cq.id);
    if (!chatId) return;

    if (cq.data.startsWith('shop:')) {
      const shopSel = cq.data.slice('shop:'.length);
      await sendTelegramMessage(token, chatId, "Qaysi davr uchun hisobot kerak?", periodSelectionKeyboard(shopSel));
      return;
    }

    if (cq.data.startsWith('period:')) {
      const [shopSel, period] = cq.data.slice('period:'.length).split(':');
      if (shopSel === 'all') {
        const shops = syncedState.shops || [];
        for (const shop of shops) {
          const result = await computePeriodReport(shop.shopId, period);
          const text = result.ok ? buildPeriodReportText(result) : `🟣 *${shop.shopTitle}*\n\n⚠️ Hisobot olinmadi: ${result.error}`;
          await sendTelegramMessage(token, chatId, text);
        }
      } else {
        const result = await computePeriodReport(shopSel, period);
        const text = result.ok ? buildPeriodReportText(result) : `⚠️ Hisobot olinmadi: ${result.error}`;
        await sendTelegramMessage(token, chatId, text, {
          inline_keyboard: [[{ text: "📊 Dashboardni ochish (Mini App)", web_app: { url: appUrl } }]]
        });
      }
      return;
    }
    return;
  }

  const { message } = req.body;
  if (!message || !message.text || !message.chat) return;

  const chatId = message.chat.id;
  const text = message.text.trim();

  if (text.startsWith('/start')) {
    const replyText = `🟣 *Uzum Pro Dashboard — Telegram Mini App + Bot*

Assalomu alaykum! Do'kon aslahasi muvaffaqiyatli ulangan. Men sizning sotuvlar va zaxirani kuzatib boruvchi aqlli yordamchingizman.

Mavjud buyruqlar:
/hisobot — Bugungi savdolar, xarajatlar va zaxira holati hisoboti.
/moliya — Naqd oqim: bu oy foyda/zarar, xarajat, kredit, proyeksiya.
/maslahat — AI moliyaviy murabbiy: bugungi 3 ta ish + Xitoy buyurtma.
/maqsad — Oylik aylanma maqsadi va unga qanchalik yaqinligingiz.
/dashboard — Do'konni vizual boshqarish va AI maslahat xonasi.

Pastdagi tugma orqali bevosita Telegram Mini App iovamizni ishga tushirishingiz mumkin.`;

    await sendTelegramMessage(token, chatId, replyText, {
      inline_keyboard: [[
        { text: "📊 Dashboardni ochish (Mini App)", web_app: { url: appUrl } }
      ]]
    });
  } else if (text.startsWith('/hisobot')) {
    // 14B1: do'kon tanlash tugmalari — har biri alohida qatorda + "Barchasi". Tanlangach davr so'raladi.
    const shops = syncedState.shops || [];
    if (shops.length === 0) {
      const result = await computePeriodReport(syncedState.activeShop, 'yesterday');
      const reportText = result.ok ? buildPeriodReportText(result) : `⚠️ Hisobot olinmadi: ${result.error}`;
      await sendTelegramMessage(token, chatId, reportText, {
        inline_keyboard: [[{ text: "📊 Dashboardni ochish (Mini App)", web_app: { url: appUrl } }]]
      });
    } else {
      const buttons = shops.map(s => ([{ text: s.shopTitle, callback_data: `shop:${s.shopId}` }]));
      buttons.push([{ text: "📊 Barchasi", callback_data: 'shop:all' }]);
      await sendTelegramMessage(token, chatId, "Qaysi do'kon uchun hisobot kerak?", { inline_keyboard: buttons });
    }
  } else if (text.startsWith('/moliya')) {
    // 18-D1: pul holati — naqd oqim + proyeksiya + kredit
    await sendTelegramMessage(token, chatId, await moliyaCommandText());
  } else if (text.startsWith('/maslahat')) {
    // 18-D1: AI moliyaviy murabbiy
    await sendTelegramMessage(token, chatId, "🤖 AI murabbiy tahlil qilyapti... (10-20 soniya)");
    const result = await generateAiAdvice(syncedState.activeShop);
    if (result.ok) {
      await sendTelegramMessage(token, chatId, aiAdviceToText(result.data));
    } else {
      await sendTelegramMessage(token, chatId, `⚠️ AI murabbiy javob bermadi: ${result.error}`);
    }
  } else if (text.startsWith('/maqsad')) {
    // 18-D1: oylik aylanma maqsadi holati
    await sendTelegramMessage(token, chatId, await maqsadCommandText());
  } else if (text.startsWith('/dashboard')) {
    await sendTelegramMessage(token, chatId, "Uzum Market sotuvchi hisobotlar panelini ochish uchun quyidagi tugmani bosing:", {
      inline_keyboard: [[
        { text: "📊 Dashboardni ochish (Mini App)", web_app: { url: appUrl } }
      ]]
    });
  }
});

// 18-BOT-FIX diagnostika: setMyCommands muvaffaqiyatli ro'yxatdan o'tganini tekshirish (o'qish uchun, xavfsiz).
app.get('/api/tg-bot/commands-status', async (req, res) => {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) return res.status(400).json({ error: "TELEGRAM_BOT_TOKEN yo'q" });
  try {
    const response = await fetch(`https://api.telegram.org/bot${token}/getMyCommands`);
    const data = await response.json();
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Endpoint to fetch simulated bot report text in the simulator
app.get('/api/tg-bot/simulate-report', async (req, res) => {
  // Return the textual report so frontend simulator can demonstrate beautifully
  const shopId = req.query.shopId || syncedState.activeShop;
  const text = await generateReportText(shopId);
  res.json({ report: text });
});

// Diagnostika: kunlik hisobotni qo'lda, darhol ishga tushiradi (cron kutmasdan sinash uchun)
app.get('/api/tg-bot/trigger-daily-report', async (req, res) => {
  const result = await runDailyReport();
  res.json(result);
});

// 18-D0 diagnostika: muammo tekshiruvini qo'lda ishga tushiradi (cron kutmasdan).
app.get('/api/tg-bot/trigger-problem-check', async (req, res) => {
  const result = await runProblemCheck();
  res.json(result);
});

// 19-B diagnostika: invoice sinxronni qo'lda ishga tushiradi (cron kutmasdan)
app.get('/api/invoice/trigger-sync', async (req, res) => {
  const result = await runInvoiceSync();
  res.json(result);
});

// 19-B diagnostika (o'qish uchun): invoice holati — nechta ayirilgan/qabul belgilangan
app.get('/api/invoice/sync-status', (req, res) => {
  const st = readJsonFile(INVOICE_STATE_FILE, null);
  res.json({
    fileExists: fs.existsSync(INVOICE_STATE_FILE),
    deductedCount: st ? (st.deducted || []).length : 0,
    acceptedNotifiedCount: st ? (st.acceptedNotified || []).length : 0
  });
});

// 19-C: kompensatsiya nomzodlari (yo'qolgan/rad etilgan tovar) — barcha ACCEPTED yuk xatlari bo'yicha
app.get('/api/compensation-candidates', async (req, res) => {
  const result = await computeCompensationCandidates();
  if (!result.ok) return sendUzumError(res, result.error);
  res.json(result);
});

// 19-D: ta'minlashlar (yuk xatlari) ro'yxati — dashboard "Ta'minlashlar" bo'limi uchun
app.get('/api/invoices', async (req, res) => {
  const result = await computeInvoicesSummary();
  if (!result.ok) return sendUzumError(res, result.error);
  res.json(result);
});

// Diagnostika: snapshotni qo'lda darhol oladi (cron kutmasdan sinash uchun)
app.get('/api/snapshot/capture', async (req, res) => {
  const result = await captureSnapshot();
  res.json(result);
});

// Diagnostika: joriy sozlamalar (do'konlar) holatini ko'rsatadi — settings.json diskdan yuklandimi
app.get('/api/settings/status', (req, res) => {
  res.json({
    loadedFromDisk: settingsLoadedFromDisk,
    settingsFileExists: fs.existsSync(SETTINGS_FILE),
    dataDir: DATA_DIR,
    shops: syncedState.shops,
    shopCount: (syncedState.shops || []).length,
    productTypesCount: (syncedState.productTypes || []).length
  });
});

// B-bosqich VAQTINCHALIK diagnostika: computeTurnoverDays()ni real SKU'lar uchun to'g'ridan-to'g'ri
// chaqiradi (proksisiz). Tekshirilgach OLIB TASHLANADI — doimiy endpoint emas.
app.get('/api/diag/turnover/:shopId', async (req, res) => {
  const shopId = req.params.shopId;
  const prod = await fetchLiveShopProducts(shopId);
  if (!prod.ok) return sendUzumError(res, prod.error);
  const snapshots = loadSnapshots();
  const rows = [];
  prod.products.forEach(p => (p.skuList || []).forEach(sku => {
    const t = computeTurnoverDays(shopId, sku.skuId, snapshots);
    rows.push({
      skuTitle: sku.skuTitle, avail: Math.max(0, sku.availableAmount || 0),
      turnoverDays: t.days === Infinity ? 'Infinity' : t.days, partial: t.partial, noSales: t.noSales,
      rate: computeStorageRate(t.days)
    });
  }));
  res.json({ shopId, snapshotDays: Object.keys(snapshots[shopId] || {}).length, count: rows.length, rows });
});

// Diagnostika: joriy snapshot holatini ko'rsatadi (nechta kun, oxirgi delta)
app.get('/api/snapshot/status', (req, res) => {
  const snapshots = loadSnapshots();
  const out = {};
  for (const shopId of Object.keys(snapshots)) {
    out[shopId] = { dates: Object.keys(snapshots[shopId]).sort(), delta: getDailyDelta(shopId) };
  }
  res.json(out);
});

// 5.1/5.2/5.4: SKU bo'yicha zaxira kunlari, ABC toifa, Xitoy buyurtma nuqtasi — snapshot tarixidan
app.get('/api/metrics/:shopId', async (req, res) => {
  const result = await computeSkuMetrics(req.params.shopId);
  if (!result.ok) return sendUzumError(res, result.error);
  res.json(result);
});

// B1/14A1: Moliya bo'limi uchun snapshot delta'ga asoslangan xulosa (finance/orders o'rniga). ?days=N (default 30)
app.get('/api/finance-summary/:shopId', async (req, res) => {
  const days = Math.max(1, Math.min(60, Number(req.query.days) || 30));
  const result = await computeFinanceSummary(req.params.shopId, days);
  if (!result.ok) return sendUzumError(res, result.error);
  res.json(result);
});

// 18-FIX diagnostika: finance/orders'dan sotuv (?period=today|yesterday|week|month yoki YYYY-MM-DD)
app.get('/api/sales-orders/:shopId', async (req, res) => {
  const period = req.query.period || 'yesterday';
  const result = await computeSalesFromOrders(req.params.shopId, period);
  if (!result.ok) return sendUzumError(res, result.error);
  res.json(result);
});

// 14A3: yagona davr endpointi — ?period=today|yesterday|week|month
app.get('/api/period-report/:shopId', async (req, res) => {
  const period = req.query.period || 'yesterday';
  if (!['today', 'yesterday', 'week', 'month'].includes(period)) {
    return res.status(400).json({ error: "Noto'g'ri davr. period=today|yesterday|week|month bo'lishi kerak" });
  }
  const result = await computePeriodReport(req.params.shopId, period);
  if (!result.ok) return sendUzumError(res, result.error);
  res.json(result);
});

// E: keyingi 30 kunlik bashorat, ishonch darajasi bilan
app.get('/api/forecast/:shopId', async (req, res) => {
  const result = await computeForecast(req.params.shopId);
  if (!result.ok) return sendUzumError(res, result.error);
  res.json(result);
});

// 18-B: NAQD OQIM (cash flow) — botning yuragi. "sinyapmanmi yoki botyapmanmi" savoliga javob.
// Bu oy: yechib olingan (keldi) − real xarajatlar − kredit to'lovlari = sof naqd oqim.
// + Keyingi 30 kun proyeksiya: kutilayotgan kredit to'lovlari vs bashorat foyda.
//
// 18-KREDIT-FIX: eski "oyning N-kuni" (paymentDay, 1-28) o'rniga ANIQ SANA (nextPaymentDate) asosiy
// bo'ldi — foydalanuvchi oldindan to'lagan bo'lsa ham, muddat oxiriga yaqin oylarda ham to'g'ri ishlaydi.
// Eski kreditlar (faqat paymentDay bilan, nextPaymentDate'siz) uchun orqaga moslik saqlanadi.
function creditDaysUntilDueByDay(paymentDay) {
  const { date } = tashkentTimeParts();
  const [y, m, d] = date.split('-').map(Number);
  const pd = Math.min(28, Math.max(1, paymentDay || 1));
  let dueYear = y, dueMonth = m;
  if (d > pd) { dueMonth++; if (dueMonth > 12) { dueMonth = 1; dueYear++; } } // bu oy o'tgan bo'lsa keyingi oy
  const due = new Date(Date.UTC(dueYear, dueMonth - 1, pd));
  const todayUTC = new Date(Date.UTC(y, m - 1, d));
  return Math.round((due - todayUTC) / 86400000);
}
// Kredit obyektini qabul qiladi (nextPaymentDate ustuvor, paymentDay — eski format uchun zaxira).
function creditDaysUntilDue(credit) {
  if (credit && credit.nextPaymentDate) {
    const { date } = tashkentTimeParts();
    const todayUTC = new Date(date + 'T00:00:00Z');
    const dueUTC = new Date(credit.nextPaymentDate + 'T00:00:00Z');
    return Math.round((dueUTC - todayUTC) / 86400000);
  }
  return creditDaysUntilDueByDay(credit ? credit.paymentDay : credit);
}
// Sanani 1 oyga suradi (kun oyning oxiridan oshsa qisqartiriladi — masalan 31-yanvar + 1 oy = 28/29-fevral).
function addOneMonthISO(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  let ny = y, nm = m + 1;
  if (nm > 12) { nm = 1; ny++; }
  const lastDay = new Date(Date.UTC(ny, nm, 0)).getUTCDate();
  const nd = Math.min(d, lastDay);
  return `${ny}-${String(nm).padStart(2, '0')}-${String(nd).padStart(2, '0')}`;
}

async function computeCashFlow() {
  const month = todayTashkent().slice(0, 7); // YYYY-MM
  const withdrawals = syncedState.withdrawals || [];
  const userExpenses = syncedState.userExpenses || [];
  const credits = syncedState.credits || [];

  const wdMonth = withdrawals.filter(w => (w.date || '').slice(0, 7) === month);
  const withdrawnCame = wdMonth.filter(w => w.status === 'keldi').reduce((a, w) => a + (w.amount || 0), 0);
  const withdrawnPending = wdMonth.filter(w => w.status !== 'keldi').reduce((a, w) => a + (w.amount || 0), 0);

  const exMonth = userExpenses.filter(e => (e.date || '').slice(0, 7) === month);
  const expensesTotal = exMonth.reduce((a, e) => a + (e.amount || 0), 0);
  const expensesByCategory = {};
  exMonth.forEach(e => { const c = e.category || 'Boshqa'; expensesByCategory[c] = (expensesByCategory[c] || 0) + (e.amount || 0); });

  const creditMonthly = credits.reduce((a, c) => a + (c.monthlyPayment || 0), 0);
  const creditRemaining = credits.reduce((a, c) => a + (c.remainingAmount || 0), 0);

  const netCashFlow = withdrawnCame - expensesTotal - creditMonthly;

  // B2: proyeksiya — keyingi 30 kun kredit to'lovlari
  const upcomingCredits = credits.filter(c => creditDaysUntilDue(c) <= 30).reduce((a, c) => a + (c.monthlyPayment || 0), 0);
  // Kutilayotgan Uzum foydasi (bashoratdan, barcha do'kon) — sof foyda (kassaga tushadigan yangi pul)
  let expectedIncome = 0, forecastReady = false;
  for (const shop of (syncedState.shops || [])) {
    const f = await computeForecast(shop.shopId);
    if (f.ok && f.ready) { expectedIncome += f.forecastProfit; forecastReady = true; }
  }
  let projection = null;
  if (upcomingCredits > 0 || forecastReady) {
    let risk, verdict;
    if (!forecastReady) { risk = 'warn'; verdict = '⚠️ Bashorat uchun ma\'lumot yetarli emas — Uzum tushumini aniq bashorat qilib bo\'lmadi'; }
    else if (expectedIncome >= upcomingCredits * 1.2) { risk = 'ok'; verdict = '✅ Yetadi — kutilayotgan foyda kredit to\'lovlaridan yuqori'; }
    else if (expectedIncome >= upcomingCredits) { risk = 'warn'; verdict = '⚠️ Tanqislik bo\'lishi mumkin — foyda kredit to\'lovlariga tenglashyapti, zaxira pul saqlang'; }
    else { risk = 'danger'; verdict = '🔴 Jiddiy xavf — kutilayotgan foyda kredit to\'lovlaridan KAM. Xarajatni kamaytiring yoki sotuvni oshiring'; }
    projection = { upcomingCredits, expectedIncome, forecastReady, risk, verdict };
  }

  return {
    ok: true, month,
    withdrawnCame, withdrawnPending,
    expensesTotal, expensesByCategory,
    creditMonthly, creditRemaining,
    netCashFlow, projection
  };
}

app.get('/api/cash-flow', async (req, res) => {
  try {
    res.json(await computeCashFlow());
  } catch (err) {
    console.error('[CASH-FLOW] xato:', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// D1/D2/D4/D5/6.3: barcha sozlangan do'konlar bo'yicha jamlangan ko'rsatkichlar (Dashboard "Barcha do'konlar" ko'rinishi uchun).
// Har do'kon uchun: joriy Uzum zaxirasi soni/qiymati (tannarx/sotilsa/foyda) va oxirgi kunlik aylanma (snapshot delta'dan).
// Uy zaxirasi barcha do'konlar uchun umumiy (D3) — shuning uchun bir marta, barcha do'konlar SKU'laridan yig'ilgan
// o'rtacha narx/foyda asosida hisoblanadi.
app.get('/api/all-shops-summary', async (req, res) => {
  const shops = syncedState.shops || [];
  const results = [];
  const typeStats = {}; // typeId -> { sumPrice, sumProfit, count } — uy zaxirasi "sotilsa/foyda" taxmini uchun
  const snapshots = loadSnapshots(); // B-bosqich: saqlash tarifi uchun aylanma kunlari (barcha do'kon shu obyektda)
  for (const shop of shops) {
    const prod = await fetchLiveShopProducts(shop.shopId);
    if (!prod.ok) { results.push({ shopId: shop.shopId, shopTitle: shop.shopTitle, ok: false, error: prod.error }); continue; }
    let totalStock = 0, activeCount = 0, outOfStock = 0, blocked = 0;
    let stockValueTannarx = 0, stockValueSotilsa = 0, stockValueFoyda = 0;
    prod.products.forEach(p => {
      activeCount++;
      if (p.status?.value === 'PERM_BANNED') blocked++;
      (p.skuList || []).forEach(s => {
        const avail = Math.max(0, s.availableAmount || 0); // 13.1: manfiy zaxira 0
        totalStock += avail;
        if (avail <= 0) outOfStock++;

        const price = s.purchasePrice || 0;
        const tInfo = resolveTannarx(s.skuId, p.productId);
        const commission = price * (commissionPct(s.skuId, s, p.productId) / 100);
        const logi = resolveLogistics(s.skuId, p.productId, s).val;
        const turnover = computeTurnoverDays(shop.shopId, s.skuId, snapshots).days;
        const stor = resolveStorage(s.skuId, p.productId, s, turnover).val;
        const profitPerUnit = price - commission - logi - stor - tInfo.tannarx; // reklama kiritilmagan (dona-darajasida ishonchli emas)

        stockValueTannarx += avail * tInfo.tannarx;
        stockValueSotilsa += avail * price;
        stockValueFoyda += avail * profitPerUnit;

        const typeId = syncedState.skuMappings[s.skuId];
        if (typeId) {
          if (!typeStats[typeId]) typeStats[typeId] = { sumPrice: 0, sumProfit: 0, count: 0 };
          typeStats[typeId].sumPrice += price;
          typeStats[typeId].sumProfit += profitPerUnit;
          typeStats[typeId].count++;
        }
      });
    });
    const fin = await computeSalesFromOrders(shop.shopId, 'month'); // 18-FIX: D4 aylanma — finance/orders (30 kun, aniq)
    results.push({
      shopId: shop.shopId, shopTitle: shop.shopTitle, ok: true, totalStock, activeCount, outOfStock, blocked,
      stockValueTannarx, stockValueSotilsa, stockValueFoyda,
      turnover: fin.ok ? { ready: true, spanDays: fin.spanDays, totalSales: fin.totalSales, totalProfit: fin.totalProfit, soldTotal: fin.soldTotal } : { ready: false, error: fin.error }
    });
  }

  // D1/D2/D3: uy zaxirasi — barcha do'konlar uchun umumiy, shuning uchun bir marta hisoblanadi
  let homeStockQty = 0, homeStockValue = 0, homeSotilsa = 0, homeFoyda = 0;
  const typesWithoutPrice = [];
  (syncedState.productTypes || []).forEach(t => {
    homeStockQty += t.stock;
    homeStockValue += t.stock * t.cost;
    const stats = typeStats[t.id];
    if (stats && stats.count > 0) {
      homeSotilsa += t.stock * (stats.sumPrice / stats.count);
      homeFoyda += t.stock * (stats.sumProfit / stats.count);
    } else if (t.stock > 0) {
      typesWithoutPrice.push(t.name);
    }
  });

  const totalStock = results.reduce((a, r) => a + (r.totalStock || 0), 0);
  const totalActive = results.reduce((a, r) => a + (r.activeCount || 0), 0);
  const totalOutOfStock = results.reduce((a, r) => a + (r.outOfStock || 0), 0);
  const uzumStockValueTannarx = results.reduce((a, r) => a + (r.stockValueTannarx || 0), 0);
  const uzumStockValueSotilsa = results.reduce((a, r) => a + (r.stockValueSotilsa || 0), 0);
  const uzumStockValueFoyda = results.reduce((a, r) => a + (r.stockValueFoyda || 0), 0);

  res.json({
    shops: results, totalStock, totalActive, totalOutOfStock,
    homeStockQty, homeStockValue, homeSotilsa, homeFoyda, typesWithoutPrice,
    uzumStockValueTannarx, uzumStockValueSotilsa, uzumStockValueFoyda
  });
});

// Automatic bot registration logic
if (process.env.TELEGRAM_BOT_TOKEN && process.env.APP_URL) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const webhookUrl = `${process.env.APP_URL}/api/tg-bot/webhook`;

  fetch(`https://api.telegram.org/bot${token}/setWebhook?url=${encodeURIComponent(webhookUrl)}`)
    .then(r => r.json())
    .then(data => {
      console.log(`Telegram Bot Hook Registered:`, data);
    })
    .catch(err => {
      console.error(`Telegram Bot webhook registration failed:`, err);
    });
}

// 18-BOT-FIX: setMyCommands — buyruqlar "/" menyusida chiqishi va matnda BOSILADIGAN bo'lishi uchun
// Telegram serveriga ro'yxatdan o'tkaziladi. Bir martalik sozlash — xato bo'lsa asosiy ishga xalaqit
// bermasligi uchun try/catch bilan o'raladi, faqat log yoziladi.
if (process.env.TELEGRAM_BOT_TOKEN) {
  (async () => {
    try {
      const token = process.env.TELEGRAM_BOT_TOKEN;
      const commands = [
        { command: 'hisobot', description: "Bugungi savdo, xarajat, zaxira hisoboti" },
        { command: 'moliya', description: "Naqd oqim: foyda/zarar, xarajat, kredit" },
        { command: 'maslahat', description: "AI murabbiy: bugungi ishlar va tavsiyalar" },
        { command: 'maqsad', description: "Aylanma maqsadi va unga yaqinlik" },
        { command: 'dashboard', description: "Mini App ochish" }
      ];
      const response = await fetch(`https://api.telegram.org/bot${token}/setMyCommands`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ commands })
      });
      const data = await response.json();
      if (data.ok) console.log('[TG] setMyCommands muvaffaqiyatli:', JSON.stringify(commands.map(c => c.command)));
      else console.error('[TG] setMyCommands RAD ETILDI:', JSON.stringify(data));
    } catch (err) {
      console.error('[TG] setMyCommands xato (asosiy ishga ta\'sir qilmaydi):', err.message);
    }
  })();
}

// Snapshot cron — har kuni 04:50 Asia/Tashkent (hisobotdan oldin, sotuv tezligi uchun)
// MUHIM: bu callback ham "[CRON]" tegi bilan loglaydi — Railway loglarida "CRON" bo'yicha
// qidirilganda ko'rinsin (avval faqat "[SNAPSHOT]" tegi bor edi, "CRON" qidiruviga tushmasdi).
if (process.env.UZUM_TOKEN) {
  cron.schedule('50 4 * * *', () => {
    console.log(`[CRON] Snapshot cron ishga tushdi: ${new Date().toISOString()}`);
    captureSnapshot()
      .then(r => {
        console.log(`[CRON] Snapshot cron tugadi: ${r.savedShops} do'kon saqlandi (${r.date})`);
        return runProblemCheck(); // 18-D0: snapshotdan keyin muammo kuzatuvi (yangi bloklangan/tugagan SKU)
      })
      .then(() => runInvoiceSync()) // 19-B: yangi yuk xati -> uy zaxirasidan avto ayirish + qabul/farq xabari
      .catch(e => console.error('[CRON] Snapshot/muammo/invoice cron xato:', e));
  }, { timezone: 'Asia/Tashkent' });
  console.log('[CRON] Kunlik snapshot rejalashtirildi: har kuni 04:50 Asia/Tashkent.');
} else {
  console.warn('[CRON] UZUM_TOKEN yo\'q — snapshot rejalashtirilmadi.');
}

// 19-C: Invoice sinxron — qo'shimcha, har 20 daqiqada (kunlik 04:50 zanjirdan mustaqil,
// unga tegmaydi). Maqsad — holat o'zgarishi (ACCEPTED/yangi yuk xati) haqidagi xabar
// ertalabgacha kutmasdan, tezroq kelishi. invoiceSyncInProgress qulfi ustma-ust tushishni oldini oladi.
if (process.env.UZUM_TOKEN) {
  cron.schedule('*/20 * * * *', () => {
    runInvoiceSync().catch(e => console.error('[CRON] 20-daqiqalik invoice sync xato:', e));
  }, { timezone: 'Asia/Tashkent' });
  console.log('[CRON] Invoice sinxron qo\'shimcha rejalashtirildi: har 20 daqiqada.');
}

// Scheduled daily report — har kuni 05:00 Toshkent vaqtida (timezone aniq ko'rsatilgan,
// server konteyneri qaysi TZ'da ishlashidan qat'i nazar to'g'ri vaqtda ishga tushadi)
if (process.env.TELEGRAM_BOT_TOKEN) {
  cron.schedule('0 5 * * *', runDailyReport, { timezone: 'Asia/Tashkent' });
  console.log('[CRON] Kunlik hisobot rejalashtirildi: har kuni 05:00 Asia/Tashkent vaqtida.');
} else {
  console.warn('[CRON] TELEGRAM_BOT_TOKEN yo\'q — kunlik hisobot rejalashtirilmadi.');
}

// Serve Telegram UI directly
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'dashboard.html'));
});

app.get('/dashboard', (req, res) => {
  res.sendFile(path.join(__dirname, 'dashboard.html'));
});

// Catch-up: cron faqat server AYNI shu daqiqada ishlab turgandagina ishga tushadi. Agar Railway
// qayta ishga tushishi (deploy, crash, restart) 04:50/05:00 oynasini o'tkazib yuborgan bo'lsa,
// cron shu kuni umuman ishlamay qoladi. Shuning uchun startupda "bugun bajarilganmi?" tekshiramiz —
// bajarilmagan bo'lsa va vaqt allaqachon o'tgan bo'lsa, bir martalik "quvib yetish" ishga tushiramiz.
async function runStartupCatchUp() {
  const { date, hour, minute } = tashkentTimeParts();

  const pastSnapshotTime = hour > 4 || (hour === 4 && minute >= 50);
  if (process.env.UZUM_TOKEN && pastSnapshotTime && todaysSnapshotMissing()) {
    console.log(`[CRON] Catch-up: bugungi (${date}) snapshot topilmadi, hozir olinmoqda...`);
    try {
      const r = await captureSnapshot();
      console.log(`[CRON] Catch-up snapshot tugadi: ${r.savedShops} do'kon saqlandi (${r.date})`);
    } catch (e) {
      console.error('[CRON] Catch-up snapshot xato:', e);
    }
  }

  const pastReportTime = hour >= 5;
  if (process.env.TELEGRAM_BOT_TOKEN && pastReportTime && getLastReportDate() !== date) {
    console.log(`[CRON] Catch-up: bugungi (${date}) hisobot hali yuborilmagan, hozir yuborilmoqda...`);
    runDailyReport().catch(e => console.error('[CRON] Catch-up hisobot xato:', e));
  }
}

// Startupda saqlangan sozlamalarni diskdan yuklaymiz (2.2)
loadSettings();

// Catch-up — server to'liq ishga tushgach, fon rejimida (startupni bloklamaydi)
runStartupCatchUp().catch(e => console.error('[CRON] Catch-up umumiy xato:', e));

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Uzum dashboard server running on port ${PORT}`);
});

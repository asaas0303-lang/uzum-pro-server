import 'dotenv/config';
import express from 'express';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { GoogleGenAI } from '@google/genai';
import cron from 'node-cron';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

// ============ DISK SAQLASH (2.2) ============
// DATA_DIR — Railway'da Volume ulanadigan yo'l. Default ./data (lokal test uchun).
// DIQQAT: Railway'da Volume ulanmasa, ./data har redeploy'da o'chadi (efemer).
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');
const SNAPSHOTS_FILE = path.join(DATA_DIR, 'snapshots.json');
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
  expenses: [] // real Uzum finance expenses synced from frontend (dashboard.html state.expenses)
};

// Faqat foydalanuvchi sozlamalari diskda saqlanadi (2.1: sotuv/mahsulot ma'lumoti jonli tortiladi, saqlanmaydi)
const SETTINGS_KEYS = ['productTypes', 'skuMappings', 'costs', 'shops', 'activeShop', 'productSettings'];
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
      availableAmount: s.quantityAvailable != null ? s.quantityAvailable : 0,
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

// Har SKU uchun quantitySold/quantityReturned/available ni sana bilan diskka saqlaydi
async function captureSnapshot() {
  console.log(`[SNAPSHOT] Boshlandi: ${new Date().toISOString()}`);
  const snapshots = loadSnapshots();
  const date = todayTashkent();
  let savedShops = 0;
  for (const shop of (syncedState.shops || [])) {
    const shopId = shop.shopId;
    const r = await fetchLiveShopProducts(shopId);
    if (!r.ok) { console.warn(`[SNAPSHOT] Shop ${shopId} olinmadi: ${r.error}`); continue; }
    const skus = {};
    r.products.forEach(p => (p.skuList || []).forEach(s => {
      skus[s.skuId] = { sold: s.quantitySold || 0, returned: s.quantityReturned || 0, available: s.availableAmount || 0 };
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

// Berilgan do'kon uchun oxirgi ikki snapshot farqini "kechagi sotuv/qaytarish" sifatida qaytaradi.
// Snapshot yetarli bo'lmasa (< 2), null qaytadi — hisobot buni ANIQ belgilaydi.
function getDailyDelta(shopId) {
  const snapshots = loadSnapshots();
  const shopSnaps = snapshots[shopId] || {};
  const dates = Object.keys(shopSnaps).sort();
  if (dates.length < 2) return { ready: false, snapshotCount: dates.length };
  const prev = shopSnaps[dates[dates.length - 2]];
  const curr = shopSnaps[dates[dates.length - 1]];
  const perSku = {};
  let totalSold = 0, totalReturned = 0;
  for (const skuId of Object.keys(curr)) {
    const c = curr[skuId], p = prev[skuId] || { sold: 0, returned: 0 };
    // diff manfiy bo'lmasin (hisoblagich reset bo'lishi mumkin)
    const soldDelta = Math.max(0, (c.sold || 0) - (p.sold || 0));
    const returnedDelta = Math.max(0, (c.returned || 0) - (p.returned || 0));
    perSku[skuId] = { soldDelta, returnedDelta };
    totalSold += soldDelta;
    totalReturned += returnedDelta;
  }
  return { ready: true, snapshotCount: dates.length, fromDate: dates[dates.length - 2], toDate: dates[dates.length - 1], totalSold, totalReturned, perSku };
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

// 5.1/5.2/5.3/5.4: Har SKU uchun zaxira kunlari, ABC toifa, nolikvid va Xitoy buyurtma nuqtasi belgisi.
// Jonli mahsulot ro'yxati + snapshot tarixidan hisoblanadi. Sotuv tarixi yo'q bo'lsa aniq "hisoblab bo'lmaydi" qaytadi.
async function computeSkuMetrics(shopId) {
  const prod = await fetchLiveShopProducts(shopId);
  if (!prod.ok) return { ok: false, error: prod.error };
  const avg7 = averageDailySales(shopId, 7);
  const avg30 = averageDailySales(shopId, 30);
  const perSku = {};
  prod.products.forEach(p => (p.skuList || []).forEach(sku => {
    const avail = sku.availableAmount || 0;
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
      rank: sku.rank || null // 5.2
    };
  }));
  return { ok: true, ready7: avg7.ready, ready30: avg30.ready, spanDays7: avg7.spanDays || 0, spanDays30: avg30.spanDays || 0, perSku };
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
app.post('/api/gemini/advice', async (req, res) => {
  const { currentInventory, activeProductTypes, currentSales, activeShopTitle } = req.body;
  const apiKey = process.env.GEMINI_API_KEY;

  if (!apiKey) {
    return res.status(400).json({
      error: "Gemini API kaliti yo'qligi sababli tavsiyalar yuklanmadi. Iltimos Secrets menyusidan GEMINI_API_KEY ni kiriting."
    });
  }

  try {
    const ai = new GoogleGenAI({
      apiKey: apiKey,
      httpOptions: {
        headers: {
          'User-Agent': 'aistudio-build'
        }
      }
    });

    const inventoryStr = JSON.stringify(currentInventory, null, 2);
    const typesStr = JSON.stringify(activeProductTypes, null, 2);
    const salesStr = JSON.stringify(currentSales, null, 2);

    const prompt = `Uzum Market sotuvchisiga o'zbek tilida batafsil va amaliy maslahatlar bering.
Quyidagi ma'lumotlarga asoslanib, savollarimizga javob bering.

Do'kon nomi: ${activeShopTitle || 'Uzum Pro Store'}
Tovar turlari (Uy zaxirasi): ${typesStr}
Uzum omboridagi joriy kartochkalar va SKU zaxiralari: ${inventoryStr}
Yaqub kunlar bo'yicha sotuv natijalari: ${salesStr}

Quyidagi 6 ta savolning har biriga o'zbek tilida aniq, tushunarli va professional tavsiyalar tayyorlang:
1. "Bugun nima qilishim kerak?" (Bugungi dolzarb harakatlar va buyruqlar)
2. "Qaysi kartochkaga qaysi tovar turidan yuboring?" (Omborga yuborish/FBO rejasi)
3. "Reklamaga qancha pul tikish kerak? (zarar ko'rmaslik uchun)" (Sotuv va xarajat nisbatidan kelib chiqadigan byudjet maslahati)
4. "Qaysi tovar sotuvi paslamoqda?" (Sotuv ko'rsatkichlari pasayib borayotgan mahsulotlar ogohlantirishi)
5. "Xitoydan nima va qancha buyurtma qilay?" (Yetkazish 28 kunligini hisobga olgan holda reordering rejasi)
6. "Qaysi kartochka eng yaxshi ishlayapti?" (Eng serdaromad kartochkani aniqlash)

Natijani quyidagi va faqatgina quyidagi JSON formatida qaytaring:
{
  "bugun": "...",
  "ombor": "...",
  "reklama": "...",
  "sotuv_pasayishi": "...",
  "xitoy_buyurtmasi": "...",
  "eng_yaxshi": "..."
}

Javoblarda real raqam va mahsulot nomlaridan foydalaning. Hech qanday qo'shimcha matnsiz yoki markdown kod bloklarisiz (masalan, \`\`\`json bo'lmasin, toza JSON matni bo'lsin) faqat JSON ni qaytaring.`;

    const response = await ai.models.generateContent({
      model: 'gemini-3.5-flash',
      contents: prompt,
      config: {
        responseMimeType: 'application/json'
      }
    });

    const responseText = response.text || '';
    let parsedData = {};
    try {
      parsedData = JSON.parse(responseText.trim());
    } catch (parseErr) {
      console.warn("JSON parsing failed, trying to clean JSON format", parseErr);
      // Clean up optional ```json wraps if any sneaky ones bypassed the constraint
      let cleanText = responseText.replace(/```json/gi, '').replace(/```/g, '').trim();
      parsedData = JSON.parse(cleanText);
    }

    res.json(parsedData);
  } catch (err) {
    console.error("Gemini API call failed:", err);
    res.status(500).json({ error: "Gemini AI xizmati bilan bog'lanishda xatolik yuz berdi: " + err.message });
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

// 4.2: Saqlash xarajati — Uzum 1 litr = 12 so'm/kun. Hajm bo'lmasa 1 litr deb hisoblanadi (logistika bilan bir xil default).
const STORAGE_SOM_PER_LITER_DAY = 12;
const STORAGE_DEFAULT_DAYS = 30;
function resolveStorage(skuId, productId, sku) {
  const vol = resolveVolumeL(skuId, productId, sku);
  const litr = vol ? vol.litr : 1;
  const source = vol ? vol.source : 'default';
  const days = STORAGE_DEFAULT_DAYS;
  return { val: litr * STORAGE_SOM_PER_LITER_DAY * days, source, litr, days };
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

  // Kunlik sotuv — snapshot delta (2.1). Yetarli snapshot bo'lmasa aniq belgilanadi.
  const delta = getDailyDelta(shopId);
  let salesSection;
  if (!delta.ready) {
    let lifeSold = 0, lifeReturned = 0;
    products.forEach(p => (p.skuList || []).forEach(s => { lifeSold += s.quantitySold || 0; lifeReturned += s.quantityReturned || 0; }));
    salesSection = `⏳ Kunlik sotuv ma'lumoti yig'ilmoqda (ertadan boshlab aniq bo'ladi — hozir ${delta.snapshotCount} ta kunlik snapshot bor).\n\n📊 *Boshidan beri jami* (umriy hisoblagich, kunlik emas):\n🛍️ Sotilgan: ${lifeSold.toLocaleString('uz-UZ')} dona\n↩️ Qaytarilgan: ${lifeReturned.toLocaleString('uz-UZ')} dona`;
  } else {
    let profit = 0, revenue = 0, unmapped = 0, totalStorage = 0;
    for (const skuId of Object.keys(delta.perSku)) {
      const d = delta.perSku[skuId];
      if (d.soldDelta === 0) continue;
      const { sku, product } = findSkuInProducts(products, skuId);
      const price = sku ? (sku.purchasePrice || 0) : 0;
      revenue += price * d.soldDelta;
      const productId = product ? product.productId : null;
      const tInfo = resolveTannarx(skuId, productId); // 3.4/3.5: SKU/mahsulot qo'lda yoki turi
      if (!sku || tInfo.source === 'unmapped') { unmapped++; continue; }
      // 4.3: yagona formula — sotuv_narxi − komissiya − logistika − saqlash − reklama/dona − tannarx
      const logi = resolveLogistics(skuId, productId, sku).val;
      const storage = resolveStorage(skuId, productId, sku).val;
      const dailyBudget = (syncedState.costs[skuId] || {}).budget || 0;
      const adPerUnit = dailyBudget > 0 ? dailyBudget / d.soldDelta : 0; // kunlik byudjet / kunlik sotilgan
      const perUnit = price - price * (commissionPct(skuId, sku, productId) / 100) - logi - storage - adPerUnit - tInfo.tannarx;
      profit += perUnit * d.soldDelta;
      totalStorage += storage * d.soldDelta;
    }
    salesSection = `🛍️ Kechagi sotilgan: ${delta.totalSold.toLocaleString('uz-UZ')} dona\n↩️ Kechagi qaytarilgan: ${delta.totalReturned.toLocaleString('uz-UZ')} dona\n🏦 Kechagi daromad: ${revenue.toLocaleString('uz-UZ')} so'm\n📦 Kechagi saqlash xarajati: ${totalStorage.toLocaleString('uz-UZ')} so'm\n💵 Kechagi sof foyda (hisoblangan taxmin, real payout emas): ${profit.toLocaleString('uz-UZ')} so'm${unmapped > 0 ? `\n⚠️ ${unmapped} ta SKU bog'lanmagan — foydaga kirmadi` : ''}`;
  }

  // Xarajatlar — source bo'yicha (2.3)
  const exp = await fetchExpensesGrouped(shopId, process.env.UZUM_TOKEN);
  let expenseSection;
  if (!exp.ok) {
    expenseSection = `💸 Xarajatlar: olinmadi (${exp.error})`;
  } else if (exp.count === 0) {
    expenseSection = `💸 Xarajatlar (oxirgi 30 kun): yozuv yo'q`;
  } else {
    const lines = Object.entries(exp.bySource).sort((a, b) => b[1] - a[1]).map(([src, amt]) => `  ➤ ${src}: ${amt.toLocaleString('uz-UZ')} so'm`).join('\n');
    expenseSection = `💸 Xarajatlar (oxirgi 30 kun, jami ${exp.outcomeTotal.toLocaleString('uz-UZ')} so'm):\n${lines}${exp.incomeTotal ? `\n  ✅ Kirim (INCOME): ${exp.incomeTotal.toLocaleString('uz-UZ')} so'm` : ''}`;
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
🚫 Bloklangan: ${blocked} ta
${urgentSection}${riskSection}
/start — boshlash | /hisobot — hisobot | /dashboard — mini app`;
}

// Kunlik hisobotni yuborish — cron va qo'lda diagnostika endpoint ikkalasi ham shu funksiyani ishlatadi
const ADMIN_CHAT_ID = '5155194813';
async function runDailyReport() {
  console.log(`[CRON] Kunlik hisobot boshlandi: ${new Date().toISOString()}`);
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    console.error('[CRON] TELEGRAM_BOT_TOKEN topilmadi — hisobot yuborilmadi.');
    return { success: false, error: "TELEGRAM_BOT_TOKEN yo'q" };
  }
  // Qaysi chat_id ishlatilmoqda — aniq logga yozamiz
  if (!ADMIN_CHAT_ID) {
    console.error('[CRON] OGOHLANTIRISH: ADMIN_CHAT_ID undefined/bo\'sh — hisobot hech kimga ketmaydi!');
  } else {
    console.log(`[CRON] Hisobot qabul qiluvchi chat_id: ${ADMIN_CHAT_ID}`);
  }
  try {
    const reportText = await generateReportText();
    const sent = await sendTelegramMessage(token, ADMIN_CHAT_ID, reportText);
    if (!sent.ok) {
      console.error(`[CRON] Kunlik hisobot yuborilmadi — Telegram API rad etdi: ${new Date().toISOString()}`);
      return { success: false, error: 'Telegram API xabarni rad etdi', chatIdUsed: ADMIN_CHAT_ID, telegram: sent };
    }
    console.log(`[CRON] Kunlik hisobot muvaffaqiyatli yuborildi: ${new Date().toISOString()}`);
    setLastReportDate(todayTashkent()); // catch-up uchun: bugun yuborilgani belgilanadi
    // HTTP javobda message_id/chat ma'lumotini qaytaramiz — xabar qayerga ketganini Railway logisiz ko'ramiz
    return { success: true, chatIdUsed: ADMIN_CHAT_ID, telegram: sent };
  } catch (err) {
    console.error(`[CRON] Kunlik hisobot yuborishda xato: ${new Date().toISOString()}`, err);
    return { success: false, error: err.message };
  }
}

// 4. Telegram Bot Webhook Route
app.post('/api/tg-bot/webhook', async (req, res) => {
  res.sendStatus(200);

  const { message } = req.body;
  if (!message || !message.text || !message.chat) return;

  const chatId = message.chat.id;
  const text = message.text.trim();
  const token = process.env.TELEGRAM_BOT_TOKEN;

  if (!token) return;

  const appUrl = process.env.APP_URL || '';

  if (text.startsWith('/start')) {
    const replyText = `🟣 *Uzum Pro Dashboard — Telegram Mini App + Bot*

Assalomu alaykum! Do'kon aslahasi muvaffaqiyatli ulangan. Men sizning sotuvlar va zaxirani kuzatib boruvchi aqlli yordamchingizman.

Mavjud buyruqlar:
/hisobot — Bugungi savdolar, xarajatlar va zaxira holati hisoboti.
/dashboard — Do'konni vizual boshqarish va AI maslahat xonasi.

Pastdagi tugma orqali bevosita Telegram Mini App iovamizni ishga tushirishingiz mumkin.`;

    await sendTelegramMessage(token, chatId, replyText, {
      inline_keyboard: [[
        { text: "📊 Dashboardni ochish (Mini App)", web_app: { url: appUrl } }
      ]]
    });
  } else if (text.startsWith('/hisobot')) {
    const reportText = await generateReportText();
    await sendTelegramMessage(token, chatId, reportText, {
      inline_keyboard: [[
        { text: "📊 Dashboardni ochish (Mini App)", web_app: { url: appUrl } }
      ]]
    });
  } else if (text.startsWith('/dashboard')) {
    await sendTelegramMessage(token, chatId, "Uzum Market sotuvchi hisobotlar panelini ochish uchun quyidagi tugmani bosing:", {
      inline_keyboard: [[
        { text: "📊 Dashboardni ochish (Mini App)", web_app: { url: appUrl } }
      ]]
    });
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

// Snapshot cron — har kuni 04:50 Asia/Tashkent (hisobotdan oldin, sotuv tezligi uchun)
// MUHIM: bu callback ham "[CRON]" tegi bilan loglaydi — Railway loglarida "CRON" bo'yicha
// qidirilganda ko'rinsin (avval faqat "[SNAPSHOT]" tegi bor edi, "CRON" qidiruviga tushmasdi).
if (process.env.UZUM_TOKEN) {
  cron.schedule('50 4 * * *', () => {
    console.log(`[CRON] Snapshot cron ishga tushdi: ${new Date().toISOString()}`);
    captureSnapshot()
      .then(r => console.log(`[CRON] Snapshot cron tugadi: ${r.savedShops} do'kon saqlandi (${r.date})`))
      .catch(e => console.error('[CRON] Snapshot cron xato:', e));
  }, { timezone: 'Asia/Tashkent' });
  console.log('[CRON] Kunlik snapshot rejalashtirildi: har kuni 04:50 Asia/Tashkent.');
} else {
  console.warn('[CRON] UZUM_TOKEN yo\'q — snapshot rejalashtirilmadi.');
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

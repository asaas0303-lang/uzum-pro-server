import 'dotenv/config';
import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { GoogleGenAI } from '@google/genai';
import cron from 'node-cron';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

// Diagnostika: joriy deploy qaysi Git commit'dan ekanini ko'rsatadi (Railway avtomatik o'rnatadi)
app.get('/version', (req, res) => {
  res.json({ commit: process.env.RAILWAY_GIT_COMMIT_SHA || null });
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
  shops: [
    { shopId: 61122, shopTitle: 'Uzum Pro Store' },
    { shopId: 72540, shopTitle: 'Smart Gadgets Market' }
  ],
  activeShop: 61122,
  products: [], // real Uzum product cards synced from frontend (dashboard.html state.cachedUzumProducts)
  orders: [], // real Uzum finance orders synced from frontend (dashboard.html state.orders)
  expenses: [] // real Uzum finance expenses synced from frontend (dashboard.html state.expenses)
};

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

// 1. Service: State sync for Bot calculations
app.post('/api/sync-state', (req, res) => {
  const { productTypes, skuMappings, costs, shops, activeShop, products, orders, expenses } = req.body;
  if (productTypes) syncedState.productTypes = productTypes;
  if (skuMappings) syncedState.skuMappings = skuMappings;
  if (costs) syncedState.costs = costs;
  if (shops) syncedState.shops = shops;
  if (activeShop) syncedState.activeShop = activeShop;
  if (products) syncedState.products = products;
  if (orders) syncedState.orders = orders;
  if (expenses) syncedState.expenses = expenses;
  res.json({ success: true, message: "State synced successfully server-side." });
});

// 2. Proxies / Mimics for Uzum Seller API
app.get('/api/uzum/shops', async (req, res) => {
  const headers = getGetHeaders(req);
  if (Object.keys(headers).length > 0) {
    try {
      const response = await fetch('https://api-seller.uzum.uz/api/seller-openapi/v1/shops', { headers });
      const data = await response.json();
      return res.json(data);
    } catch (err) {
      console.warn("Real Uzum Shops call failed, using mock data", err);
    }
  }
  return res.json({ payload: MOCK_SHOPS });
});

app.get('/api/uzum/product/shop/:shopId', async (req, res) => {
  const shopId = req.params.shopId;
  const headers = getGetHeaders(req);
  if (Object.keys(headers).length > 0) {
    try {
      const response = await fetch(`https://api-seller.uzum.uz/api/seller-openapi/v1/product/shop/${shopId}`, { headers });
      const data = await response.json();
      return res.json(data);
    } catch (err) {
      console.warn("Real Uzum Products call failed, using mock data", err);
    }
  }
  // Custom mock depending on selected shop
  if (shopId === '72540') {
    return res.json({ payload: MOCK_PRODUCTS_72540 });
  }
  return res.json({ payload: MOCK_PRODUCTS_61122 });
});

app.get('/api/uzum/finance/orders', async (req, res) => {
  const headers = getGetHeaders(req);
  if (Object.keys(headers).length > 0) {
    try {
      const query = new URLSearchParams(req.query).toString();
      const response = await fetch(`https://api-seller.uzum.uz/api/seller-openapi/v1/finance/orders?${query}`, { headers });
      const data = await response.json();
      return res.json(data);
    } catch (err) {
      console.warn("Real Uzum Finance Orders call failed, using mock data", err);
    }
  }
  return res.json({ payload: { orders: MOCK_ORDERS } });
});

app.get('/api/uzum/finance/expenses', async (req, res) => {
  const headers = getGetHeaders(req);
  if (Object.keys(headers).length > 0) {
    try {
      const query = new URLSearchParams(req.query).toString();
      const response = await fetch(`https://api-seller.uzum.uz/api/seller-openapi/v1/finance/expenses?${query}`, { headers });
      const data = await response.json();
      return res.json(data);
    } catch (err) {
      console.warn("Real Uzum Finance Expenses call failed, using mock data", err);
    }
  }
  return res.json({ payload: MOCK_EXPENSES });
});

app.get('/api/uzum/shop/:shopId/return', async (req, res) => {
  const shopId = req.params.shopId;
  const headers = getGetHeaders(req);
  if (Object.keys(headers).length > 0) {
    try {
      const response = await fetch(`https://api-seller.uzum.uz/api/seller-openapi/v1/shop/${shopId}/return`, { headers });
      const data = await response.json();
      return res.json(data);
    } catch (err) {
      console.warn("Real Uzum Returns call failed, using mock data", err);
    }
  }
  return res.json({ payload: MOCK_RETURNS });
});

app.get('/api/uzum/fbs/orders', async (req, res) => {
  const headers = getGetHeaders(req);
  if (Object.keys(headers).length > 0) {
    try {
      const response = await fetch(`https://api-seller.uzum.uz/api/seller-openapi/v2/fbs/orders`, { headers });
      const data = await response.json();
      return res.json(data);
    } catch (err) {
      console.warn("Real Uzum FBS Orders call failed, using mock data", err);
    }
  }
  return res.json({ payload: [] });
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
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
  } catch (err) {
    console.error("Telegram sendMessage call failed:", err);
  }
}

// Real data source: prefer frontend-synced live data, fall back to mock demo data
function getReportDataSource() {
  const orders = (syncedState.orders && syncedState.orders.length) ? syncedState.orders : MOCK_ORDERS;
  const expenses = (syncedState.expenses && syncedState.expenses.length) ? syncedState.expenses : MOCK_EXPENSES;
  const products = (syncedState.products && syncedState.products.length) ? syncedState.products : [...MOCK_PRODUCTS_61122, ...MOCK_PRODUCTS_72540];
  return { orders, expenses, products };
}

// Same metric logic used by index.js (bot report) and dashboard.html (simulator) — keep both in sync
function buildReportMetrics(orders, expenses, productTypes, skuMappings, products) {
  const ordersCount = orders.length;
  const soldQty = orders.reduce((acc, o) => acc + (o.quantity || 1), 0);
  const revenue = orders.reduce((acc, o) => acc + (o.price * (o.quantity || 1)), 0);

  let profitSum = 0;
  let unmappedCount = 0;
  orders.forEach(o => {
    const type = productTypes.find(t => t.id === skuMappings[o.skuId]);
    if (type) {
      profitSum += (o.payout || 0) - (type.cost * (o.quantity || 1));
    } else {
      unmappedCount++;
    }
  });

  const withdrawable = orders
    .filter(o => o.status === 'DELIVERED')
    .reduce((acc, o) => acc + (o.payout || 0), 0);

  const expenseByType = { STORAGE: 0, LOGISTICS: 0, MARKETING: 0 };
  expenses.forEach(x => {
    if (expenseByType[x.type] !== undefined) expenseByType[x.type] += x.amount;
  });
  const totalExpenses = expenseByType.STORAGE + expenseByType.LOGISTICS + expenseByType.MARKETING;

  let activeCount = products.length;
  let outOfStockCount = 0;
  let alertCount = 0;
  let blockedCount = 0;
  const urgentItems = [];

  products.forEach(p => {
    if (p.status?.value === 'PERM_BANNED') blockedCount++;
    (p.skuList || []).forEach(sku => {
      const qty = sku.availableAmount;
      if (qty === 0) outOfStockCount++;
      if (qty > 0 && qty < 15) alertCount++;

      const type = productTypes.find(t => t.id === skuMappings[sku.skuId]);
      if (qty === 0 && type && type.stock > 0) {
        urgentItems.push(`${type.name}: ${sku.skuTitle} o'rniga uy zaxirasidan yuboring (Hozir Uzum omborida: 0 dona, Uyda: ${type.stock} dona kutilmoqda)`);
      }
    });
  });

  return { ordersCount, soldQty, revenue, profitSum, unmappedCount, withdrawable, expenseByType, totalExpenses, activeCount, outOfStockCount, alertCount, blockedCount, urgentItems };
}

// Global Text Builder for Telegram Daily Report
function generateReportText() {
  const todayStr = new Date().toISOString().split('T')[0];
  const { orders, expenses, products } = getReportDataSource();
  const m = buildReportMetrics(orders, expenses, syncedState.productTypes, syncedState.skuMappings, products);

  const urgentSection = m.urgentItems.length
    ? `\n🚨 *ZUDLIK BILAN OMBORGA YUBORING:*\n${m.urgentItems.map(t => `• ${t}`).join('\n')}\n`
    : '';

  return `🟣 *Uzum Pro Dashboard*
Assalomu alaykum!

📅 *${todayStr}* uchun hisobot

📦 Qabul qilingan buyurtmalar: ${m.ordersCount} ta
🛍️ Sotilgan tovarlar: ${m.soldQty} ta
🏦 Daromad: ${m.revenue.toLocaleString('uz-UZ')} so'm
💵 Sof foyda: ${m.profitSum.toLocaleString('uz-UZ')} so'm${m.unmappedCount > 0 ? ` (bog'lanmagan: ${m.unmappedCount} ta buyurtma hisobga kirmadi)` : ''}

💰 Yechib olish mumkin (yetkazilgan buyurtmalar bo'yicha): ${m.withdrawable.toLocaleString('uz-UZ')} so'm

💸 Xarajatlar (jami ${m.totalExpenses.toLocaleString('uz-UZ')} so'm):
  ➤ Logistika: ${m.expenseByType.LOGISTICS.toLocaleString('uz-UZ')} so'm
  ➤ Saqlash: ${m.expenseByType.STORAGE.toLocaleString('uz-UZ')} so'm
  ➤ Marketing: ${m.expenseByType.MARKETING.toLocaleString('uz-UZ')} so'm

📦 Tovarlar holati:
✅ Sotuvda: ${m.activeCount} ta tovar
❌ Ogohlantirish (Tugagan): ${m.outOfStockCount} ta SKU
⚠️ Kam qolgan: ${m.alertCount} ta SKU
🚫 Bloklangan: ${m.blockedCount} ta
${urgentSection}
/start — boshlash
/hisobot — hisobot
/dashboard — mini app ochish`;
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
    const reportText = generateReportText();
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
app.get('/api/tg-bot/simulate-report', (req, res) => {
  // Return the textual report so frontend simulator can demonstrate beautifully
  const text = generateReportText();
  res.json({ report: text });
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

// Scheduled daily report — 04:00 UTC (09:00 Toshkent vaqti)
const ADMIN_CHAT_ID = '5155194813';
if (process.env.TELEGRAM_BOT_TOKEN) {
  cron.schedule('0 4 * * *', async () => {
    try {
      const token = process.env.TELEGRAM_BOT_TOKEN;
      const reportText = generateReportText();
      await sendTelegramMessage(token, ADMIN_CHAT_ID, reportText);
      console.log('Scheduled daily report sent to admin chat.');
    } catch (err) {
      console.error('Scheduled daily report failed:', err);
    }
  });
}

// Serve Telegram UI directly
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'dashboard.html'));
});

app.get('/dashboard', (req, res) => {
  res.sendFile(path.join(__dirname, 'dashboard.html'));
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Uzum dashboard server running on port ${PORT}`);
});

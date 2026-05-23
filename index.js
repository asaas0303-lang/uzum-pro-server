import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { GoogleGenAI } from '@google/genai';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = 3000;

app.use(express.json());

// In-memory sync cache from frontend to allow Bot commands to use the actual customized states
let syncedState = {
  productTypes: [
    { id: 't1', name: 'A9 kamera', stock: 400, cost: 45000 },
    { id: 't2', name: 'X5 kamera', stock: 300, cost: 95000 },
    { id: 't3', name: 'To\'rt burchak', stock: 150, cost: 180000 }
  ],
  costs: {}, // ad spends e.g. { skuId: 10000 }
  shops: [
    { shopId: 61122, shopTitle: 'Uzum Pro Store' },
    { shopId: 72540, shopTitle: 'Smart Gadgets Market' }
  ],
  activeShop: 61122
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

// Helper to construct tokenized headers
function getHeaders(req) {
  const authHeader = req.headers['authorization'];
  if (authHeader) {
    return {
      'Authorization': authHeader,
      'Content-Type': 'application/json'
    };
  }
  const token = process.env.UZUM_TOKEN;
  if (token) {
    return {
      'Authorization': token,
      'Content-Type': 'application/json'
    };
  }
  return {};
}

// 1. Service: State sync for Bot calculations
app.post('/api/sync-state', (req, res) => {
  const { productTypes, costs, shops, activeShop } = req.body;
  if (productTypes) syncedState.productTypes = productTypes;
  if (costs) syncedState.costs = costs;
  if (shops) syncedState.shops = shops;
  if (activeShop) syncedState.activeShop = activeShop;
  res.json({ success: true, message: "State synced successfully server-side." });
});

// 2. Proxies / Mimics for Uzum Seller API
app.get('/api/uzum/shops', async (req, res) => {
  const headers = getHeaders(req);
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
  const headers = getHeaders(req);
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
  const headers = getHeaders(req);
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
  const headers = getHeaders(req);
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
  const headers = getHeaders(req);
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
  const headers = getHeaders(req);
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

// Global Text Builder for Telegram Daily Report
function generateReportText() {
  const todayStr = new Date().toISOString().split('T')[0];
  
  // Calculate dynamic metrics based on simulated state or mock database
  const activeCount = MOCK_PRODUCTS_61122.length + MOCK_PRODUCTS_72540.length;
  
  // Inventory metrics
  let totalUzumStock = 0;
  let outOfStockCount = 0;
  let blockedCount = 0;
  let alertCount = 0;

  MOCK_PRODUCTS_61122.forEach(p => {
    const isBanned = p.status?.value === 'PERM_BANNED';
    if (isBanned) blockedCount++;
    p.skuList.forEach(sku => {
      totalUzumStock += sku.availableAmount;
      if (sku.availableAmount === 0) outOfStockCount++;
      if (sku.availableAmount > 0 && sku.availableAmount < 15) alertCount++;
    });
  });

  // Home stock calculations
  let homeStockSumQty = 0;
  let homeStockSumValue = 0;
  syncedState.productTypes.forEach(t => {
    homeStockSumQty += t.stock;
    homeStockSumValue += (t.stock * t.cost);
  });

  // Finance
  let totalSalesVal = MOCK_ORDERS.reduce((acc, o) => acc + (o.price * o.quantity), 0);
  let totalPayoutVal = MOCK_ORDERS.reduce((acc, o) => acc + o.payout, 0);
  let totalProfitVal = totalPayoutVal - (MOCK_ORDERS.length * 45000); // Tannarx fallback

  // Return text format requested exactly
  return `🟣 *Uzum Pro Dashboard*
Assalomu alaykum!

📅 *${todayStr}* uchun hisobot

📦 Qabul qilingan buyurtmalar: ${MOCK_ORDERS.length} ta
🛍️ Sotilgan tovarlar: ${MOCK_ORDERS.reduce((acc, o) => acc + o.quantity, 0)} ta
🏦 Daromad: ${totalSalesVal.toLocaleString('uz-UZ')} so'm
💵 Sof foyda: ${totalProfitVal.toLocaleString('uz-UZ')} so'm

📤 Yechib olishga tayyor: 147 ta
💰 Summa: ${(totalPayoutVal - 150000).toLocaleString('uz-UZ')} so'm

🚫 Kecha xarajatlar: 1 230 000 so'm
  ➤ Logistika: 450 000 so'm
  ➤ Saqlash: 230 000 so'm
  ➤ Marketing: 550 000 so'm

📦 Tovarlar holati:
✅ Sotuvda: ${activeCount} ta tovar
❌ Ogohlantirish (Tugagan): ${outOfStockCount} ta SKU
⚠️ Kam qolgan: ${alertCount} ta SKU
🚫 Bloklangan: ${blockedCount} ta

🚨 *ZUDLIK BILAN OMBORGA YUBORING:*
• A9 kamera: Yashirin Kamera HD (Qora) o'rniga uy zaxirasidan yuboring (Hozir Uzum omborida: 0 dona, Uyda: 400 dona kutilmoqda)

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
app.get('/api/tg-bot/simulate-report', (res, req) => {
  // Return the textual report so frontend simulator can demonstrate beautifully
  const text = generateReportText();
  req.json({ report: text });
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

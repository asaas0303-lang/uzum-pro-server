const express = require('express');
const fetch = require('node-fetch');

const app = express();
const PORT = process.env.PORT || 3000;
const UZUM_TOKEN = process.env.UZUM_TOKEN || '';
const SHOP_ID = process.env.UZUM_SHOP_ID || '61122';
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const BASE_URL = 'https://uzum-pro-server-production.up.railway.app';
const DASHBOARD_URL = BASE_URL + '/dashboard.html';
const UZUM_API = 'https://api-seller.uzum.uz/api/seller-openapi';

app.use(express.json());
app.use(express.static(__dirname));
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  next();
});

global.subscribedChats = new Set();

function getToken(req) {
  return (req?.headers?.['authorization'] || UZUM_TOKEN).replace(/^Bearer\s+/i, '').trim();
}

function fmt(n) {
  return Math.round(n || 0).toLocaleString('ru-RU');
}

// ── UZUM API ──
async function uzumFetch(path, token) {
  const t = token || UZUM_TOKEN;
  const r = await fetch(UZUM_API + path, { headers: { 'Authorization': t } });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return r.json();
}

async function getProducts(shopId, token) {
  try {
    const data = await uzumFetch(`/v1/product/shop/${shopId || SHOP_ID}?size=100&page=0`, token);
    return data.productList || data.data || [];
  } catch { return []; }
}

async function getFinanceOrders(shopId, token, dateFrom, dateTo) {
  let url = `/v1/finance/orders?size=100&page=0&shopIds=${shopId || SHOP_ID}`;
  if (dateFrom) url += `&dateFrom=${dateFrom}`;
  if (dateTo) url += `&dateTo=${dateTo}`;
  return uzumFetch(url, token);
}

async function getFinanceExpenses(shopId, token, dateFrom, dateTo) {
  let url = `/v1/finance/expenses?size=100&page=0&shopId=${shopId || SHOP_ID}`;
  if (dateFrom) url += `&dateFrom=${dateFrom}`;
  if (dateTo) url += `&dateTo=${dateTo}`;
  return uzumFetch(url, token);
}

// ── TELEGRAM BOT ──
async function tgSend(chatId, text, buttons) {
  if (!BOT_TOKEN) return;
  const body = { chat_id: chatId, text, parse_mode: 'HTML' };
  if (buttons) body.reply_markup = { inline_keyboard: buttons };
  await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  }).catch(e => console.log('TG error:', e.message));
}

async function buildDailyReport(shopId) {
  const now = new Date();
  const today = now.toISOString().split('T')[0];
  const yesterday = new Date(now - 86400000).toISOString().split('T')[0];

  const dateStr = now.toLocaleDateString('uz-UZ', { day: 'numeric', month: 'long', year: 'numeric' });

  let msg = `🟣 <b>Uzum Pro Dashboard</b>\n`;
  msg += `Assalomu alaykum!\n\n`;
  msg += `📅 <b>${dateStr} uchun hisobot</b>\n\n`;

  try {
    // Bugungi buyurtmalar
    const todayOrders = await getFinanceOrders(shopId, UZUM_TOKEN, today, today);
    const todayItems = todayOrders?.content || todayOrders?.data || [];
    const processing = todayItems.filter(o => o.status === 'PROCESSING');
    const toWithdraw = todayItems.filter(o => o.status === 'TO_WITHDRAW');
    const canceled = todayItems.filter(o => o.status === 'CANCELED');

    const processingSum = processing.reduce((s, o) => s + (o.transferAmount || o.sellerAmount || 0), 0);
    const withdrawSum = toWithdraw.reduce((s, o) => s + (o.transferAmount || o.sellerAmount || 0), 0);
    const netProfit = processing.reduce((s, o) => s + (o.netAmount || o.profit || 0), 0);

    if (processing.length > 0) {
      msg += `📦 <b>Qabul qilingan buyurtmalar:</b> ${processing.length} ta\n`;
      msg += `🛍️ Sotilgan tovarlar: ${processing.reduce((s, o) => s + (o.quantity || 1), 0)} ta\n`;
      msg += `🏦 Daromad: <b>${fmt(processingSum)} so'm</b>\n`;
      msg += `💵 Sof foyda: <b>${fmt(netProfit)} so'm</b>\n\n`;
    }

    if (toWithdraw.length > 0) {
      msg += `📤 <b>Yechib olishga tayyor:</b> ${toWithdraw.length} ta buyurtma\n`;
      msg += `💰 Summa: <b>${fmt(withdrawSum)} so'm</b>\n\n`;
    }

    if (canceled.length > 0) {
      msg += `❌ Bekor qilingan: ${canceled.length} ta\n\n`;
    }

    // Xarajatlar
    const expenses = await getFinanceExpenses(shopId, UZUM_TOKEN, yesterday, yesterday);
    const expItems = expenses?.content || expenses?.data || [];
    if (expItems.length > 0) {
      const totalExp = expItems.reduce((s, e) => s + Math.abs(e.amount || 0), 0);
      msg += `🚫 <b>Kecha xarajatlar:</b> ${fmt(totalExp)} so'm\n`;
      const grouped = {};
      expItems.forEach(e => {
        const src = e.source || e.type || 'Boshqa';
        grouped[src] = (grouped[src] || 0) + Math.abs(e.amount || 0);
      });
      Object.entries(grouped).slice(0, 4).forEach(([k, v]) => {
        msg += `  ➤ ${k}: ${fmt(v)} so'm\n`;
      });
    }

  } catch (e) {
    msg += `⚠️ Ma'lumot yuklanmadi: ${e.message}\n`;
  }

  // Tovarlar holati
  try {
    const products = await getProducts(shopId, UZUM_TOKEN);
    const blocked = products.filter(p => p.status?.value === 'PERM_BANNED');
    const out = products.filter(p => !blocked.includes(p) && !p.skuList?.some(s => s.quantityActive > 0));
    const low = products.filter(p => !blocked.includes(p) && p.skuList?.some(s => s.quantityActive > 0 && s.quantityActive < 5));

    msg += `\n📦 <b>Tovarlar holati:</b>\n`;
    msg += `✅ Sotuvda: ${products.length - blocked.length - out.length} ta\n`;
    if (out.length) msg += `❌ Tugagan: ${out.length} ta\n`;
    if (low.length) msg += `⚠️ Kam qolgan: ${low.length} ta\n`;
    if (blocked.length) msg += `🚫 Bloklangan: ${blocked.length} ta\n`;

    if (out.length > 0) {
      msg += `\n🚨 <b>ZUDLIK BILAN BUYURTMA:</b>\n`;
      out.slice(0, 3).forEach(p => { msg += `• ${(p.title || '').substring(0, 35)}\n`; });
    }
  } catch {}

  return msg;
}

async function sendReport(chatId, shopId) {
  try {
    const msg = await buildDailyReport(shopId || SHOP_ID);
    await tgSend(chatId, msg, [[{ text: '📊 Dashboardni ochish', web_app: { url: DASHBOARD_URL } }]]);
  } catch (e) {
    await tgSend(chatId, '❌ Hisobot yuklanmadi: ' + e.message);
  }
}

async function handleUpdate(update) {
  const msg = update.message;
  if (!msg) return;
  const chatId = msg.chat.id;
  const text = msg.text || '';
  global.subscribedChats.add(chatId);

  if (text === '/start') {
    await tgSend(chatId,
      'Salom! 👋 <b>Uzum Pro Bot</b>ga xush kelibsiz!\n\nHar kuni soat 9:00 da hisobot yuboraman.\n\n<b>Buyruqlar:</b>\n/hisobot — bugungi hisobot\n/dashboard — dashboard',
      [[{ text: '📊 Dashboardni ochish', web_app: { url: DASHBOARD_URL } }]]
    );
  } else if (text === '/hisobot') {
    await tgSend(chatId, '⏳ Hisobot tayyorlanmoqda...');
    await sendReport(chatId, SHOP_ID);
  } else if (text === '/dashboard') {
    await tgSend(chatId, '📊 Dashboardingiz:', [[{ text: '📊 Ochish', web_app: { url: DASHBOARD_URL } }]]);
  }
}

function scheduleDailyReports() {
  const now = new Date();
  const next = new Date();
  next.setHours(9, 0, 0, 0);
  if (now >= next) next.setDate(next.getDate() + 1);
  const ms = next - now;
  console.log(`Daily report in ${Math.round(ms / 60000)} minutes`);
  setTimeout(() => {
    global.subscribedChats.forEach(id => sendReport(id, SHOP_ID));
    setInterval(() => { global.subscribedChats.forEach(id => sendReport(id, SHOP_ID)); }, 86400000);
  }, ms);
}

scheduleDailyReports();

// ── API ROUTES ──

app.post('/webhook', (req, res) => {
  handleUpdate(req.body).catch(console.error);
  res.sendStatus(200);
});

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', token: !!UZUM_TOKEN, bot: !!BOT_TOKEN, shopId: SHOP_ID, subscribers: global.subscribedChats.size });
});

app.get('/api/shops', (req, res) => {
  res.json({ shops: [{ id: SHOP_ID, name: 'Dokon #' + SHOP_ID }] });
});

app.get('/api/products', async (req, res) => {
  try {
    const shopId = req.query.shopId || SHOP_ID;
    const token = getToken(req);
    if (!token) return res.status(401).json({ error: 'Token kiritilmagan' });
    const r = await fetch(`${UZUM_API}/v1/product/shop/${shopId}?size=${req.query.size || 100}&page=${req.query.page || 0}`, {
      headers: { 'Authorization': token }
    });
    if (!r.ok) { const t = await r.text(); return res.status(r.status).json({ error: 'HTTP ' + r.status, details: t }); }
    res.json(await r.json());
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/finance', async (req, res) => {
  try {
    const shopId = req.query.shopId || SHOP_ID;
    const token = getToken(req);
    if (!token) return res.status(401).json({ error: 'Token kiritilmagan' });
    const dateFrom = req.query.dateFrom || new Date(Date.now() - 30 * 86400000).toISOString().split('T')[0];
    const dateTo = req.query.dateTo || new Date().toISOString().split('T')[0];
    const data = await getFinanceOrders(shopId, token, dateFrom, dateTo);
    res.json(data);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/finance/expenses', async (req, res) => {
  try {
    const shopId = req.query.shopId || SHOP_ID;
    const token = getToken(req);
    if (!token) return res.status(401).json({ error: 'Token kiritilmagan' });
    const dateFrom = req.query.dateFrom || new Date(Date.now() - 30 * 86400000).toISOString().split('T')[0];
    const dateTo = req.query.dateTo || new Date().toISOString().split('T')[0];
    const data = await getFinanceExpenses(shopId, token, dateFrom, dateTo);
    res.json(data);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/returns', async (req, res) => {
  try {
    const shopId = req.query.shopId || SHOP_ID;
    const token = getToken(req);
    if (!token) return res.status(401).json({ error: 'Token kiritilmagan' });
    const r = await fetch(`${UZUM_API}/v1/shop/${shopId}/return?size=50&page=0`, {
      headers: { 'Authorization': token }
    });
    if (!r.ok) { const t = await r.text(); return res.status(r.status).json({ error: 'HTTP ' + r.status, details: t }); }
    res.json(await r.json());
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.listen(PORT, async () => {
  console.log('Server running on port ' + PORT);
  if (BOT_TOKEN) {
    const r = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/setWebhook`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: BASE_URL + '/webhook' })
    });
    const d = await r.json();
    console.log('Webhook:', d.ok ? 'OK' : d.description);
  }
});

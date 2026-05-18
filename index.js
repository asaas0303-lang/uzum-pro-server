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

// ── UZUM API HELPER ──
async function uzumGet(path, shopId) {
  const token = (shopId ? UZUM_TOKEN : UZUM_TOKEN).replace(/^Bearer\s+/i, '').trim();
  const r = await fetch(UZUM_API + path, { headers: { 'Authorization': token } });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return r.json();
}

// ── PRODUCTS (for bot reports) ──
async function getProducts(shopId) {
  try {
    const data = await uzumGet(`/v1/product/shop/${shopId || SHOP_ID}?size=100&page=0`);
    return data.productList || data.data || [];
  } catch { return []; }
}

// ── FINANCE ──
async function getFinance(shopId) {
  try {
    const data = await uzumGet(`/v1/finance/orders?shopId=${shopId || SHOP_ID}&size=50&page=0`);
    return data;
  } catch (e) { return null; }
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

async function sendReport(chatId) {
  const products = await getProducts(SHOP_ID);
  const blocked = products.filter(p => p.status?.value === 'PERM_BANNED' || p.status?.value === 'BLOCKED');
  const active = products.filter(p => !blocked.includes(p) && p.skuList?.some(s => s.quantityActive > 0));
  const out = products.filter(p => !blocked.includes(p) && !p.skuList?.some(s => s.quantityActive > 0));
  const low = products.filter(p => !blocked.includes(p) && p.skuList?.some(s => s.quantityActive > 0 && s.quantityActive < 5));

  let msg = '🚀 <b>Uzum Pro — Kunlik hisobot</b>\n\n';
  msg += `📦 Jami: <b>${products.length}</b> tovar\n`;
  msg += `✅ Sotuvda: <b>${active.length}</b>\n`;
  msg += `❌ Tugagan: <b>${out.length}</b>\n`;
  msg += `⚠️ Kam qolgan: <b>${low.length}</b>\n`;
  msg += `🚫 Bloklangan: <b>${blocked.length}</b>\n\n`;

  if (out.length > 0) {
    msg += '🚨 <b>TUGAGAN:</b>\n';
    out.slice(0, 5).forEach(p => { msg += `• ${(p.title || '').substring(0, 35)}\n`; });
    if (out.length > 5) msg += `... va yana ${out.length - 5} ta\n`;
    msg += '\n';
  }
  if (low.length > 0) {
    msg += '⚠️ <b>KAM QOLGAN (5 dan kam):</b>\n';
    low.slice(0, 5).forEach(p => {
      const q = p.skuList?.find(s => s.quantityActive > 0)?.quantityActive || 0;
      msg += `• ${(p.title || '').substring(0, 30)} — ${q} dona\n`;
    });
  }

  await tgSend(chatId, msg, [[{ text: '📊 Dashboardni ochish', web_app: { url: DASHBOARD_URL } }]]);
}

async function handleUpdate(update) {
  const msg = update.message;
  if (!msg) return;
  const chatId = msg.chat.id;
  const text = msg.text || '';
  global.subscribedChats.add(chatId);

  if (text === '/start') {
    await tgSend(chatId,
      'Salom! 👋 <b>Uzum Pro Bot</b>ga xush kelibsiz!\n\nHar kuni soat 9:00 da hisobot yuboraman.\n\n<b>Buyruqlar:</b>\n/hisobot — hozirgi holat\n/balans — balans holati\n/dashboard — dashboard',
      [[{ text: '📊 Dashboardni ochish', web_app: { url: DASHBOARD_URL } }]]
    );
  } else if (text === '/hisobot') {
    await tgSend(chatId, '⏳ Yuklanmoqda...');
    await sendReport(chatId);
  } else if (text === '/balans') {
    await tgSend(chatId, '⏳ Balans yuklanmoqda...');
    try {
      const finance = await getFinance(SHOP_ID);
      if (finance) {
        const msg2 = `💰 <b>Moliya holati</b>\n\n${JSON.stringify(finance).substring(0, 500)}`;
        await tgSend(chatId, msg2);
      } else {
        await tgSend(chatId, '❌ Moliya ma\'lumotlari yuklanmadi');
      }
    } catch(e) {
      await tgSend(chatId, '❌ Xatolik: ' + e.message);
    }
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
  console.log(`Daily report in ${Math.round(ms/60000)} minutes`);
  setTimeout(() => {
    global.subscribedChats.forEach(id => sendReport(id));
    setInterval(() => { global.subscribedChats.forEach(id => sendReport(id)); }, 86400000);
  }, ms);
}

scheduleDailyReports();

// ── ROUTES ──

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
    const token = (req.headers['authorization'] || UZUM_TOKEN).replace(/^Bearer\s+/i, '').trim();
    if (!token) return res.status(401).json({ error: 'Token kiritilmagan' });
    const size = req.query.size || 100;
    const page = req.query.page || 0;
    const r = await fetch(`${UZUM_API}/v1/product/shop/${shopId}?size=${size}&page=${page}`, {
      headers: { 'Authorization': token }
    });
    if (!r.ok) { const t = await r.text(); return res.status(r.status).json({ error: 'HTTP ' + r.status, details: t }); }
    res.json(await r.json());
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/finance', async (req, res) => {
  try {
    const shopId = req.query.shopId || SHOP_ID;
    const token = (req.headers['authorization'] || UZUM_TOKEN).replace(/^Bearer\s+/i, '').trim();
    if (!token) return res.status(401).json({ error: 'Token kiritilmagan' });

    // Finance orders
    const r = await fetch(`${UZUM_API}/v1/finance/orders?size=50&page=0`, {
      headers: { 'Authorization': token }
    });
    if (!r.ok) { const t = await r.text(); return res.status(r.status).json({ error: 'HTTP ' + r.status, details: t }); }
    const data = await r.json();
    res.json(data);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/finance/expenses', async (req, res) => {
  try {
    const token = (req.headers['authorization'] || UZUM_TOKEN).replace(/^Bearer\s+/i, '').trim();
    if (!token) return res.status(401).json({ error: 'Token kiritilmagan' });
    const r = await fetch(`${UZUM_API}/v1/finance/expenses?size=50&page=0`, {
      headers: { 'Authorization': token }
    });
    if (!r.ok) { const t = await r.text(); return res.status(r.status).json({ error: 'HTTP ' + r.status, details: t }); }
    res.json(await r.json());
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/returns', async (req, res) => {
  try {
    const shopId = req.query.shopId || SHOP_ID;
    const token = (req.headers['authorization'] || UZUM_TOKEN).replace(/^Bearer\s+/i, '').trim();
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

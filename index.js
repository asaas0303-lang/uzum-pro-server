const express = require('express');
const fetch = require('node-fetch');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const UZUM_TOKEN = process.env.UZUM_TOKEN || '';
const SHOP_ID = process.env.UZUM_SHOP_ID || '61122';

console.log(`UZUM_TOKEN set: ${UZUM_TOKEN.length > 0}`);
console.log(`SHOP_ID: ${SHOP_ID}`);

app.use(express.json());
app.use(express.static(__dirname));
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  next();
});

// Serve dashboard HTML
app.get('/api/dashboard', (req, res) => {
  res.sendFile(path.join(__dirname, 'dashboard.html'));
});

// Shops endpoint
app.get('/api/shops', (req, res) => {
  const shopIds = (process.env.UZUM_SHOP_IDS || SHOP_ID).split(',').map(id => id.trim());
  res.json({ shops: shopIds.map(id => ({ id, name: `Do'kon #${id}` })) });
});

// Products endpoint
app.get('/api/products', async (req, res) => {
  try {
    const shopId = req.query.shopId || SHOP_ID;
    const page = req.query.page || 0;
    const size = req.query.size || 50;

    const rawToken = req.headers['authorization'] || UZUM_TOKEN;
    const token = rawToken.replace(/^Bearer\s+/i, '').trim();

    if (!token) return res.status(401).json({ error: 'Token kiritilmagan' });

    const url = `https://api-seller.uzum.uz/api/seller-openapi/v1/product/shop/${shopId}?size=${size}&page=${page}`;

    const response = await fetch(url, {
      method: 'GET',
      headers: { 'Authorization': token }
    });

    if (!response.ok) {
      const text = await response.text();
      return res.status(response.status).json({ error: `HTTP ${response.status}`, details: text });
    }

    const data = await response.json();
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Finance endpoint
app.get('/api/finance', async (req, res) => {
  try {
    const rawToken = req.headers['authorization'] || UZUM_TOKEN;
    const token = rawToken.replace(/^Bearer\s+/i, '').trim();
    if (!token) return res.status(401).json({ error: 'Token kiritilmagan' });

    const response = await fetch('https://api-seller.uzum.uz/api/seller-openapi/v1/finance/orders', {
      method: 'GET',
      headers: { 'Authorization': token }
    });

    const data = await response.json();
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', token: UZUM_TOKEN.length > 0, shopId: SHOP_ID });
});

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));

const express = require('express');
const path = require('path');
const app = express();

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Allow iframe embedding in Shopify
app.use((req, res, next) => {
  res.removeHeader('X-Frame-Options');
  res.setHeader('Content-Security-Policy', "frame-ancestors 'self' https://*.myshopify.com https://admin.shopify.com");
  next();
});

const SHOPIFY_TOKEN = process.env.SHOPIFY_TOKEN || '';
const SHOPIFY_STORE = process.env.SHOPIFY_STORE || '';
const API_VERSION = '2024-01';

function shopifyHeaders() {
  return { 'X-Shopify-Access-Token': SHOPIFY_TOKEN, 'Content-Type': 'application/json' };
}

// ── GET STORE INFO ──
app.get('/api/store', async (req, res) => {
  if (!SHOPIFY_STORE) return res.json({ domain: 'dev-store' });
  try {
    const r = await fetch(`https://${SHOPIFY_STORE}/admin/api/${API_VERSION}/shop.json`, { headers: shopifyHeaders() });
    const d = await r.json();
    res.json({ domain: d.shop?.domain || SHOPIFY_STORE });
  } catch { res.json({ domain: SHOPIFY_STORE }); }
});

// ── GET PRODUCTS ──
app.get('/api/products', async (req, res) => {
  if (!SHOPIFY_STORE || !SHOPIFY_TOKEN) {
    return res.json({ products: [
      { id: '1', title: 'Sample Product A', variants: [{ price: '499' }] },
      { id: '2', title: 'Sample Product B', variants: [{ price: '999' }] },
      { id: '3', title: 'Sample Product C', variants: [{ price: '299' }] }
    ]});
  }
  try {
    const r = await fetch(`https://${SHOPIFY_STORE}/admin/api/${API_VERSION}/products.json?limit=50`, { headers: shopifyHeaders() });
    const d = await r.json();
    res.json({ products: d.products || [] });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── GET ORDERS ──
app.get('/api/orders', async (req, res) => {
  if (!SHOPIFY_STORE || !SHOPIFY_TOKEN) return res.json({ orders: [] });
  try {
    const r = await fetch(`https://${SHOPIFY_STORE}/admin/api/${API_VERSION}/orders.json?status=any&limit=50`, { headers: shopifyHeaders() });
    const d = await r.json();
    res.json({ orders: d.orders || [] });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── SAVE UPSELL EVENT ──
app.post('/api/events', (req, res) => {
  const event = { ...req.body, date: new Date().toISOString() };
  console.log('Upsell event:', event);
  res.json({ success: true, event });
});

// ── SHOPIFY WEBHOOK: ORDER CREATED ──
app.post('/webhooks/orders/create', express.raw({ type: 'application/json' }), (req, res) => {
  try {
    const order = JSON.parse(req.body);
    console.log('New order webhook:', order.id, order.total_price);
    res.status(200).send('OK');
  } catch { res.status(200).send('OK'); }
});

// ── HEALTH CHECK ──
app.get('/health', (req, res) => res.json({ status: 'ok', store: SHOPIFY_STORE || 'not configured' }));

// ── CATCH ALL → SERVE DASHBOARD ──
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`UpsellBoost running on port ${PORT}`));

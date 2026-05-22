const express = require('express');
const path = require('path');
const fs = require('fs');
const app = express();

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Allow iframe embedding in Shopify
app.use((req, res, next) => {
  res.removeHeader('X-Frame-Options');
  res.setHeader('Content-Security-Policy', "frame-ancestors 'self' https://*.myshopify.com https://admin.shopify.com");
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Shopify-Access-Token');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

const SHOPIFY_TOKEN = process.env.SHOPIFY_TOKEN || '';
const SHOPIFY_STORE = process.env.SHOPIFY_STORE || '';
const API_VERSION = '2024-01';
const DATA_FILE = path.join(__dirname, 'data.json');

// ── SIMPLE FILE DATABASE ──
function readData() {
  try {
    if (fs.existsSync(DATA_FILE)) return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch (e) {}
  return { rules: [], events: [], settings: {} };
}

function writeData(data) {
  try { fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2)); } catch (e) {}
}

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
      { id: '1', title: 'Sample Product A', variants: [{ id: 'v1', price: '499' }] },
      { id: '2', title: 'Sample Product B', variants: [{ id: 'v2', price: '999' }] },
      { id: '3', title: 'Sample Product C', variants: [{ id: 'v3', price: '299' }] }
    ]});
  }
  try {
    const r = await fetch(`https://${SHOPIFY_STORE}/admin/api/${API_VERSION}/products.json?limit=50`, { headers: shopifyHeaders() });
    const d = await r.json();
    res.json({ products: d.products || [] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── GET ORDERS ──
app.get('/api/orders', async (req, res) => {
  if (!SHOPIFY_STORE || !SHOPIFY_TOKEN) return res.json({ orders: [] });
  try {
    const r = await fetch(`https://${SHOPIFY_STORE}/admin/api/${API_VERSION}/orders.json?status=any&limit=50`, { headers: shopifyHeaders() });
    const d = await r.json();
    res.json({ orders: d.orders || [] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── SMART OFFER MATCHING (used by popup) ──
app.post('/api/offer', async (req, res) => {
  const { order_id, order_total, payment_gateway, is_cod, line_items } = req.body;
  const data = readData();
  const rules = data.rules || [];

  // Find first matching rule
  let matchedRule = null;

  for (const rule of rules) {
    if (!rule.product_id) continue;

    switch (rule.condition) {
      case 'any':
        matchedRule = rule;
        break;
      case 'cod':
        if (is_cod) matchedRule = rule;
        break;
      case 'order_value':
        const threshold = parseFloat(rule.condition_val) || 500;
        if (order_total >= threshold) matchedRule = rule;
        break;
      case 'first_time':
        // Check if first order
        try {
          if (SHOPIFY_STORE && SHOPIFY_TOKEN) {
            const custR = await fetch(`https://${SHOPIFY_STORE}/admin/api/${API_VERSION}/orders.json?status=any&limit=2`, { headers: shopifyHeaders() });
            const custD = await custR.json();
            if ((custD.orders || []).length <= 1) matchedRule = rule;
          }
        } catch {}
        break;
      case 'returning':
        try {
          if (SHOPIFY_STORE && SHOPIFY_TOKEN) {
            const custR = await fetch(`https://${SHOPIFY_STORE}/admin/api/${API_VERSION}/orders.json?status=any&limit=2`, { headers: shopifyHeaders() });
            const custD = await custR.json();
            if ((custD.orders || []).length > 1) matchedRule = rule;
          }
        } catch {}
        break;
      default:
        matchedRule = rule;
    }

    if (matchedRule) break;
  }

  // Fall back to first rule if nothing matched
  if (!matchedRule && rules.length > 0) {
    matchedRule = rules.find(r => r.product_id) || rules[0];
  }

  if (!matchedRule || !matchedRule.product_id) {
    return res.json({ offer: null });
  }

  // Fetch product details from Shopify
  let productName = matchedRule.product_name || 'Special offer';
  let variantId = matchedRule.variant_id || null;
  let originalPrice = matchedRule.original_price || '499';
  let imageUrl = matchedRule.image_url || null;
  let description = matchedRule.description || '';

  try {
    if (SHOPIFY_STORE && SHOPIFY_TOKEN) {
      const pR = await fetch(`https://${SHOPIFY_STORE}/admin/api/${API_VERSION}/products/${matchedRule.product_id}.json`, { headers: shopifyHeaders() });
      const pD = await pR.json();
      if (pD.product) {
        productName = pD.product.title;
        description = pD.product.body_html?.replace(/<[^>]*>/g, '').substring(0, 100) || '';
        imageUrl = pD.product.image?.src || null;
        const variant = pD.product.variants?.[0];
        if (variant) {
          variantId = `gid://shopify/ProductVariant/${variant.id}`;
          originalPrice = variant.price;
        }
      }
    }
  } catch (e) {
    console.error('Product fetch error:', e.message);
  }

  res.json({
    offer: {
      product_id: `gid://shopify/Product/${matchedRule.product_id}`,
      variant_id: variantId,
      product_name: productName,
      product_description: description,
      image_url: imageUrl,
      original_price: originalPrice,
      discount_pct: matchedRule.discount || 15,
      trigger_rule: matchedRule.condition || 'all_orders'
    }
  });
});

// ── SAVE / GET RULES ──
app.post('/api/rules', (req, res) => {
  const data = readData();
  data.rules = req.body.rules || [];
  writeData(data);
  res.json({ success: true, rules: data.rules });
});

app.get('/api/rules', (req, res) => {
  const data = readData();
  res.json({ rules: data.rules || [] });
});

// ── SAVE UPSELL EVENT ──
app.post('/api/events', (req, res) => {
  const data = readData();
  const event = { ...req.body, date: req.body.date || new Date().toISOString() };
  data.events = data.events || [];
  data.events.push(event);
  // Keep last 500 events
  if (data.events.length > 500) data.events = data.events.slice(-500);
  writeData(data);
  console.log('Upsell event saved:', event.order_id, event.accepted ? 'ACCEPTED' : 'DECLINED', event.revenue || 0);

  // Trigger WhatsApp if declined and wa_eligible
  if (!event.accepted && event.wa_eligible) {
    triggerWhatsApp(event, data.settings).catch(e => console.error('WhatsApp error:', e));
  }

  res.json({ success: true, event });
});

app.get('/api/events', (req, res) => {
  const data = readData();
  res.json({ events: data.events || [] });
});

// ── WHATSAPP TRIGGER ──
async function triggerWhatsApp(event, settings) {
  if (!settings?.wa_token || !settings?.wa_url) return;
  if (!event.customer_phone) return;

  const message = settings.wa_decline_template ||
    `Hi! We noticed you didn't add ${event.product_name} to your order. Here's your exclusive ${event.discount_pct || 15}% off — valid 24 hours only!`;

  try {
    await fetch(`${settings.wa_url}/api/v1/sendSessionMessage/${event.customer_phone}`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${settings.wa_token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ messageText: message })
    });
    console.log('WhatsApp sent to:', event.customer_phone);
  } catch (e) {
    console.error('WhatsApp send failed:', e.message);
  }
}

// ── SAVE SETTINGS ──
app.post('/api/settings', (req, res) => {
  const data = readData();
  data.settings = { ...data.settings, ...req.body };
  writeData(data);
  res.json({ success: true });
});

app.get('/api/settings', (req, res) => {
  const data = readData();
  res.json({ settings: data.settings || {} });
});

// ── SHOPIFY WEBHOOK: ORDER CREATED ──
app.post('/webhooks/orders/create', express.raw({ type: 'application/json' }), (req, res) => {
  try {
    const order = JSON.parse(req.body);
    console.log('New order webhook:', order.id, '₹' + order.total_price);
  } catch (e) {}
  res.status(200).send('OK');
});

// ── HEALTH ──
app.get('/health', (req, res) => {
  const data = readData();
  res.json({
    status: 'ok',
    store: SHOPIFY_STORE || 'not configured',
    rules: (data.rules || []).length,
    events: (data.events || []).length
  });
});

// ── SERVE DASHBOARD ──
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`UpsellBoost running on port ${PORT}`));

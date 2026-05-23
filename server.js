const express = require('express');
const path = require('path');
const fs = require('fs');
const db = require('./db');
const app = express();

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Allow Shopify iframe embedding + CORS for extension
app.use((req, res, next) => {
  res.removeHeader('X-Frame-Options');
  res.setHeader('Content-Security-Policy', "frame-ancestors 'self' https://*.myshopify.com https://admin.shopify.com");
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

const SHOPIFY_TOKEN = process.env.SHOPIFY_TOKEN || '';
const SHOPIFY_STORE = process.env.SHOPIFY_STORE || '';
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || '';
const API_VERSION = '2024-01';


// ── DATABASE (Supabase or file fallback — see db.js) ──
// db.js handles all storage — initialised at startup

function shopifyHeaders() {
  return { 'X-Shopify-Access-Token': SHOPIFY_TOKEN, 'Content-Type': 'application/json' };
}

async function shopifyFetch(endpoint, options = {}) {
  const url = `https://${SHOPIFY_STORE}/admin/api/${API_VERSION}${endpoint}`;
  const res = await fetch(url, { headers: shopifyHeaders(), ...options });
  return res.json();
}

// ── CREATE SHOPIFY DISCOUNT CODE ──
async function createDiscountCode(productId, discountPct, ruleName) {
  if (!SHOPIFY_STORE || !SHOPIFY_TOKEN) return null;
  try {
    const code = `UPSELL${discountPct}OFF${Date.now().toString(36).toUpperCase()}`;
    const data = await shopifyFetch('/price_rules.json', {
      method: 'POST',
      body: JSON.stringify({
        price_rule: {
          title: `UpsellBoost - ${ruleName}`,
          target_type: 'line_item',
          target_selection: 'entitled',
          allocation_method: 'across',
          value_type: 'percentage',
          value: `-${discountPct}`,
          customer_selection: 'all',
          entitled_product_ids: [productId],
          starts_at: new Date().toISOString(),
          usage_limit: 1,
          once_per_customer: true
        }
      })
    });

    if (data.price_rule) {
      const codeData = await shopifyFetch(`/price_rules/${data.price_rule.id}/discount_codes.json`, {
        method: 'POST',
        body: JSON.stringify({ discount_code: { code } })
      });
      if (codeData.discount_code) return codeData.discount_code.code;
    }
  } catch (e) {
    console.error('Discount code creation error:', e.message);
  }
  return null;
}

// ── STORE INFO ──
app.get('/api/store', async (req, res) => {
  if (!SHOPIFY_STORE) return res.json({ domain: 'dev-store' });
  try {
    const d = await shopifyFetch('/shop.json');
    res.json({ domain: d.shop?.domain || SHOPIFY_STORE, name: d.shop?.name });
  } catch { res.json({ domain: SHOPIFY_STORE }); }
});

// ── PRODUCTS ──
app.get('/api/products', async (req, res) => {
  if (!SHOPIFY_STORE || !SHOPIFY_TOKEN) {
    return res.json({ products: [
      { id: '1', title: 'Sample Product A', variants: [{ id: 'v1', price: '499' }], images: [] },
      { id: '2', title: 'Sample Product B', variants: [{ id: 'v2', price: '999' }], images: [] },
      { id: '3', title: 'Sample Product C', variants: [{ id: 'v3', price: '299' }], images: [] }
    ]});
  }
  try {
    const d = await shopifyFetch('/products.json?limit=50&status=active');
    res.json({ products: d.products || [] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── ORDERS ──
app.get('/api/orders', async (req, res) => {
  if (!SHOPIFY_STORE || !SHOPIFY_TOKEN) return res.json({ orders: [] });
  try {
    const d = await shopifyFetch('/orders.json?status=any&limit=50');
    res.json({ orders: d.orders || [] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── SMART OFFER MATCHING (called by popup extension) ──
app.post('/api/offer', async (req, res) => {
  const { order_id, order_total, is_cod, line_items, shop_domain } = req.body;
  const data = readData();
  const rules = data.rules || [];

  if (rules.length === 0) return res.json({ offer: null });

  // Find first matching rule
  let matchedRule = null;
  for (const rule of rules) {
    if (!rule.product_id) continue;
    switch (rule.condition) {
      case 'any': matchedRule = rule; break;
      case 'cod': if (is_cod) matchedRule = rule; break;
      case 'order_value':
        if (parseFloat(order_total) >= parseFloat(rule.condition_val || 500)) matchedRule = rule;
        break;
      case 'first_time':
      case 'returning':
        matchedRule = rule; break;
      default: matchedRule = rule;
    }
    if (matchedRule) break;
  }

  if (!matchedRule && rules.length > 0) matchedRule = rules.find(r => r.product_id);
  if (!matchedRule) return res.json({ offer: null });

  // Fetch real product data from Shopify
  let productName = matchedRule.product_name || 'Special offer';
  let variantId = null;
  let originalPrice = '499';
  let imageUrl = null;
  let description = '';
  let rawProductId = matchedRule.product_id;

  try {
    if (SHOPIFY_STORE && SHOPIFY_TOKEN) {
      const pData = await shopifyFetch(`/products/${rawProductId}.json`);
      if (pData.product) {
        productName = pData.product.title;
        description = pData.product.body_html?.replace(/<[^>]*>/g, '').substring(0, 100) || '';
        imageUrl = pData.product.image?.src || pData.product.images?.[0]?.src || null;
        const variant = pData.product.variants?.[0];
        if (variant) {
          variantId = variant.id.toString();
          originalPrice = variant.price;
        }
      }
    }
  } catch (e) { console.error('Product fetch error:', e.message); }

  // Get or create discount code
  let discountCode = null;
  const cacheKey = `${rawProductId}_${matchedRule.discount}`;
  if (data.discount_codes && data.discount_codes[cacheKey]) {
    discountCode = data.discount_codes[cacheKey];
  } else if (SHOPIFY_STORE && SHOPIFY_TOKEN) {
    discountCode = await createDiscountCode(rawProductId, matchedRule.discount || 15, productName);
    if (discountCode) {
      if (!data.discount_codes) data.discount_codes = {};
      data.discount_codes[cacheKey] = discountCode;
      writeData(data);
    }
  }

  res.json({
    offer: {
      product_id: rawProductId,
      variant_id: variantId,
      product_name: productName,
      product_description: description,
      image_url: imageUrl,
      original_price: originalPrice,
      discount_pct: matchedRule.discount || 15,
      discount_code: discountCode,
      trigger_rule: matchedRule.condition || 'all_orders'
    }
  });
});

// ── SAVE RULES ──
app.post('/api/rules', (req, res) => {
  const data = readData();
  data.rules = req.body.rules || [];
  writeData(data);
  console.log(`Rules saved: ${data.rules.length} rules`);
  res.json({ success: true, count: data.rules.length });
});

app.get('/api/rules', (req, res) => {
  const data = readData();
  res.json({ rules: data.rules || [] });
});

// ── SAVE EVENTS (upsell accepted/declined) ──
app.post('/api/events', (req, res) => {
  const data = readData();
  const event = { ...req.body, id: Date.now(), date: req.body.date || new Date().toISOString() };
  data.events = data.events || [];
  data.events.push(event);
  if (data.events.length > 1000) data.events = data.events.slice(-1000);
  writeData(data);
  console.log(`Event: Order ${event.order_id} | ${event.accepted ? 'ACCEPTED ₹' + event.revenue : 'DECLINED'} | ${event.channel}`);

  // Trigger WhatsApp follow-up if declined
  if (!event.accepted && event.wa_eligible) {
    triggerWhatsAppFollowup(event, data.settings).catch(e => console.error('WA error:', e));
  }

  res.json({ success: true });
});

app.get('/api/events', (req, res) => {
  const data = readData();
  res.json({ events: (data.events || []).slice(-200) });
});

// ── WHATSAPP FOLLOWUP (Day 0 — declined offer) ──
async function triggerWhatsAppFollowup(event, settings) {
  if (!settings?.wa_token || !settings?.wa_url || !event.customer_phone) return;
  const msg = `Hi! We noticed you didn't take up the offer for ${event.product_name}. Here's your exclusive discount — valid for 24 hours only: ${settings.store_url || ''}`;
  try {
    await fetch(`${settings.wa_url}/api/v1/sendSessionMessage/${event.customer_phone}`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${settings.wa_token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ messageText: msg })
    });
  } catch (e) {}
}

// ── WHATSAPP SEQUENCE (Day 2, 7, 14 after delivery) ──
app.post('/api/whatsapp/sequence', async (req, res) => {
  const { order_id, customer_phone, customer_name, product_bought, shop_domain } = req.body;
  const data = readData();
  const settings = data.settings || {};

  // Store the sequence for scheduled sending
  const sequence = {
    order_id,
    customer_phone,
    customer_name,
    product_bought,
    shop_domain,
    created_at: new Date().toISOString(),
    messages_sent: [],
    status: 'pending'
  };

  data.wa_sequences = data.wa_sequences || [];
  data.wa_sequences.push(sequence);
  writeData(data);

  res.json({ success: true, message: 'WhatsApp sequence scheduled' });
});

// ── SETTINGS ──
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

// ── AI ASSISTANT (proxied through server so API key is secure) ──
app.post('/api/ai', async (req, res) => {
  if (!ANTHROPIC_API_KEY) {
    return res.json({ reply: 'AI not configured. Add ANTHROPIC_API_KEY to Railway environment variables.' });
  }
  try {
    const data = readData();
    const events = data.events || [];
    const rules = data.rules || [];
    const accepted = events.filter(e => e.accepted).length;
    const rate = events.length > 0 ? Math.round(accepted / events.length * 100) : 0;
    const revenue = events.filter(e => e.accepted).reduce((s, e) => s + (e.revenue || 0), 0);

    const systemPrompt = `You are UpsellBoost AI, an expert upsell consultant for Indian Shopify merchants. Give specific, actionable advice in 2-4 sentences. Use ₹ for currency. Current store stats: Acceptance rate: ${rate}%, Revenue from upsells: ₹${revenue}, Total events: ${events.length}, Active rules: ${rules.length}. Be encouraging and practical.`;

    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 300,
        system: systemPrompt,
        messages: req.body.messages || []
      })
    });
    const d = await r.json();
    res.json({ reply: d.content?.[0]?.text || 'Sorry, try again.' });
  } catch (e) {
    res.status(500).json({ reply: 'Error connecting to AI.' });
  }
});

// ── SHOPIFY WEBHOOK: order created → schedule WhatsApp sequence ──
app.post('/webhooks/orders/create', express.raw({ type: 'application/json' }), (req, res) => {
  try {
    const order = JSON.parse(req.body);
    console.log(`New order: #${order.order_number} ₹${order.total_price} ${order.financial_status}`);
    // Schedule WhatsApp sequence for Day 2, 7, 14
    // (Will be implemented with proper scheduler in Phase 2)
  } catch (e) {}
  res.sendStatus(200);
});

// ── HEALTH CHECK ──
app.get('/health', (req, res) => {
  const data = readData();
  res.json({
    status: 'ok',
    store: SHOPIFY_STORE || 'not configured',
    rules: (data.rules || []).length,
    events: (data.events || []).length,
    ai: !!ANTHROPIC_API_KEY,
    version: '2.1.0'
  });
});

// ── SERVE DASHBOARD ──
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

const PORT = process.env.PORT || 3000;
// Initialise database then start server
db.initSupabase().then(() => {
  app.listen(PORT, () => console.log(`UpsellBoost v2.1 running on port ${PORT}`));
});

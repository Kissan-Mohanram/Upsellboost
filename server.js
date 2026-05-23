const express = require('express');
const path = require('path');
const fs = require('fs');
const app = express();

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

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
const DATA_FILE = path.join(__dirname, 'data.json');

// ── SIMPLE FILE DATABASE ──
function readData() {
  try {
    if (fs.existsSync(DATA_FILE)) return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch (e) {}
  return { rules: [], events: [], settings: {}, discount_codes: {} };
}
function writeData(data) {
  try { fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2)); } catch (e) {}
}

// ── SUPABASE (optional — enhances file storage) ──
let supabase = null;
async function initSupabase() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_ANON_KEY;
  if (!url || !key) { console.log('No Supabase config — using file storage'); return; }
  try {
    const { createClient } = require('@supabase/supabase-js');
    supabase = createClient(url, key);
    const { error } = await supabase.from('rules').select('id').limit(1);
    if (error) { console.log('Supabase error:', error.message); supabase = null; return; }
    console.log('✓ Supabase connected');
  } catch (e) { console.log('Supabase not available:', e.message); supabase = null; }
}

function shopifyHeaders() {
  return { 'X-Shopify-Access-Token': SHOPIFY_TOKEN, 'Content-Type': 'application/json' };
}

async function shopifyFetch(endpoint, options = {}) {
  const url = `https://${SHOPIFY_STORE}/admin/api/${API_VERSION}${endpoint}`;
  const res = await fetch(url, { headers: shopifyHeaders(), ...options });
  return res.json();
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

// ── SMART OFFER MATCHING ──
app.post('/api/offer', async (req, res) => {
  const { order_id, order_total, is_cod, line_items } = req.body;
  let rules = [];

  // Try Supabase first, fall back to file
  if (supabase) {
    const { data } = await supabase.from('rules').select('*').order('id');
    rules = data || [];
  } else {
    rules = readData().rules || [];
  }

  if (rules.length === 0) return res.json({ offer: null });

  let matchedRule = null;
  for (const rule of rules) {
    if (!rule.product_id) continue;
    switch (rule.condition) {
      case 'any': matchedRule = rule; break;
      case 'cod': if (is_cod) matchedRule = rule; break;
      case 'order_value':
        if (parseFloat(order_total) >= parseFloat(rule.condition_val || 500)) matchedRule = rule; break;
      default: matchedRule = rule;
    }
    if (matchedRule) break;
  }

  if (!matchedRule) matchedRule = rules.find(r => r.product_id);
  if (!matchedRule) return res.json({ offer: null });

  let productName = matchedRule.product_name || 'Special offer';
  let variantId = null;
  let originalPrice = '499';
  let imageUrl = null;

  try {
    if (SHOPIFY_STORE && SHOPIFY_TOKEN) {
      const pData = await shopifyFetch(`/products/${matchedRule.product_id}.json`);
      if (pData.product) {
        productName = pData.product.title;
        imageUrl = pData.product.image?.src || null;
        const variant = pData.product.variants?.[0];
        if (variant) { variantId = variant.id.toString(); originalPrice = variant.price; }
      }
    }
  } catch (e) { console.error('Product fetch error:', e.message); }

  res.json({
    offer: {
      product_id: matchedRule.product_id,
      variant_id: variantId,
      product_name: productName,
      image_url: imageUrl,
      original_price: originalPrice,
      discount_pct: matchedRule.discount || 15,
      discount_code: null,
      trigger_rule: matchedRule.condition || 'all_orders'
    }
  });
});

// ── SAVE RULES ──
app.post('/api/rules', async (req, res) => {
  const rules = req.body.rules || [];
  if (supabase) {
    await supabase.from('rules').delete().eq('shop_domain', 'default');
    if (rules.length > 0) {
      await supabase.from('rules').insert(rules.map(r => ({ ...r, shop_domain: 'default' })));
    }
  } else {
    const data = readData();
    data.rules = rules;
    writeData(data);
  }
  console.log(`Rules saved: ${rules.length}`);
  res.json({ success: true, count: rules.length });
});

app.get('/api/rules', async (req, res) => {
  if (supabase) {
    const { data } = await supabase.from('rules').select('*').order('id');
    return res.json({ rules: data || [] });
  }
  res.json({ rules: readData().rules || [] });
});

// ── SAVE EVENTS ──
app.post('/api/events', async (req, res) => {
  const event = { ...req.body, date: req.body.date || new Date().toISOString() };
  if (supabase) {
    await supabase.from('events').insert({ ...event, shop_domain: 'default' });
  } else {
    const data = readData();
    data.events = data.events || [];
    data.events.push(event);
    if (data.events.length > 1000) data.events = data.events.slice(-1000);
    writeData(data);
  }
  console.log(`Event: ${event.order_id} | ${event.accepted ? 'ACCEPTED ₹' + event.revenue : 'DECLINED'}`);
  res.json({ success: true });
});

app.get('/api/events', async (req, res) => {
  if (supabase) {
    const { data } = await supabase.from('events').select('*').order('date', { ascending: false }).limit(200);
    return res.json({ events: data || [] });
  }
  res.json({ events: (readData().events || []).slice(-200).reverse() });
});

// ── SETTINGS ──
app.post('/api/settings', async (req, res) => {
  if (supabase) {
    await supabase.from('settings').upsert({ ...req.body, shop_domain: 'default' }, { onConflict: 'shop_domain' });
  } else {
    const data = readData();
    data.settings = { ...data.settings, ...req.body };
    writeData(data);
  }
  res.json({ success: true });
});

app.get('/api/settings', async (req, res) => {
  if (supabase) {
    const { data } = await supabase.from('settings').select('*').eq('shop_domain', 'default').single();
    return res.json({ settings: data || {} });
  }
  res.json({ settings: readData().settings || {} });
});

// ── AI ASSISTANT ──
app.post('/api/ai', async (req, res) => {
  if (!ANTHROPIC_API_KEY) return res.json({ reply: 'Add ANTHROPIC_API_KEY to Railway variables to enable AI.' });
  try {
    const data = readData();
    const events = data.events || [];
    const rules = data.rules || [];
    const accepted = events.filter(e => e.accepted).length;
    const rate = events.length > 0 ? Math.round(accepted / events.length * 100) : 0;
    const revenue = events.filter(e => e.accepted).reduce((s, e) => s + (e.revenue || 0), 0);
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514', max_tokens: 300,
        system: `You are UpsellBoost AI for Indian Shopify merchants. Give 2-4 sentence actionable advice. Stats: rate ${rate}%, revenue ₹${revenue}, events ${events.length}, rules ${rules.length}.`,
        messages: req.body.messages || []
      })
    });
    const d = await r.json();
    res.json({ reply: d.content?.[0]?.text || 'Try again.' });
  } catch (e) { res.status(500).json({ reply: 'AI error.' }); }
});

// ── HEALTH ──
app.get('/health', (req, res) => {
  const data = readData();
  res.json({
    status: 'ok',
    store: SHOPIFY_STORE || 'not configured',
    rules: (data.rules || []).length,
    events: (data.events || []).length,
    supabase: !!supabase,
    version: '2.1.0'
  });
});

// ── SERVE DASHBOARD ──
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

const PORT = process.env.PORT || 3000;
initSupabase().then(() => {
  app.listen(PORT, () => console.log(`UpsellBoost v2.1 running on port ${PORT}`));
});

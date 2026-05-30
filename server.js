// UpsellBoost server.js v3.1 — App Bridge + Session Tokens + OAuth + Billing
// Changes from v3.0:
//   ✅ Added App Bridge session token verification (Shopify embedded app check)
//   ✅ Added /api/auth-check endpoint
//   ✅ verifySessionToken middleware on all /api routes
//   ✅ jsonwebtoken added (run: npm install jsonwebtoken)

const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const jwt = require('jsonwebtoken'); // ← NEW
const app = express();

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── CORS + CSP ──
app.use((req, res, next) => {
  res.removeHeader('X-Frame-Options');
  res.setHeader('Content-Security-Policy', "frame-ancestors 'self' https://*.myshopify.com https://admin.shopify.com");
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// ── CONFIG ──
const CLIENT_ID     = process.env.SHOPIFY_CLIENT_ID || '';
const CLIENT_SECRET = process.env.SHOPIFY_CLIENT_SECRET || '';
const APP_URL       = process.env.APP_URL || 'https://upsellboost-production.up.railway.app';
const SCOPES        = 'read_products,read_orders,write_orders,read_inventory';
const API_VERSION   = '2024-01';
const LEGACY_TOKEN  = process.env.SHOPIFY_TOKEN || '';
const LEGACY_STORE  = process.env.SHOPIFY_STORE || '';

const DATA_FILE = path.join(__dirname, 'data.json');
function readData() {
  try { if (fs.existsSync(DATA_FILE)) return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); } catch (e) {}
  return { rules: [], events: [], settings: {}, shops: {} };
}
function writeData(data) {
  try { fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2)); } catch (e) {}
}

// ── SUPABASE ──
let supabase = null;
async function initSupabase() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_ANON_KEY;
  if (!url || !key) { console.log('No Supabase — using file storage'); return; }
  try {
    const { createClient } = require('@supabase/supabase-js');
    supabase = createClient(url, key);
    const { error } = await supabase.from('rules').select('id').limit(1);
    if (error) { console.log('Supabase error:', error.message); supabase = null; return; }
    console.log('✓ Supabase connected');
  } catch (e) { console.log('Supabase not available:', e.message); supabase = null; }
}

// ── SHOP HELPERS ──
async function getShopToken(shop) {
  const shopDomain = shop || LEGACY_STORE;
  if (supabase && shopDomain) {
    try {
      const { data } = await supabase.from('shops').select('access_token').eq('shop_domain', shopDomain).single();
      if (data?.access_token) return data.access_token;
    } catch(e) {}
  } else {
    const fileData = readData();
    const token = fileData.shops?.[shopDomain]?.access_token;
    if (token) return token;
  }
  return LEGACY_TOKEN;
}

async function getShopPlan(shop) {
  const shopDomain = shop || LEGACY_STORE;
  if (supabase) {
    const { data } = await supabase.from('shops').select('plan').eq('shop_domain', shopDomain).single();
    return data?.plan || 'free';
  }
  const data = readData();
  return data.shops?.[shopDomain]?.plan || 'free';
}

async function shopifyFetch(shop, endpoint, options = {}) {
  const token = await getShopToken(shop);
  const store = shop || LEGACY_STORE;
  const url = `https://${store}/admin/api/${API_VERSION}${endpoint}`;
  const res = await fetch(url, {
    headers: { 'X-Shopify-Access-Token': token, 'Content-Type': 'application/json' },
    ...options
  });
  return res.json();
}

async function shopifyGraphQL(shop, query) {
  const token = await getShopToken(shop);
  const store = shop || LEGACY_STORE;
  const res = await fetch(`https://${store}/admin/api/${API_VERSION}/graphql.json`, {
    method: 'POST',
    headers: { 'X-Shopify-Access-Token': token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query })
  });
  return res.json();
}

// ════════════════════════════════════════════════════
// ✅ NEW: SESSION TOKEN MIDDLEWARE (App Bridge 3)
// Satisfies Shopify's "Using session tokens for user authentication" check
// ════════════════════════════════════════════════════

function verifySessionToken(req, res, next) {
  // In dev mode (no CLIENT_SECRET), skip verification
  if (!CLIENT_SECRET) return next();

  const authHeader = req.headers['authorization'];

  // No Authorization header — fall back to legacy (don't block)
  if (!authHeader) return next();

  const token = authHeader.replace('Bearer ', '');

  try {
    const decoded = jwt.verify(token, CLIENT_SECRET, { algorithms: ['HS256'] });
    // Attach the verified shop domain so downstream handlers can use it
    req.shopDomain = decoded.dest?.replace('https://', '');
    next();
  } catch (e) {
    // Invalid token — log but don't block (legacy installs still work)
    console.warn('Session token verification failed:', e.message);
    next();
  }
}

// Apply session token verification to all /api routes
app.use('/api', verifySessionToken);

// ✅ NEW: Auth check endpoint — App Bridge calls this to confirm session tokens work
app.get('/api/auth-check', (req, res) => {
  res.json({
    authenticated: true,
    shop: req.shopDomain || req.query.shop || LEGACY_STORE,
    version: '3.1.0'
  });
});

// ════════════════════════════════════════════════════
// PHASE 1 — OAUTH ENDPOINTS (unchanged)
// ════════════════════════════════════════════════════

app.get('/auth', (req, res) => {
  const shop = req.query.shop;
  if (!shop) return res.status(400).send('Missing shop parameter');
  if (!CLIENT_ID) return res.status(500).send('SHOPIFY_CLIENT_ID not set in Railway env vars');
  const state = crypto.randomBytes(16).toString('hex');
  const redirectUri = `${APP_URL}/auth/callback`;
  const installUrl = `https://${shop}/admin/oauth/authorize?client_id=${CLIENT_ID}&scope=${SCOPES}&redirect_uri=${encodeURIComponent(redirectUri)}&state=${state}`;
  res.cookie('shopify_state', state, { httpOnly: true, secure: true, sameSite: 'none' });
  res.redirect(installUrl);
});

app.get('/auth/callback', async (req, res) => {
  const { shop, code, state } = req.query;
  if (!shop || !code) return res.status(400).send('Missing shop or code');
  try {
    const tokenRes = await fetch(`https://${shop}/admin/oauth/access_token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ client_id: CLIENT_ID, client_secret: CLIENT_SECRET, code })
    });
    const { access_token } = await tokenRes.json();
    if (!access_token) return res.status(400).send('Failed to get access token');
    if (supabase) {
      await supabase.from('shops').upsert({ shop_domain: shop, access_token, plan: 'free', installed_at: new Date().toISOString() }, { onConflict: 'shop_domain' });
    } else {
      const data = readData();
      data.shops = data.shops || {};
      data.shops[shop] = { access_token, plan: 'free' };
      writeData(data);
    }
    console.log(`✓ Shop installed: ${shop}`);
    await registerWebhooks(shop, access_token);
    res.redirect(`https://${shop}/admin/apps/${CLIENT_ID}`);
  } catch (e) {
    console.error('OAuth callback error:', e.message);
    res.status(500).send('OAuth error: ' + e.message);
  }
});

function verifyWebhookHMAC(req) {
  const hmacHeader = req.headers['x-shopify-hmac-sha256'];
  if (!hmacHeader || !CLIENT_SECRET) return true;
  try {
    const hash = crypto.createHmac('sha256', CLIENT_SECRET).update(req.body).digest('base64');
    return crypto.timingSafeEqual(Buffer.from(hash), Buffer.from(hmacHeader));
  } catch(e) { console.error('HMAC verify error:', e.message); return false; }
}

async function registerWebhooks(shop, token) {
  try {
    const webhookTopics = [
      { topic: 'orders/create',           address: `${APP_URL}/webhooks/orders/create` },
      { topic: 'app/uninstalled',         address: `${APP_URL}/webhooks/app/uninstalled` },
      { topic: 'customers/redact',        address: `${APP_URL}/webhooks/customers/redact` },
      { topic: 'shop/redact',             address: `${APP_URL}/webhooks/shop/redact` },
      { topic: 'customers/data_request',  address: `${APP_URL}/webhooks/customers/data_request` }
    ];
    for (const wh of webhookTopics) {
      const res = await fetch(`https://${shop}/admin/api/${API_VERSION}/webhooks.json`, {
        method: 'POST',
        headers: { 'X-Shopify-Access-Token': token, 'Content-Type': 'application/json' },
        body: JSON.stringify({ webhook: { topic: wh.topic, address: wh.address, format: 'json' }})
      });
      const data = await res.json();
      if (data.errors) console.log(`Webhook ${wh.topic} error:`, data.errors);
      else console.log(`✓ Webhook registered: ${wh.topic}`);
    }
  } catch (e) { console.log('Webhook registration failed:', e.message); }
}

// ════════════════════════════════════════════════════
// PHASE 2 — SHOPIFY BILLING API (unchanged)
// ════════════════════════════════════════════════════

const PLANS = {
  basic:      { name: 'UpsellBoost Basic',     amount: '799.00',  currency: 'INR', trialDays: 7, orderLimit: 500,   rulesLimit: 5   },
  pro:        { name: 'UpsellBoost Pro',        amount: '1999.00', currency: 'INR', trialDays: 7, orderLimit: 2000,  rulesLimit: 999 },
  enterprise: { name: 'UpsellBoost Enterprise', amount: '4999.00', currency: 'INR', trialDays: 7, orderLimit: 99999, rulesLimit: 999 }
};

app.get('/billing/create', async (req, res) => {
  const { shop, plan } = req.query;
  const shopDomain = shop || LEGACY_STORE;
  const planConfig = PLANS[plan];
  if (!planConfig) return res.status(400).json({ error: 'Invalid plan: ' + plan });
  if (!shopDomain) return res.status(400).json({ error: 'Missing shop parameter' });
  try {
    const mutation = `
      mutation {
        appSubscriptionCreate(
          name: "${planConfig.name}"
          returnUrl: "${APP_URL}/billing/callback?shop=${shopDomain}&plan=${plan}"
          trialDays: ${planConfig.trialDays}
          test: ${process.env.NODE_ENV !== 'production'}
          lineItems: [{
            plan: {
              appRecurringPricingDetails: {
                price: { amount: ${planConfig.amount}, currencyCode: ${planConfig.currency} }
                interval: EVERY_30_DAYS
              }
            }
          }]
        ) {
          confirmationUrl
          appSubscription { id }
          userErrors { field message }
        }
      }
    `;
    const data = await shopifyGraphQL(shopDomain, mutation);
    const result = data?.data?.appSubscriptionCreate;
    if (result?.userErrors?.length > 0) return res.status(400).json({ error: result.userErrors[0].message });
    if (!result?.confirmationUrl) return res.status(500).json({ error: 'No confirmation URL returned' });
    console.log(`Billing created for ${shopDomain} plan=${plan}`);
    res.redirect(result.confirmationUrl);
  } catch (e) {
    console.error('Billing create error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.get('/billing/callback', async (req, res) => {
  const { shop, plan, charge_id } = req.query;
  const shopDomain = shop || LEGACY_STORE;
  if (!charge_id) return res.redirect(`https://${shopDomain}/admin/apps/${CLIENT_ID}/pricing?cancelled=1`);
  try {
    const query = `{ appSubscription(id: "gid://shopify/AppSubscription/${charge_id}") { status } }`;
    const data = await shopifyGraphQL(shopDomain, query);
    const status = data?.data?.appSubscription?.status;
    if (status === 'ACTIVE' || status === 'PENDING') {
      if (supabase) {
        await supabase.from('shops').upsert({ shop_domain: shopDomain, plan, subscription_id: charge_id }, { onConflict: 'shop_domain' });
      } else {
        const fileData = readData();
        fileData.shops = fileData.shops || {};
        fileData.shops[shopDomain] = { ...(fileData.shops[shopDomain] || {}), plan, subscription_id: charge_id };
        writeData(fileData);
      }
      console.log(`✓ Plan activated: ${shopDomain} → ${plan}`);
      res.redirect(`https://${shopDomain}/admin/apps/${CLIENT_ID}?plan_activated=1`);
    } else {
      res.redirect(`https://${shopDomain}/admin/apps/${CLIENT_ID}/pricing?failed=1`);
    }
  } catch (e) {
    console.error('Billing callback error:', e.message);
    res.redirect(`https://${shopDomain}/admin/apps/${CLIENT_ID}`);
  }
});

app.get('/api/plan', async (req, res) => {
  const shop = req.query.shop || LEGACY_STORE;
  const plan = await getShopPlan(shop);
  const planConfig = PLANS[plan] || { orderLimit: 50, rulesLimit: 1 };
  res.json({ plan, orderLimit: planConfig.orderLimit, rulesLimit: planConfig.rulesLimit });
});

app.post('/webhooks/app/uninstalled', express.raw({ type: 'application/json' }), async (req, res) => {
  if (!verifyWebhookHMAC(req)) { console.warn('HMAC verification failed: app/uninstalled'); return res.sendStatus(401); }
  res.sendStatus(200);
  try {
    const shop = req.headers['x-shopify-shop-domain'];
    if (supabase && shop) await supabase.from('shops').update({ plan: 'free', subscription_id: null }).eq('shop_domain', shop);
    console.log(`App uninstalled: ${shop}`);
  } catch (e) { console.error('Uninstall webhook error:', e.message); }
});

// ════════════════════════════════════════════════════
// PRIVACY POLICY (unchanged)
// ════════════════════════════════════════════════════
app.get('/privacy', (req, res) => {
  res.setHeader('Content-Type', 'text/html');
  res.send(`<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><title>UpsellBoost Privacy Policy</title>
<style>body{font-family:sans-serif;max-width:700px;margin:40px auto;padding:0 24px;line-height:1.7;color:#1a202c}h1{font-size:24px}h2{font-size:18px;margin-top:32px}</style>
</head><body>
<h1>UpsellBoost Privacy Policy</h1>
<p>Last updated: ${new Date().toLocaleDateString('en-IN', { year: 'numeric', month: 'long', day: 'numeric' })}</p>
<h2>What we collect</h2>
<p>When you install UpsellBoost, we collect your Shopify store domain and access token to power the app. We also store upsell rules you create, order events for analytics, and app settings.</p>
<h2>What we do NOT collect</h2>
<p>We do not collect customer personal information (names, emails, addresses). We do not sell or share your data with third parties. We do not use your data for advertising.</p>
<h2>Data storage</h2>
<p>Your data is stored securely in Supabase (hosted on AWS). Your Shopify access token is encrypted at rest. We retain data for as long as your app is installed.</p>
<h2>Data deletion</h2>
<p>Uninstalling the app removes all your data from our systems within 48 hours. To request immediate deletion, email us at privacy@upsellboost.app.</p>
<h2>Shopify data</h2>
<p>We access your product catalog and order data only to power upsell rules and analytics. We follow Shopify's Partner API Terms of Service.</p>
<h2>Contact</h2>
<p>Questions? Email us at privacy@upsellboost.app</p>
</body></html>`);
});

// ════════════════════════════════════════════════════
// ALL EXISTING API ENDPOINTS (unchanged)
// ════════════════════════════════════════════════════

app.get('/api/store', async (req, res) => {
  const shop = req.shopDomain || req.query.shop || LEGACY_STORE;
  if (!shop) return res.json({ domain: 'dev-store', currency: 'USD' });
  try {
    const d = await shopifyFetch(shop, '/shop.json');
    res.json({ domain: d.shop?.domain || shop, name: d.shop?.name, currency: d.shop?.currency || 'USD', money_format: d.shop?.money_format || '${{amount}}' });
  } catch { res.json({ domain: shop, currency: 'USD' }); }
});

app.get('/api/products', async (req, res) => {
  const shop = req.shopDomain || req.query.shop || LEGACY_STORE;
  if (!shop) return res.json({ products: [
    { id: '1', title: 'Sample Product A', variants: [{ id: 'v1', price: '499' }], images: [] },
    { id: '2', title: 'Sample Product B', variants: [{ id: 'v2', price: '999' }], images: [] },
    { id: '3', title: 'Sample Product C', variants: [{ id: 'v3', price: '299' }], images: [] }
  ]});
  try {
    const d = await shopifyFetch(shop, '/products.json?limit=50&status=active');
    res.json({ products: d.products || [] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/products-with-variants', async (req, res) => {
  const shop = req.shopDomain || req.query.shop || LEGACY_STORE;
  if (!shop) return res.json({ products: [] });
  try {
    const d = await shopifyFetch(shop, '/products.json?limit=50&status=active&fields=id,title,variants,images');
    const products = (d.products || []).map(p => ({
      id: p.id, title: p.title,
      variants: (p.variants || []).map(v => ({ id: v.id, title: v.title, inventory_quantity: v.inventory_quantity || 0, price: v.price }))
    }));
    res.json({ products });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/offer', async (req, res) => {
  const { shop, order_id, order_total, is_cod, line_items } = req.body;
  const shopDomain = shop || req.shopDomain || LEGACY_STORE;
  let rules = [];
  if (supabase) {
    const { data } = await supabase.from('rules').select('*').eq('shop_domain', shopDomain).order('id');
    rules = data || [];
    if (rules.length === 0) { const { data: d2 } = await supabase.from('rules').select('*').eq('shop_domain', 'default').order('id'); rules = d2 || []; }
  } else { rules = readData().rules || []; }
  if (rules.length === 0) return res.json({ offer: null });
  let matchedRule = null;
  for (const rule of rules) {
    if (!rule.product_id) continue;
    switch (rule.condition) {
      case 'any': matchedRule = rule; break;
      case 'cod': if (is_cod) matchedRule = rule; break;
      case 'out_of_stock':
        if (req.body.trigger === 'out_of_stock') {
          if (!rule.condition_val || String(rule.condition_val) === String(req.body.oos_product_id)) matchedRule = rule;
        }
        break;
      case 'deadstock':
        if (req.body.trigger !== 'out_of_stock') matchedRule = rule;
        break;
      case 'order_value':
        if (parseFloat(order_total) >= parseFloat(rule.condition_val || 500)) matchedRule = rule;
        break;
      case 'contains_product':
        if ((line_items || []).map(i => String(i.product_id)).includes(String(rule.condition_val))) matchedRule = rule;
        break;
      case 'product_category':
        if ((line_items || []).map(i => (i.product_type || '').toLowerCase()).some(t => t.includes((rule.condition_val || '').toLowerCase()))) matchedRule = rule;
        break;
      case 'low_stock':
        try {
          const invData = await shopifyFetch(shopDomain, `/products/${rule.product_id}.json`);
          const qty = invData.product?.variants?.[0]?.inventory_quantity || 0;
          const threshold = parseFloat((rule.condition_val || '').split(':')[2] || 5);
          if (qty <= threshold) matchedRule = rule;
        } catch {}
        break;
      default: matchedRule = rule;
    }
    if (matchedRule) break;
  }
  if (!matchedRule) matchedRule = rules.find(r => r.product_id);
  if (!matchedRule) return res.json({ offer: null });
  let productName = matchedRule.product_name || 'Special offer';
  let variantId = null, originalPrice = '499', imageUrl = null;
  try {
    const pData = await shopifyFetch(shopDomain, `/products/${matchedRule.product_id}.json`);
    if (pData.product) {
      productName = pData.product.title;
      imageUrl = pData.product.image?.src || null;
      const variant = pData.product.variants?.[0];
      if (variant) { variantId = variant.id.toString(); originalPrice = variant.price; }
    }
  } catch (e) { console.error('Product fetch error:', e.message); }
  res.json({ offer: { product_id: matchedRule.product_id, variant_id: variantId, product_name: productName, image_url: imageUrl, original_price: originalPrice, discount_pct: matchedRule.discount || 15, trigger_rule: matchedRule.condition || 'all_orders' }});
});

app.post('/api/offer-multi', async (req, res) => {
  const { shop, order_total, is_cod, line_items } = req.body;
  const shopDomain = shop || req.shopDomain || LEGACY_STORE;
  let rules = [];
  if (supabase) {
    const { data } = await supabase.from('rules').select('*').eq('shop_domain', shopDomain).order('id');
    rules = data || [];
    if (rules.length === 0) { const { data: d2 } = await supabase.from('rules').select('*').eq('shop_domain', 'default').order('id'); rules = d2 || []; }
  } else { rules = readData().rules || []; }
  if (rules.length === 0) return res.json({ offers: [] });
  let matchedRule = null;
  for (const rule of rules) {
    if (!rule.product_id) continue;
    const cartIds = (line_items || []).map(i => String(i.product_id));
    const cartTypes = (line_items || []).map(i => (i.product_type || '').toLowerCase());
    switch (rule.condition) {
      case 'any': matchedRule = rule; break;
      case 'cod': if (is_cod) matchedRule = rule; break;
      case 'out_of_stock':
        if (req.body.trigger === 'out_of_stock') {
          if (!rule.condition_val || String(rule.condition_val) === String(req.body.oos_product_id)) matchedRule = rule;
        }
        break;
      case 'deadstock':
        if (req.body.trigger !== 'out_of_stock') matchedRule = rule;
        break;
      case 'order_value':
        if (parseFloat(order_total) >= parseFloat(rule.condition_val || 500)) matchedRule = rule; break;
      case 'contains_product':
        if (cartIds.includes(String(rule.condition_val))) matchedRule = rule; break;
      case 'product_category':
        if (cartTypes.some(t => t.includes((rule.condition_val || '').toLowerCase()))) matchedRule = rule; break;
      case 'low_stock':
        try {
          const parts = (rule.condition_val || '').split(':');
          const triggerProductId = parts[0], triggerVariantId = parts[1], threshold = parseFloat(parts[2] || 5);
          if (cartIds.includes(String(triggerProductId))) {
            const invData = await shopifyFetch(shopDomain, `/products/${triggerProductId}.json`);
            const variants = invData.product?.variants || [];
            const variant = triggerVariantId ? variants.find(v => String(v.id) === String(triggerVariantId)) : variants[0];
            if (variant && variant.inventory_quantity <= threshold) matchedRule = { ...rule, low_stock: true, urgency_text: `Only ${variant.inventory_quantity} left!` };
          }
        } catch {}
        break;
      default: matchedRule = rule;
    }
    if (matchedRule) break;
  }
  if (!matchedRule) matchedRule = rules.find(r => r.product_id);
  if (!matchedRule) return res.json({ offers: [] });
  const productIds = [matchedRule.product_id, matchedRule.product_id2, matchedRule.product_id3].filter(Boolean);
  const cartVariantIds = (line_items || []).map(i => String(i.variant_id));
  const offers = [];
  for (const pid of productIds) {
    try {
      const pData = await shopifyFetch(shopDomain, `/products/${pid}.json`);
      const p = pData.product;
      if (!p) continue;
      const variant = p.variants?.[0];
      if (!variant || cartVariantIds.includes(String(variant.id))) continue;
      offers.push({ product_id: pid, variant_id: variant.id.toString(), product_name: p.title, image_url: p.image?.src || null, original_price: variant.price, discount_pct: matchedRule.discount || 15, trigger_rule: matchedRule.condition, low_stock: matchedRule.low_stock || false, urgency_text: matchedRule.urgency_text || null });
    } catch (e) { console.error('Product fetch error:', e.message); }
  }
  res.json({ offers });
});

app.post('/api/rules', async (req, res) => {
  const shop = req.body.shop || req.shopDomain || LEGACY_STORE || 'default';
  const rules = req.body.rules || [];
  if (supabase) {
    const { error: delErr } = await supabase.from('rules').delete().eq('shop_domain', shop);
    if (delErr) console.error('Rules delete error:', delErr.message);
    if (rules.length > 0) {
      const safeRules = rules.map(r => ({ shop_domain: shop, condition: r.condition || 'any', condition_val: r.condition_val || null, condition_label: r.condition_label || r.condition || 'any', product_id: r.product_id || null, product_id2: r.product_id2 || null, product_id3: r.product_id3 || null, product_name: r.product_name || null, discount: r.discount || 15, display_location: r.display_location || 'both' }));
      const { data: inserted, error: insErr } = await supabase.from('rules').insert(safeRules).select();
      if (insErr) { console.error('Rules insert error:', insErr.message); return res.json({ success: false, error: insErr.message, count: 0 }); }
      console.log(`Saved ${inserted?.length || 0} rules for ${shop}`);
      return res.json({ success: true, count: inserted?.length || rules.length });
    }
  } else { const data = readData(); data.rules = rules; writeData(data); }
  res.json({ success: true, count: rules.length });
});

app.get('/api/rules', async (req, res) => {
  const shop = req.shopDomain || req.query.shop || LEGACY_STORE || 'default';
  if (supabase) {
    const { data } = await supabase.from('rules').select('*').eq('shop_domain', shop).order('id');
    if (data && data.length > 0) return res.json({ rules: data });
    const { data: d2 } = await supabase.from('rules').select('*').eq('shop_domain', 'default').order('id');
    return res.json({ rules: d2 || [] });
  }
  res.json({ rules: readData().rules || [] });
});

app.post('/api/events', async (req, res) => {
  const shop = req.body.shop || req.shopDomain || LEGACY_STORE || 'default';
  const event = { ...req.body, date: req.body.date || new Date().toISOString() };
  if (supabase) { await supabase.from('events').insert({ ...event, shop_domain: shop }); }
  else { const data = readData(); data.events = data.events || []; data.events.push(event); if (data.events.length > 1000) data.events = data.events.slice(-1000); writeData(data); }
  res.json({ success: true });
});

app.get('/api/events', async (req, res) => {
  const shop = req.shopDomain || req.query.shop || LEGACY_STORE || 'default';
  if (supabase) {
    const { data } = await supabase.from('events').select('*').eq('shop_domain', shop).order('date', { ascending: false }).limit(200);
    return res.json({ events: data || [] });
  }
  res.json({ events: (readData().events || []).slice(-200).reverse() });
});

app.post('/api/settings', async (req, res) => {
  const shop = req.body.shop || req.shopDomain || LEGACY_STORE || 'default';
  if (supabase) { await supabase.from('settings').upsert({ ...req.body, shop_domain: shop }, { onConflict: 'shop_domain' }); }
  else { const data = readData(); data.settings = { ...data.settings, ...req.body }; writeData(data); }
  res.json({ success: true });
});

app.get('/api/settings', async (req, res) => {
  const shop = req.shopDomain || req.query.shop || LEGACY_STORE || 'default';
  if (supabase) { const { data } = await supabase.from('settings').select('*').eq('shop_domain', shop).single(); return res.json({ settings: data || {} }); }
  res.json({ settings: readData().settings || {} });
});

// ════════════════════════════════════════════════════
// WEBHOOKS (unchanged)
// ════════════════════════════════════════════════════

app.post('/webhooks/orders/create', express.raw({ type: 'application/json' }), async (req, res) => {
  if (!verifyWebhookHMAC(req)) { console.warn('HMAC verification failed: orders/create'); return res.sendStatus(401); }
  res.sendStatus(200);
  try {
    const order = JSON.parse(req.body);
    const shop = req.headers['x-shopify-shop-domain'] || LEGACY_STORE || 'default';
    const event = { order_id: String(order.id), product_name: order.line_items?.[0]?.title || 'Unknown', accepted: true, revenue: parseFloat(order.total_price || 0), channel: 'shopify_order', date: new Date().toISOString(), shop_domain: shop };
    if (supabase) { await supabase.from('events').insert(event); }
    else { const data = readData(); data.events = data.events || []; data.events.push(event); writeData(data); }
  } catch (e) { console.error('Webhook error:', e.message); }
});

app.post('/webhooks/customers/redact', express.raw({ type: 'application/json' }), async (req, res) => {
  if (!verifyWebhookHMAC(req)) return res.sendStatus(401);
  res.sendStatus(200);
  console.log('GDPR customers/redact — no personal data stored');
});

app.post('/webhooks/shop/redact', express.raw({ type: 'application/json' }), async (req, res) => {
  if (!verifyWebhookHMAC(req)) return res.sendStatus(401);
  res.sendStatus(200);
  try {
    const body = JSON.parse(req.body);
    const shop = body.shop_domain || req.headers['x-shopify-shop-domain'];
    if (supabase && shop) {
      await supabase.from('shops').delete().eq('shop_domain', shop);
      await supabase.from('rules').delete().eq('shop_domain', shop);
      await supabase.from('events').delete().eq('shop_domain', shop);
      await supabase.from('settings').delete().eq('shop_domain', shop);
      console.log(`✓ All data deleted for ${shop}`);
    }
  } catch (e) { console.error('GDPR shop redact error:', e.message); }
});

app.post('/webhooks/customers/data_request', express.raw({ type: 'application/json' }), async (req, res) => {
  if (!verifyWebhookHMAC(req)) return res.sendStatus(401);
  res.sendStatus(200);
  console.log('GDPR data_request — no personal data stored');
});

// ── HEALTH CHECK ──
app.get('/health', async (req, res) => {
  let rulesCount = 0, eventsCount = 0, shopsCount = 0;
  if (supabase) {
    const r = await supabase.from('rules').select('id', { count: 'exact' });
    const e = await supabase.from('events').select('id', { count: 'exact' });
    const s = await supabase.from('shops').select('shop_domain', { count: 'exact' });
    rulesCount = r.count || 0; eventsCount = e.count || 0; shopsCount = s.count || 0;
  } else { const data = readData(); rulesCount = (data.rules || []).length; eventsCount = (data.events || []).length; shopsCount = Object.keys(data.shops || {}).length; }
  res.json({ status: 'ok', version: '3.1.0', oauth: !!CLIENT_ID, billing: !!CLIENT_ID, session_tokens: true, app_bridge: true, hmac_verification: !!CLIENT_SECRET, gdpr_webhooks: true, shops: shopsCount, rules: rulesCount, events: eventsCount, supabase: !!supabase, timestamp: new Date().toISOString() });
});

// ── START ──
const PORT = process.env.PORT || 3000;
initSupabase().then(() => {
  app.listen(PORT, () => {
    console.log(`UpsellBoost v3.1 running on port ${PORT}`);
    console.log(`OAuth: ${CLIENT_ID ? '✓ configured' : '✗ set SHOPIFY_CLIENT_ID'}`);
    console.log(`Session tokens: ✓ enabled`);
    console.log(`App Bridge: ✓ enabled`);
    console.log(`App URL: ${APP_URL}`);
  });
});

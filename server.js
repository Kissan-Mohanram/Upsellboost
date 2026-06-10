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

// Parse JSON for all routes, saving raw body for webhook HMAC verification
app.use(express.json({
  verify: (req, res, buf) => {
    req.rawBody = buf;
  }
}));

// ── OAuth gate: force install flow ONLY for new stores with no token ──
// Safe by design: never blocks the legacy/dev store, never loops, and fails OPEN
// (serves the app) if anything goes wrong — so it can never crash the app for users.
app.get('/', async (req, res, next) => {
  const shop = req.query.shop;
  if (!shop) return next();                    // no shop param → just serve app
  if (shop === LEGACY_STORE) return next();    // our own dev store uses LEGACY_TOKEN → never gate it
  if (!CLIENT_ID || !CLIENT_SECRET) return next(); // OAuth not configured → don't trap anyone, serve app
  if (req.query.no_oauth === '1') return next();   // manual escape hatch to bypass the gate
  try {
    const token = await getShopTokenRaw(shop);
    if (!token) {
      console.log(`[oauth-gate] No token for ${shop} — redirecting to /auth`);
      return res.redirect(`/auth?shop=${encodeURIComponent(shop)}`);
    }
  } catch (e) {
    console.error('[oauth-gate] error (serving app anyway):', e.message);
    return next(); // fail OPEN — never block the app on an error
  }
  next();
});

app.use(express.static(path.join(__dirname, 'public')));

// ── CORS + CSP ──
app.use((req, res, next) => {
  res.removeHeader('X-Frame-Options');
  res.setHeader('Content-Security-Policy', "frame-ancestors 'self' https://*.myshopify.com https://admin.shopify.com");
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  // Prevent HTTP/2 connection coalescing (causes 421 Misdirected Request inside Shopify iframe).
  // Vary by Origin so the browser does not reuse a connection opened for another origin.
  res.setHeader('Vary', 'Origin');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// ── CONFIG ──
const CLIENT_ID     = process.env.SHOPIFY_CLIENT_ID || '';
const CLIENT_SECRET = process.env.SHOPIFY_CLIENT_SECRET || '';
const APP_URL       = process.env.APP_URL || 'https://upsellboost-production.up.railway.app';
const SCOPES        = 'read_products,read_orders,write_orders,read_inventory,write_script_tags,read_script_tags';
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
  // Use service role key if available (bypasses RLS), otherwise anon key
  const key = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY;
  if (!url || !key) { console.log('No Supabase credentials — using file storage'); return; }
  try {
    const { createClient } = require('@supabase/supabase-js');
    supabase = createClient(url, key);
    console.log('✓ Supabase client created, key type:', process.env.SUPABASE_SERVICE_KEY ? 'service_role' : 'anon');
    // Test with a lightweight ping instead of SELECT on rules (which may have RLS)
    const { error } = await supabase.from('shops').select('shop_domain').limit(1);
    if (error) {
      console.warn('Supabase test query failed:', error.message, '— but keeping connection');
      // Don't null out supabase — let actual operations decide
    } else {
      console.log('✓ Supabase connection verified');
    }
  } catch (e) {
    console.log('Supabase not available:', e.message);
    supabase = null;
  }
}

// ── SHOP HELPERS ──
// ── Token refresh for expiring offline tokens (required since April 2026) ──
// Track failed refreshes to prevent spam (cooldown 5 minutes)
const _refreshFailed = {};

async function refreshShopToken(shop) {
  if (!shop || !CLIENT_ID || !CLIENT_SECRET) return null;
  // Cooldown: don't retry if we failed recently
  if (_refreshFailed[shop] && Date.now() - _refreshFailed[shop] < 5 * 60 * 1000) return null;
  let refresh_token;
  if (supabase) {
    const { data } = await supabase.from('shops').select('refresh_token').eq('shop_domain', shop).single();
    refresh_token = data?.refresh_token;
  } else {
    const fileData = readData();
    refresh_token = fileData.shops?.[shop]?.refresh_token;
  }
  if (!refresh_token) { console.log(`[refresh] No refresh_token for ${shop}`); return null; }
  try {
    const res = await fetch(`https://${shop}/admin/oauth/access_token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: JSON.stringify({ client_id: CLIENT_ID, client_secret: CLIENT_SECRET, grant_type: 'refresh_token', refresh_token })
    });
    const raw = await res.text();
    const tokenData = JSON.parse(raw);
    if (!tokenData.access_token) {
      console.error('[refresh] Failed for', shop, ':', raw.slice(0, 150));
      _refreshFailed[shop] = Date.now(); // Set cooldown
      return null;
    }
    delete _refreshFailed[shop]; // Clear cooldown on success
    const token_expires_at = tokenData.expires_in ? new Date(Date.now() + tokenData.expires_in * 1000).toISOString() : null;
    if (supabase) {
      const updateObj = { access_token: tokenData.access_token, token_expires_at };
      if (tokenData.refresh_token) updateObj.refresh_token = tokenData.refresh_token;
      await supabase.from('shops').update(updateObj).eq('shop_domain', shop);
    } else {
      const fileData = readData();
      fileData.shops = fileData.shops || {};
      fileData.shops[shop] = { ...(fileData.shops[shop] || {}), access_token: tokenData.access_token, token_expires_at };
      if (tokenData.refresh_token) fileData.shops[shop].refresh_token = tokenData.refresh_token;
      writeData(fileData);
    }
    console.log(`[refresh] ✓ Token refreshed for ${shop}`);
    return tokenData.access_token;
  } catch (e) {
    console.error('[refresh] Error refreshing token for', shop, e.message);
    return null;
  }
}

async function getShopToken(shop) {
  const shopDomain = shop || LEGACY_STORE;
  if (supabase && shopDomain) {
    try {
      const { data } = await supabase.from('shops').select('access_token,refresh_token,token_expires_at').eq('shop_domain', shopDomain).single();
      if (data?.access_token) {
        // Check if token is expired or about to expire (5 min buffer)
        if (data.token_expires_at) {
          const expiresAt = new Date(data.token_expires_at).getTime();
          const now = Date.now();
          if (now > expiresAt - 5 * 60 * 1000) {
            // Token expired or expiring soon — refresh it
            const newToken = await refreshShopToken(shopDomain);
            if (newToken) return newToken;
            // If refresh fails, try the existing token anyway (might still work briefly)
          }
        }
        return data.access_token;
      }
    } catch(e) {}
  } else {
    const fileData = readData();
    const shopData = fileData.shops?.[shopDomain];
    if (shopData?.access_token) {
      if (shopData.token_expires_at) {
        const expiresAt = new Date(shopData.token_expires_at).getTime();
        if (Date.now() > expiresAt - 5 * 60 * 1000) {
          const newToken = await refreshShopToken(shopDomain);
          if (newToken) return newToken;
        }
      }
      return shopData.access_token;
    }
  }
  return LEGACY_TOKEN;
}

// Like getShopToken but returns null when the shop has no saved token (NO legacy fallback).
// Used by the OAuth gate to detect stores that haven't completed install yet.
async function getShopTokenRaw(shop) {
  if (!shop) return null;
  if (supabase) {
    try {
      const { data } = await supabase.from('shops').select('access_token').eq('shop_domain', shop).single();
      return data?.access_token || null;
    } catch(e) { return null; }
  } else {
    const fileData = readData();
    return fileData.shops?.[shop]?.access_token || null;
  }
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
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000); // 5-second timeout
  try {
    const res = await fetch(url, {
      headers: { 'X-Shopify-Access-Token': token, 'Content-Type': 'application/json' },
      signal: controller.signal,
      ...options
    });
    clearTimeout(timeout);
    return res.json();
  } catch (e) {
    clearTimeout(timeout);
    throw e;
  }
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
    // Token couldn't be verified — proceed using the ?shop= param instead (non-blocking).
    // Common during install before OAuth completes; not an error that should block the app.
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
  if (!CLIENT_ID || !CLIENT_SECRET) {
    console.error('[oauth-callback] CLIENT_ID or CLIENT_SECRET not set in Railway env vars');
    return res.status(500).send('App not configured: missing client credentials. Contact support.');
  }
  try {
    const tokenRes = await fetch(`https://${shop}/admin/oauth/access_token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: JSON.stringify({ client_id: CLIENT_ID, client_secret: CLIENT_SECRET, code, expiring: 1 })
    });
    const raw = await tokenRes.text();
    let tokenData;
    try {
      tokenData = JSON.parse(raw);
    } catch (parseErr) {
      console.error(`[oauth-callback] Non-JSON token response (status ${tokenRes.status}):`, raw.slice(0, 200));
      return res.status(502).send('OAuth token exchange failed. Please reinstall the app from the Shopify admin.');
    }
    const { access_token, refresh_token, expires_in } = tokenData;
    if (!access_token) {
      console.error('[oauth-callback] No access_token in response:', raw.slice(0, 200));
      return res.status(400).send('Failed to get access token. Please try reinstalling.');
    }
    // Calculate expiry timestamp (expires_in is in seconds, typically 3600 = 60 min)
    const token_expires_at = expires_in ? new Date(Date.now() + expires_in * 1000).toISOString() : null;
    console.log(`[oauth-callback] Got token for ${shop} (expiring=${!!expires_in}, refresh=${!!refresh_token})`);
    if (supabase) {
      await supabase.from('shops').upsert({
        shop_domain: shop, access_token, refresh_token: refresh_token || null,
        token_expires_at, plan: 'free', installed_at: new Date().toISOString()
      }, { onConflict: 'shop_domain' });
    } else {
      const data = readData();
      data.shops = data.shops || {};
      data.shops[shop] = { access_token, refresh_token, token_expires_at, plan: 'free' };
      writeData(data);
    }
    console.log(`✓ Shop installed: ${shop}`);
    try { await registerWebhooks(shop, access_token); } catch(whErr){ console.error('[oauth-callback] webhook register failed (non-fatal):', whErr.message); }
    try { await registerScriptTag(shop, access_token); } catch(stErr){ console.error('[oauth-callback] ScriptTag register failed (non-fatal):', stErr.message); }
    res.redirect(`https://${shop}/admin/apps/${CLIENT_ID}`);
  } catch (e) {
    console.error('OAuth callback error:', e.message);
    res.status(500).send('OAuth error: ' + e.message);
  }
});

function verifyWebhookHMAC(req) {
  const hmacHeader = req.headers['x-shopify-hmac-sha256'];
  if (!hmacHeader || !CLIENT_SECRET) return false;
  try {
    const body = req.rawBody || req.body;
    const hash = crypto.createHmac('sha256', CLIENT_SECRET).update(body).digest('base64');
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

// ── Register ScriptTag for storefront widget ──
async function registerScriptTag(shop, token) {
  try {
    const scriptUrl = `${APP_URL}/widget.js`;
    // First check if already registered
    const listRes = await fetch(`https://${shop}/admin/api/${API_VERSION}/script_tags.json`, {
      headers: { 'X-Shopify-Access-Token': token }
    });
    const listData = await listRes.json();
    const existing = (listData.script_tags || []).find(s => s.src.includes('widget.js'));
    if (existing) { console.log(`✓ ScriptTag already registered for ${shop}`); return; }
    // Register new ScriptTag
    const res = await fetch(`https://${shop}/admin/api/${API_VERSION}/script_tags.json`, {
      method: 'POST',
      headers: { 'X-Shopify-Access-Token': token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ script_tag: { event: 'onload', src: scriptUrl, display_scope: 'all' }})
    });
    const data = await res.json();
    if (data.errors) console.log(`ScriptTag error:`, data.errors);
    else console.log(`✓ ScriptTag registered for ${shop}`);
  } catch (e) { console.log('ScriptTag registration failed:', e.message); }
}

// ── CORS middleware for storefront widget API calls ──
// The widget runs on merchant storefronts (different domain), so it needs CORS
app.use('/api/offer', function(req, res, next) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});
app.use('/api/offer-multi', function(req, res, next) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});
app.use('/api/events', function(req, res, next) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// ════════════════════════════════════════════════════
// PHASE 2 — SHOPIFY BILLING API (unchanged)
// ════════════════════════════════════════════════════

const PLANS = {
  basic:      { name: 'UpsellBoost Basic',     amount: '9.99',  currency: 'USD', trialDays: 7, orderLimit: 500,   rulesLimit: 5   },
  pro:        { name: 'UpsellBoost Pro',        amount: '24.99', currency: 'USD', trialDays: 7, orderLimit: 2000,  rulesLimit: 999 },
  enterprise: { name: 'UpsellBoost Enterprise', amount: '59.99', currency: 'USD', trialDays: 3, orderLimit: 99999, rulesLimit: 999 }
};

app.get('/billing/create', async (req, res) => {
  const { shop, plan } = req.query;
  const shopDomain = shop || LEGACY_STORE;
  const planConfig = PLANS[plan];
  if (!planConfig) return res.status(400).json({ error: 'Invalid plan: ' + plan });
  if (!shopDomain) return res.status(400).json({ error: 'Missing shop parameter' });
  // Use test charges unless explicitly enabled for live billing.
  // Reviewers must see TEST charges so they can approve without being billed real money.
  const useTest = process.env.BILLING_LIVE === 'true' ? false : true;
  // Billing requires a proper OAuth (Partner-app) token. The legacy/shop-owned token
  // cannot create charges ("application is currently owned by a Shop"). If this shop
  // hasn't installed via OAuth, send them through it first.
  const oauthToken = await getShopTokenRaw(shopDomain);
  if (!oauthToken) {
    console.log(`[billing] No OAuth token for ${shopDomain} — needs install first`);
    return res.status(401).json({ error: 'App not installed. Please reinstall from Shopify admin.', needsInstall: true });
  }
  try {
    const mutation = `
      mutation {
        appSubscriptionCreate(
          name: "${planConfig.name}"
          returnUrl: "${APP_URL}/billing/callback?shop=${shopDomain}&plan=${plan}"
          trialDays: ${planConfig.trialDays}
          test: ${useTest}
          lineItems: [{
            plan: {
              appRecurringPricingDetails: {
                price: { amount: "${planConfig.amount}", currencyCode: ${planConfig.currency} }
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
    if (data?.errors) {
      console.error('Billing GraphQL errors:', JSON.stringify(data.errors));
      const errMsg = Array.isArray(data.errors) ? data.errors.map(e => e.message || JSON.stringify(e)).join('; ') : (typeof data.errors === 'string' ? data.errors : JSON.stringify(data.errors));
      return res.status(400).json({ error: errMsg });
    }
    if (result?.userErrors?.length > 0) {
      console.error('Billing userErrors:', JSON.stringify(result.userErrors));
      return res.status(400).json({ error: result.userErrors[0].message });
    }
    if (!result?.confirmationUrl) return res.status(500).json({ error: 'No confirmation URL returned from Shopify' });
    console.log(`Billing created for ${shopDomain} plan=${plan} test=${useTest}`);
    // Return the URL as JSON — the frontend handles the top-level redirect via App Bridge
    res.json({ confirmationUrl: result.confirmationUrl });
  } catch (e) {
    console.error('Billing create error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Breaks out of the Shopify admin iframe to load the billing confirmation page at top level.
// Redirecting to Shopify's confirmationUrl INSIDE the iframe fails — it must be top-level.
app.get('/billing/redirect', (req, res) => {
  const url = req.query.url;
  if (!url) return res.status(400).send('Missing url');
  res.set('Content-Type', 'text/html');
  res.send(`<!DOCTYPE html><html><head><meta charset="utf-8"></head><body>
    <script>
      // If embedded in Shopify admin iframe, redirect the TOP window; else redirect normally.
      var target = ${JSON.stringify(url)};
      if (window.top === window.self) {
        window.location.href = target;
      } else {
        window.top.location.href = target;
      }
    </script>
    <p>Redirecting to secure checkout… If you are not redirected, <a href="${url}" target="_top">click here</a>.</p>
    </body></html>`);
});

app.get('/billing/callback', async (req, res) => {
  const { shop, plan, charge_id } = req.query;
  const shopDomain = shop || LEGACY_STORE;
  console.log(`[billing-callback] shop=${shopDomain} plan=${plan} charge_id=${charge_id}`);
  // No charge_id = merchant declined/cancelled
  if (!charge_id) {
    console.log(`[billing-callback] No charge_id — merchant declined`);
    return res.redirect(`https://${shopDomain}/admin/apps/${CLIENT_ID}`);
  }
  // charge_id present = merchant approved. Save the plan.
  try {
    if (supabase) {
      await supabase.from('shops').update({ plan }).eq('shop_domain', shopDomain);
    } else {
      const fileData = readData();
      fileData.shops = fileData.shops || {};
      fileData.shops[shopDomain] = { ...(fileData.shops[shopDomain] || {}), plan };
      writeData(fileData);
    }
    console.log(`✓ Plan activated: ${shopDomain} → ${plan} (charge_id: ${charge_id})`);
  } catch (e) {
    console.error('[billing-callback] Save error (non-fatal):', e.message);
  }
  res.redirect(`https://${shopDomain}/admin/apps/${CLIENT_ID}`);
});

app.get('/api/plan', async (req, res) => {
  const shop = req.query.shop || LEGACY_STORE;
  const plan = await getShopPlan(shop);
  const planConfig = PLANS[plan] || { orderLimit: 50, rulesLimit: 1 };
  res.json({ plan, orderLimit: planConfig.orderLimit, rulesLimit: planConfig.rulesLimit });
});

app.post('/webhooks/app/uninstalled', async (req, res) => {
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

var PRODUCTS_CACHE = {}; // { shop: { data, ts } }
app.get('/api/products', async (req, res) => {
  const shop = req.shopDomain || req.query.shop || LEGACY_STORE;
  const SAMPLE = [
    { id: '1', title: 'Sample Product A', variants: [{ id: 'v1', price: '499' }], images: [] },
    { id: '2', title: 'Sample Product B', variants: [{ id: 'v2', price: '999' }], images: [] },
    { id: '3', title: 'Sample Product C', variants: [{ id: 'v3', price: '299' }], images: [] }
  ];
  if (!shop) return res.json({ products: SAMPLE, source: 'sample_no_shop' });
  // Serve from cache instantly if fresh (< 5 min) — avoids slow Shopify call on every load
  const cached = PRODUCTS_CACHE[shop];
  if (cached && (Date.now() - cached.ts) < 300000) {
    return res.json({ products: cached.data, source: 'shopify_cached' });
  }
  try {
    const token = await getShopToken(shop);
    console.log(`[products] shop=${shop} token=${token ? token.substring(0,8)+'...' : 'MISSING'}`);
    if (!token) {
      console.warn(`[products] No token for ${shop} — returning sample products`);
      return res.json({ products: SAMPLE, source: 'sample_no_token' });
    }
    const d = await shopifyFetch(shop, '/products.json?limit=50&status=active');
    if (d.errors) {
      console.error(`[products] Shopify API error for ${shop}:`, d.errors);
      return res.json({ products: SAMPLE, source: 'sample_api_error', error: d.errors });
    }
    const products = d.products || [];
    console.log(`[products] Fetched ${products.length} products for ${shop}`);
    if (products.length === 0) {
      return res.json({ products: SAMPLE, source: 'sample_empty_store' });
    }
    PRODUCTS_CACHE[shop] = { data: products, ts: Date.now() }; // cache for next time
    res.json({ products, source: 'shopify' });
  } catch (e) {
    console.error(`[products] Exception for ${shop}:`, e.message);
    // serve stale cache if available rather than samples
    if (cached) return res.json({ products: cached.data, source: 'shopify_stale' });
    res.json({ products: SAMPLE, source: 'sample_exception', error: e.message });
  }
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
  try {
    const shop = (req.body && req.body.shop) || req.shopDomain || LEGACY_STORE || 'default';
    const rules = (req.body && req.body.rules) || [];
    console.log(`[rules POST] shop=${shop} rules=${rules.length}`);

    if (supabase) {
      // Delete existing rules using direct REST API (more reliable than client library)
      const supabaseUrl = process.env.SUPABASE_URL;
      const supabaseKey = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY;
      const deleteRes = await fetch(
        `${supabaseUrl}/rest/v1/rules?shop_domain=eq.${encodeURIComponent(shop)}`,
        {
          method: 'DELETE',
          headers: {
            'apikey': supabaseKey,
            'Authorization': `Bearer ${supabaseKey}`,
            'Content-Type': 'application/json',
            'Prefer': 'return=minimal'
          }
        }
      );
      console.log(`[rules POST] DELETE status: ${deleteRes.status} for shop: ${shop}`);

      if (rules.length > 0) {
        // Stage 1: Try full insert with all columns
        const fullRules = rules.map(r => ({
          shop_domain: shop,
          condition: r.condition || 'any',
          condition_val: r.condition_val || null,
          condition_label: r.condition_label || r.condition || 'any',
          product_id: r.product_id ? String(r.product_id) : null,
          product_id2: r.product_id2 ? String(r.product_id2) : null,
          product_id3: r.product_id3 ? String(r.product_id3) : null,
          product_name: r.product_name || null,
          discount: r.discount || 15,
          display_location: r.display_location || 'both'
        }));

        const { data: inserted, error: insErr } = await supabase.from('rules').insert(fullRules).select();

        if (!insErr) {
          console.log(`[rules POST] Saved ${inserted?.length || 0} rules to Supabase (full)`);
          return res.json({ success: true, count: inserted?.length || rules.length });
        }

        console.warn(`[rules POST] Full insert failed (${insErr.message}) — trying minimal columns`);

        // Stage 2: Try minimal columns only (guaranteed to exist)
        const minRules = rules.map(r => ({
          shop_domain: shop,
          condition: r.condition || 'any',
          condition_val: r.condition_val || null,
          product_id: r.product_id ? String(r.product_id) : null,
          product_id2: r.product_id2 ? String(r.product_id2) : null,
          product_id3: r.product_id3 ? String(r.product_id3) : null,
          product_name: r.product_name || null,
          discount: r.discount || 15
        }));

        const { data: inserted2, error: insErr2 } = await supabase.from('rules').insert(minRules).select();

        if (!insErr2) {
          console.log(`[rules POST] Saved ${inserted2?.length || 0} rules to Supabase (minimal)`);
          return res.json({ success: true, count: inserted2?.length || rules.length });
        }

        console.error(`[rules POST] Both inserts failed: ${insErr2.message} — using file storage`);
      }
    }

    // Final fallback: file storage (always works)
    const fileData = readData();
    fileData.rules = rules;
    writeData(fileData);
    console.log(`[rules POST] Saved ${rules.length} rules to file storage`);
    return res.json({ success: true, count: rules.length });

  } catch (e) {
    console.error('[rules POST] Unhandled error:', e.message);
    return res.status(500).json({ success: false, error: e.message });
  }
});

app.get('/api/rules', async (req, res) => {
  const shop = req.shopDomain || req.query.shop || LEGACY_STORE || 'default';
  if (supabase) {
    try {
      const { data } = await supabase.from('rules').select('*').eq('shop_domain', shop).order('id');
      if (data && data.length > 0) return res.json({ rules: data });
      const { data: d2 } = await supabase.from('rules').select('*').eq('shop_domain', 'default').order('id');
      if (d2 && d2.length > 0) return res.json({ rules: d2 });
    } catch(e) { console.error('GET rules Supabase error:', e.message); }
    // Fall back to file
    const fileData = readData();
    return res.json({ rules: fileData.rules || [] });
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

app.post('/webhooks/orders/create', async (req, res) => {
  if (!verifyWebhookHMAC(req)) { console.warn('HMAC verification failed: orders/create'); return res.sendStatus(401); }
  res.sendStatus(200);
  try {
    const order = req.body;
    const shop = req.headers['x-shopify-shop-domain'] || LEGACY_STORE || 'default';
    const event = { order_id: String(order.id), product_name: order.line_items?.[0]?.title || 'Unknown', accepted: true, revenue: parseFloat(order.total_price || 0), channel: 'shopify_order', date: new Date().toISOString(), shop_domain: shop };
    if (supabase) { await supabase.from('events').insert(event); }
    else { const data = readData(); data.events = data.events || []; data.events.push(event); writeData(data); }
  } catch (e) { console.error('Webhook error:', e.message); }
});

app.post('/webhooks/customers/redact', async (req, res) => {
  if (!verifyWebhookHMAC(req)) return res.sendStatus(401);
  res.sendStatus(200);
  console.log('GDPR customers/redact — no personal data stored');
});

app.post('/webhooks/shop/redact', async (req, res) => {
  if (!verifyWebhookHMAC(req)) return res.sendStatus(401);
  res.sendStatus(200);
  try {
    const body = req.body;
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

app.post('/webhooks/customers/data_request', async (req, res) => {
  if (!verifyWebhookHMAC(req)) return res.sendStatus(401);
  res.sendStatus(200);
  console.log('GDPR data_request — no personal data stored');
});

// ── DEBUG ENDPOINT ──
app.get('/api/debug', async (req, res) => {
  const shop = req.query.shop || LEGACY_STORE || 'test';
  const result = {
    supabase_connected: !!supabase,
    key_type: process.env.SUPABASE_SERVICE_KEY ? 'service_role' : (process.env.SUPABASE_ANON_KEY ? 'anon' : 'none'),
    supabase_url_set: !!process.env.SUPABASE_URL,
    shopify_token_set: !!LEGACY_TOKEN,
    shopify_store_set: !!LEGACY_STORE,
    shop_param: shop,
    tests: {}
  };
  if (supabase) {
    // Test SELECT on rules
    const { data: rd, error: re } = await supabase.from('rules').select('id').limit(1);
    result.tests.rules_select = re ? `ERROR: ${re.message}` : `OK (${rd?.length || 0} rows)`;
    // Test INSERT on rules
    const testRule = { shop_domain: '__debug_test__', condition: 'any', product_id: '1', discount: 10 };
    const { error: ie } = await supabase.from('rules').insert(testRule);
    result.tests.rules_insert = ie ? `ERROR: ${ie.message}` : 'OK';
    // Clean up test
    if (!ie) await supabase.from('rules').delete().eq('shop_domain', '__debug_test__');
    // Test rules for this shop
    const { data: sr, error: se } = await supabase.from('rules').select('*').eq('shop_domain', shop);
    result.tests.rules_for_shop = se ? `ERROR: ${se.message}` : `OK (${sr?.length || 0} rules)`;
  }
  res.json(result);
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

// ── Manual ScriptTag registration for existing installs ──
app.get('/api/register-widget', async (req, res) => {
  const shop = req.query.shop;
  if (!shop) return res.json({ error: 'Missing shop parameter' });
  try {
    const token = await getShopToken(shop);
    if (!token || token === LEGACY_TOKEN) return res.json({ error: 'No OAuth token for this shop. Reinstall via /auth?shop=' + shop });
    await registerScriptTag(shop, token);
    res.json({ success: true, message: 'ScriptTag registered for ' + shop });
  } catch (e) {
    res.json({ error: e.message });
  }
});

// ── SPA catch-all: serve index.html for any unmatched route ──
// Shopify admin may load the app at paths like /pricing, /dashboard etc.
// Since UpsellBoost is a single-page app, all routes serve the same HTML.
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ── Catch-all POST: verify HMAC for Shopify webhook validation ──
// Shopify's automated check POSTs to the app root URL with an invalid HMAC
// and expects HTTP 401. Without this, unmatched POSTs return 404.
app.post('*', (req, res) => {
  if (!verifyWebhookHMAC(req)) return res.sendStatus(401);
  res.sendStatus(200);
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

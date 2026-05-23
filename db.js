// db.js — Database layer
// Uses Supabase if SUPABASE_URL is set, otherwise falls back to file
const fs = require('fs');
const path = require('path');
const DATA_FILE = path.join(__dirname, 'data.json');

let supabase = null;

// Try to initialise Supabase
async function initSupabase() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_ANON_KEY;
  if (!url || !key) return false;
  try {
    const { createClient } = require('@supabase/supabase-js');
    supabase = createClient(url, key);
    // Test connection
    const { error } = await supabase.from('rules').select('id').limit(1);
    if (error) { console.log('Supabase connection failed:', error.message); supabase = null; return false; }
    console.log('✓ Supabase connected — using cloud database');
    return true;
  } catch (e) {
    console.log('Supabase not available, using file storage');
    supabase = null;
    return false;
  }
}

// ── FILE FALLBACK ──
function readFile() {
  try {
    if (fs.existsSync(DATA_FILE)) return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch (e) {}
  return { rules: [], events: [], settings: {}, discount_codes: {} };
}

function writeFile(data) {
  try { fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2)); } catch (e) {}
}

// ── RULES ──
async function getRules(shopDomain = 'default') {
  if (supabase) {
    const { data, error } = await supabase.from('rules').select('*').eq('shop_domain', shopDomain).order('id');
    if (!error) return data || [];
  }
  return readFile().rules || [];
}

async function saveRules(rules, shopDomain = 'default') {
  if (supabase) {
    // Delete old rules for this shop then insert new ones
    await supabase.from('rules').delete().eq('shop_domain', shopDomain);
    if (rules.length > 0) {
      const rows = rules.map(r => ({ ...r, shop_domain: shopDomain }));
      const { error } = await supabase.from('rules').insert(rows);
      if (error) console.error('Supabase rules save error:', error.message);
    }
    return true;
  }
  const data = readFile();
  data.rules = rules;
  writeFile(data);
  return true;
}

// ── EVENTS ──
async function saveEvent(event, shopDomain = 'default') {
  if (supabase) {
    const { error } = await supabase.from('events').insert({ ...event, shop_domain: shopDomain });
    if (error) console.error('Supabase event save error:', error.message);
    return true;
  }
  const data = readFile();
  data.events = data.events || [];
  data.events.push({ ...event, date: event.date || new Date().toISOString() });
  if (data.events.length > 1000) data.events = data.events.slice(-1000);
  writeFile(data);
  return true;
}

async function getEvents(shopDomain = 'default', limit = 200) {
  if (supabase) {
    const { data, error } = await supabase.from('events').select('*').eq('shop_domain', shopDomain).order('date', { ascending: false }).limit(limit);
    if (!error) return data || [];
  }
  return (readFile().events || []).slice(-limit).reverse();
}

// ── SETTINGS ──
async function getSettings(shopDomain = 'default') {
  if (supabase) {
    const { data } = await supabase.from('settings').select('*').eq('shop_domain', shopDomain).single();
    return data || {};
  }
  return readFile().settings || {};
}

async function saveSettings(settings, shopDomain = 'default') {
  if (supabase) {
    const { error } = await supabase.from('settings').upsert({ ...settings, shop_domain: shopDomain, updated_at: new Date().toISOString() }, { onConflict: 'shop_domain' });
    if (error) console.error('Settings save error:', error.message);
    return true;
  }
  const data = readFile();
  data.settings = { ...data.settings, ...settings };
  writeFile(data);
  return true;
}

// ── DISCOUNT CODE CACHE ──
async function getCachedDiscountCode(key) {
  const data = readFile();
  return data.discount_codes?.[key] || null;
}

async function setCachedDiscountCode(key, code) {
  const data = readFile();
  data.discount_codes = data.discount_codes || {};
  data.discount_codes[key] = code;
  writeFile(data);
}

module.exports = { initSupabase, getRules, saveRules, saveEvent, getEvents, getSettings, saveSettings, getCachedDiscountCode, setCachedDiscountCode };

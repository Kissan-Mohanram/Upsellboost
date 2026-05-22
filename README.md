# UpsellBoost — Shopify Upsell App

Professional post-purchase upsell app for Shopify merchants.

## Files in this project

- `server.js` — Backend (Node.js + Express)
- `public/index.html` — Merchant dashboard (all 4 pages)
- `package.json` — Dependencies
- `.env.example` — Environment variables template

## Deploy FREE on Railway in 5 minutes

1. Go to railway.app → sign up free (no credit card)
2. Click "New Project" → "Deploy from GitHub"
3. Upload these files to a GitHub repo first (github.com → New repo → upload files)
4. Connect Railway to your GitHub repo
5. Railway auto-deploys and gives you a live URL like: https://upsellboost.up.railway.app

## Set your environment variables on Railway

In Railway dashboard → your project → Variables → add:
- SHOPIFY_STORE = your-store.myshopify.com
- SHOPIFY_TOKEN = shpat_your_token_here

## Connect to Shopify

1. Copy your Railway URL (e.g. https://upsellboost.up.railway.app)
2. Go to partners.shopify.com → your app → Configuration
3. Paste the Railway URL into App URL field
4. Save → go to your dev store → click your app → dashboard loads!

## What's included

- Dashboard with live stat cards
- Offers page with product dropdown + trigger rules
- Analytics with events table
- Settings with WhatsApp + popup toggles
- Shopify API connections (products, orders, webhooks)
- No iframe issues — works perfectly inside Shopify admin

#!/usr/bin/env node
// Refresh product prices in data/catalogue.json from Woolworths and Drakes.
//
// For each product:
//   - Woolworths products with a `stockcode` are looked up through the
//     Woolworths product API.
//   - Any product with a `url` (Woolworths or Drakes) falls back to reading
//     the price from the product page's structured data (JSON-LD / meta tags).
// Products without a stockcode or url are left alone. A failed lookup never
// removes a price; it keeps the old one and is reported.
//
// Usage: node scripts/update-prices.mjs [--dry-run]

import { readFile, writeFile } from 'node:fs/promises';

const FILE = new URL('../data/catalogue.json', import.meta.url);
const DRY_RUN = process.argv.includes('--dry-run');
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const today = new Date().toISOString().slice(0, 10);

let wooliesCookies = null;

async function woolworthsCookies() {
  if (wooliesCookies !== null) return wooliesCookies;
  try {
    const res = await fetch('https://www.woolworths.com.au/', { headers: { 'user-agent': UA } });
    wooliesCookies = (res.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ');
  } catch {
    wooliesCookies = '';
  }
  return wooliesCookies;
}

async function woolworthsPrice(stockcode) {
  const cookie = await woolworthsCookies();
  const res = await fetch(`https://www.woolworths.com.au/apis/ui/product/detail/${encodeURIComponent(stockcode)}`, {
    headers: { 'user-agent': UA, accept: 'application/json', cookie },
  });
  if (!res.ok) throw new Error(`Woolworths API HTTP ${res.status}`);
  const json = await res.json();
  const product = json.Product ?? json;
  const price = product.Price ?? product.InstorePrice;
  if (!Number.isFinite(price)) throw new Error('no price in Woolworths response (possibly unavailable)');
  return { price, name: product.Name };
}

function findOfferPrice(node) {
  if (!node || typeof node !== 'object') return null;
  if (Array.isArray(node)) {
    for (const n of node) {
      const p = findOfferPrice(n);
      if (p != null) return p;
    }
    return null;
  }
  if (node.offers) {
    const offers = Array.isArray(node.offers) ? node.offers : [node.offers];
    for (const o of offers) {
      const p = Number(o.price ?? o.lowPrice);
      if (Number.isFinite(p) && p > 0) return p;
    }
  }
  for (const v of Object.values(node)) {
    const p = findOfferPrice(v);
    if (p != null) return p;
  }
  return null;
}

async function pagePrice(url) {
  const res = await fetch(url, { headers: { 'user-agent': UA, accept: 'text/html' } });
  if (!res.ok) throw new Error(`page HTTP ${res.status}`);
  const html = await res.text();

  for (const m of html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      const p = findOfferPrice(JSON.parse(m[1]));
      if (p != null) return { price: p };
    } catch {
      /* ignore malformed JSON-LD */
    }
  }
  const meta =
    html.match(/<meta[^>]+(?:property|name)=["'](?:product:price:amount|og:price:amount)["'][^>]+content=["']([\d.]+)["']/i) ||
    html.match(/itemprop=["']price["'][^>]+content=["']([\d.]+)["']/i);
  if (meta) return { price: Number(meta[1]) };
  throw new Error('no price found on page');
}

async function lookup(product) {
  if (product.store === 'woolworths' && product.stockcode) {
    try {
      return await woolworthsPrice(product.stockcode);
    } catch (err) {
      if (!product.url) throw err;
    }
  }
  if (product.url) return pagePrice(product.url);
  return null;
}

async function main() {
  const catalogue = JSON.parse(await readFile(FILE, 'utf8'));
  let changed = 0;
  let checked = 0;
  const failures = [];

  for (const ing of Object.values(catalogue.ingredients)) {
    for (const product of ing.products) {
      if (!product.stockcode && !product.url) continue;
      try {
        const result = await lookup(product);
        if (!result) continue;
        checked++;
        const price = Math.round(result.price * 100) / 100;
        if (price !== product.price) {
          console.log(`${product.id}: ${product.price} -> ${price}`);
          product.price = price;
          changed++;
        }
        product.priceUpdated = today;
      } catch (err) {
        failures.push(`${product.id}: ${err.message}`);
      }
      await new Promise((r) => setTimeout(r, 750)); // be polite
    }
  }

  console.log(`Checked ${checked} product(s), ${changed} price change(s).`);
  if (failures.length) console.warn(`Failed lookups:\n  ${failures.join('\n  ')}`);

  if (!DRY_RUN && checked > 0) {
    await writeFile(FILE, JSON.stringify(catalogue, null, 2) + '\n');
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

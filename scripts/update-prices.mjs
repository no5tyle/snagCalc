#!/usr/bin/env node
// Refresh product prices in data/catalogue.json from Woolworths and Drakes.
//
// For each product:
//   - Woolworths products with a `stockcode` are looked up through the
//     Woolworths product API.
//   - Any product with a `url` (Woolworths or Drakes) falls back to reading
//     the price from the product page's structured data (JSON-LD / meta tags).
// Products without a stockcode or url are left alone. A failed lookup never
// removes a price; it keeps the old one and is reported. A product on special
// keeps its usual price as `regularPrice` (see price-rules.mjs).
//
// Woolworths blocks requests from GitHub's servers, so the scheduled run only
// refreshes Drakes. Run this from a home connection to refresh Woolworths.
// On GitHub the results are also written to the run's summary page.
//
// Usage: node scripts/update-prices.mjs [--dry-run]

import { readFile, writeFile, appendFile } from 'node:fs/promises';
import { recordPrice, daysSince, drakesSpecial } from './price-rules.mjs';

const FILE = new URL('../data/catalogue.json', import.meta.url);
const DRY_RUN = process.argv.includes('--dry-run');
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const today = new Date().toISOString().slice(0, 10);

const TIMEOUT_MS = 15000;
const get = (url, headers) => fetch(url, { headers, signal: AbortSignal.timeout(TIMEOUT_MS) });
// Prices this old are listed in the summary as worth checking by hand
const STALE_DAYS = 30;

let wooliesCookies = null;

async function woolworthsCookies() {
  if (wooliesCookies !== null) return wooliesCookies;
  try {
    const res = await get('https://www.woolworths.com.au/', { 'user-agent': UA });
    wooliesCookies = (res.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ');
  } catch {
    wooliesCookies = '';
  }
  return wooliesCookies;
}

async function woolworthsPrice(stockcode) {
  const cookie = await woolworthsCookies();
  const res = await get(`https://www.woolworths.com.au/apis/ui/product/detail/${encodeURIComponent(stockcode)}`, {
    'user-agent': UA,
    accept: 'application/json',
    cookie,
  });
  if (!res.ok) throw new Error(`Woolworths API HTTP ${res.status}`);
  const json = await res.json();
  const product = json.Product ?? json;
  const price = product.Price ?? product.InstorePrice;
  if (!Number.isFinite(price)) throw new Error('no price in Woolworths response (possibly unavailable)');
  const was = product.WasPrice;
  const special = Number.isFinite(was) && was > price;
  return { price, name: product.Name, special, ...(special ? { wasPrice: was } : {}) };
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
  const res = await get(url, { 'user-agent': UA, accept: 'text/html' });
  if (!res.ok) throw new Error(`page HTTP ${res.status}`);
  const html = await res.text();
  // Only Drakes pages say whether something is on special; elsewhere it's unknown
  const extra = (price) => {
    if (!/\bdrakes\.com\.au\//.test(url)) return {};
    const { special, saving } = drakesSpecial(html);
    return { special, ...(special && saving ? { wasPrice: price + saving } : {}) };
  };

  for (const m of html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      const p = findOfferPrice(JSON.parse(m[1]));
      if (p != null) return { price: p, ...extra(p) };
    } catch {
      /* ignore malformed JSON-LD */
    }
  }
  const meta =
    html.match(/<meta[^>]+(?:property|name)=["'](?:product:price:amount|og:price:amount)["'][^>]+content=["']([\d.]+)["']/i) ||
    html.match(/itemprop=["']price["'][^>]+content=["']([\d.]+)["']/i);
  if (meta) return { price: Number(meta[1]), ...extra(Number(meta[1])) };
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

const money = (n) => (n == null ? '?' : `$${Number(n).toFixed(2)}`);

async function main() {
  const catalogue = JSON.parse(await readFile(FILE, 'utf8'));
  const changes = [];
  const specials = [];
  const failures = [];
  const stale = [];
  let checked = 0;

  for (const ing of Object.values(catalogue.ingredients)) {
    for (const product of ing.products) {
      const store = catalogue.stores[product.store]?.name ?? product.store;
      if (product.stockcode || product.url) {
        try {
          const found = await lookup(product);
          if (found) {
            checked++;
            const { changed, special, from } = recordPrice(product, found, today);
            if (changed) changes.push(`${product.id}: ${money(from)} -> ${money(product.price)}`);
            if (special) specials.push(`${product.name} (${store}): ${money(product.price)}, usually ${money(product.regularPrice)}`);
          }
        } catch (err) {
          failures.push(`${product.id} (${store}): ${err.message}`);
        }
        await new Promise((r) => setTimeout(r, 750)); // be polite
      }
      const age = product.priceUpdated ? daysSince(product.priceUpdated, today) : null;
      if (age == null) stale.push(`${product.name} (${store}): estimate, never checked`);
      else if (age > STALE_DAYS) stale.push(`${product.name} (${store}): last checked ${product.priceUpdated}`);
    }
  }

  console.log(`Checked ${checked} product(s), ${changes.length} price change(s).`);
  for (const c of changes) console.log(`  ${c}`);
  if (specials.length) console.log(`On special:\n  ${specials.join('\n  ')}`);
  if (failures.length) console.warn(`Failed lookups:\n  ${failures.join('\n  ')}`);
  if (stale.length) console.warn(`Worth checking by hand:\n  ${stale.join('\n  ')}`);

  // On GitHub: the same on the run's summary page, and a warning on the run for anything that needs a person
  if (process.env.GITHUB_STEP_SUMMARY) {
    const section = (title, items) => (items.length ? `### ${title}\n${items.map((i) => `- ${i}`).join('\n')}\n\n` : '');
    await appendFile(
      process.env.GITHUB_STEP_SUMMARY,
      `## Price update ${today}\nChecked ${checked} product(s).\n\n` +
        section('Price changes', changes) +
        section('On special', specials) +
        section('Lookups that failed (old price kept)', failures) +
        section('Worth checking by hand', stale)
    );
    if (failures.length) console.log(`::warning title=Price update::${failures.length} lookup(s) failed and kept their old price. See the run summary.`);
    if (stale.length) console.log(`::warning title=Price update::${stale.length} price(s) are estimates or over ${STALE_DAYS} days old. See the run summary.`);
  }

  if (!DRY_RUN && checked > 0) {
    await writeFile(FILE, JSON.stringify(catalogue, null, 2) + '\n');
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

// Loading Woolworths prices through the user's own browser.
//
// Woolworths only answers its own pages: it refuses GitHub's servers, and a
// page on another site can't read its answers. So the prices are collected by
// a small script the user runs on woolworths.com.au (a bookmark, or pasted
// into the console), which then comes back here with them in the link, after
// `#ww=`. No DOM access in the functions the site calls, so they can be
// unit-tested; `collector` runs on the Woolworths page and is kept
// self-contained so it can be turned into text.

import { recordPrice } from './price-rules.js';

/** What a Woolworths product-detail response says: { price, name, special, wasPrice? }, or null with no price. */
export function parseWoolworthsProduct(json) {
  const product = json?.Product ?? json;
  const price = product?.Price ?? product?.InstorePrice;
  if (typeof price !== 'number' || !Number.isFinite(price) || price <= 0) return null;
  const was = product.WasPrice;
  const special = typeof was === 'number' && was > price;
  return { price, name: product.Name ?? product.DisplayName, special, ...(special ? { wasPrice: was } : {}) };
}

/** The stockcodes to ask Woolworths about, from its store file. */
export const stockcodesOf = (file) => [...new Set(Object.values(file?.products ?? {}).flat().map((p) => p.stockcode).filter(Boolean).map(String))];

/**
 * Runs on a woolworths.com.au page. Asks for each product, shows progress,
 * then goes back to Snag Calc with the answers in the link.
 * Self-contained: it's shipped as text (see collectorSource).
 */
export function collector(codes, back) {
  var fromLink = /[#&]snagcalc=([\d.]+)/.exec(location.hash);
  if (fromLink) codes = fromLink[1].split('.');
  if (!/(^|\.)woolworths\.com\.au$/.test(location.hostname)) {
    alert('Open woolworths.com.au first, then run this again from there.');
    return;
  }
  var box = document.createElement('div');
  box.setAttribute('style', 'position:fixed;z-index:2147483647;left:50%;top:24px;transform:translateX(-50%);padding:14px 20px;border-radius:14px;background:#052767;color:#fff;font:600 16px system-ui,sans-serif;box-shadow:0 8px 30px rgba(0,0,0,.35)');
  box.textContent = 'Snag Calc: reading prices…';
  document.body.appendChild(box);
  var out = {};
  var i = 0;
  function next() {
    if (i >= codes.length) {
      var json = JSON.stringify({ v: 1, p: out });
      var b64 = btoa(unescape(encodeURIComponent(json))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
      box.textContent = 'Snag Calc: done, going back…';
      location.href = back + '#ww=' + b64;
      return;
    }
    var code = codes[i++];
    box.textContent = 'Snag Calc: reading price ' + i + ' of ' + codes.length + '…';
    fetch('/apis/ui/product/detail/' + encodeURIComponent(code), { headers: { accept: 'application/json' }, credentials: 'include' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (j) {
        var p = (j && (j.Product || j)) || {};
        var price = typeof p.Price === 'number' ? p.Price : p.InstorePrice;
        out[code] = typeof price === 'number' && price > 0 ? [price, typeof p.WasPrice === 'number' ? p.WasPrice : 0, String(p.Name || p.DisplayName || '').slice(0, 80)] : 0;
      })
      .catch(function () { out[code] = 0; })
      .then(function () { setTimeout(next, 200); });
  }
  next();
}

/** The collector as a line of JavaScript: `javascript:` for a bookmark, or to paste into the console. */
export const collectorSource = (codes, back) => `(${collector.toString()})(${JSON.stringify(codes)},${JSON.stringify(back)});`;
export const bookmarklet = (codes, back) => `javascript:${encodeURIComponent(collectorSource(codes, back))}`;

/** The Woolworths page to run it on, carrying the current list of stockcodes. */
export const woolworthsUrl = (codes) => `https://www.woolworths.com.au/#snagcalc=${codes.join('.')}`;

/** The answers in a link's hash (`#ww=…`): { [stockcode]: { price, wasPrice, name } | null }, or null if it isn't one. */
export function pricesInHash(hash) {
  const code = /^#?ww=([\w-]+)$/.exec(hash || '')?.[1];
  if (!code) return null;
  try {
    const bytes = Uint8Array.from(atob(code.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
    const data = JSON.parse(new TextDecoder().decode(bytes));
    if (data?.v !== 1 || !data.p || typeof data.p !== 'object') return null;
    const out = {};
    for (const [stockcode, v] of Object.entries(data.p)) {
      if (!/^\d{1,12}$/.test(stockcode)) continue;
      const ok = Array.isArray(v) && typeof v[0] === 'number' && Number.isFinite(v[0]) && v[0] > 0 && v[0] < 10000;
      out[stockcode] = ok ? { price: v[0], wasPrice: typeof v[1] === 'number' && v[1] > v[0] ? v[1] : null, name: String(v[2] ?? '').slice(0, 80) } : null;
    }
    return out;
  } catch {
    return null;
  }
}

/**
 * Record collected prices on a copy of the Woolworths store file.
 * @returns {{ file, loaded: number, changes: Array, specials: Array, failures: Array }}
 *   changes: { id, name, from, to }; specials: { id, name, price, regularPrice };
 *   failures: { id, name, reason } for products Woolworths gave no price for,
 *   or whose answer was for a different product (the old price is kept).
 */
export function applyWoolworthsPrices(file, prices, today) {
  const next = structuredClone(file);
  const result = { file: next, loaded: 0, changes: [], specials: [], failures: [] };
  for (const product of Object.values(next.products).flat()) {
    if (!product.stockcode || !(String(product.stockcode) in prices)) continue;
    const found = prices[String(product.stockcode)];
    try {
      if (!found) throw new Error('Woolworths gave no price (it may be unavailable)');
      const wasGuess = !product.priceUpdated;
      const { changed, special, from } = recordPrice(product, { price: found.price, name: found.name || undefined, special: found.wasPrice != null, wasPrice: found.wasPrice ?? undefined }, today);
      result.loaded++;
      if (changed || wasGuess) result.changes.push({ id: product.id, name: product.name, from, to: product.price, wasGuess });
      if (special) result.specials.push({ id: product.id, name: product.name, price: product.price, regularPrice: product.regularPrice });
    } catch (err) {
      result.failures.push({ id: product.id, name: product.name, reason: err.message });
    }
  }
  return result;
}

/**
 * The prices that differ between a store file and a newer copy of it, small
 * enough to keep in the browser: { [productId]: { price, regularPrice, priceUpdated } }.
 */
export function pricePatch(file, newer) {
  const before = new Map(Object.values(file.products).flat().map((p) => [p.id, p]));
  const patch = {};
  for (const p of Object.values(newer.products).flat()) {
    const old = before.get(p.id);
    if (!old || old.price !== p.price || old.priceUpdated !== p.priceUpdated || (old.regularPrice ?? null) !== (p.regularPrice ?? null)) {
      patch[p.id] = { price: p.price, regularPrice: p.regularPrice ?? null, priceUpdated: p.priceUpdated };
    }
  }
  return patch;
}

/** A store file with a saved patch applied, where the patch is newer than what the file has. */
export function withPricePatch(file, patch) {
  if (!patch || !Object.keys(patch).length) return file;
  const next = structuredClone(file);
  for (const p of Object.values(next.products).flat()) {
    const mine = patch[p.id];
    if (!mine || typeof mine.price !== 'number' || !/^\d{4}-\d{2}-\d{2}$/.test(mine.priceUpdated ?? '') || mine.priceUpdated <= (p.priceUpdated ?? '')) continue;
    p.price = mine.price;
    p.priceUpdated = mine.priceUpdated;
    if (typeof mine.regularPrice === 'number' && mine.regularPrice > mine.price) p.regularPrice = mine.regularPrice;
    else delete p.regularPrice;
  }
  return next;
}

/** A store file as the text every tool writes, so an upload only differs where prices do. */
export const storeFileText = (file) => `${JSON.stringify(file, null, 2)}\n`;

#!/usr/bin/env node
// Record prices someone has checked in store on the shared price list.
//
// Usage: node scripts/set-prices.mjs ww-eggs-12=6.20 ww-bacon-1kg=13
//    or: node scripts/set-prices.mjs < prices.txt
//
// Each price is `product-id=price`. Anything after the price on a line is
// ignored, so the text from "Copy my prices" on the site can be pasted in as
// it is. Sets the price, marks it checked today and clears any special.

import { readFile, writeFile } from 'node:fs/promises';

const FILE = new URL('../data/catalogue.json', import.meta.url);
const today = new Date().toISOString().slice(0, 10);

/** `id=price` pairs from lines or arguments; other text is skipped. */
export function parsePrices(text) {
  const out = {};
  for (const m of String(text).matchAll(/(?:^|\s)([a-z0-9][\w.-]*)=\$?(\d+(?:\.\d+)?)(?=\s|$)/gim)) out[m[1]] = Number(m[2]);
  return out;
}

async function main() {
  const args = process.argv.slice(2);
  const text = args.length ? args.join('\n') : await readFile(0, 'utf8');
  const prices = parsePrices(text);
  if (!Object.keys(prices).length) {
    console.error('No prices given. Usage: node scripts/set-prices.mjs product-id=price ...');
    process.exit(1);
  }
  const catalogue = JSON.parse(await readFile(FILE, 'utf8'));
  const products = new Map(Object.values(catalogue.ingredients).flatMap((i) => i.products.map((p) => [p.id, p])));
  let unknown = 0;
  for (const [id, price] of Object.entries(prices)) {
    const p = products.get(id);
    if (!p) {
      console.warn(`Unknown product: ${id}`);
      unknown++;
      continue;
    }
    console.log(`${id}: ${p.price} -> ${price}`);
    p.price = Math.round(price * 100) / 100;
    p.priceUpdated = today;
    delete p.regularPrice;
  }
  await writeFile(FILE, JSON.stringify(catalogue, null, 2) + '\n');
  if (unknown) process.exit(1);
}

if (import.meta.url === new URL(process.argv[1], 'file://').href) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

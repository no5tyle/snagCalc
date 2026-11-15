#!/usr/bin/env node
// Record prices someone has checked in store on the shared price list.
//
// Usage: node scripts/set-prices.mjs ww-eggs-12=6.20 ww-bacon-1kg=13
//    or: node scripts/set-prices.mjs < prices.txt
//
// Each price is `product-id=price`. Anything after the price on a line is
// ignored, so the text from "Copy my prices" on the site can be pasted in as
// it is. Sets the price, marks it checked today and clears any special.

import { readFile } from 'node:fs/promises';
import { storeIds, readStoreFile, writeStoreFile } from './catalogue-files.mjs';

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
  const files = storeIds().map((store) => ({ store, file: readStoreFile(store), touched: false }));
  let unknown = 0;
  for (const [id, price] of Object.entries(prices)) {
    const home = files.find((f) => Object.values(f.file.products).flat().some((p) => p.id === id));
    if (!home) {
      console.warn(`Unknown product: ${id}`);
      unknown++;
      continue;
    }
    const p = Object.values(home.file.products).flat().find((x) => x.id === id);
    console.log(`${id}: ${p.price} -> ${price}`);
    p.price = Math.round(price * 100) / 100;
    p.priceUpdated = today;
    delete p.regularPrice;
    home.touched = true;
  }
  for (const f of files) if (f.touched) writeStoreFile(f.store, f.file);
  if (unknown) process.exit(1);
}

if (import.meta.url === new URL(process.argv[1], 'file://').href) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

// Reading and writing the price list files from Node (scripts and tests).
//
// data/catalogue.json   what's sold: ingredients and menus, and where each store's file is
// data/woolworths.json  Woolworths products and prices
// data/drakes.json      Drakes products and prices

import { readFileSync, writeFileSync } from 'node:fs';
import { assembleCatalogue } from '../assets/calc.js';

const ROOT = new URL('../', import.meta.url);
const read = (file) => JSON.parse(readFileSync(new URL(file, ROOT), 'utf8'));

export const readBase = () => read('data/catalogue.json');
export const storeIds = () => Object.keys(readBase().stores);
export const readStoreFile = (store) => read(readBase().stores[store].file);

/** A store file as text, the way every tool here writes it, so files only differ where prices do. */
export const storeFileText = (file) => `${JSON.stringify(file, null, 2)}\n`;
export const writeStoreFile = (store, file) => writeFileSync(new URL(readBase().stores[store].file, ROOT), storeFileText(file));

/** The whole price list as the site sees it: the base file with every store's products attached. */
export function loadCatalogue() {
  const base = readBase();
  return assembleCatalogue(base, Object.keys(base.stores).map((s) => read(base.stores[s].file)));
}

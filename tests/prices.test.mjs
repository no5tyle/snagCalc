import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { namesMatch, recordPrice, drakesSpecial, daysSince } from '../scripts/price-rules.mjs';
import { parsePrices } from '../scripts/set-prices.mjs';
import { calculate, combineResults, withPackSizes, priceStatus, priceNotes, onSpecial, pricedProducts } from '../assets/calc.js';

const catalogue = JSON.parse(readFileSync(new URL('../data/catalogue.json', import.meta.url)));

test('namesMatch accepts the same product under a longer name and refuses another product', () => {
  assert.ok(namesMatch('Pepsi 24 pack', 'Pepsi Cola Soft Drink Cans Multipack 375mL x 24 pack'));
  assert.ok(namesMatch('Coke No Sugar 24 pack', 'Coca-Cola Zero Sugar Soft Drink Cans 375mL x 24 pack'));
  assert.ok(namesMatch('Masterfoods Mild American Mustard 550g', 'MasterFoods Mild American Mustard 550g'));
  assert.ok(!namesMatch('Fountain Tomato Sauce 500ml', 'Huggies Nappies Size 4 Jumbo'));
  assert.ok(namesMatch('Brown onions 2kg bag', undefined), 'no name to compare is not a mismatch');
});

test('every Woolworths stockcode is on a product whose price can be refreshed', () => {
  const coded = Object.values(catalogue.ingredients).flatMap((i) => i.products).filter((p) => p.stockcode);
  assert.ok(coded.length >= 10);
  for (const p of coded) assert.equal(p.store, 'woolworths', p.id);
});

test('recordPrice: a special keeps the usual price, and clears when it ends', () => {
  const p = { name: 'Sausages 21 pack', price: 11, priceUpdated: '2026-11-01' };
  let r = recordPrice(p, { price: 9.5, special: true, wasPrice: 11 }, '2026-11-15');
  assert.deepEqual([p.price, p.regularPrice, p.priceUpdated], [9.5, 11, '2026-11-15']);
  assert.deepEqual(r, { changed: true, special: true, from: 11 });
  // Same again next week: nothing changed, still checked
  r = recordPrice(p, { price: 9.5, special: true, wasPrice: 11 }, '2026-11-22');
  assert.equal(r.changed, false);
  assert.equal(p.priceUpdated, '2026-11-22');
  // Special over
  r = recordPrice(p, { price: 11, special: false }, '2026-11-29');
  assert.deepEqual([p.price, 'regularPrice' in p, r.changed, r.special], [11, false, true, false]);
});

test('recordPrice: a special with no saving shown falls back to the price before it', () => {
  const p = { name: 'Thing', price: 5 };
  recordPrice(p, { price: 4, special: true }, '2026-11-15');
  assert.deepEqual([p.price, p.regularPrice], [4, 5]);
  // A store that can't say either way leaves the usual price until the price is back up
  recordPrice(p, { price: 4.5 }, '2026-11-22');
  assert.equal(p.regularPrice, 5);
  recordPrice(p, { price: 5.2 }, '2026-11-29');
  assert.ok(!('regularPrice' in p));
});

test('recordPrice refuses a different product or a missing price, leaving the old one', () => {
  const p = { name: 'Fountain Tomato Sauce 500ml', price: 2.2, priceUpdated: '2026-11-07' };
  assert.throws(() => recordPrice(p, { price: 30, name: 'Huggies Nappies' }, '2026-11-15'), /different product/);
  assert.throws(() => recordPrice(p, { price: NaN }, '2026-11-15'), /no usable price/);
  assert.deepEqual(p, { name: 'Fountain Tomato Sauce 500ml', price: 2.2, priceUpdated: '2026-11-07' });
});

test('drakesSpecial reads the saving off the page sticker', () => {
  const html = `<div class="talker__stickers"><span class="talker__sticker talker__sticker--topright talker__sticker--Saving talker__sticker--Special talker__sticker--Discount">
    <span class="talker__sticker__label"> <span class="weak"> save </span> <br> $1.50 </span> </span> </div>`;
  assert.deepEqual(drakesSpecial(html), { special: true, saving: 1.5 });
  assert.deepEqual(drakesSpecial('<div class="talker__stickers"></div>'), { special: false, saving: null });
});

test('daysSince counts whole days', () => {
  assert.equal(daysSince('2026-11-07', '2026-11-15'), 8);
  assert.equal(daysSince('nope', '2026-11-15'), null);
});

test('parsePrices reads id=price pairs and skips the rest', () => {
  const text = 'Snag Calc prices checked 2026-11-15\nww-eggs-12=6.20  Cage-free eggs 12 pack 700g (Woolworths)\nww-bacon-1kg=$13 Bacon\nnot a price\n';
  assert.deepEqual(parsePrices(text), { 'ww-eggs-12': 6.2, 'ww-bacon-1kg': 13 });
  assert.deepEqual(parsePrices('dk-bread-white=3'), { 'dk-bread-white': 3 });
});

test('priceStatus: own, estimate, stale or checked', () => {
  const today = '2026-12-20';
  assert.equal(priceStatus({ priceUpdated: '2026-12-01' }, today), 'checked');
  assert.equal(priceStatus({ priceUpdated: '2026-11-07' }, today), 'stale');
  assert.equal(priceStatus({ priceUpdated: null }, today), 'estimate');
  assert.equal(priceStatus({ priceUpdated: null, overridden: true }, today), 'own');
  assert.equal(priceStatus({ priceUpdated: null, custom: true }, today), 'own');
});

test('priceNotes counts specials, what they save, and prices worth checking', () => {
  const cat = {
    stores: { a: { name: 'A' } },
    ingredients: {
      snags: { name: 'Snags', unit: 'snags', products: [{ id: 's', store: 'a', packSize: 10, price: 9, regularPrice: 11, priceUpdated: '2026-11-14' }] },
      bread: { name: 'Bread', unit: 'slices', products: [{ id: 'b', store: 'a', packSize: 20, price: 3, priceUpdated: null }] },
      onions: { name: 'Onions', unit: 'g', products: [{ id: 'o', store: 'a', packSize: 1000, price: 3, priceUpdated: '2026-09-01' }] },
    },
    menu: { m: { recipe: [{ ingredient: 'snags', perServe: 1, enabled: true }, { ingredient: 'bread', perServe: 1, enabled: true }, { ingredient: 'onions', perServe: 10, enabled: true }] } },
  };
  const r = calculate({ catalogue: cat, menuId: 'm', serves: 100, store: 'a' });
  assert.deepEqual(priceNotes(r, '2026-11-15'), { estimates: 1, stale: 1, specials: 1, specialSaving: 20 });
  // The user's own price is neither a special nor an estimate
  const own = calculate({ catalogue: cat, menuId: 'm', serves: 100, store: 'a', priceOverrides: { s: 9, b: 3 } });
  assert.deepEqual(priceNotes(own, '2026-11-15'), { estimates: 0, stale: 1, specials: 0, specialSaving: 0 });
  assert.ok(!onSpecial(pricedProducts(cat.ingredients.snags.products, { s: 9 })[0]));
});

test('withPackSizes: your own slices per loaf changes the loaves bought and counted', () => {
  const cat = withPackSizes(catalogue, { 'ww-bread-white': 15, 'ww-pepsi-24': 0, nope: 3 });
  assert.equal(catalogue.ingredients.bread.products.find((p) => p.id === 'ww-bread-white').packSize, 20, 'original untouched');
  const bread = cat.ingredients.bread;
  assert.equal(bread.products.find((p) => p.id === 'ww-bread-white').packSize, 15);
  assert.equal(bread.products.find((p) => p.id === 'dk-bread-white').packSize, 20);
  assert.equal(bread.stockUnit.size, 15); // a loaf left over is 15 slices too
  assert.equal(cat.ingredients.pepsi.products[0].packSize, 24);
  const r = calculate({ catalogue: cat, menuId: 'sausage-sizzle', serves: 200, store: 'woolworths' });
  assert.equal(r.lines.find((l) => l.id === 'bread').purchase.packs[0].count, 14);
  assert.equal(withPackSizes(catalogue, {}), catalogue);
});

test('products with an approximate pack count are the bread and the bacon', () => {
  const approx = Object.entries(catalogue.ingredients).filter(([, i]) => i.products.some((p) => p.packApprox)).map(([id]) => id);
  assert.deepEqual(approx, ['bread', 'bacon']);
});

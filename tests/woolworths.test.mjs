import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readStoreFile, storeFileText as nodeStoreFileText } from '../scripts/catalogue-files.mjs';
import {
  parseWoolworthsProduct,
  stockcodesOf,
  collector,
  collectorSource,
  bookmarklet,
  woolworthsUrl,
  pricesInHash,
  applyWoolworthsPrices,
  pricePatch,
  withPricePatch,
  storeFileText,
} from '../assets/woolworths.js';

const file = {
  store: 'woolworths',
  name: 'Woolworths',
  products: {
    pepsi: [
      { id: 'ww-pepsi-24', name: 'Pepsi 24 pack', packSize: 24, price: 23, stockcode: '14310', priceUpdated: '2026-11-07' },
      { id: 'ww-pepsi-30', name: 'Pepsi Cola Cans 375mL x 30 pack', packSize: 30, price: 29.5, stockcode: '773147', priceUpdated: null },
    ],
    sauce: [{ id: 'ww-sauce', name: 'Fountain Tomato Sauce 500ml', packSize: 500, price: 2.2, stockcode: '306969', priceUpdated: '2026-11-07' }],
    oil: [{ id: 'ww-oil', name: 'Oil 750ml', packSize: 1, price: 4, stockcode: null, priceUpdated: '2026-11-07' }],
  },
};

const toHash = (data) => `#ww=${Buffer.from(JSON.stringify(data)).toString('base64url')}`;

test('parseWoolworthsProduct reads the price, name and any special', () => {
  assert.deepEqual(parseWoolworthsProduct({ Product: { Price: 23.7, WasPrice: 39.5, Name: 'Pepsi Max' } }), { price: 23.7, name: 'Pepsi Max', special: true, wasPrice: 39.5 });
  assert.deepEqual(parseWoolworthsProduct({ Product: { Price: 2.2, WasPrice: 2.2, Name: 'Sauce' } }), { price: 2.2, name: 'Sauce', special: false });
  assert.deepEqual(parseWoolworthsProduct({ Price: null, InstorePrice: 5, DisplayName: 'In store only' }), { price: 5, name: 'In store only', special: false });
  assert.equal(parseWoolworthsProduct({ Product: { Price: null } }), null);
  assert.equal(parseWoolworthsProduct(null), null);
});

test('stockcodesOf lists each code once, skipping products without one', () => {
  assert.deepEqual(stockcodesOf(file), ['14310', '773147', '306969']);
  assert.ok(stockcodesOf(readStoreFile('woolworths')).length >= 30);
});

test('the collector runs on a Woolworths page and comes back with the prices in the link', async () => {
  const answers = {
    14310: { Product: { Price: 23.7, WasPrice: 39.5, Name: 'Pepsi Cola Soft Drink Cans Multipack 375mL x 24 pack' } },
    773147: { Product: { Price: null, Name: 'Pepsi 30' } },
  };
  const page = { hostname: 'www.woolworths.com.au', hash: '', href: '' };
  const asked = [];
  const saved = { location: globalThis.location, document: globalThis.document, fetch: globalThis.fetch, setTimeout: globalThis.setTimeout };
  Object.assign(globalThis, {
    location: page,
    document: { createElement: () => ({ setAttribute() {}, textContent: '' }), body: { appendChild() {} } },
    fetch: async (url) => {
      const code = url.split('/').pop();
      asked.push(url);
      if (!answers[code]) return { ok: false };
      return { ok: true, json: async () => answers[code] };
    },
    setTimeout: (fn) => saved.setTimeout(fn, 0),
  });
  try {
    // As shipped: turned into text and run
    (0, eval)(collectorSource(['14310', '773147', '306969'], 'https://example.test/snagCalc/'));
    await new Promise((resolve) => {
      const wait = () => (page.href ? resolve() : saved.setTimeout(wait, 5));
      wait();
    });
  } finally {
    Object.assign(globalThis, saved);
  }
  assert.deepEqual(asked, ['/apis/ui/product/detail/14310', '/apis/ui/product/detail/773147', '/apis/ui/product/detail/306969']);
  assert.match(page.href, /^https:\/\/example\.test\/snagCalc\/#ww=[\w-]+$/);
  assert.deepEqual(pricesInHash(page.href.slice(page.href.indexOf('#'))), {
    14310: { price: 23.7, wasPrice: 39.5, name: 'Pepsi Cola Soft Drink Cans Multipack 375mL x 24 pack' },
    773147: null,
    306969: null,
  });
});

test('the collector refuses to run anywhere but Woolworths, and takes its codes from the link when given', () => {
  const saved = { location: globalThis.location, alert: globalThis.alert };
  let said = '';
  Object.assign(globalThis, { location: { hostname: 'no5tyle.github.io', hash: '' }, alert: (m) => (said = m) });
  try {
    collector(['1'], 'https://example.test/');
  } finally {
    Object.assign(globalThis, saved);
  }
  assert.match(said, /woolworths\.com\.au/);
  assert.equal(woolworthsUrl(['14310', '773147']), 'https://www.woolworths.com.au/#snagcalc=14310.773147');
  assert.match(bookmarklet(['1'], 'https://example.test/'), /^javascript:/);
  assert.ok(!/[\s"<>]/.test(bookmarklet(['1'], 'https://example.test/')), 'safe to put in a link');
});

test('pricesInHash drops anything that is not a sensible price', () => {
  assert.deepEqual(pricesInHash(toHash({ v: 1, p: { 14310: [23, 0, 'Pepsi'], 2: ['<b>', 0, 'x'], 3: [-1, 0, 'x'], 4: [99999, 0, 'x'], 'not-a-code': [1, 0, 'x'], 5: 0 } })), {
    14310: { price: 23, wasPrice: null, name: 'Pepsi' },
    2: null,
    3: null,
    4: null,
    5: null,
  });
  assert.equal(pricesInHash('#ww=notbase64!!'), null);
  assert.equal(pricesInHash(toHash({ v: 2, p: {} })), null);
  assert.equal(pricesInHash('#plan=abc'), null);
});

test('applyWoolworthsPrices records what came back and keeps the rest', () => {
  const prices = {
    14310: { price: 23.7, wasPrice: 39.5, name: 'Pepsi Cola Soft Drink Cans Multipack 375mL x 24 pack' },
    773147: { price: 29.5, wasPrice: null, name: 'Pepsi Cola Soft Drink Cans Multipack 375mL x 30 pack' },
    306969: { price: 30, wasPrice: null, name: 'Huggies Nappies Size 4' },
  };
  const r = applyWoolworthsPrices(file, prices, '2026-11-20');
  assert.equal(file.products.pepsi[0].price, 23, 'the original is untouched');
  assert.equal(r.loaded, 2);
  const [p24, p30] = r.file.products.pepsi;
  assert.deepEqual([p24.price, p24.regularPrice, p24.priceUpdated], [23.7, 39.5, '2026-11-20']);
  // The estimate turned out right: same price, but it's now checked, and reported
  assert.deepEqual([p30.price, p30.priceUpdated], [29.5, '2026-11-20']);
  assert.deepEqual(r.changes.map((c) => [c.id, c.from, c.to, c.wasGuess]), [['ww-pepsi-24', 23, 23.7, false], ['ww-pepsi-30', 29.5, 29.5, true]]);
  assert.deepEqual(r.specials.map((c) => c.id), ['ww-pepsi-24']);
  // A different product under that code is refused, and a product with no code is left alone
  assert.deepEqual(r.failures.map((c) => c.id), ['ww-sauce']);
  assert.deepEqual(r.file.products.sauce, file.products.sauce);
  assert.deepEqual(r.file.products.oil, file.products.oil);
  // Woolworths had no price for it
  const none = applyWoolworthsPrices(file, { 14310: null }, '2026-11-20');
  assert.deepEqual([none.loaded, none.failures.length, none.file.products.pepsi[0].price], [0, 1, 23]);
});

test('a saved patch brings loaded prices back until the published file catches up', () => {
  const { file: newer } = applyWoolworthsPrices(file, { 14310: { price: 23.7, wasPrice: 39.5, name: '' }, 773147: { price: 31, wasPrice: null, name: '' } }, '2026-11-20');
  const patch = pricePatch(file, newer);
  assert.deepEqual(Object.keys(patch), ['ww-pepsi-24', 'ww-pepsi-30']);
  assert.deepEqual(withPricePatch(file, patch), newer);
  assert.equal(withPricePatch(file, {}), file);
  // Once the published file is as new or newer, it wins
  const published = structuredClone(file);
  published.products.pepsi[0] = { ...published.products.pepsi[0], price: 25, priceUpdated: '2026-11-27' };
  assert.equal(withPricePatch(published, patch).products.pepsi[0].price, 25);
  // Nonsense in storage is ignored
  assert.deepEqual(withPricePatch(file, { 'ww-pepsi-24': { price: '<b>', priceUpdated: '2026-12-01' }, 'ww-sauce': { price: 1, priceUpdated: 'soon' } }), file);
});

test('the exported file is written exactly as the repo files are, so a clean reload exports no changes', () => {
  const published = readStoreFile('woolworths');
  assert.equal(storeFileText(published), nodeStoreFileText(published));
  assert.equal(storeFileText(withPricePatch(published, pricePatch(published, published))), nodeStoreFileText(published));
});

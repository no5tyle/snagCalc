import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { cheapestPacks, calculate, calculateRestock, calculateItems, wizardProducts, applyWizardPrices } from '../assets/calc.js';

const catalogue = JSON.parse(readFileSync(new URL('../data/catalogue.json', import.meta.url)));

test('cheapestPacks covers the requirement at minimum cost', () => {
  const products = [
    { id: 'small', packSize: 15, price: 8 },
    { id: 'big', packSize: 30, price: 14 },
  ];
  const r = cheapestPacks(100, products);
  assert.ok(r.units >= 100);
  // 3 big (90) + 1 small (15) = $50; 4 big = $56; 7 small = $56
  assert.equal(r.cost, 50);
});

test('cheapestPacks returns nothing when nothing is needed', () => {
  const r = cheapestPacks(0, [{ packSize: 10, price: 1 }]);
  assert.deepEqual(r.packs, []);
  assert.equal(r.cost, 0);
});

test('cheapestPacks flags missing products', () => {
  const r = cheapestPacks(5, []);
  assert.equal(r.unavailable, true);
  assert.equal(r.cost, null);
});

test('cheapestPacks handles unpriced products by minimising packs', () => {
  const r = cheapestPacks(45, [{ packSize: 15, price: null }, { packSize: 30, price: null }]);
  assert.equal(r.cost, null);
  assert.equal(r.packs.reduce((s, p) => s + p.count, 0), 2);
});

test('calculate: 200 sausages needs 200 slices of bread (10 loaves)', () => {
  const r = calculate({ catalogue, menuId: 'sausage-sizzle', serves: 200, store: 'cheapest' });
  const bread = r.lines.find((l) => l.id === 'bread');
  assert.equal(bread.needed, 200);
  assert.equal(bread.purchase.units, 200);
  const sausages = r.lines.find((l) => l.id === 'sausages');
  assert.ok(sausages.purchase.units >= 200);
  assert.ok(r.totalCost > 0);
});

test('calculate applies buffer and recipe overrides', () => {
  const r = calculate({
    catalogue,
    menuId: 'sausage-sizzle',
    serves: 100,
    bufferPct: 10,
    store: 'drakes',
    recipeOverrides: { bread: { perServe: 2 }, mustard: { enabled: true } },
  });
  assert.equal(r.lines.find((l) => l.id === 'bread').needed, 220);
  assert.ok(r.lines.some((l) => l.id === 'mustard'));
  assert.ok(r.lines.every((l) => l.purchase.store === 'drakes'));
});

test('sausages come from Slapes 1.5kg packs of 21 at Drakes', () => {
  const r = calculate({ catalogue, menuId: 'sausage-sizzle', serves: 200, store: 'cheapest' });
  const s = r.lines.find((l) => l.id === 'sausages');
  assert.equal(s.purchase.store, 'drakes');
  assert.equal(s.purchase.units, 210); // 10 packs of 21
  assert.equal(s.purchase.cost, 110);
});

test('cheapest mode picks one store per ingredient', () => {
  const r = calculate({ catalogue, menuId: 'sausage-sizzle', serves: 50, store: 'cheapest' });
  for (const l of r.lines) {
    const stores = new Set(l.purchase.packs.map((p) => p.product.store));
    assert.ok(stores.size <= 1);
  }
});

test('price overrides are used', () => {
  const r = calculate({
    catalogue,
    menuId: 'sausage-sizzle',
    serves: 20,
    store: 'woolworths',
    priceOverrides: { 'ww-bread-white': 10 },
  });
  assert.equal(r.lines.find((l) => l.id === 'bread').purchase.cost, 10);
});

test('restock subtracts sales and stock on hand', () => {
  const r = calculateRestock({
    catalogue,
    menuId: 'sausage-sizzle',
    totalDesired: 400,
    sold: 180,
    stock: { sausages: 40, bread: 60 },
    store: 'cheapest',
  });
  assert.equal(r.remainingServes, 220);
  const s = r.lines.find((l) => l.id === 'sausages');
  assert.equal(s.shortfall, 180);
  assert.ok(s.purchase.units >= 180);
  const b = r.lines.find((l) => l.id === 'bread');
  assert.equal(b.shortfall, 160);
});

test('restock buys nothing when stock already covers the remainder', () => {
  const r = calculateRestock({
    catalogue,
    menuId: 'sausage-sizzle',
    totalDesired: 100,
    sold: 90,
    stock: { sausages: 50, bread: 50, onions: 5000, 'tomato-sauce': 5000, 'bbq-sauce': 5000, oil: 1000, napkins: 100, mustard: 2000 },
  });
  assert.equal(r.totalCost, 0);
  assert.ok(r.lines.every((l) => l.purchase.packs.length === 0));
});

test('restock never goes negative when sales exceed target', () => {
  const r = calculateRestock({ catalogue, menuId: 'sausage-sizzle', totalDesired: 100, sold: 150 });
  assert.equal(r.remainingServes, 0);
  assert.equal(r.totalCost, 0);
});

test('items: drinks use their own quantities and sale prices', () => {
  const r = calculateItems({ catalogue, menuId: 'drinks', store: 'cheapest', itemOverrides: { pepsi: { quantity: 30, salePrice: 2.5 } } });
  const pepsi = r.lines.find((l) => l.id === 'pepsi');
  assert.equal(pepsi.needed, 30);
  assert.equal(pepsi.purchase.units, 48); // two 24 packs
  assert.equal(pepsi.purchase.cost, 46);
  const others = r.lines.filter((l) => l.id !== 'pepsi').reduce((s, l) => s + l.needed * l.salePrice, 0);
  assert.equal(r.revenue, 30 * 2.5 + others);
});

test('items: restock subtracts sold/used and stock left over', () => {
  const r = calculateItems({ catalogue, menuId: 'consumables', sold: { napkins: 400 }, stock: { napkins: 300 } });
  const n = r.lines.find((l) => l.id === 'napkins');
  assert.equal(n.needed, 600);
  assert.equal(n.shortfall, 300);
  assert.equal(n.purchase.units, 300);
});

test('items: disabled items are left out', () => {
  const r = calculateItems({ catalogue, menuId: 'consumables', itemOverrides: { gloves: { enabled: false } } });
  assert.ok(!r.lines.some((l) => l.id === 'gloves'));
});

test('egg and bacon: 2 slices of bread and 2 rashers per sandwich', () => {
  const r = calculate({ catalogue, menuId: 'egg-bacon', serves: 50, store: 'cheapest' });
  assert.equal(r.lines.find((l) => l.id === 'bread').needed, 100);
  assert.equal(r.lines.find((l) => l.id === 'bacon').needed, 100);
  assert.equal(r.lines.find((l) => l.id === 'eggs').needed, 50);
});

test('every menu references known ingredients with products', () => {
  for (const [id, menu] of Object.entries(catalogue.menu)) {
    for (const r of menu.recipe) {
      const ing = catalogue.ingredients[r.ingredient];
      assert.ok(ing, `${id}: ${r.ingredient} exists`);
      assert.ok(ing.products.length, `${id}: ${r.ingredient} has products`);
    }
  }
});

test('wizardProducts lists each product once with the menus using it', () => {
  const all = wizardProducts(catalogue);
  const ids = all.map((e) => e.product.id);
  assert.equal(new Set(ids).size, ids.length);
  const bread = all.find((e) => e.product.id === 'ww-bread-white');
  assert.deepEqual(bread.menus, ['sausage-sizzle', 'egg-bacon']);
  const drinksOnly = wizardProducts(catalogue, ['drinks']);
  assert.ok(drinksOnly.every((e) => e.menus.includes('drinks')));
  assert.ok(!drinksOnly.some((e) => e.product.id === 'ww-bread-white'));
});

test('applyWizardPrices sets changed prices and clears unchanged ones', () => {
  const out = applyWizardPrices(catalogue, { 'ww-bread-white': 3, 'ww-pepsi-24': 20 }, {
    'ww-bread-white': 2.8, // same as listed: override removed
    'dk-slapes-bbq-1.5kg': 10.5,
    'ww-eggs-12': null, // blank: use listed
    'not-a-product': 5,
  });
  assert.deepEqual(out, { 'ww-pepsi-24': 20, 'dk-slapes-bbq-1.5kg': 10.5 });
});

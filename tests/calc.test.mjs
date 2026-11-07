import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { cheapestPacks, calculate, calculateRestock, calculateItems, wizardProducts, applyWizardPrices, round2, withCustomItems, expectedDay2, recipeUsage, itemsUsage, leftoverEstimate } from '../assets/calc.js';

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
    recipeOverrides: { bread: { perServe: 2 }, onions: { enabled: false } },
  });
  assert.equal(r.lines.find((l) => l.id === 'bread').needed, 220);
  assert.ok(!r.lines.some((l) => l.id === 'onions'));
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

test('day 2 restock: 400 bought, 300 sold, half the sales expected means 50 more', () => {
  const r = calculateRestock({
    catalogue,
    menuId: 'sausage-sizzle',
    sold: 300,
    day2Pct: 50,
    stock: { sausages: 100, bread: 40 },
    store: 'cheapest',
  });
  assert.equal(r.expectedServes, 150);
  const s = r.lines.find((l) => l.id === 'sausages');
  assert.equal(s.needed, 150);
  assert.equal(s.shortfall, 50);
  assert.equal(s.purchase.units, 63); // 3 packs of 21
  assert.equal(r.lines.find((l) => l.id === 'bread').shortfall, 110);
});

test('day 2 restock applies the wastage buffer to the expected sales', () => {
  const r = calculateRestock({ catalogue, menuId: 'sausage-sizzle', sold: 300, day2Pct: 50, bufferPct: 10, stock: { sausages: 100 } });
  assert.equal(r.lines.find((l) => l.id === 'sausages').shortfall, 65); // 165 - 100
});

test('day 2 restock rounds expected sales up to whole serves', () => {
  assert.equal(expectedDay2(7, 33), 3); // 2.31
  assert.equal(expectedDay2(300, 50), 150);
  assert.equal(expectedDay2(0, 80), 0);
  assert.equal(expectedDay2(100, 0), 0);
});

test('day 2 restock buys nothing when leftovers cover the expected sales', () => {
  const r = calculateRestock({
    catalogue,
    menuId: 'sausage-sizzle',
    sold: 90,
    day2Pct: 100,
    stock: { sausages: 100, bread: 100, onions: 5000, oil: 1000 },
  });
  assert.equal(r.totalCost, 0);
  assert.ok(r.lines.every((l) => l.purchase.packs.length === 0));
});

test('leftoverEstimate: what the plan bought minus what day 1 used', () => {
  const plan = calculate({ catalogue, menuId: 'sausage-sizzle', serves: 400, store: 'cheapest' });
  const used = recipeUsage(catalogue, 'sausage-sizzle', {}, 300);
  assert.equal(used.sausages, 300);
  assert.equal(used.bread, 300);
  const left = leftoverEstimate(plan, used);
  assert.equal(left.sausages, plan.lines.find((l) => l.id === 'sausages').purchase.units - 300);
  assert.equal(left.onions, plan.lines.find((l) => l.id === 'onions').purchase.units - 4500);
  // Never negative
  assert.equal(leftoverEstimate(plan, { sausages: 10000 }).sausages, 0);
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

test('items: day 2 restock scales day 1 sales and uses leftovers first', () => {
  const r = calculateItems({ catalogue, menuId: 'drinks', day2Pct: 50, sold: { pepsi: 40 }, stock: { pepsi: 8 } });
  const p = r.lines.find((l) => l.id === 'pepsi');
  assert.equal(p.needed, 20); // half of 40
  assert.equal(p.shortfall, 12);
  assert.equal(p.purchase.units, 24);
  assert.equal(r.revenue, 20 * 2); // only lines with day 1 sales expect day 2 sales
});

test('items: plan mode ignores sold counts', () => {
  const r = calculateItems({ catalogue, menuId: 'consumables', sold: { napkins: 400 } });
  assert.equal(r.lines.find((l) => l.id === 'napkins').needed, 1000);
});

test('itemsUsage: counts for fixed items, per serve for sauces', () => {
  const used = itemsUsage(catalogue, 'consumables', {}, { napkins: 350 }, { 'sausage-sizzle': 300, 'egg-bacon': 50 });
  assert.equal(used.napkins, 350);
  assert.equal(used['tomato-sauce'], 3500); // 10ml × 350
  assert.equal(used.mustard, 900); // 3g × 300 sausages only
  assert.equal(used.gloves, 0);
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

test('sauces are in consumables and scale from sausages plus sandwiches', () => {
  for (const id of ['sausage-sizzle', 'egg-bacon']) {
    assert.ok(!catalogue.menu[id].recipe.some((r) => ['tomato-sauce', 'bbq-sauce', 'mustard'].includes(r.ingredient)));
  }
  const r = calculateItems({ catalogue, menuId: 'consumables', servesByMenu: { 'sausage-sizzle': 200, 'egg-bacon': 100 }, bufferPct: 0 });
  assert.equal(r.lines.find((l) => l.id === 'tomato-sauce').needed, 3000); // 10ml × 300
  assert.equal(r.lines.find((l) => l.id === 'bbq-sauce').needed, 1500);
  assert.equal(r.lines.find((l) => l.id === 'mustard').needed, 600); // sausages only
  assert.equal(r.lines.find((l) => l.id === 'napkins').needed, 1000); // fixed quantity
});

test('per-serve consumables use the buffer and day 2 serves on restock', () => {
  const r = calculateItems({
    catalogue,
    menuId: 'consumables',
    servesByMenu: { 'sausage-sizzle': 100, 'egg-bacon': 0 }, // day 2's expected serves
    bufferPct: 10,
    day2Pct: 50,
    sold: { 'tomato-sauce': 500 },
    stock: { 'tomato-sauce': 300 },
  });
  const t = r.lines.find((l) => l.id === 'tomato-sauce');
  assert.equal(t.needed, 1100);
  assert.equal(t.shortfall, 800);
  assert.equal(t.purchase.units, 1000);
});

test('donated products cost nothing and keep their value', () => {
  const r = calculate({
    catalogue,
    menuId: 'sausage-sizzle',
    serves: 200,
    store: 'cheapest',
    donated: { 'dk-slapes-bbq-1.5kg': true },
    priceOverrides: { 'dk-slapes-bbq-1.5kg': 10.5 },
  });
  const s = r.lines.find((l) => l.id === 'sausages');
  assert.equal(s.purchase.cost, 0);
  assert.equal(s.purchase.donatedValue, 105); // 10 packs × $10.50
  assert.equal(r.donatedValue, 105);
  const normal = calculate({ catalogue, menuId: 'sausage-sizzle', serves: 200, store: 'cheapest' });
  assert.equal(round2(normal.totalCost - r.totalCost), 110);
});

test('withCustomItems adds the user\'s own drinks to a copy of the catalogue', () => {
  const custom = [
    { id: 'custom-ice-tea', menu: 'drinks', name: 'Iced tea', unit: 'bottles', packSize: 12, price: 18, store: 'woolworths', quantity: 24, salePrice: 3 },
    { id: 'custom-bad', menu: 'nope', name: 'x', unit: 'cans', packSize: 6, price: 5, store: 'woolworths' },
    { id: 'custom-bad2', menu: 'drinks', name: 'y', unit: 'cans', packSize: 0, price: 5, store: 'woolworths' },
  ];
  const cat = withCustomItems(catalogue, custom);
  assert.ok(!catalogue.ingredients['custom-ice-tea'], 'original untouched');
  assert.ok(cat.ingredients['custom-ice-tea']);
  assert.ok(!cat.ingredients['custom-bad'] && !cat.ingredients['custom-bad2']);
  const r = calculateItems({ catalogue: cat, menuId: 'drinks', store: 'cheapest' });
  const tea = r.lines.find((l) => l.id === 'custom-ice-tea');
  assert.equal(tea.needed, 24);
  assert.equal(tea.purchase.cost, 36); // 2 × $18
  assert.equal(tea.salePrice, 3);
  assert.ok(tea.purchase.packs[0].product.custom);
});

test('big-name drinks are offered, with the group\'s usual ones switched on', () => {
  const lines = catalogue.menu.drinks.recipe;
  for (const id of ['coca-cola', 'coke-no-sugar', 'pepsi', 'pepsi-max', 'sprite', 'fanta', 'solo', 'water']) {
    assert.ok(lines.some((l) => l.ingredient === id), `${id} offered`);
  }
  const on = lines.filter((l) => l.enabled).map((l) => l.ingredient).sort();
  assert.deepEqual(on, ['pepsi', 'pepsi-max', 'solo', 'water']);
});

test('wizardProducts can leave out items that are switched off', () => {
  const on = (menuId, id) => id !== 'coca-cola';
  const ids = wizardProducts(catalogue, ['drinks'], on).map((e) => e.product.id);
  assert.ok(!ids.includes('ww-coca-cola-24'));
  assert.ok(ids.includes('ww-pepsi-24'));
});

test('oil is a consumable: one bottle per event, not in the food recipes', () => {
  assert.equal(catalogue.ingredients.oil.name, 'Oil');
  for (const id of ['sausage-sizzle', 'egg-bacon']) assert.ok(!catalogue.menu[id].recipe.some((r) => r.ingredient === 'oil'));
  const r = calculateItems({ catalogue, menuId: 'consumables', servesByMenu: { 'sausage-sizzle': 500, 'egg-bacon': 200 } });
  const oil = r.lines.find((l) => l.id === 'oil');
  assert.equal(oil.needed, 1); // the same however many are sold
  assert.equal(oil.purchase.packs[0].count, 1);
  assert.equal(oil.purchase.cost, 4);
});

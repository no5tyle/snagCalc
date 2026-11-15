import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { unitPrice, unitBasis, compareProducts, purchaseFor, pricedProducts, stockLeft, carryForward, combineResults, byStore, stockShare, sumUsage, withCustomMenus, effectiveRecipe, cheapestPacks, calculate, calculateRestock, calculateItems, wizardProducts, applyWizardPrices, round2, withCustomItems, expectedDay2, recipeUsage, itemsUsage, leftoverEstimate } from '../assets/calc.js';

const catalogue = JSON.parse(readFileSync(new URL('../data/catalogue.json', import.meta.url)));
// Listed prices change every week, so tests read them rather than hard-coding them
const listed = (id) => Object.values(catalogue.ingredients).flatMap((i) => i.products).find((p) => p.id === id).price;

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
  assert.equal(s.purchase.cost, round2(10 * listed('dk-slapes-bbq-1.5kg')));
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
  const r = calculateItems({ catalogue, menuId: 'drinks', store: 'woolworths', itemOverrides: { pepsi: { quantity: 30, salePrice: 2.5 } } });
  const pepsi = r.lines.find((l) => l.id === 'pepsi');
  assert.equal(pepsi.needed, 30);
  // Whichever mix of Woolworths packs covers 30 cans for least: never more than two 24 packs
  assert.ok(pepsi.purchase.units >= 30);
  assert.ok(pepsi.purchase.packs.every(({ product }) => product.store === 'woolworths'));
  assert.ok(pepsi.purchase.cost <= round2(2 * listed('ww-pepsi-24')));
  const others = r.lines.filter((l) => l.id !== 'pepsi').reduce((s, l) => s + l.needed * l.salePrice, 0);
  assert.equal(r.revenue, 30 * 2.5 + others);
});

test('items: day 2 restock scales day 1 sales and uses leftovers first', () => {
  const r = calculateItems({ catalogue, menuId: 'drinks', store: 'woolworths', day2Pct: 50, sold: { pepsi: 40 }, stock: { pepsi: 8 } });
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
  assert.equal(round2(normal.totalCost - r.totalCost), round2(10 * listed('dk-slapes-bbq-1.5kg')));
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

test('bottles checked by eye: another is bought only if what is left will not last day 2', () => {
  const run = (percentLeft, day2Pct = 50) =>
    calculateItems({ catalogue, menuId: 'consumables', day2Pct, percentLeft: { oil: percentLeft } }).lines.find((l) => l.id === 'oil');
  // 40% left: day 1 used 60%, day 2 at 50% needs 30%, so it's enough
  let oil = run(40);
  assert.equal(oil.byEye, true);
  assert.equal(oil.sold, 0.6);
  assert.equal(oil.needed, 0.3);
  assert.equal(oil.shortfall, 0);
  assert.equal(oil.purchase.packs.length, 0);
  // 20% left: day 1 used 80%, day 2 needs 40%, so another bottle
  oil = run(20);
  assert.ok(oil.shortfall > 0);
  assert.equal(oil.purchase.packs[0].count, 1);
  // Not checked counts as empty: day 1 used the whole bottle
  oil = run(undefined, 100);
  assert.equal(oil.percentLeft, null);
  assert.equal(oil.purchase.packs[0].count, 1);
  // An unopened spare (100%) plus some is plenty
  assert.equal(run(140, 100).shortfall, 0);
});

test('combineResults buys shared bread once across sausages and sandwiches', () => {
  const opts = { catalogue, store: 'woolworths' };
  const snags = calculate({ ...opts, menuId: 'sausage-sizzle', serves: 190 });
  const eggs = calculate({ ...opts, menuId: 'egg-bacon', serves: 95 });
  const all = combineResults([{ menuId: 'sausage-sizzle', result: snags }, { menuId: 'egg-bacon', result: eggs }], opts);
  const bread = all.lines.find((l) => l.id === 'bread');
  assert.equal(bread.needed, 190 + 95 * 2);
  assert.deepEqual(bread.menus, ['sausage-sizzle', 'egg-bacon']);
  // 380 slices is 19 loaves; planned apart it's 10 + 10
  assert.equal(bread.purchase.units, 380);
  const apart = [snags, eggs].reduce((s, r) => s + r.lines.find((l) => l.id === 'bread').purchase.units, 0);
  assert.equal(apart, 400);
  assert.equal(all.lines.length, 5); // sausages, bread, onions, eggs, bacon
  assert.ok(all.totalCost < round2(snags.totalCost + eggs.totalCost));
});

test('combineResults takes stock off the combined need for a restock', () => {
  const opts = { catalogue, store: 'woolworths' };
  const parts = [
    { menuId: 'sausage-sizzle', result: calculateRestock({ ...opts, menuId: 'sausage-sizzle', sold: 100, day2Pct: 100 }) },
    { menuId: 'egg-bacon', result: calculateRestock({ ...opts, menuId: 'egg-bacon', sold: 50, day2Pct: 100 }) },
  ];
  const all = combineResults(parts, { ...opts, stock: { bread: 150, sausages: 500 } });
  const bread = all.lines.find((l) => l.id === 'bread');
  assert.equal(bread.needed, 200);
  assert.equal(bread.onHand, 150);
  assert.equal(bread.shortfall, 50);
  assert.equal(bread.purchase.units, 60); // 3 loaves
  assert.equal(all.lines.find((l) => l.id === 'sausages').shortfall, 0);
});

test('combineResults keeps bottles checked by eye as they are', () => {
  const result = calculateItems({ catalogue, menuId: 'consumables', day2Pct: 100, percentLeft: { oil: 30 }, itemOverrides: {} });
  const all = combineResults([{ menuId: 'consumables', result }], { catalogue, stock: { oil: 5 } });
  const oil = all.lines.find((l) => l.id === 'oil');
  assert.ok(oil.byEye);
  assert.equal(oil.onHand, 0.3);
  assert.equal(oil.purchase.units, 1);
});

test('byStore splits the list by store, with donations and gaps apart', () => {
  const opts = { catalogue, store: 'cheapest', donated: { 'ww-bread-white': true, 'dk-bread-white': true } };
  const snags = calculate({ ...opts, menuId: 'sausage-sizzle', serves: 100 });
  const all = combineResults([{ menuId: 'sausage-sizzle', result: snags }], opts);
  const { groups, donated, missing } = byStore(all, Object.keys(catalogue.stores));
  assert.equal(donated.length, 1);
  assert.equal(donated[0].line.id, 'bread');
  assert.equal(missing.length, 0);
  for (const g of groups) assert.ok(g.items.every((i) => i.product.store === g.store));
  assert.equal(round2(groups.reduce((s, g) => s + g.cost, 0)), all.totalCost);

  const none = { ...catalogue, ingredients: { ...catalogue.ingredients, onions: { ...catalogue.ingredients.onions, products: [] } } };
  const gap = calculate({ catalogue: none, menuId: 'sausage-sizzle', serves: 100 });
  assert.deepEqual(byStore(gap, ['woolworths', 'drakes']).missing.map((l) => l.id), ['onions']);
});

test('every built-in ingredient can be bought at both Woolworths and Drakes', () => {
  for (const [id, ing] of Object.entries(catalogue.ingredients)) {
    for (const store of Object.keys(catalogue.stores)) {
      assert.ok(ing.products.some((p) => p.store === store), `${id} has no ${store} product`);
    }
  }
});

test('stockShare splits shared stock by need', () => {
  const needs = { a: { bread: 100, sausages: 100 }, b: { bread: 300 } };
  assert.deepEqual(stockShare({ bread: 80, sausages: 40 }, needs, 'a'), { bread: 20, sausages: 40 });
  assert.deepEqual(stockShare({ bread: 80 }, needs, 'b'), { bread: 60 });
  assert.deepEqual(stockShare({ bread: 80 }, { a: { bread: 0 } }, 'a'), { bread: 80 });
});

test('sumUsage adds usage across menus', () => {
  assert.deepEqual(sumUsage([{ bread: 100, eggs: 5 }, { bread: 50 }]), { bread: 150, eggs: 5 });
});

test('a custom recipe: its own menu, new and reused ingredients', () => {
  const menus = [{ id: 'recipe-burgers', name: 'Burgers', icon: '🍔', serveNoun: 'burger', defaultServes: 50, defaultSalePrice: 5 }, { id: 'drinks', name: 'Clash' }, { id: 'x', name: ' ' }];
  const items = [
    { id: 'custom-patties', menu: 'recipe-burgers', name: 'Beef patties', unit: 'patties', packSize: 10, price: 9, store: 'drakes', perServe: 1 },
    { id: 'custom-use-bread', menu: 'recipe-burgers', ingredient: 'bread', perServe: 2 },
    { id: 'custom-use-nope', menu: 'recipe-burgers', ingredient: 'nope', perServe: 1 },
    { id: 'custom-dup-bread', menu: 'sausage-sizzle', ingredient: 'bread', perServe: 5 },
    { id: 'custom-cheese', menu: 'egg-bacon', name: 'Cheese', unit: 'g', packSize: 500, price: 6, store: 'woolworths', perServe: 20 },
  ];
  const cat = withCustomItems(withCustomMenus(catalogue, menus), items);
  assert.ok(!catalogue.menu['recipe-burgers'], 'original untouched');
  // After the food menus, before drinks, so sauces count burgers too
  assert.deepEqual(Object.keys(cat.menu), ['sausage-sizzle', 'egg-bacon', 'recipe-burgers', 'drinks', 'consumables']);
  assert.equal(cat.menu.drinks.name, 'Drinks');
  assert.equal(cat.menu['recipe-burgers'].serveLabel, 'burgers');
  assert.deepEqual(cat.menu['recipe-burgers'].recipe.map((r) => [r.ingredient, r.perServe, r.customId]), [
    ['custom-patties', 1, 'custom-patties'],
    ['bread', 2, 'custom-use-bread'],
  ]);
  // Bread was already in the sausage recipe, so it isn't added twice
  assert.equal(effectiveRecipe(cat, 'sausage-sizzle').filter((r) => r.ingredient === 'bread').length, 1);
  assert.equal(cat.ingredients['custom-cheese'].products[0].name, 'Cheese 500g');

  const r = calculate({ catalogue: cat, menuId: 'recipe-burgers', serves: 50, store: 'cheapest' });
  const patties = r.lines.find((l) => l.id === 'custom-patties');
  assert.equal(patties.purchase.cost, 45);
  assert.equal(r.lines.find((l) => l.id === 'bread').needed, 100);
  const egg = calculate({ catalogue: cat, menuId: 'egg-bacon', serves: 50, store: 'cheapest' });
  assert.equal(egg.lines.find((l) => l.id === 'custom-cheese').purchase.units, 1000);
  const sauces = calculateItems({ catalogue: cat, menuId: 'consumables', servesByMenu: { 'sausage-sizzle': 100, 'recipe-burgers': 50 } });
  assert.equal(sauces.lines.find((l) => l.id === 'tomato-sauce').needed, 1500);
});

test('applyWizardPrices keeps an estimate the user agreed with as their own price', () => {
  const out = applyWizardPrices(catalogue, {}, { 'ww-sausages-24': listed('ww-sausages-24'), 'dk-bread-white': listed('dk-bread-white') });
  assert.equal(out['ww-sausages-24'], listed('ww-sausages-24'));
  assert.ok(!('dk-bread-white' in out));
});

test('stockLeft: what the day started with minus what has been used', () => {
  assert.deepEqual(stockLeft({ sausages: 210, bread: 200, onions: 500 }, { sausages: 150, bread: 250 }), { sausages: 60, bread: 0, onions: 500 });
});

// A two-menu stall on day 1: 210 sausages and 200 slices to start with
function restockFor({ sold, pct, start }) {
  const opts = { catalogue, store: 'drakes' };
  const parts = [{ menuId: 'sausage-sizzle', result: calculateRestock({ ...opts, menuId: 'sausage-sizzle', sold, day2Pct: pct, recipeOverrides: { onions: { enabled: false } } }) }];
  const used = { sausages: sold, bread: sold };
  return { used, result: combineResults(parts, { ...opts, stock: stockLeft(start, used) }) };
}

test('carryForward after a top-up: later estimates include what was bought', () => {
  const start = { sausages: 210, bread: 200 };
  // 1pm: 190 sold, half as many again expected: 95 needed, 20 sausages and 10 slices left
  const { used, result } = restockFor({ sold: 190, pct: 50, start });
  const snags = result.lines.find((l) => l.id === 'sausages');
  assert.equal(snags.onHand, 20);
  assert.equal(snags.purchase.units, 84); // 4 packs of 21 cover the 75 short
  const carry = carryForward(start, result, 'today', used);
  assert.equal(carry.sausages, 210 + 84);
  // Straight after: nothing more to buy, and 104 on the stall
  assert.equal(stockLeft(carry, used).sausages, 104);
  const again = restockFor({ sold: 190, pct: 50, start: carry });
  assert.equal(again.result.totalCost, 0);
});

test('carryForward at the end of a day: tomorrow starts with what is left plus the restock', () => {
  const start = { sausages: 210, bread: 200 };
  const { used, result } = restockFor({ sold: 180, pct: 100, start });
  const snags = result.lines.find((l) => l.id === 'sausages');
  assert.equal(snags.onHand, 30);
  const carry = carryForward(start, result, 'next', used);
  assert.equal(carry.sausages, 30 + snags.purchase.units);
  assert.ok(carry.sausages >= 180);
  // Day 2 then counts down from there
  assert.equal(stockLeft(carry, { sausages: 100 }).sausages, carry.sausages - 100);
});

test('bottles checked by eye count down from what the day opened with', () => {
  // Two bottles on the stall after a top-up, 1.2 left: 0.8 used, the same again expected
  const r = calculateItems({ catalogue, menuId: 'consumables', day2Pct: 100, percentLeft: { oil: 120 }, opening: { oil: 2 } });
  const oil = r.lines.find((l) => l.id === 'oil');
  assert.equal(oil.sold, 0.8);
  assert.equal(oil.shortfall, 0);
  const all = combineResults([{ menuId: 'consumables', result: r }], { catalogue });
  assert.equal(carryForward({}, all, 'today').oil, 2); // nothing bought, so the opening figure stands
  assert.equal(carryForward({}, all, 'next').oil, 1.2);
});

test('unit prices: per 100 for weight and volume, per one for everything else', () => {
  assert.deepEqual(unitBasis({ unit: 'ml' }), { size: 100, label: '100 ml' });
  assert.deepEqual(unitBasis({ unit: 'cans' }), { size: 1, label: 'can' });
  assert.deepEqual(unitBasis({ unit: 'slices' }), { size: 1, label: 'slice' });
  assert.equal(unitPrice({ packSize: 2000, price: 6 }, { unit: 'ml' }), 0.3);
  assert.equal(unitPrice({ packSize: 30, price: 27 }, { unit: 'cans' }), 0.9);
  assert.equal(unitPrice({ packSize: 30, price: null }, { unit: 'cans' }), null);
});

test('compareProducts sorts by unit price across stores, sizes and brands', () => {
  const ing = {
    unit: 'ml',
    products: [
      { id: 'small', store: 'a', packSize: 500, price: 2.2, priceUpdated: '2026-11-15' },
      { id: 'big', store: 'b', packSize: 2000, price: 6, regularPrice: 8, priceUpdated: '2026-11-15' },
      { id: 'posh', store: 'a', packSize: 500, price: 5.35, priceUpdated: '2026-11-15' },
      { id: 'unknown', store: 'a', packSize: 500, price: null },
    ],
  };
  const rows = compareProducts(ing);
  assert.deepEqual(rows.map((r) => r.product.id), ['big', 'small', 'posh', 'unknown']);
  assert.deepEqual(rows.map((r) => r.cheapest), [true, false, false, false]);
  assert.equal(rows[0].unitPrice, 0.3);
  assert.equal(rows[0].usualUnitPrice, 0.4);
  assert.equal(rows[3].unitPrice, null);
  // On the user's own prices: the small one at $1 wins, and is no longer a listed special
  const own = compareProducts(ing, pricedProducts(ing.products, { small: 1 }));
  assert.equal(own[0].product.id, 'small');
  assert.equal(compareProducts({ unit: 'cans', products: [{ id: 'only', packSize: 24, price: 23 }] })[0].cheapest, false);
  // An estimate can sort first, but "cheapest" goes to the best price someone has checked
  const guess = compareProducts({ unit: 'cans', products: [{ id: 'guess', packSize: 30, price: 20, priceUpdated: null }, { id: 'sure', packSize: 24, price: 23, priceUpdated: '2026-11-15' }] });
  assert.deepEqual(guess.map((r) => [r.product.id, r.cheapest]), [['guess', false], ['sure', true]]);
});

test('the sauces can be compared across Fountain, Masterfoods, Rosella and Ozesauce', () => {
  const names = (id) => catalogue.ingredients[id].products.map((p) => p.name).join(' | ');
  for (const brand of ['Fountain', 'Masterfoods', 'Rosella', 'Ozesauce']) assert.match(names('tomato-sauce'), new RegExp(brand, 'i'));
  for (const brand of ['Fountain', 'Masterfoods']) assert.match(names('bbq-sauce'), new RegExp(brand, 'i'));
  // More than one size of each soft drink at Woolworths
  for (const id of ['pepsi', 'pepsi-max', 'solo', 'coca-cola', 'coke-no-sugar', 'sprite']) {
    const sizes = new Set(catalogue.ingredients[id].products.filter((p) => p.store === 'woolworths').map((p) => p.packSize));
    assert.ok(sizes.size >= 2, `${id} has one Woolworths size`);
  }
});

test('a product with no price yet is never bought while another is priced', () => {
  const r = calculateItems({ catalogue, menuId: 'consumables', store: 'woolworths', servesByMenu: { 'sausage-sizzle': 200 } });
  const sauce = r.lines.find((l) => l.id === 'tomato-sauce');
  assert.ok(sauce.purchase.packs.every(({ product }) => Number.isFinite(product.price)));
  assert.ok(sauce.purchase.cost > 0);
});

test('cheapest store: on a tie, a checked price beats an estimate', () => {
  const products = [
    { id: 'guess', store: 'a', packSize: 10, price: 5, priceUpdated: null },
    { id: 'sure', store: 'b', packSize: 10, price: 5, priceUpdated: '2026-11-15' },
  ];
  assert.equal(purchaseFor(10, products, 'cheapest', ['a', 'b']).store, 'b');
  // A cheaper guess still wins
  products[0].price = 4;
  assert.equal(purchaseFor(10, products, 'cheapest', ['a', 'b']).store, 'a');
});

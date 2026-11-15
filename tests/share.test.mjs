import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planOf, encodePlan, decodePlan, planInHash } from '../assets/share.js';

const settings = {
  store: 'drakes',
  buffer: 5,
  day2Pct: 75,
  day: 2,
  restockFor: 'today',
  prices: { 'ww-bread-white': 3 },
  donated: { 'dk-eggs-12': true },
  active: { 'egg-bacon': false },
  stock: { bread: 2.5 },
  carry: { sausages: 120 },
  customMenus: [{ id: 'recipe-burgers', name: 'Burgers', icon: '🍔', serveNoun: 'burger', defaultServes: 50, defaultSalePrice: 5 }],
  customItems: [{ id: 'custom-patties', menu: 'recipe-burgers', name: 'Beef patties', unit: 'patties', packSize: 10, price: 9, store: 'drakes', perServe: 1 }],
  menus: {
    'sausage-sizzle': { planServes: 400, salePrice: 3, recipe: { onions: { enabled: false, perServe: 20 } }, restock: { sold: 300 } },
    drinks: { items: { pepsi: { quantity: 48, salePrice: 2.5 } }, restock: { sold: { pepsi: 20 }, leftPct: {} } },
    consumables: { items: {}, restock: { sold: {}, leftPct: { oil: 40 } } },
  },
  // Not part of a plan
  view: 'restock',
  menu: 'drinks',
  ticks: { plan: { x: 1 } },
  wizardDone: true,
};

test('a plan survives being made into a link and read back', async () => {
  const code = await encodePlan(settings);
  assert.match(code, /^[zj][\w-]+$/);
  const plan = await decodePlan(code);
  assert.deepEqual(plan, planOf(settings));
  assert.equal(plan.menus['sausage-sizzle'].restock.sold, 300);
  assert.equal(plan.menus.drinks.restock.sold.pepsi, 20);
  assert.equal(plan.customMenus[0].icon, '🍔');
  for (const key of ['view', 'menu', 'ticks', 'wizardDone']) assert.ok(!(key in plan), `${key} is left out`);
});

test('a plain (uncompressed) link is read too', async () => {
  const code = `j${Buffer.from(JSON.stringify({ store: 'woolworths', buffer: 10 })).toString('base64url')}`;
  assert.deepEqual(await decodePlan(code), { ...planOf({}), store: 'woolworths', buffer: 10 });
});

test('a link that is not a plan is refused', async () => {
  assert.equal(await decodePlan('zNotAPlan'), null);
  assert.equal(await decodePlan('x1234'), null);
  assert.equal(await decodePlan(`j${Buffer.from('[1,2]').toString('base64url')}`), null);
});

test('anything in a link that is not the expected kind of value is dropped', () => {
  const plan = planOf({
    store: '<img src=x onerror=alert(1)>'.repeat(20),
    buffer: '5',
    day: 2.5,
    restockFor: 'whenever',
    prices: { a: 3, b: '<b>', c: -1, d: Infinity },
    donated: { a: true, b: 'yes' },
    stock: 'lots',
    carry: [1, 2],
    customItems: [{ id: 'ok', name: 'Fine', packSize: '<script>', extra: 'x' }, { name: 'no id' }, 'nope'],
    customMenus: 'nope',
    menus: { m: { planServes: '<i>', salePrice: 4, restock: { sold: { a: 1, b: 'x' } }, evil: true } },
    onload: 'alert(1)',
  });
  assert.equal(plan.store.length, 100);
  assert.ok(!('buffer' in plan) && !('day' in plan) && !('restockFor' in plan) && !('onload' in plan) && !('carry' in plan));
  assert.deepEqual(plan.prices, { a: 3 });
  assert.deepEqual(plan.donated, { a: true });
  assert.deepEqual(plan.stock, {});
  assert.deepEqual(plan.customItems, [{ id: 'ok', name: 'Fine' }]);
  assert.deepEqual(plan.customMenus, []);
  assert.deepEqual(plan.menus, { m: { salePrice: 4, recipe: {}, items: {}, restock: { sold: { a: 1 }, leftPct: {} } } });
});

test('planInHash finds the plan in a link', () => {
  assert.equal(planInHash('#plan=zAbc-_9'), 'zAbc-_9');
  assert.equal(planInHash('#other'), null);
  assert.equal(planInHash('#plan=bad!chars'), null);
  assert.equal(planInHash(''), null);
});

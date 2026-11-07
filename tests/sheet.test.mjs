import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { calculate, calculateRestock, calculateItems } from '../assets/calc.js';
import { buildSheet, toTSV } from '../assets/sheet.js';

const catalogue = JSON.parse(readFileSync(new URL('../data/catalogue.json', import.meta.url)));

// Minimal spreadsheet evaluator covering the functions the export uses.
function evaluate(rows) {
  const raw = (ref) => {
    const m = /^\$?([A-Z]+)\$?(\d+)$/.exec(ref);
    const col = [...m[1]].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1;
    return rows[Number(m[2]) - 1]?.[col] ?? '';
  };
  const cache = new Map();
  const value = (ref) => {
    const key = ref.replace(/\$/g, '');
    if (cache.has(key)) return cache.get(key);
    const v = raw(key);
    let out;
    if (typeof v === 'string' && v.startsWith('=')) {
      const expr = v
        .slice(1)
        .replace(/\$?([A-Z]+)\$?(\d+):\$?([A-Z]+)\$?(\d+)/g, (_, c1, r1, c2, r2) => {
          assert.equal(c1, c2);
          const refs = [];
          for (let r = Number(r1); r <= Number(r2); r++) refs.push(`v("${c1}${r}")`);
          return `[${refs.join(',')}]`;
        })
        .replace(/(?<![A-Z"])\$?([A-Z]{1,2})\$?(\d+)(?![\d"(])/g, (_, c, r) => `v("${c}${r}")`)
        .replace(/(?<![<>=!])=(?!=)/g, '==');
      const fns = {
        SUM: (a) => a.reduce((s, x) => s + (Number(x) || 0), 0),
        ROUNDUP: (x, d) => Math.ceil(x * 10 ** d) / 10 ** d,
        ROUND: (x, d) => Math.round(x * 10 ** d) / 10 ** d,
        MAX: Math.max,
        IF: (c, a, b) => (c ? a : b),
      };
      // Text stays text (e.g. "Yes"); blanks count as 0, as in a spreadsheet
      const cellValue = (r) => {
        const x = value(r);
        return typeof x === 'string' && x !== '' && Number.isNaN(Number(x)) ? x : Number(x) || 0;
      };
      out = Function('v', ...Object.keys(fns), `return (${expr});`)(cellValue, ...Object.values(fns));
    } else out = v;
    cache.set(key, out);
    return out;
  };
  return value;
}

const labelled = (rows, value, label) => {
  const i = rows.findIndex((r) => r[0] === label);
  assert.ok(i >= 0, `row "${label}" exists`);
  return value(`B${i + 1}`);
};
const near = (a, b) => assert.ok(Math.abs(a - b) < 0.005, `${a} ≈ ${b}`);

test('sausage plan sheet: formulas reproduce the app totals', () => {
  const result = calculate({ catalogue, menuId: 'sausage-sizzle', serves: 200, bufferPct: 5, store: 'cheapest' });
  const rows = buildSheet({ kind: 'recipe', mode: 'plan', result, title: 'Test', serveLabel: 'sausages', serveNoun: 'sausage', bufferPct: 5, salePrice: 3 });
  const v = evaluate(rows);
  near(labelled(rows, v, 'Shopping total'), result.totalCost);
  near(labelled(rows, v, 'Takings if all sell'), 600);
  near(labelled(rows, v, 'Profit if all sell'), 600 - result.totalCost);
  assert.ok(rows.some((r) => String(r[0]).startsWith('Sausages to sell')));
});

test('sheet formulas recalculate when the serves cell changes', () => {
  const result = calculate({ catalogue, menuId: 'sausage-sizzle', serves: 200, bufferPct: 5, store: 'cheapest' });
  const rows = buildSheet({ kind: 'recipe', mode: 'plan', result, title: 'Test', serveLabel: 'sausages', serveNoun: 'sausage', bufferPct: 5, salePrice: 3 });
  rows[1][1] = 400; // Sausages to sell
  const bigger = calculate({ catalogue, menuId: 'sausage-sizzle', serves: 400, bufferPct: 5, store: 'cheapest' });
  near(labelled(rows, evaluate(rows), 'Shopping total'), bigger.totalCost);
});

test('sausage restock sheet matches the app', () => {
  const result = calculateRestock({
    catalogue, menuId: 'sausage-sizzle', sold: 300, day2Pct: 50, bufferPct: 5, store: 'cheapest',
    stock: { sausages: 100, bread: 60 },
  });
  const rows = buildSheet({ kind: 'recipe', mode: 'restock', result, title: 'Test', serveLabel: 'sausages', serveNoun: 'sausage', bufferPct: 5, salePrice: 3 });
  const v = evaluate(rows);
  near(labelled(rows, v, 'Sausages expected on day 2'), 150);
  near(labelled(rows, v, 'Shopping total'), result.totalCost);
  near(labelled(rows, v, 'Takings on day 2'), 150 * 3);
  // Changing the % in the sheet recalculates
  rows[rows.findIndex((r) => r[0] === 'Day 2 sales, % of day 1')][1] = 80;
  const more = calculateRestock({
    catalogue, menuId: 'sausage-sizzle', sold: 300, day2Pct: 80, bufferPct: 5, store: 'cheapest',
    stock: { sausages: 100, bread: 60 },
  });
  near(labelled(rows, evaluate(rows), 'Shopping total'), more.totalCost);
});

test('drinks sheet includes sale prices and takings', () => {
  const result = calculateItems({ catalogue, menuId: 'drinks', store: 'cheapest' });
  const rows = buildSheet({ kind: 'items', mode: 'plan', result, title: 'Drinks', sells: true });
  const v = evaluate(rows);
  near(labelled(rows, v, 'Shopping total'), result.totalCost);
  near(labelled(rows, v, 'Takings if all sell'), result.revenue);
});

test('consumables restock sheet matches the app', () => {
  // Day 1: 300 sausages and 100 sandwiches; day 2 expects 50% of that
  const day1 = { 'sausage-sizzle': 300, 'egg-bacon': 100 };
  const day2 = { 'sausage-sizzle': 150, 'egg-bacon': 50 };
  const result = calculateItems({
    catalogue, menuId: 'consumables', store: 'cheapest', day2Pct: 50, bufferPct: 5, servesByMenu: day2,
    sold: { napkins: 400 }, stock: { napkins: 100, 'tomato-sauce': 600 },
  });
  const foodServes = [
    { id: 'sausage-sizzle', label: 'Sausages sold on day 1', serves: day1['sausage-sizzle'] },
    { id: 'egg-bacon', label: 'Sandwiches sold on day 1', serves: day1['egg-bacon'] },
  ];
  const rows = buildSheet({ kind: 'items', mode: 'restock', result, title: 'Consumables', sells: false, day2Pct: 50, bufferPct: 5, foodServes });
  near(labelled(rows, evaluate(rows), 'Shopping total'), result.totalCost);
  assert.ok(!rows.some((r) => r[0] === 'Takings on day 2'));
});

test('drinks restock sheet scales day 1 sales by the day 2 %', () => {
  const result = calculateItems({ catalogue, menuId: 'drinks', store: 'cheapest', day2Pct: 50, sold: { pepsi: 40, solo: 25 }, stock: { pepsi: 8 } });
  const rows = buildSheet({ kind: 'items', mode: 'restock', result, title: 'Drinks', sells: true, day2Pct: 50 });
  const v = evaluate(rows);
  near(labelled(rows, v, 'Shopping total'), result.totalCost);
  near(labelled(rows, v, 'Takings on day 2'), result.revenue);
});

test('toTSV separates cells with tabs and strips tabs and newlines from text', () => {
  assert.equal(toTSV([['a', 1], ['b\tc', '=A1'], ['d\ne']]), 'a\t1\nb c\t=A1\nd e');
});

test('consumables sheet scales sauces from the food serves cells', () => {
  const servesByMenu = { 'sausage-sizzle': 200, 'egg-bacon': 100 };
  const result = calculateItems({ catalogue, menuId: 'consumables', store: 'cheapest', servesByMenu, bufferPct: 5 });
  const foodServes = [
    { id: 'sausage-sizzle', label: 'Sausages to sell', serves: 200 },
    { id: 'egg-bacon', label: 'Sandwiches to sell', serves: 100 },
  ];
  const rows = buildSheet({ kind: 'items', mode: 'plan', result, title: 'Consumables', bufferPct: 5, foodServes });
  near(labelled(rows, evaluate(rows), 'Shopping total'), result.totalCost);
  // Doubling the sandwiches in the sheet matches the app with double sandwiches
  rows[2][1] = 200;
  const more = calculateItems({ catalogue, menuId: 'consumables', store: 'cheapest', servesByMenu: { ...servesByMenu, 'egg-bacon': 200 }, bufferPct: 5 });
  near(labelled(rows, evaluate(rows), 'Shopping total'), more.totalCost);
});

test('donated items cost nothing in the sheet and add to donations worth', () => {
  const opts = { catalogue, menuId: 'sausage-sizzle', serves: 200, bufferPct: 5, store: 'cheapest' };
  const result = calculate({ ...opts, donated: { 'dk-slapes-bbq-1.5kg': true } });
  const rows = buildSheet({ kind: 'recipe', mode: 'plan', result, title: 'Test', serveLabel: 'sausages', serveNoun: 'sausage', bufferPct: 5, salePrice: 3 });
  const v = evaluate(rows);
  near(labelled(rows, v, 'Shopping total'), result.totalCost);
  near(labelled(rows, v, 'Donations worth'), result.donatedValue);
  near(result.donatedValue, 110);
});

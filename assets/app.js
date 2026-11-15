import {
  calculate,
  calculateRestock,
  expectedDay2,
  recipeUsage,
  itemsUsage,
  stockLeft,
  carryForward,
  calculateItems,
  effectiveRecipe,
  effectiveItems,
  wizardProducts,
  applyWizardPrices,
  withCustomItems,
  withCustomMenus,
  combineResults,
  byStore,
  stockShare,
  sumUsage,
} from './calc.js';
import { buildSheet, toTSV } from './sheet.js';
import { planOf, encodePlan, decodePlan, planInHash } from './share.js';

const STORAGE_KEY = 'snagcalc:v2';
const OLD_STORAGE_KEY = 'snagcalc:v1';
const VIEWS = ['plan', 'restock', 'settings'];
// The first tab: one shopping list across everything that's switched on
const SHOP = 'all';

const $ = (sel) => document.querySelector(sel);
const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const money = (n) => (n == null ? '—' : n.toLocaleString('en-AU', { style: 'currency', currency: 'AUD' }));
const num = (n, dp = 2) => Number(n.toFixed(dp)).toLocaleString('en-AU');
const toNumber = (v) => (v === '' || v == null ? null : Number(v));
const valueAttr = (v) => (Number.isFinite(v) ? v : '');

let baseCatalogue; // data/catalogue.json as loaded
let catalogue; // baseCatalogue plus the user's own items (see rebuildCatalogue)
let settings;

// ---------- Menus ----------

const menuIds = () => Object.keys(catalogue.menu);
const menuDef = (id = settings.menu) => catalogue.menu[id];
const isItems = (id = settings.menu) => menuDef(id).kind === 'items';
const serveLabel = (id = settings.menu) => menuDef(id).serveLabel ?? 'serves';
const serveNoun = (id = settings.menu) => menuDef(id).serveNoun ?? 'serve';
const menuLabel = (id) => menuDef(id).tabLabel ?? menuDef(id).name;

const onShop = () => settings.menu === SHOP;
/** Whether a menu is being sold this event, so it's on the combined shopping list. */
const isActive = (id) => settings.active[id] !== false;
const activeMenus = () => menuIds().filter(isActive);
/** The menus that share stock with `id`: everything switched on, and `id` itself. */
const menuSet = (id) => menuIds().filter((m) => isActive(m) || m === id);

function defaultMenuSettings(id) {
  const m = catalogue.menu[id];
  if (m.kind === 'items') return { items: {}, restock: { sold: {} } };
  const serves = m.defaultServes ?? 100;
  return {
    salePrice: m.defaultSalePrice ?? 3,
    planServes: serves,
    restock: { sold: 0 },
    recipe: {},
  };
}

/** Settings for one menu, filled in with defaults for anything missing. */
function ms(id = settings.menu) {
  const base = defaultMenuSettings(id);
  const cur = settings.menus[id] || {};
  const merged = { ...base, ...cur, restock: { ...base.restock, ...(cur.restock || {}) } };
  settings.menus[id] = merged;
  return merged;
}

// ---------- Settings ----------

function defaultSettings() {
  return {
    store: 'cheapest',
    buffer: 5,
    prices: {},
    donated: {},
    customItems: [],
    customMenus: [],
    active: {}, // { [menuId]: false } for menus not being sold
    stock: {}, // stock counted since the day began, { [ingredientId]: amount in its stock unit }
    day: 1, // the day of the event that's running (or just finished)
    carry: null, // what the day started with once a restock was bought, { [ingredientId]: base units }; before that it's the first shop
    restockFor: 'next', // 'next' (tomorrow) or 'today' (a top-up for the rest of today)
    topupPct: 50, // rest of today's sales as a % of sales so far
    ticks: {}, // items ticked off while shopping, { plan|restock: { [productId]: packs } }
    day2Pct: 100,
    menu: SHOP,
    view: 'plan',
    menus: {},
    wizardDone: false,
    wizardMenus: null,
  };
}

function readJSON(key) {
  try {
    const v = JSON.parse(localStorage.getItem(key) || 'null');
    return v && typeof v === 'object' ? v : null;
  } catch {
    return null;
  }
}

const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});
const list = (v) => (Array.isArray(v) ? v : []);

function loadSettings() {
  const base = defaultSettings();
  const saved = readJSON(STORAGE_KEY);
  if (saved) {
    const s = {
      ...base,
      ...saved,
      menus: obj(saved.menus),
      donated: obj(saved.donated),
      prices: obj(saved.prices),
      ticks: obj(saved.ticks),
      customItems: list(saved.customItems),
      customMenus: list(saved.customMenus),
    };
    if (!VIEWS.includes(s.view)) s.view = 'plan';
    // Stock used to be counted on each tab; it's now counted once for the whole stall
    if (!saved.stock) {
      s.stock = {};
      for (const m of Object.values(s.menus)) {
        for (const [id, v] of Object.entries(obj(m?.restock?.stock))) {
          if (Number.isFinite(v)) s.stock[id] = (s.stock[id] || 0) + v;
        }
      }
    }
    // What was picked in the price check is what's being sold
    if (!saved.active) {
      s.active = {};
      const picked = list(saved.wizardMenus);
      if (picked.length) for (const id of Object.keys(baseCatalogue.menu)) if (!picked.includes(id)) s.active[id] = false;
    }
    return s;
  }
  // Carry over settings saved before there were several menu tabs.
  const old = readJSON(OLD_STORAGE_KEY);
  if (old) {
    const s = { ...base, store: old.store ?? base.store, buffer: old.buffer ?? base.buffer, prices: old.prices || {} };
    if (VIEWS.includes(old.tab)) s.view = old.tab;
    s.stock = obj(old.restock?.stock);
    s.menus['sausage-sizzle'] = {
      salePrice: old.salePrice,
      planServes: old.planServes,
      restock: { sold: old.restock?.sold ?? 0 },
      recipe: old.recipe || {},
    };
    return s;
  }
  return base;
}

function save() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch {
    /* ignore: private mode etc. */
  }
}

// ---------- Which day, and what a restock is for ----------

const dayNow = () => (Number.isInteger(settings.day) && settings.day >= 1 ? settings.day : 1);
/** A top-up for the rest of today, rather than a restock for tomorrow. */
const topUp = () => settings.restockFor === 'today';
const pctKey = () => (topUp() ? 'topupPct' : 'day2Pct');
const pctNow = () => (Number.isFinite(settings[pctKey()]) ? settings[pctKey()] : 100);

/** How a restock is worded: counted from today's sales, bought for the rest of today or for tomorrow. */
function words() {
  const d = dayNow();
  return topUp()
    ? {
        soldWhen: 'so far today',
        target: 'the rest of today',
        targetWhen: 'for the rest of today',
        pctLabel: 'Rest of today, % of sales so far',
        title: d > 1 ? `Top-up for today (day ${d})` : 'Top-up for today',
        after: 'Part-way through the day',
      }
    : {
        soldWhen: `on day ${d}`,
        target: `day ${d + 1}`,
        targetWhen: `on day ${d + 1}`,
        pctLabel: `Day ${d + 1} sales, % of day ${d}`,
        title: `Day ${d + 1} restock`,
        after: `After day ${d}`,
      };
}

// ---------- Formatting ----------

/** "1 bottle", "3 bottles": units are plain plurals (or g / ml, which stay as they are). */
const unitFor = (n, unit) => (Math.abs(n - 1) < 1e-9 && /[^s]s$/.test(unit) ? unit.slice(0, -1) : unit);
const fmtPlain = (base, ing) => `${num(base, 1)} ${unitFor(base, ing.unit)}`;

function fmtQty(base, ing) {
  const main = esc(fmtPlain(base, ing));
  const su = ing.stockUnit;
  if (!su || su.size === 1 || su.label === ing.unit) return main;
  return `${main} <span class="sub">${num(base / su.size, 2)} ${esc(su.label)}</span>`;
}

const storeName = (id) => catalogue.stores[id]?.name ?? id;

function buyCell(line) {
  const p = line.purchase;
  if (line.shortfall <= 0) return '<span class="none">Nothing needed</span>';
  if (p.unavailable) return '<span class="badge-estimate">No product listed</span>';
  const items = p.packs
    .map(
      ({ product, count }) =>
        `${count} × ${esc(product.name)}${product.donated ? ' <span class="badge-donated">Donated</span>' : ''} <span class="sub">${esc(product.packLabel)}</span>`
    )
    .join('');
  return `${items}<span class="sub">Gives ${esc(fmtPlain(p.units, line.ingredient))}${
    p.store ? ` <span class="store-tag">${esc(storeName(p.store))}</span>` : ''
  }</span>`;
}

function shoppingListText(result, heading) {
  const byStore = new Map();
  for (const line of result.lines) {
    for (const { product, count } of line.purchase.packs) {
      const key = product.donated ? 'donated' : line.purchase.store ?? 'other';
      if (!byStore.has(key)) byStore.set(key, []);
      const cost = product.donated
        ? product.value
          ? ` (worth ${money(product.value * count)})`
          : ''
        : Number.isFinite(product.price)
          ? ` (${money(product.price * count)})`
          : '';
      byStore.get(key).push(`- ${count} × ${product.name} – ${product.packLabel}${cost}`);
    }
  }
  if (!byStore.size) return `${heading}\nNothing to buy.`;
  const parts = [heading];
  // Stores first, donations last
  const entries = [...byStore].sort(([a], [b]) => (a === 'donated') - (b === 'donated'));
  for (const [store, items] of entries) parts.push(`\n${store === 'donated' ? 'Donated' : storeName(store)}:\n${items.join('\n')}`);
  parts.push(`\nTotal: ${money(result.totalCost)}${result.incomplete ? ' (some prices missing)' : ''}`);
  if (result.donatedValue > 0) parts.push(`Donations worth: ${money(result.donatedValue)}`);
  return parts.join('\n');
}

function statsFor(result, restock) {
  const stats = [['Shopping total', money(result.totalCost)]];
  if (result.donatedValue > 0) stats.push(['Donations worth', money(result.donatedValue)]);
  if (isItems()) {
    if (!menuDef().sells) return stats;
    stats.push([restock ? `Takings ${words().targetWhen}` : 'Takings if all sell', money(result.revenue)]);
    if (!restock) stats.push(['Profit if all sell', money(result.revenue - result.totalCost)]);
    return stats;
  }
  const sale = ms().salePrice;
  if (!restock && result.serves > 0) {
    const revenue = result.serves * sale;
    stats.push([`Cost per ${serveNoun()}`, money(result.totalCost / result.serves)]);
    stats.push([`Takings at ${money(sale)} each`, money(revenue)]);
    stats.push(['Profit if all sell', money(revenue - result.totalCost)]);
  }
  if (restock) {
    stats.push([`${cap(serveLabel())} expected ${words().targetWhen}`, num(result.expectedServes, 0)]);
    stats.push([`Takings at ${money(sale)} each`, money(result.expectedServes * sale)]);
  }
  return stats;
}

const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

/** Restock row for something checked by eye (e.g. oil): just whether another is needed. */
function byEyeRow(l) {
  const one = unitFor(1, l.ingredient.unit);
  const share = (x) => `${num(x * 100, 0)}% of a ${esc(one)}`;
  const buy = l.purchase.packs.reduce((s, p) => s + p.count, 0);
  return `<tr>
    <td class="item"><strong>${esc(l.ingredient.name)}</strong></td>
    <td class="num" data-label="Need"><div>${share(l.needed)}<span class="sub">for ${esc(words().target)}</span></div></td>
    <td class="num" data-label="Have"><div>${
      l.percentLeft == null ? 'Not checked<span class="sub">counted as empty</span>' : `${share(l.onHand)} left`
    }</div></td>
    <td data-label="Buy"><div>${
      l.shortfall <= 0
        ? '<span class="none">No more needed</span><span class="sub">What’s left should last</span>'
        : `<strong>${buy > 1 ? `${buy} more ${esc(l.ingredient.unit)} needed` : `Another ${esc(one)} needed`}</strong>${buyCell(l)}`
    }</div></td>
    <td class="num" data-label="Cost"><div>${money(l.purchase.cost)}</div></td>
  </tr>`;
}

function resultsCard(result, { restock = false, title, counted = {}, shared = new Set() }) {
  const rows = result.lines
    .map((l) =>
      restock && l.byEye
        ? byEyeRow(l)
        : `<tr>
        <td class="item"><strong>${esc(l.ingredient.name)}</strong></td>
        <td class="num" data-label="Need"><div>${fmtQty(l.needed, l.ingredient)}</div></td>
        ${
          restock
            ? `<td class="num" data-label="Have"><div>${fmtQty(l.onHand, l.ingredient)}${
                shared.has(l.id)
                  ? `<span class="sub">this tab’s share${l.id in counted ? '' : ', estimated'}</span>`
                  : l.id in counted
                    ? ''
                    : '<span class="sub">estimated</span>'
              }</div></td>`
            : ''
        }
        <td data-label="Buy"><div>${buyCell(l)}</div></td>
        <td class="num" data-label="Cost"><div>${money(l.purchase.cost)}${
          l.purchase.donatedValue > 0
            ? `<span class="sub">donated, worth ${money(l.purchase.donatedValue)}</span>`
            : l.purchase.packs.some(({ product }) => !product.priceUpdated && !product.overridden && !product.donated && !product.custom)
              ? '<span class="sub"><span class="badge-estimate">estimate</span></span>'
              : ''
        }</div></td>
      </tr>`
    )
    .join('');

  return `<div class="card">
    <h2>${esc(title)}</h2>
    ${result.incomplete ? '<p class="notice">Some items have no price, so the total is incomplete.</p>' : ''}
    ${result.lines.length ? '' : '<p class="hint">Nothing here yet. Add or turn on items under Recipe &amp; prices.</p>'}
    <div class="table-scroll"><table class="data results">
      <thead><tr>
        <th>Item</th><th class="num">Need</th>${restock ? '<th class="num">Have</th>' : ''}<th>Buy</th><th class="num">Cost</th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table></div>
    <div class="totals">${statsFor(result, restock)
      .map(([label, value]) => `<div class="stat"><span class="label">${esc(label)}</span><span class="value">${value}</span></div>`)
      .join('')}</div>
    <div class="actions">
      <button class="primary" data-copy="list">Copy shopping list</button>
      <button class="secondary" data-copy="sheet">Copy for spreadsheet</button>
      <button class="secondary" data-print>Print</button>
    </div>
    <p class="hint small">"Copy for spreadsheet" copies a table with formulas. Paste it into cell A1 of an empty Excel or Google Sheets sheet. Change the numbers there and the packs, costs and totals update.</p>
  </div>`;
}

// ---------- Calculation wrappers ----------

function stockInBaseUnits(stock) {
  const out = {};
  for (const [id, v] of Object.entries(stock || {})) {
    const ing = catalogue.ingredients[id];
    if (ing && Number.isFinite(v)) out[id] = v * (ing.stockUnit?.size ?? 1);
  }
  return out;
}

/** Food menus (sausages, egg & bacon, your own recipes): the ones sauces and other per-serve consumables scale from. */
const foodMenuIds = () => menuIds().filter((id) => !isItems(id));

/**
 * Food serves per menu: 'plan' (planned), 'day1' (sold on day 1) or 'restock'
 * (expected on day 2). A menu that's switched off sells nothing.
 */
function servesByMenu(mode) {
  const out = {};
  for (const id of foodMenuIds()) {
    const m = ms(id);
    const sold = m.restock.sold ?? 0;
    out[id] = !isActive(id) ? 0 : mode === 'restock' ? expectedDay2(sold, pctNow()) : mode === 'day1' ? sold : m.planServes ?? 0;
  }
  return out;
}

/** One menu's plan or day 2 restock. `stock` is what it has on hand, in base units. */
function menuResult(id, mode, stock = {}) {
  const m = ms(id);
  const common = { catalogue, menuId: id, store: settings.store, bufferPct: settings.buffer, priceOverrides: settings.prices, donated: settings.donated };
  if (isItems(id)) {
    return calculateItems({
      ...common,
      itemOverrides: m.items,
      servesByMenu: servesByMenu(mode),
      ...(mode === 'restock' ? { sold: m.restock.sold, stock, day2Pct: pctNow(), percentLeft: m.restock.leftPct || {}, opening: settings.carry || {} } : {}),
    });
  }
  if (mode === 'restock') return calculateRestock({ ...common, recipeOverrides: m.recipe, sold: m.restock.sold, day2Pct: pctNow(), stock });
  return calculate({ ...common, recipeOverrides: m.recipe, serves: m.planServes });
}

/** One shopping list across several menus, with shared ingredients added up. */
function combined(ids, mode, stock = null) {
  return combineResults(
    ids.map((id) => ({ menuId: id, result: menuResult(id, mode) })),
    { catalogue, store: settings.store, stock }
  );
}

/** What day 1 used of each ingredient, across several menus. */
function usedOnDay1(ids) {
  return sumUsage(
    ids.map((id) => {
      const m = ms(id);
      return isItems(id)
        ? itemsUsage(catalogue, id, m.items, m.restock.sold, servesByMenu('day1'))
        : recipeUsage(catalogue, id, m.recipe, m.restock.sold);
    })
  );
}

const countedStock = () => stockInBaseUnits(settings.stock);

/**
 * What the day started with, in base units: the first shop, or once a
 * restock or top-up has been bought, what was carried forward from it.
 */
function startStock(ids) {
  const first = Object.fromEntries(combined(ids, 'plan').lines.map((l) => [l.id, l.purchase.units]));
  return { ...first, ...(settings.carry || {}) };
}

/**
 * Stock left now in base units, for the whole stall: what the day started
 * with minus what's been used since, unless someone has counted it.
 */
function stockNow(ids) {
  const estimates = stockLeft(startStock(ids), usedOnDay1(ids));
  return { estimates, stock: { ...estimates, ...countedStock() } };
}

/** Ingredients more than one of these menus uses (e.g. bread). */
function sharedIngredients(ids) {
  const seen = new Set();
  const shared = new Set();
  for (const id of ids) {
    for (const l of menuResult(id, 'plan').lines) (seen.has(l.id) ? shared : seen).add(l.id);
  }
  return shared;
}

/** Whether the current items menu has lines scaled from food serves. */
const hasScaledItems = (id = settings.menu) =>
  isItems(id) && effectiveItems(catalogue, id, ms(id).items).some((r) => r.enabled && Number.isFinite(r.perServe));

const planResult = (id = settings.menu) => menuResult(id, 'plan');

/** A tab's day 2 restock, using its share of the stock that's left. */
function restockResult(id = settings.menu) {
  const ids = menuSet(id);
  const needs = Object.fromEntries(
    ids.map((m) => [m, Object.fromEntries(menuResult(m, 'restock').lines.map((l) => [l.id, l.needed]))])
  );
  return menuResult(id, 'restock', stockShare(stockNow(ids).stock, needs, id));
}

/** Takings across the menus switched on: planned, or expected on day 2. */
function takingsFor(ids, mode) {
  return ids.reduce((sum, id) => {
    if (isItems(id)) return sum + (menuDef(id).sells ? menuResult(id, mode).revenue : 0);
    const m = ms(id);
    const serves = mode === 'restock' ? expectedDay2(m.restock.sold, pctNow()) : m.planServes ?? 0;
    return sum + serves * (m.salePrice ?? 0);
  }, 0);
}

function sheetText(result, mode, title) {
  // For a restock the sheet takes day 1 sales and scales them by the day 2 % itself
  const serves = servesByMenu(mode === 'restock' ? 'day1' : 'plan');
  const foodServes = foodMenuIds().map((id) => ({
    id,
    label: `${cap(serveLabel(id))} ${mode === 'restock' ? `sold ${words().soldWhen}` : 'to sell'}`,
    serves: serves[id],
  }));
  return toTSV(
    buildSheet({
      kind: isItems() ? 'items' : 'recipe',
      mode,
      result,
      title,
      serveLabel: serveLabel(),
      serveNoun: serveNoun(),
      bufferPct: settings.buffer,
      salePrice: ms().salePrice,
      sells: Boolean(menuDef().sells),
      foodServes,
      day2Pct: pctNow(),
      storeName,
      words: words(),
    })
  );
}

// ---------- Rendering: results (re-rendered on every change) ----------

function renderPlanResults() {
  const result = planResult();
  const menu = menuDef();
  const title = isItems()
    ? `${menu.name} shopping list`
    : `Shopping list for ${num(result.serves, 0)} ${serveLabel()}`;
  const heading = isItems() ? `Snag Calc – ${menu.name}` : `Snag Calc – ${num(result.serves, 0)} ${serveLabel()}`;
  const el = $('#plan-results');
  el.innerHTML = resultsCard(result, { title });
  wireActions(el, {
    list: () => shoppingListText(result, heading),
    sheet: () => sheetText(result, 'plan', heading),
  });
}

/** Show the leftover estimates as placeholders until someone counts. */
function showStockEstimates(estimates) {
  for (const input of document.querySelectorAll('#restock-inputs [data-stock]')) {
    const ing = catalogue.ingredients[input.dataset.stock];
    const est = (estimates[input.dataset.stock] ?? 0) / (ing?.stockUnit?.size ?? 1);
    input.placeholder = `${num(est, 1)} (est.)`;
  }
}

/** "Day 2: expect 150 sausages (50% of 300)." under each food menu's day 1 sales. */
function showDay2Summaries() {
  for (const el of document.querySelectorAll('#restock-inputs [data-summary]')) {
    const id = el.dataset.summary;
    const sold = ms(id).restock.sold ?? 0;
    el.textContent = `${cap(words().target)}: expect ${num(expectedDay2(sold, pctNow()), 0)} ${serveLabel(id)} (${num(pctNow(), 0)}% of ${num(sold, 0)}).`;
  }
}

function renderRestockResults() {
  const result = restockResult();
  const menu = menuDef();
  const w = words();
  const heading = isItems()
    ? `Snag Calc – ${menu.name}, ${w.title.toLowerCase()} (${num(pctNow(), 0)}% of sales ${w.soldWhen})`
    : `Snag Calc – ${w.title.toLowerCase()}, ${num(result.expectedServes, 0)} ${serveLabel()}`;
  const ids = menuSet(settings.menu);
  showDay2Summaries();
  showStockEstimates(stockNow(ids).estimates);
  const el = $('#restock-results');
  el.innerHTML = resultsCard(result, {
    restock: true,
    title: `${menu.name}: ${w.title.toLowerCase()}`,
    counted: countedStock(),
    shared: sharedIngredients(ids),
  });
  wireActions(el, {
    list: () => shoppingListText(result, heading),
    sheet: () => sheetText(result, 'restock', heading),
  });
}

// ---------- The Shop tab: one list for everything, split by store ----------

const isEstimate = (p) => !p.priceUpdated && !p.overridden && !p.donated && !p.custom;

/** Where to look a product up: its own page, or the Woolworths page for its stockcode. */
const productUrl = (p) =>
  p.url || (p.store === 'woolworths' && p.stockcode ? `https://www.woolworths.com.au/shop/productdetails/${encodeURIComponent(p.stockcode)}` : null);

function shopItemRow({ line, product, count, cost }, mode) {
  const ing = line.ingredient;
  const why = line.byEye
    ? line.percentLeft == null
      ? 'not checked, counted as empty'
      : `${num(line.percentLeft, 0)}% left`
    : mode === 'restock'
      ? `need ${fmtPlain(line.needed, ing)}, have ${fmtPlain(line.onHand, ing)}`
      : `need ${fmtPlain(line.needed, ing)}`;
  const url = productUrl(product);
  const ticked = settings.ticks[mode]?.[product.id] === count;
  return `<li><label class="shop-item">
    <input type="checkbox" data-tick="${esc(product.id)}" data-count="${count}" ${ticked ? 'checked' : ''} aria-label="Got ${esc(product.name)}">
    <span class="what"><strong>${count} ×</strong> ${esc(product.name)}
      <span class="sub">${esc(product.packLabel)} · ${esc(ing.name)}: ${esc(why)}${
        url ? ` · <a href="${esc(url)}" target="_blank" rel="noopener">View</a>` : ''
      }</span></span>
    <span class="cost">${
      product.donated
        ? `<span class="badge-donated">Donated</span>${product.value ? `<span class="sub">worth ${money(product.value * count)}</span>` : ''}`
        : `${money(cost)}${isEstimate(product) ? '<span class="sub"><span class="badge-estimate">estimate</span></span>' : ''}`
    }</span>
  </label></li>`;
}

function shopResultsHTML(result, mode, ids) {
  const restock = mode === 'restock';
  if (!ids.length) {
    return `<div class="card"><p class="hint">Nothing is switched on. ${
      restock ? 'Switch on what you’re selling on the Plan view.' : 'Switch on what you’re selling above.'
    }</p></div>`;
  }
  const { groups, donated, missing } = byStore(result, Object.keys(catalogue.stores));
  const takings = takingsFor(ids, mode);
  const stats = [['Shopping total', money(result.totalCost)]];
  if (groups.length > 1) for (const g of groups) stats.push([storeName(g.store), money(g.cost)]);
  if (result.donatedValue > 0) stats.push(['Donations worth', money(result.donatedValue)]);
  stats.push([restock ? `Takings ${words().targetWhen}` : 'Takings if all sell', money(takings)]);
  if (!restock) stats.push(['Profit if all sell', money(takings - result.totalCost)]);
  const enough = restock ? result.lines.filter((l) => l.shortfall <= 0) : [];
  const nothing = !groups.length && !donated.length;

  const summary = `<div class="card">
    <h2>${restock ? esc(words().title) : 'First shop'}</h2>
    <p class="hint">${esc(ids.map(menuLabel).join(', '))}${
      settings.store === 'cheapest' ? ', from whichever store is cheaper for each item' : `, all from ${esc(storeName(settings.store))}`
    }.</p>
    ${result.incomplete && !missing.length ? '<p class="notice">Some items have no price, so the total is incomplete.</p>' : ''}
    ${
      missing.length
        ? `<p class="notice">Not on the price list for ${esc(storeName(settings.store))}: ${esc(missing.map((l) => l.ingredient.name).join(', '))}. They’re left off the total. Change “Shop at” to buy them elsewhere.</p>`
        : ''
    }
    <div class="totals">${stats
      .map(([label, value]) => `<div class="stat"><span class="label">${esc(label)}</span><span class="value">${value}</span></div>`)
      .join('')}</div>
    <div class="actions">
      <button class="primary" data-copy="list">Copy shopping list</button>
      <button class="secondary" data-copy="sheet">Copy for spreadsheet</button>
      <button class="secondary" data-print>Print</button>
      <button class="secondary" data-share>Share plan</button>
    </div>
  </div>`;

  const storeCards = groups
    .map(
      (g) => `<div class="card store-card">
      <h2>${esc(storeName(g.store))}<span class="store-total">${money(g.cost)}</span></h2>
      <ul class="shop-list">${g.items.map((it) => shopItemRow(it, mode)).join('')}</ul>
    </div>`
    )
    .join('');
  const donatedCard = donated.length
    ? `<div class="card store-card">
      <h2>Donated<span class="store-total">worth ${money(result.donatedValue)}</span></h2>
      <ul class="shop-list">${donated.map((it) => shopItemRow(it, mode)).join('')}</ul>
    </div>`
    : '';
  const tail =
    nothing || enough.length
      ? `<div class="card">${nothing ? '<p class="none">Nothing to buy.</p>' : ''}${
          enough.length ? `<p class="hint">Enough left already: ${esc(enough.map((l) => l.ingredient.name).join(', '))}.</p>` : ''
        }</div>`
      : '';
  // Once it's bought, the stock on the stall has changed: carry it forward
  const d = dayNow();
  const done = !restock
    ? ''
    : topUp()
      ? `<div class="card done-card">
      <h2>Bought the top-up?</h2>
      <p class="hint">Add it to today’s stock, so the next restock knows it’s there. Sales so far stay as they are.</p>
      <div class="actions"><button type="button" class="primary" data-roll="today">Add it to today’s stock</button></div>
    </div>`
      : `<div class="card done-card">
      <h2>Bought it? Start day ${d + 1}</h2>
      <p class="hint">What’s left plus this list becomes day ${d + 1}’s starting stock. Day ${d}’s sales and counts are cleared, ready for day ${d + 1}’s.</p>
      <div class="actions"><button type="button" class="primary" data-roll="next">Start day ${d + 1}</button></div>
    </div>`;
  return summary + storeCards + donatedCard + tail + done;
}

/** The combined list as a plain table for a spreadsheet: one row per product to buy. */
function shopSheetText(result, title) {
  return toTSV(
    buildSheet({
      kind: 'items',
      mode: 'plan',
      result: { lines: result.lines.map((l) => ({ ...l, planned: l.shortfall })) },
      title,
      storeName,
    })
  );
}

function renderShopResults() {
  const ids = activeMenus();
  for (const mode of ['plan', 'restock']) {
    const restock = mode === 'restock';
    const now = restock ? stockNow(ids) : null;
    const result = combined(ids, mode, now?.stock);
    const heading = `Snag Calc – ${restock ? `${words().title.toLowerCase()} (${num(pctNow(), 0)}% of sales ${words().soldWhen})` : 'first shop'}`;
    const el = $(`#${mode}-results`);
    el.innerHTML = shopResultsHTML(result, mode, ids);
    wireActions(el, {
      list: () => shoppingListText(result, heading),
      sheet: () => shopSheetText(result, `${heading}, to buy`),
    });
    if (restock) {
      showDay2Summaries();
      showStockEstimates(now.estimates);
    }
  }
}

function renderResults() {
  if (onShop()) return renderShopResults();
  renderPlanResults();
  renderRestockResults();
}

// ---------- Rendering: inputs (re-rendered when the menu changes) ----------

/** e.g. "200 sausages and 100 sandwiches" (planned, or still to sell for a restock). */
function foodServesText(mode = 'plan') {
  const serves = servesByMenu(mode);
  const parts = foodMenuIds()
    .filter(isActive)
    .map((id) => `${num(serves[id], 0)} ${serveLabel(id)}`);
  return parts.length ? parts.join(' and ') : 'no food switched on';
}

/** "sausage or sandwich", for the menus a per-serve line scales from. */
function perServeLabel(r) {
  const ids = (r.servesFrom ?? foodMenuIds()).filter((id) => catalogue.menu[id]);
  return ids.map((id) => serveNoun(id)).join(' or ') || 'serve';
}

/**
 * The plan inputs for one menu. `embedded` is for the Shop tab, where each
 * menu is a section of one page.
 */
function planInputsHTML(id, embedded = false) {
  const m = ms(id);
  const menu = menuDef(id);
  if (!isItems(id)) {
    const empty = !effectiveRecipe(catalogue, id, m.recipe).some((r) => r.enabled);
    return `<div class="grid-2">
      <label class="big-input">How many ${esc(serveLabel(id))} do you want to sell?
        <input data-field="planServes" type="number" min="0" step="10" inputmode="numeric" value="${valueAttr(m.planServes)}">
      </label>
      <label>Sale price per ${esc(serveNoun(id))}
        <span class="input-prefix"><span>$</span><input data-field="salePrice" type="number" min="0" step="0.5" inputmode="decimal" value="${valueAttr(m.salePrice)}"></span>
      </label>
    </div>${
      empty
        ? `<p class="hint recipe-empty">This recipe has no ingredients yet. <button type="button" class="link" data-goto-choose="${esc(id)}">Add what goes into each ${esc(serveNoun(id))}</button></p>`
        : ''
    }`;
  }
  const items = effectiveItems(catalogue, id, m.items).filter((r) => r.enabled);
  const scaled = items.some((r) => Number.isFinite(r.perServe));
  const choose = `<button type="button" class="link" data-goto-choose="${esc(id)}">${
    menu.sells ? `Choose ${esc(menu.name.toLowerCase())} or add your own` : 'Add or remove items'
  }</button>`;
  const hint = menu.sells
    ? `How many of each do you want to sell? Set the sale price for each one too. ${choose}`
    : `${
        scaled
          ? embedded
            ? 'Sauces are worked out from the food above. Set how much each serve uses. '
            : `Sauces are worked out from your plans on the other tabs: <strong>${esc(foodServesText())}</strong>. Set how much each one uses. `
          : ''
      }For everything else, enter how many you need for the event. Napkins are usually about 1 per serve. ${choose}`;
  return `${embedded ? '' : `<h2>${esc(menu.name)}</h2>`}
    <p class="hint">${hint}</p>
    ${items.length ? '' : '<p class="hint">Nothing selected. Turn items on under Recipe &amp; prices.</p>'}
    <div class="item-grid">${items
      .map((r) => {
        const ing = catalogue.ingredients[r.ingredient];
        return `<div class="item-row">
          <span class="item-name">${esc(ing.name)}${r.note ? `<span class="sub">${esc(r.note)}</span>` : ''}</span>
          ${
            Number.isFinite(r.perServe)
              ? `<label>Per ${esc(perServeLabel(r))}
            <span class="input-suffix"><input type="number" min="0" step="any" inputmode="decimal" data-per-item="${esc(r.ingredient)}" value="${valueAttr(r.perServe)}"><span>${esc(ing.unit)}</span></span>
          </label>`
              : `<label>Quantity
            <span class="input-suffix"><input type="number" min="0" step="1" inputmode="numeric" data-qty="${esc(r.ingredient)}" value="${valueAttr(r.quantity)}"><span>${esc(ing.unit)}</span></span>
          </label>`
          }
          ${
            menu.sells
              ? `<label>Sale price each
            <span class="input-prefix"><span>$</span><input type="number" min="0" step="0.5" inputmode="decimal" data-sale="${esc(r.ingredient)}" value="${valueAttr(r.salePrice)}"></span>
          </label>`
              : ''
          }
        </div>`;
      })
      .join('')}</div>`;
}

/** Shown on a tab that's switched off, so it isn't a surprise that the Shop list leaves it out. */
const offNotice = (id) =>
  isActive(id)
    ? ''
    : `<p class="notice">${esc(menuLabel(id))} is switched off, so it isn’t on the Shop list. <button type="button" class="link" data-activate="${esc(id)}">Switch it on</button></p>`;

function renderPlanInputs() {
  const id = settings.menu;
  $('#plan-inputs').innerHTML = `<div data-menu-id="${esc(id)}">${offNotice(id)}${planInputsHTML(id)}</div>`;
}

/** Whether the restock is for tomorrow or a top-up for the rest of today. */
function restockForField() {
  const d = dayNow();
  const pick = (value, label) =>
    `<button type="button" class="chip" data-restock-for="${value}" aria-pressed="${(settings.restockFor === 'today') === (value === 'today')}">${label}</button>`;
  return `<div class="pct-field restock-for">
    <span class="field-label">Buying for</span>
    <div class="chip-row" role="group" aria-label="Buying for">${pick('next', `Day ${d + 1}`)}${pick('today', 'The rest of today')}</div>
  </div>`;
}

/** The % field, shared by every tab, with quick picks: how busy the time being bought for will be. */
function day2PctField() {
  const picks = topUp() ? [25, 50, 100] : [50, 75, 100];
  return `${restockForField()}<div class="pct-field">
    <label>${esc(words().pctLabel)}
      <span class="input-suffix"><input data-field="day2Pct" type="number" min="0" step="5" inputmode="numeric" value="${valueAttr(pctNow())}"><span>%</span></span>
    </label>
    <div class="chip-row" role="group" aria-label="Quick picks">${picks
      .map((p) => `<button type="button" class="chip" data-pct="${p}" aria-pressed="${pctNow() === p}">${p}%</button>`)
      .join('')}</div>
  </div>`;
}

const leftoverHint = () =>
  `Left over is worked out from what ${
    settings.carry ? 'the day started with' : 'the first shop bought'
  }, minus what’s been used since. Count what’s really left and type it in to replace an estimate.`;

/** "After day 1, enter … Snag Calc works out what to buy for day 2, using up what's left first." */
const restockIntro = (what) => {
  const w = words();
  return `${w.after}, enter ${what} and how busy you expect ${w.target} to be. Snag Calc works out what to buy for ${w.target}, using up what’s left first.`;
};

function stockField(ingredientId, label) {
  const ing = catalogue.ingredients[ingredientId];
  const step = (ing.stockUnit?.size ?? 1) > 1 ? '0.1' : '1';
  return `<label>${esc(label)}
    <span class="input-suffix"><input type="number" min="0" step="${step}" inputmode="decimal"
      data-stock="${esc(ingredientId)}" value="${valueAttr(settings.stock[ingredientId])}" placeholder="0"><span>${esc(ing.stockUnit?.label ?? ing.unit)}</span></span>
  </label>`;
}

/**
 * The day 2 restock inputs for one menu. On the Shop tab (`embedded`) each
 * ingredient's stock is asked for once: `seen` holds the ones already shown.
 */
function restockInputsHTML(id, { embedded = false, seen = new Set() } = {}) {
  const m = ms(id);
  if (!isItems(id)) {
    const label = serveLabel(id);
    const recipe = effectiveRecipe(catalogue, id, m.recipe).filter((r) => r.enabled);
    const fresh = recipe.filter((r) => !seen.has(r.ingredient));
    const above = recipe.filter((r) => seen.has(r.ingredient)).map((r) => catalogue.ingredients[r.ingredient].name);
    for (const r of recipe) seen.add(r.ingredient);
    const shared = embedded ? new Set() : sharedIngredients(menuSet(id));
    return `${
      embedded
        ? ''
        : `<p class="hint">${restockIntro('how many sold')}</p>`
    }
      <div class="grid-2">
        <label>${esc(cap(label))} sold ${esc(words().soldWhen)}
          <input data-field="restock.sold" type="number" min="0" step="1" inputmode="numeric" value="${valueAttr(m.restock.sold)}">
        </label>
        ${embedded ? '' : day2PctField()}
      </div>
      <p class="summary" data-summary="${esc(id)}"></p>
      <h3>Stock left over</h3>
      ${embedded ? '' : `<p class="hint">${leftoverHint()}${shared.size ? ' Count everything on the stall: what’s shared with another tab is split between them.' : ''}</p>`}
      <div class="stock-grid">${fresh.map((r) => stockField(r.ingredient, catalogue.ingredients[r.ingredient].name)).join('')}</div>
      ${above.length ? `<p class="hint small">${esc(above.join(', '))}: counted above.</p>` : ''}`;
  }
  const items = effectiveItems(catalogue, id, m.items).filter((r) => r.enabled);
  const scaled = items.some((r) => Number.isFinite(r.perServe));
  const did = menuDef(id).sells ? 'sold' : 'used';
  return `${
    embedded
      ? ''
      : `<p class="hint">${restockIntro(`how many of each were ${did}`)}${
          scaled
            ? ` Sauces follow the food sales expected (from sales on their Restock tabs): <strong>${esc(foodServesText('restock'))}</strong>.`
            : ''
        }</p>
    <div class="grid-2">${day2PctField()}</div>
    <p class="hint">${leftoverHint()}</p>`
  }
    <div class="item-grid">${items
      .map((r) => {
        const ing = catalogue.ingredients[r.ingredient];
        const perServe = Number.isFinite(r.perServe);
        if (r.restock === 'percentLeft') {
          // Checked by eye: how much of the bottle is left
          return `<div class="item-row">
          <span class="item-name">${esc(ing.name)}<span class="sub">Planned: ${num(r.quantity, 0)} ${esc(unitFor(r.quantity, ing.unit))}. An unopened one counts as 100%.</span></span>
          <label class="span-all">How much of the ${esc(unitFor(1, ing.unit))} is left?
            <span class="input-suffix"><input type="number" min="0" step="5" inputmode="numeric" data-left-pct="${esc(r.ingredient)}"
              value="${valueAttr(m.restock.leftPct?.[r.ingredient])}" placeholder="e.g. 40"><span>%</span></span>
          </label>
        </div>`;
        }
        seen.add(r.ingredient);
        return `<div class="item-row">
          <span class="item-name">${esc(ing.name)}<span class="sub">${
            perServe
              ? `${num(r.perServe, 1)} ${esc(ing.unit)} per ${esc(perServeLabel(r))}`
              : `Planned: ${num(r.quantity, 0)} ${esc(ing.unit)}`
          }</span></span>
          ${
            perServe
              ? '<span aria-hidden="true"></span>'
              : `<label>${cap(did)} ${esc(words().soldWhen)}
            <span class="input-suffix"><input type="number" min="0" step="1" inputmode="numeric" data-sold="${esc(r.ingredient)}"
              value="${valueAttr(m.restock.sold[r.ingredient])}" placeholder="0"><span>${esc(ing.unit)}</span></span>
          </label>`
          }
          ${stockField(r.ingredient, 'Left over')}
        </div>`;
      })
      .join('')}</div>`;
}

function renderRestockInputs() {
  const id = settings.menu;
  $('#restock-inputs').innerHTML = `<div data-menu-id="${esc(id)}">${offNotice(id)}${restockInputsHTML(id)}</div>`;
}

// ---------- The Shop tab's inputs: every menu as a section of one page ----------

// Which sections are folded open, kept while the page is open
const shopOpen = { plan: {}, restock: {} };

function shopSection(id, mode, body, sub = '') {
  const m = menuDef(id);
  const on = isActive(id);
  const open = shopOpen[mode][id] ?? (mode === 'restock' || !isItems(id));
  return `<details class="menu-section${on ? '' : ' off'}" data-menu-id="${esc(id)}" data-mode="${mode}" ${on && open ? 'open' : ''}>
    <summary>
      <span class="icon" aria-hidden="true">${esc(m.icon ?? '')}</span>
      <span class="section-title">${esc(menuLabel(id))}${sub ? `<span class="sub">${esc(sub)}</span>` : ''}</span>
      ${
        mode === 'plan'
          ? `<input type="checkbox" class="switch" role="switch" data-active="${esc(id)}" ${on ? 'checked' : ''} aria-label="Selling ${esc(m.name)}">`
          : ''
      }
    </summary>
    ${on ? `<div class="section-body">${body}</div>` : ''}
  </details>`;
}

/** "Pepsi, Pepsi Max, Solo +1" for an items menu's section heading. */
function itemsSummary(id) {
  const names = effectiveItems(catalogue, id, ms(id).items)
    .filter((r) => r.enabled)
    .map((r) => catalogue.ingredients[r.ingredient].name);
  return names.length > 3 ? `${names.slice(0, 3).join(', ')} +${names.length - 3}` : names.join(', ');
}

function renderShopInputs() {
  $('#plan-inputs').innerHTML = `<h2>What are you selling?</h2>
    <p class="hint">Switch on what’s on the menu and set how many. The list below adds it all up and splits it by store. Anything two menus share, like bread, is bought once.</p>
    ${menuIds()
      .map((id) => shopSection(id, 'plan', planInputsHTML(id, true), isItems(id) ? itemsSummary(id) : isActive(id) ? '' : 'Not selling'))
      .join('')}
    <div class="actions"><button type="button" class="secondary" data-new-recipe>Add your own recipe</button></div>`;

  const ids = activeMenus();
  const seen = new Set();
  $('#restock-inputs').innerHTML = `<h2>${esc(words().title)}</h2>
    <p class="hint">${restockIntro('what sold')} ${leftoverHint()}</p>
    <div class="grid-2">${day2PctField()}</div>
    ${ids.length ? '' : '<p class="hint">Nothing is switched on. Switch on what you’re selling on the Plan view.</p>'}
    ${ids.map((id) => shopSection(id, 'restock', restockInputsHTML(id, { embedded: true, seen }))).join('')}`;
}

// ---------- Recipe & prices ----------

function renderRecipeTable() {
  if (onShop()) {
    // No one recipe here: list the user's own recipes instead
    $('#recipe-title').textContent = 'Your own recipes';
    $('#recipe-hint').textContent =
      'Selling something that isn’t listed, like burgers or pancakes? Add it as your own recipe: say what goes into each one and Snag Calc plans, shops and restocks it like the rest.';
    $('#recipe-table').innerHTML = '';
    $('#custom-items').innerHTML = `${
      settings.customMenus.length
        ? `<ul class="recipe-list">${settings.customMenus
            .filter((m) => catalogue.menu[m.id])
            .map(
              (m) => `<li><span><span aria-hidden="true">${esc(catalogue.menu[m.id].icon)}</span> ${esc(catalogue.menu[m.id].name)}</span>
              <button type="button" class="secondary" data-open-menu="${esc(m.id)}">Open</button></li>`
            )
            .join('')}</ul>`
        : ''
    }<div class="actions"><button type="button" class="primary" data-new-recipe>Add your own recipe</button></div>`;
    return;
  }
  const m = ms();
  const menu = menuDef();
  const removeBtn = (r) =>
    r.custom ? `Added by you <button type="button" class="link danger" data-remove-custom="${esc(r.customId)}">Remove</button>` : esc(r.note ?? '');
  if (isItems()) {
    const sells = Boolean(menu.sells);
    $('#recipe-title').textContent = sells ? `Choose ${menu.name.toLowerCase()}` : 'Items';
    $('#recipe-hint').textContent = sells
      ? `Tick the ${menu.name.toLowerCase()} you're selling, or add your own below. Set how many on the Plan tab.`
      : "Untick anything you don't need, or add your own below. Set quantities on the Plan tab.";
    const items = effectiveItems(catalogue, settings.menu, m.items);
    $('#recipe-table').innerHTML = `<thead><tr><th>Use</th><th>Item</th><th>Notes</th></tr></thead>
      <tbody>${items
        .map((r) => {
          const ing = catalogue.ingredients[r.ingredient];
          return `<tr>
            <td><input type="checkbox" data-enable="${esc(r.ingredient)}" ${r.enabled ? 'checked' : ''} aria-label="Use ${esc(ing.name)}"></td>
            <td>${esc(ing.name)}</td>
            <td class="sub">${removeBtn(r)}</td>
          </tr>`;
        })
        .join('')}</tbody>`;
  } else {
    const noun = serveNoun();
    $('#recipe-title').textContent = `Recipe (per ${noun})`;
    const recipe = effectiveRecipe(catalogue, settings.menu, m.recipe);
    $('#recipe-hint').textContent = recipe.length
      ? `Untick the items you don't need, change how much each ${noun} uses, or add another ingredient below.`
      : `Add what goes into each ${noun} below.`;
    $('#recipe-table').innerHTML = recipe.length
      ? `<thead><tr><th>Use</th><th>Item</th><th>Per ${esc(noun)}</th><th>Notes</th></tr></thead>
    <tbody>${recipe
      .map((r) => {
        const ing = catalogue.ingredients[r.ingredient];
        return `<tr>
          <td><input type="checkbox" data-enable="${esc(r.ingredient)}" ${r.enabled ? 'checked' : ''} aria-label="Use ${esc(ing.name)}"></td>
          <td>${esc(ing.name)}</td>
          <td><span class="input-suffix"><input type="number" min="0" step="any" inputmode="decimal" data-per="${esc(r.ingredient)}" value="${r.perServe}" aria-label="${esc(ing.name)} per ${esc(noun)}"><span>${esc(ing.unit)}</span></span></td>
          <td class="sub">${removeBtn(r)}</td>
        </tr>`;
      })
      .join('')}</tbody>`
      : '';
  }
  renderCustomForm();
}

// ---------- The user's own items and recipes ----------

function rebuildCatalogue() {
  catalogue = withCustomItems(withCustomMenus(baseCatalogue, settings.customMenus), settings.customItems);
}

/** Ingredients a recipe could reuse: anything a food menu already uses that this one doesn't. */
function reusableIngredients(id) {
  const mine = new Set(menuDef(id).recipe.map((r) => r.ingredient));
  const out = new Set();
  for (const other of foodMenuIds()) for (const r of catalogue.menu[other].recipe) if (!mine.has(r.ingredient)) out.add(r.ingredient);
  return [...out];
}

function renderCustomForm() {
  const id = settings.menu;
  const menu = menuDef(id);
  const items = isItems(id);
  const noun = !items ? 'ingredient' : menu.sells ? menu.name.toLowerCase().replace(/s$/, '') : 'item';
  const stores = Object.entries(catalogue.stores)
    .map(([sid, st]) => `<option value="${esc(sid)}">${esc(st.name)}</option>`)
    .join('');
  const reuse = items ? [] : reusableIngredients(id);
  $('#custom-items').innerHTML = `<form class="custom-form" novalidate>
    <h3>Add ${/^[aeiou]/.test(noun) ? 'an' : 'a'} ${esc(noun)}</h3>
    <div class="custom-grid">
      ${
        reuse.length
          ? `<label class="wide">What is it?
        <select name="ingredient">
          <option value="">Something new…</option>
          ${reuse.map((i) => `<option value="${esc(i)}">${esc(catalogue.ingredients[i].name)}</option>`).join('')}
        </select>
      </label>`
          : ''
      }
      <label class="wide" data-new-only>Name
        <input type="text" name="name" required maxlength="60" placeholder="${
          items ? (menu.sells ? 'e.g. Lift, iced tea, juice boxes' : 'e.g. Foil trays, tongs, ice') : 'e.g. Burger patties, cheese slices, rolls'
        }" autocomplete="off">
      </label>
      <label data-new-only>${menu.sells ? 'Comes in' : 'Counted in'}
        ${
          menu.sells
            ? '<select name="unit"><option value="cans">Cans</option><option value="bottles">Bottles</option><option value="poppers">Poppers</option></select>'
            : `<input type="text" name="unit" maxlength="20" list="unit-options" placeholder="e.g. patties, slices, g" autocomplete="off" autocapitalize="none">
        <datalist id="unit-options">${['patties', 'rolls', 'buns', 'slices', 'pieces', 'items', 'g', 'ml'].map((u) => `<option value="${u}">`).join('')}</datalist>`
        }
      </label>
      <label data-new-only>How many in a pack
        <input type="number" name="packSize" min="1" step="1" inputmode="numeric" value="${menu.sells ? 24 : ''}" placeholder="${menu.sells ? '' : 'e.g. 12, or 500 for 500 g'}" required>
      </label>
      <label data-new-only>Pack price
        <span class="input-prefix"><span>$</span><input type="number" name="price" min="0" step="0.01" inputmode="decimal" required placeholder="0.00"></span>
      </label>
      <label data-new-only>Store
        <select name="store">${stores}</select>
      </label>
      ${
        !items
          ? `<label>How much per ${esc(serveNoun(id))}
        <input type="number" name="perServe" min="0" step="any" inputmode="decimal" value="1">
      </label>`
          : `${
              menu.sells
                ? `<label>Sale price each
        <span class="input-prefix"><span>$</span><input type="number" name="salePrice" min="0" step="0.5" inputmode="decimal" value="2"></span>
      </label>`
                : ''
            }
      <label>How many to ${menu.sells ? 'sell' : 'get'}
        <input type="number" name="quantity" min="0" step="1" inputmode="numeric" value="${menu.sells ? 24 : 1}">
      </label>`
      }
    </div>
    <p class="notice" data-custom-error hidden></p>
    <div class="actions"><button type="submit" class="primary">Add ${esc(noun)}</button></div>
  </form>${
    menu.custom
      ? `<div class="actions recipe-admin">
      <button type="button" class="secondary" data-edit-recipe="${esc(id)}">Rename recipe</button>
      <button type="button" class="secondary danger" data-delete-recipe="${esc(id)}">Delete recipe</button>
    </div>`
      : ''
  }`;
}

const slugOf = (name) => name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 30) || 'item';

function addCustomItem(form) {
  const f = new FormData(form);
  const menu = menuDef();
  const existing = String(f.get('ingredient') || '');
  const name = String(f.get('name') || '').trim();
  const packSize = toNumber(f.get('packSize'));
  const price = toNumber(f.get('price'));
  const error = existing
    ? ''
    : !name
      ? 'Give it a name.'
      : !(packSize >= 1)
        ? 'Enter how many come in a pack.'
        : price == null || !(price >= 0)
          ? 'Enter the pack price.'
          : '';
  if (error) {
    const el = form.querySelector('[data-custom-error]');
    el.textContent = error;
    el.hidden = false;
    return;
  }
  const amounts = {
    quantity: Math.max(0, toNumber(f.get('quantity')) ?? 0),
    perServe: Math.max(0, toNumber(f.get('perServe')) ?? 1),
    salePrice: Math.max(0, toNumber(f.get('salePrice')) ?? 0),
  };
  const stamp = Date.now().toString(36);
  settings.customItems.push(
    existing
      ? { id: `custom-use-${slugOf(existing)}-${stamp}`, menu: settings.menu, ingredient: existing, ...amounts }
      : {
          id: `custom-${slugOf(name)}-${stamp}`,
          menu: settings.menu,
          name,
          unit: String(f.get('unit') || '').trim().toLowerCase() || (menu.sells ? 'cans' : 'items'),
          packSize: Math.round(packSize),
          price,
          store: String(f.get('store')),
          ...amounts,
        }
  );
  save();
  rebuildCatalogue();
  renderMenu();
  $('#custom-items [name=name]')?.focus();
}

/**
 * Asks "are you sure?" in Snag Calc's own dialog rather than the browser's confirm box. Resolves true when
 * the action is confirmed; Cancel, Escape or a tap outside resolve false.
 */
function confirmAction({ title, message = '', confirmLabel, danger = false }) {
  const dlg = $('#confirm');
  $('#confirm-title').textContent = title;
  $('#confirm-text').textContent = message;
  $('#confirm-text').hidden = !message;
  const ok = $('#confirm-ok');
  ok.textContent = confirmLabel;
  ok.classList.toggle('danger', danger);
  dlg.returnValue = 'cancel';
  return new Promise((resolve) => {
    const onClose = () => resolve(dlg.returnValue === 'ok');
    dlg.addEventListener('close', onClose, { once: true });
    if (typeof dlg.showModal === 'function') dlg.showModal();
    else dlg.setAttribute('open', '');
    // Something that can't be undone starts on Cancel, so Enter doesn't go ahead by accident
    (danger ? dlg.querySelector('[value=cancel]') : ok).focus();
  });
}

/** Forget everything saved about one of the user's own ingredients. */
function forgetIngredient(id) {
  const productId = `${id}-pack`;
  delete settings.prices[productId];
  delete settings.donated[productId];
  delete settings.stock[id];
  for (const m of Object.values(settings.menus)) {
    if (m.items) delete m.items[id];
    if (m.recipe) delete m.recipe[id];
    if (m.restock?.sold && typeof m.restock.sold === 'object') delete m.restock.sold[id];
  }
  // Recipes that reused it lose it too
  settings.customItems = settings.customItems.filter((it) => it.ingredient !== id);
}

/** Take one of the user's own items off its menu (without asking). */
function dropCustomItem(item) {
  settings.customItems = settings.customItems.filter((it) => it.id !== item.id);
  if (item.ingredient) {
    // An ingredient from the price list, reused: only this menu's settings for it go
    const m = settings.menus[item.menu];
    if (m?.recipe) delete m.recipe[item.ingredient];
    if (m?.items) delete m.items[item.ingredient];
  } else {
    forgetIngredient(item.id);
  }
}

async function removeCustomItem(id) {
  const item = settings.customItems.find((it) => it.id === id);
  if (!item) return;
  const name = item.ingredient ? catalogue.ingredients[item.ingredient]?.name ?? 'this' : item.name;
  const sure = await confirmAction({
    title: `Remove ${name}?`,
    message: item.ingredient
      ? `It comes out of ${menuDef(item.menu)?.name ?? 'this recipe'}. Other tabs that use it keep it.`
      : 'It comes off every list, with its price and any counts entered for it.',
    confirmLabel: 'Remove',
    danger: true,
  });
  if (!sure) return;
  dropCustomItem(item);
  save();
  rebuildCatalogue();
  renderMenu();
}

// The user's own recipes (extra menus)

const RECIPE_ICONS = ['🍔', '🥓', '🌯', '🥪', '🥞', '🍗', '🌽', '🍟', '🧁', '🍪', '☕', '🍦'];

/** Opens the sheet for a new recipe, or to rename one (`id`). */
function openRecipeDialog(id = null) {
  const cur = id ? settings.customMenus.find((m) => m.id === id) : null;
  const icon = cur?.icon ?? RECIPE_ICONS[0];
  const dlg = $('#recipe-dialog');
  dlg.innerHTML = `<form novalidate data-recipe-id="${esc(id ?? '')}">
    <h2 id="recipe-dialog-title">${cur ? 'Rename recipe' : 'Add your own recipe'}</h2>
    ${cur ? '' : '<p class="hint">Something you sell by the serve, like burgers. You’ll add what goes into each one next.</p>'}
    <label>What are you selling?
      <input type="text" name="name" maxlength="30" required placeholder="e.g. Burgers" value="${esc(cur?.name ?? '')}" autocomplete="off">
    </label>
    <label>One of them is a…
      <input type="text" name="serveNoun" maxlength="30" placeholder="e.g. burger" value="${esc(cur?.serveNoun ?? '')}" autocomplete="off" autocapitalize="none">
    </label>
    <fieldset class="icon-choices"><legend>Icon</legend>${RECIPE_ICONS.map(
      (i) => `<label><input type="radio" name="icon" value="${i}" ${i === icon ? 'checked' : ''}><span aria-hidden="true">${i}</span></label>`
    ).join('')}</fieldset>
    ${
      cur
        ? ''
        : `<div class="grid-2 tight">
      <label>How many to sell
        <input type="number" name="serves" min="0" step="10" inputmode="numeric" value="100">
      </label>
      <label>Sale price each
        <span class="input-prefix"><span>$</span><input type="number" name="salePrice" min="0" step="0.5" inputmode="decimal" value="5"></span>
      </label>
    </div>`
    }
    <p class="notice" data-recipe-error hidden>Give it a name.</p>
    <div class="confirm-actions">
      <button type="button" class="secondary" data-close-recipe>Cancel</button>
      <button type="submit" class="primary">${cur ? 'Save' : 'Add recipe'}</button>
    </div>
  </form>`;
  if (typeof dlg.showModal === 'function') dlg.showModal();
  else dlg.setAttribute('open', '');
  dlg.querySelector('[name=name]').focus();
}

function saveRecipeDialog(form) {
  const f = new FormData(form);
  const name = String(f.get('name') || '').trim();
  if (!name) {
    form.querySelector('[data-recipe-error]').hidden = false;
    return;
  }
  const details = { name, serveNoun: String(f.get('serveNoun') || '').trim().toLowerCase(), icon: String(f.get('icon') || RECIPE_ICONS[0]) };
  const id = form.dataset.recipeId;
  const cur = settings.customMenus.find((m) => m.id === id);
  if (cur) {
    Object.assign(cur, details);
  } else {
    const newId = `recipe-${slugOf(name)}-${Date.now().toString(36)}`;
    settings.customMenus.push({
      id: newId,
      ...details,
      defaultServes: Math.max(0, toNumber(f.get('serves')) ?? 0),
      defaultSalePrice: Math.max(0, toNumber(f.get('salePrice')) ?? 0),
    });
    // Straight to its recipe, to say what goes into each one
    settings.menu = newId;
    settings.view = 'settings';
  }
  $('#recipe-dialog').close();
  save();
  rebuildCatalogue();
  renderMenu();
  selectView(settings.view);
  if (!cur) $('#custom-items select, #custom-items [name=name]')?.focus();
}

async function deleteRecipe(id) {
  const cur = settings.customMenus.find((m) => m.id === id);
  if (!cur) return;
  const sure = await confirmAction({
    title: `Delete ${cur.name}?`,
    message: 'The recipe goes, with the ingredients you added for it and everything entered on its tab.',
    confirmLabel: 'Delete',
    danger: true,
  });
  if (!sure) return;
  for (const item of settings.customItems.filter((it) => it.menu === id)) dropCustomItem(item);
  settings.customMenus = settings.customMenus.filter((m) => m.id !== id);
  delete settings.menus[id];
  delete settings.active[id];
  settings.menu = SHOP;
  save();
  rebuildCatalogue();
  renderMenu();
}

function renderPriceTable() {
  // The Shop tab lists everything switched on. A menu with a list to choose from (drinks) only lists the ones ticked
  const menus = onShop() ? activeMenus() : [settings.menu];
  const ids = [...new Set(menus.flatMap((id) => menuDef(id).recipe.filter((r) => isOn(id, r.ingredient)).map((r) => r.ingredient)))];
  let rows = '';
  for (const id of ids) {
    for (const p of catalogue.ingredients[id].products) {
      const override = settings.prices[p.id];
      rows += `<tr>
        <td>${esc(p.name)}<span class="sub">${esc(p.packLabel)}</span></td>
        <td>${esc(storeName(p.store))}</td>
        <td class="num">${money(p.price)}<span class="sub">${
          p.custom ? 'added by you' : p.priceUpdated ? `checked ${esc(p.priceUpdated)}` : '<span class="badge-estimate">estimate</span>'
        }</span></td>
        <td class="your-price"><span class="input-prefix"><span>$</span><input type="number" min="0" step="0.01" inputmode="decimal" data-price="${esc(p.id)}"
          value="${valueAttr(override)}" placeholder="${p.price ?? ''}" aria-label="Your price for ${esc(p.name)} at ${esc(storeName(p.store))}"></span>
          <label class="donated-check"><input type="checkbox" data-donated="${esc(p.id)}" ${settings.donated[p.id] ? 'checked' : ''}>Donated</label></td>
      </tr>`;
    }
  }
  $('#price-table').innerHTML = rows
    ? `<thead><tr><th>Product</th><th>Store</th><th class="num">Listed price</th><th>Your price</th></tr></thead><tbody>${rows}</tbody>`
    : '';
  $('#price-info').textContent =
    'Listed prices come from the shared price list in this site. Prices marked "estimate" haven\'t been checked against the store yet. ' +
    'Enter your own price to override one for this browser. Prices are shared across all tabs. ' +
    'Tick Donated for anything given to the group: it costs nothing on the shopping list, and its price counts as the value of the donation.';
}

function renderMenuTabs() {
  const tab = (id, icon, label, off = false) => `<button role="tab" data-menu="${esc(id)}" aria-selected="${id === settings.menu}"${off ? ' class="off"' : ''}>
        <span class="icon" aria-hidden="true">${esc(icon)}</span><span class="tab-label">${esc(label)}</span></button>`;
  $('#menu-tabs').innerHTML =
    tab(SHOP, '🛒', 'Shop') +
    menuIds()
      .map((id) => tab(id, catalogue.menu[id].icon ?? '', menuLabel(id), !isActive(id)))
      .join('');
  $('#menu-tabs [aria-selected=true]')?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
}

function renderMenu() {
  if (!onShop() && !catalogue.menu[settings.menu]) settings.menu = SHOP;
  const shop = onShop();
  document.body.classList.toggle('on-shop', shop);
  renderMenuTabs();
  $('#buffer-label').hidden = !shop && isItems() && !hasScaledItems();
  if (shop) {
    renderShopInputs();
  } else {
    renderPlanInputs();
    renderRestockInputs();
  }
  renderRecipeTable();
  renderPriceTable();
  renderResults();
}

// ---------- Moving through the event ----------

const clearCounts = () => {
  settings.stock = {};
  settings.ticks = { ...settings.ticks, restock: {} };
};

/**
 * The restock list has been bought. For a top-up it joins today's stock; at
 * the end of a day, what's left plus the list becomes tomorrow's starting
 * stock and the day's sales are cleared.
 */
async function boughtRestock(kind) {
  const d = dayNow();
  const sure = await confirmAction(
    kind === 'today'
      ? { title: 'Add the top-up to today’s stock?', message: 'Do this once it’s bought. Stock counts you typed in are replaced by the new estimate.', confirmLabel: 'Add it' }
      : { title: `Start day ${d + 1}?`, message: `Do this once the list is bought. Day ${d}’s sales and stock counts are cleared, and can’t be brought back.`, confirmLabel: `Start day ${d + 1}` }
  );
  if (!sure) return;
  const ids = activeMenus();
  const result = combined(ids, 'restock', stockNow(ids).stock);
  settings.carry = carryForward(startStock(ids), result, kind, usedOnDay1(ids));
  for (const l of result.lines.filter((x) => x.byEye)) {
    // A bottle checked by eye: after a top-up there's what was left plus what was bought
    const r = ms(l.menus[0]).restock;
    r.leftPct = { ...r.leftPct };
    if (kind === 'today') r.leftPct[l.id] = Math.round((l.onHand + l.purchase.units) * 100);
    else delete r.leftPct[l.id];
  }
  clearCounts();
  if (kind === 'next') {
    for (const id of menuIds()) {
      const r = ms(id).restock;
      r.sold = isItems(id) ? {} : 0;
      r.leftPct = {};
    }
    settings.day = d + 1;
    settings.restockFor = 'next';
  }
  save();
  renderMenu();
  window.scrollTo({ top: 0 });
}

/** A fresh event: prices, recipes and what's planned stay; sales, stock counts and the day go. */
async function newEvent() {
  const sure = await confirmAction({
    title: 'Start a new event?',
    message: 'Sales, stock counts and ticks are cleared and it’s day 1 again. Your prices, recipes and planned numbers stay.',
    confirmLabel: 'New event',
  });
  if (!sure) return;
  for (const id of Object.keys(settings.menus)) {
    const m = settings.menus[id];
    if (m) m.restock = catalogue.menu[id] && !isItems(id) ? { sold: 0 } : { sold: {} };
  }
  settings.stock = {};
  settings.ticks = {};
  settings.carry = null;
  settings.day = 1;
  settings.restockFor = 'next';
  save();
  renderMenu();
  selectView('plan');
  window.scrollTo({ top: 0 });
}

// ---------- Sharing a plan as a link ----------

async function sharePlan(btn) {
  const url = `${location.origin}${location.pathname}#plan=${await encodePlan(settings)}`;
  const label = btn.textContent;
  const flash = (text) => {
    btn.textContent = text;
    setTimeout(() => (btn.textContent = label), 2000);
  };
  if (navigator.share) {
    try {
      await navigator.share({ title: 'Snag Calc plan', text: 'Our BBQ plan in Snag Calc', url });
      return;
    } catch (err) {
      if (err?.name === 'AbortError') return; // closed the share sheet
    }
  }
  flash((await copyText(url)) ? 'Link copied!' : "Couldn't copy");
}

/** The plan in the link that was opened, if any: null for none, false if it can't be read. Drops it from the address bar. */
async function takeSharedPlan() {
  const code = planInHash(location.hash);
  if (!code) return null;
  history.replaceState(null, '', location.pathname + location.search);
  return (await decodePlan(code)) || false;
}

const adoptPlan = (plan) => ({ ...defaultSettings(), ...plan, wizardDone: true });

/** A link with a plan in it was opened in a browser that has a plan of its own: ask before replacing it. */
async function offerSharedPlan(plan) {
  if (plan === null) return;
  if (plan === false) {
    await confirmAction({ title: 'That link didn’t work', message: 'The plan in it couldn’t be read. Ask for it to be shared again.', confirmLabel: 'OK' });
    return;
  }
  if (JSON.stringify(planOf(settings)) === JSON.stringify(plan)) return; // already have it
  const sure = await confirmAction({
    title: 'Open the shared plan?',
    message: 'It replaces the plan saved in this browser: what’s being sold, prices, recipes, sales and stock counts.',
    confirmLabel: 'Open it',
  });
  if (!sure) return;
  settings = adoptPlan(plan);
  save();
  closeWizard();
  init();
}

// ---------- Actions ----------

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Older browsers: copy through a temporary textarea.
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try {
      ok = document.execCommand('copy');
    } catch {
      ok = false;
    }
    ta.remove();
    return ok;
  }
}

function wireActions(container, getters) {
  for (const btn of container.querySelectorAll('[data-copy]')) {
    const label = btn.textContent;
    btn.addEventListener('click', async () => {
      const ok = await copyText(getters[btn.dataset.copy]());
      btn.textContent = ok ? 'Copied!' : "Couldn't copy";
      setTimeout(() => (btn.textContent = label), 2000);
    });
  }
  container.querySelector('[data-print]')?.addEventListener('click', () => window.print());
  container.querySelector('[data-share]')?.addEventListener('click', (e) => sharePlan(e.currentTarget));
  for (const btn of container.querySelectorAll('[data-roll]')) btn.addEventListener('click', () => boughtRestock(btn.dataset.roll));
}

// ---------- Price wizard ----------

let wiz = null; // { step, menus, items, answers }

const fmtDate = (iso) => {
  const d = new Date(`${iso}T00:00:00`);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString('en-AU', { day: 'numeric', month: 'short', year: 'numeric' });
};
const menuTag = (id) => `${catalogue.menu[id].icon ?? ''} ${catalogue.menu[id].tabLabel ?? catalogue.menu[id].name}`.trim();

function openWizard() {
  const saved = (settings.wizardMenus || []).filter((id) => catalogue.menu[id]);
  wiz = { step: 0, menus: saved.length ? saved : activeMenus(), store: settings.store, items: [], answers: {}, donated: {} };
  renderWizard();
  const dlg = $('#wizard');
  if (!dlg.open) {
    if (typeof dlg.showModal === 'function') dlg.showModal();
    else dlg.setAttribute('open', '');
  }
  fitWizard();
}

/**
 * Keep the wizard inside the part of the screen that's visible, which shrinks
 * when the phone's keyboard opens (the visual viewport). It's centred in that
 * space, switches to a compact layout when space is short, and scrolls within
 * itself if it still doesn't fit.
 */
function fitWizard() {
  const dlg = $('#wizard');
  if (!dlg?.open) return;
  const vv = window.visualViewport;
  const height = vv ? vv.height : window.innerHeight;
  const top = vv ? vv.offsetTop : 0;
  const gap = height < 560 ? 6 : 12;
  dlg.classList.toggle('compact', height < 640);
  dlg.style.maxHeight = `${Math.max(200, height - gap * 2)}px`;
  dlg.style.top = `${top + Math.max(gap, (height - dlg.offsetHeight) / 2)}px`;
  // Keep the field being typed in clear of the pinned buttons
  const active = document.activeElement;
  if (active?.matches?.('input') && dlg.contains(active) && dlg.scrollHeight > dlg.clientHeight) {
    active.scrollIntoView({ block: 'nearest' });
  }
}

function closeWizard() {
  const dlg = $('#wizard');
  if (dlg.open) {
    if (typeof dlg.close === 'function') dlg.close();
    else dlg.removeAttribute('open');
  }
  wiz = null;
}

/** Price to show for a product: this run's answer, else the saved override, else the listed price. */
function wizardValue(product) {
  if (product.id in wiz.answers) return wiz.answers[product.id];
  return Number.isFinite(settings.prices[product.id]) ? settings.prices[product.id] : product.price;
}

/** Whether an item is switched on in a menu (the wizard skips ones that are off). */
function isOn(menuId, ingredientId) {
  if (!catalogue.menu[menuId]) return false;
  const list = isItems(menuId) ? effectiveItems(catalogue, menuId, ms(menuId).items) : effectiveRecipe(catalogue, menuId, ms(menuId).recipe);
  return list.some((r) => r.ingredient === ingredientId && r.enabled);
}

/** The products the wizard asks about: what's switched on in the chosen menus, at the chosen store. */
const wizardItems = () =>
  wizardProducts(catalogue, wiz.menus, isOn).filter((e) => wiz.store === 'cheapest' || e.product.store === wiz.store);

const wizardDonated = (product) => (product.id in wiz.donated ? wiz.donated[product.id] : Boolean(settings.donated[product.id]));

function recordWizardAnswer() {
  const input = $('#wizard [data-wiz-price]');
  if (!input) return;
  wiz.answers[input.dataset.wizPrice] = toNumber(input.value);
  wiz.donated[input.dataset.wizPrice] = $('#wizard [data-wiz-donated]').checked;
}

/** Wording of the price field: a price normally, the donation's value when donated. */
function wizardPriceWording(donated) {
  $('#wizard [data-wiz-price-label]').textContent = donated ? 'What it would have cost' : 'Price at your store';
  $('#wizard [data-wiz-donated-hint]').hidden = !donated;
}

function renderWizard() {
  const n = wiz.items.length;
  const actions = (left, right) =>
    `<div class="wizard-actions">${left}<span class="right">${right}</span></div>`;
  let html;

  if (wiz.step === 0) {
    html = `<h2 id="wizard-title">Check your prices</h2>
      <p>Snag Calc uses a price for every product. Check each one against your local store so the shopping totals are right. It takes a few minutes, you can stop at any point with Finish, and you can redo it any time from <strong>Recipe &amp; prices</strong>.</p>
      <p><strong>What are you planning?</strong></p>
      <div class="menu-choices">${menuIds()
        .map((id) => `<label><input type="checkbox" data-wiz-menu="${esc(id)}" ${wiz.menus.includes(id) ? 'checked' : ''}>${esc(menuTag(id))}</label>`)
        .join('')}</div>
      <p class="notice" data-wiz-error hidden>Pick at least one.</p>
      <label><strong>Where do you shop?</strong>
        <select data-wiz-store>
          <option value="cheapest" ${wiz.store === 'cheapest' ? 'selected' : ''}>Both: whichever is cheaper for each item</option>
          ${Object.entries(catalogue.stores)
            .map(([id, st]) => `<option value="${esc(id)}" ${wiz.store === id ? 'selected' : ''}>${esc(st.name)} only</option>`)
            .join('')}
        </select>
      </label>
      ${actions('<button type="button" class="secondary" data-act="skip">Skip for now</button>', '<button type="submit" class="primary">Start</button>')}`;
  } else if (wiz.step <= n) {
    const { product, menus } = wiz.items[wiz.step - 1];
    const value = wizardValue(product);
    const override = settings.prices[product.id];
    const listedNote = product.custom
      ? `Your price <strong>${money(product.price)}</strong>, added by you`
      : product.priceUpdated
      ? `Listed price <strong>${money(product.price)}</strong>, checked ${esc(fmtDate(product.priceUpdated))}`
      : `Estimate <strong>${money(product.price)}</strong> <span class="badge-estimate">not checked yet</span>`;
    html = `<div class="progress" aria-hidden="true"><span style="width:${Math.round(((wiz.step - 1) / n) * 100)}%"></span></div>
      <p class="step-count">Price ${wiz.step} of ${n} · ${esc(menus.map(menuTag).join(', '))}</p>
      <div>
        <h2 id="wizard-title" class="product-name">${esc(product.name)}</h2>
        <p class="sub">${esc(product.packLabel)} · <span class="store-tag">${esc(storeName(product.store))}</span></p>
      </div>
      <p class="listed">${listedNote}${
        Number.isFinite(override) ? `<span class="sub">You saved ${money(override)} last time.</span>` : ''
      }</p>
      <label class="switch-row">
        <span><strong>Donated</strong><span class="sub">Someone is giving this to the group</span></span>
        <input type="checkbox" class="switch" role="switch" data-wiz-donated ${wizardDonated(product) ? 'checked' : ''}>
      </label>
      <label class="price-input"><span data-wiz-price-label>Price at your store</span>
        <span class="input-prefix"><span>$</span><input type="number" min="0" step="0.01" inputmode="decimal"
          data-wiz-price="${esc(product.id)}" value="${valueAttr(value)}" placeholder="${product.price ?? ''}"></span>
      </label>
      <p class="hint" data-wiz-donated-hint hidden>It won't cost anything on the shopping list. This value is shown as what the donation saved.</p>
      <p><button type="button" class="link" data-act="listed">Use the listed price</button></p>
      ${actions(
        `<button type="button" class="secondary" data-act="back">Back</button>`,
        `<button type="button" class="secondary" data-act="finish">Finish</button><button type="submit" class="primary">Next</button>`
      )}`;
  } else {
    const draft = applyWizardPrices(catalogue, settings.prices, wiz.answers);
    const all = wizardItems();
    const isDonated = ({ product }) => wizardDonated(product);
    const changed = all.filter((e) => !isDonated(e) && Number.isFinite(draft[e.product.id]));
    const gifts = all.filter(isDonated);
    const priceOf = (product) => (Number.isFinite(draft[product.id]) ? draft[product.id] : product.price);
    html = `<div class="progress" aria-hidden="true"><span style="width:100%"></span></div>
      <h2 id="wizard-title">All done</h2>
      ${
        changed.length
          ? `<p>${changed.length} ${changed.length === 1 ? 'price differs' : 'prices differ'} from the listed price:</p>
        <ul class="changes">${changed
          .map(({ product }) => `<li>${esc(product.name)}: ${money(product.price)} → <strong>${money(draft[product.id])}</strong></li>`)
          .join('')}</ul>`
          : '<p>All your prices match the listed prices.</p>'
      }
      ${
        gifts.length
          ? `<p>${gifts.length} donated:</p>
        <ul class="changes">${gifts
          .map(({ product }) => `<li>${esc(product.name)}, worth <strong>${money(priceOf(product))}</strong> a pack</li>`)
          .join('')}</ul>`
          : ''
      }
      <p class="hint">Your prices are saved in this browser. You can change any of them under <strong>Recipe &amp; prices</strong>.</p>
      ${actions('<button type="button" class="secondary" data-act="back">Back</button>', '<button type="submit" class="primary">Save prices</button>')}`;
  }

  $('#wizard').innerHTML = `<form novalidate>${html}</form>`;
  $('#wizard').scrollTop = 0;
  const input = $('#wizard [data-wiz-price]');
  if (input) wizardPriceWording($('#wizard [data-wiz-donated]').checked);
  fitWizard();
  if (input) {
    input.focus({ preventScroll: true });
    input.select();
  } else {
    $('#wizard button[type=submit]')?.focus({ preventScroll: true });
  }
}

function wizardNext() {
  const n = wiz.items.length;
  if (wiz.step === 0) {
    const menus = [...document.querySelectorAll('#wizard [data-wiz-menu]')].filter((c) => c.checked).map((c) => c.dataset.wizMenu);
    if (!menus.length) {
      $('#wizard [data-wiz-error]').hidden = false;
      return;
    }
    wiz.menus = menus;
    wiz.store = $('#wizard [data-wiz-store]').value;
    wiz.items = wizardItems();
    wiz.step = 1;
  } else if (wiz.step <= n) {
    recordWizardAnswer();
    wiz.step += 1;
  } else {
    settings.prices = applyWizardPrices(catalogue, settings.prices, wiz.answers);
    for (const [id, gift] of Object.entries(wiz.donated)) {
      if (gift) settings.donated[id] = true;
      else delete settings.donated[id];
    }
    settings.wizardDone = true;
    settings.wizardMenus = wiz.menus;
    // What was picked is what's being sold, and where it's bought
    for (const id of menuIds()) {
      if (wiz.menus.includes(id)) delete settings.active[id];
      else settings.active[id] = false;
    }
    settings.store = wiz.store;
    $('#store').value = settings.store;
    save();
    closeWizard();
    renderMenu();
    return;
  }
  renderWizard();
}

function bindWizard() {
  const dlg = $('#wizard');
  dlg.addEventListener('change', (e) => {
    if (e.target.matches('[data-wiz-donated]')) wizardPriceWording(e.target.checked);
  });
  dlg.addEventListener('submit', (e) => {
    e.preventDefault();
    wizardNext();
  });
  dlg.addEventListener('click', (e) => {
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (!act || !wiz) return;
    if (act === 'skip') {
      settings.wizardDone = true;
      save();
      closeWizard();
    } else if (act === 'back') {
      recordWizardAnswer();
      wiz.step = Math.max(0, wiz.step - 1);
      renderWizard();
    } else if (act === 'finish') {
      recordWizardAnswer();
      wiz.step = wiz.items.length + 1;
      renderWizard();
    } else if (act === 'listed') {
      const input = $('#wizard [data-wiz-price]');
      const item = wiz.items[wiz.step - 1];
      input.value = item.product.price ?? '';
      input.focus();
    }
  });
  // Escape closes without saving this run's answers, and counts as "skip for now".
  dlg.addEventListener('cancel', () => {
    settings.wizardDone = true;
    save();
    wiz = null;
  });
  for (const btn of document.querySelectorAll('[data-open-wizard]')) btn.addEventListener('click', openWizard);
  // The keyboard opening or closing changes the visible area
  window.visualViewport?.addEventListener('resize', fitWizard);
  window.visualViewport?.addEventListener('scroll', fitWizard);
  window.addEventListener('resize', fitWizard);
  // Keep the field being typed in visible above the keyboard
  dlg.addEventListener('focusin', (e) => {
    if (!e.target.matches('input')) return;
    setTimeout(() => {
      fitWizard();
      e.target.scrollIntoView({ block: 'nearest' });
    }, 300);
  });
}

// ---------- Views ----------

function selectView(name) {
  for (const t of VIEWS) {
    const on = t === name;
    $(`#tab-${t}`).setAttribute('aria-selected', String(on));
    $(`#panel-${t}`).hidden = !on;
  }
  settings.view = name;
  save();
}

// ---------- Init ----------

const nonNeg = (v) => Math.max(0, toNumber(v) ?? 0);

function syncPctChips() {
  for (const c of document.querySelectorAll('#restock-inputs [data-pct]')) {
    c.setAttribute('aria-pressed', String(Number(c.dataset.pct) === pctNow()));
  }
}

function setOverride(map, id, key, value) {
  const o = { ...map[id] };
  if (value == null) delete o[key];
  else o[key] = value;
  map[id] = o;
}

function bindInputs() {
  const store = $('#store');
  store.innerHTML =
    `<option value="cheapest">Cheapest per item</option>` +
    Object.entries(catalogue.stores)
      .map(([id, s]) => `<option value="${esc(id)}">${esc(s.name)} only</option>`)
      .join('');

  const changed = () => {
    save();
    renderResults();
  };

  store.addEventListener('change', (e) => {
    settings.store = e.target.value;
    changed();
  });
  $('#buffer').addEventListener('input', (e) => {
    settings.buffer = nonNeg(e.target.value);
    changed();
  });

  const goToMenu = (id, view) => {
    settings.menu = id;
    save();
    renderMenu();
    if (view) selectView(view);
    window.scrollTo({ top: 0 });
  };

  $('#menu-tabs').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-menu]');
    if (!btn || btn.dataset.menu === settings.menu) return;
    goToMenu(btn.dataset.menu);
  });

  // Plan and restock inputs (rendered per menu, so delegate).
  for (const panel of ['#plan-inputs', '#restock-inputs']) {
    $(panel).addEventListener('input', (e) => {
      const t = e.target;
      const { field, qty, sale, sold, stock, perItem, leftPct } = t.dataset;
      const v = toNumber(t.value);
      const clamp = v == null || v < 0 ? null : v;
      // Stock and the day 2 % belong to the whole stall; everything else to the menu the field sits in
      const menuId = t.closest('[data-menu-id]')?.dataset.menuId;
      const m = menuId && catalogue.menu[menuId] ? ms(menuId) : null;
      if (stock) {
        if (clamp == null) delete settings.stock[stock];
        else settings.stock[stock] = clamp;
      } else if (field === 'day2Pct') {
        settings[pctKey()] = nonNeg(t.value);
        syncPctChips();
      } else if (!m) return;
      else if (field === 'planServes') m.planServes = nonNeg(t.value);
      else if (field === 'salePrice') m.salePrice = nonNeg(t.value);
      else if (field === 'restock.sold') m.restock.sold = nonNeg(t.value);
      else if (qty) setOverride(m.items, qty, 'quantity', clamp);
      else if (perItem) setOverride(m.items, perItem, 'perServe', clamp);
      else if (leftPct) {
        m.restock.leftPct = { ...m.restock.leftPct };
        if (clamp == null) delete m.restock.leftPct[leftPct];
        else m.restock.leftPct[leftPct] = clamp;
      }
      else if (sale) setOverride(m.items, sale, 'salePrice', clamp);
      else if (sold) {
        if (clamp == null) delete m.restock.sold[sold];
        else m.restock.sold[sold] = clamp;
      } else return;
      changed();
    });

    // Switching a menu on or off
    $(panel).addEventListener('change', (e) => {
      const id = e.target.dataset.active;
      if (!id) return;
      if (e.target.checked) delete settings.active[id];
      else settings.active[id] = false;
      save();
      renderMenu();
    });
    $(panel).addEventListener('click', (e) => {
      const id = e.target.closest('[data-activate]')?.dataset.activate;
      if (!id) return;
      delete settings.active[id];
      save();
      renderMenu();
    });
    // Remember which sections of the Shop tab are folded open
    $(panel).addEventListener(
      'toggle',
      (e) => {
        const d = e.target;
        if (d.matches?.('details.menu-section') && !d.classList.contains('off')) shopOpen[d.dataset.mode][d.dataset.menuId] = d.open;
      },
      true
    );
  }

  // Ticking things off the Shop list as they go in the trolley
  for (const mode of ['plan', 'restock']) {
    $(`#${mode}-results`).addEventListener('change', (e) => {
      const id = e.target.dataset.tick;
      if (!id) return;
      settings.ticks[mode] = { ...settings.ticks[mode] };
      if (e.target.checked) settings.ticks[mode][id] = Number(e.target.dataset.count);
      else delete settings.ticks[mode][id];
      save();
    });
  }

  $('#recipe-table').addEventListener('input', (e) => {
    const m = ms();
    const { enable, per } = e.target.dataset;
    const target = isItems() ? m.items : m.recipe;
    if (enable) {
      setOverride(target, enable, 'enabled', e.target.checked);
      renderPlanInputs();
      renderRestockInputs();
      renderPriceTable();
    } else if (per) {
      const v = toNumber(e.target.value);
      setOverride(m.recipe, per, 'perServe', v == null || v < 0 ? null : v);
    } else return;
    changed();
  });

  $('#restock-inputs').addEventListener('click', (e) => {
    const mode = e.target.closest('[data-restock-for]')?.dataset.restockFor;
    if (mode) {
      settings.restockFor = mode;
      save();
      renderMenu();
      return;
    }
    const chip = e.target.closest('[data-pct]');
    if (!chip) return;
    settings[pctKey()] = Number(chip.dataset.pct);
    $('#restock-inputs [data-field=day2Pct]').value = pctNow();
    syncPctChips();
    changed();
  });

  $('#custom-items').addEventListener('submit', (e) => {
    e.preventDefault();
    addCustomItem(e.target);
  });
  $('#recipe-table').addEventListener('click', (e) => {
    const id = e.target.closest('[data-remove-custom]')?.dataset.removeCustom;
    if (id) removeCustomItem(id);
  });
  $('#plan-inputs').addEventListener('click', (e) => {
    const id = e.target.closest('[data-goto-choose]')?.dataset.gotoChoose;
    if (id) goToMenu(id, 'settings');
  });

  // The user's own recipes
  document.addEventListener('click', (e) => {
    const t = e.target.closest('[data-new-recipe], [data-edit-recipe], [data-delete-recipe], [data-open-menu], [data-close-recipe]');
    if (!t) return;
    if ('newRecipe' in t.dataset) openRecipeDialog();
    else if (t.dataset.editRecipe) openRecipeDialog(t.dataset.editRecipe);
    else if (t.dataset.deleteRecipe) deleteRecipe(t.dataset.deleteRecipe);
    else if (t.dataset.openMenu) goToMenu(t.dataset.openMenu, 'plan');
    else $('#recipe-dialog').close();
  });
  $('#recipe-dialog').addEventListener('submit', (e) => {
    e.preventDefault();
    saveRecipeDialog(e.target);
  });
  $('#recipe-dialog').addEventListener('click', (e) => {
    if (e.target === e.currentTarget) e.currentTarget.close();
  });
  // Adding an ingredient that's already on the price list needs no pack details
  $('#custom-items').addEventListener('change', (e) => {
    if (e.target.name !== 'ingredient') return;
    for (const el of e.target.form.querySelectorAll('[data-new-only]')) el.hidden = e.target.value !== '';
  });

  $('#price-table').addEventListener('input', (e) => {
    const donatedId = e.target.dataset.donated;
    if (donatedId) {
      if (e.target.checked) settings.donated[donatedId] = true;
      else delete settings.donated[donatedId];
      changed();
      return;
    }
    const id = e.target.dataset.price;
    if (!id) return;
    const v = toNumber(e.target.value);
    if (v == null || v < 0) delete settings.prices[id];
    else settings.prices[id] = v;
    changed();
  });

  for (const t of VIEWS) $(`#tab-${t}`).addEventListener('click', () => selectView(t));

  // A tap on the dimmed page around the "are you sure?" dialog cancels it
  $('#confirm').addEventListener('click', (e) => {
    if (e.target === e.currentTarget) e.currentTarget.close('cancel');
  });

  $('#new-event').addEventListener('click', newEvent);
  for (const btn of document.querySelectorAll('[data-share-plan]')) btn.addEventListener('click', () => sharePlan(btn));

  $('#reset').addEventListener('click', async () => {
    const sure = await confirmAction({
      title: 'Reset everything?',
      message: 'All settings, stock counts and your own prices go back to the start, on every tab.',
      confirmLabel: 'Reset',
      danger: true,
    });
    if (!sure) return;
    settings = defaultSettings();
    save();
    init();
  });
}

let bound = false;
function init() {
  rebuildCatalogue();
  if (settings.menu !== SHOP && !catalogue.menu[settings.menu]) settings.menu = SHOP;
  $('#group-name').textContent = catalogue.groupName || 'Scout Group';
  if (!bound) {
    bindInputs();
    bindWizard();
    bound = true;
  }
  $('#store').value = settings.store;
  $('#buffer').value = settings.buffer;
  renderMenu();
  selectView(settings.view || 'plan');
  if (!settings.wizardDone) openWizard();
}

async function start() {
  try {
    const res = await fetch('data/catalogue.json', { cache: 'no-cache' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    baseCatalogue = await res.json();
    catalogue = baseCatalogue;
  } catch (err) {
    document.querySelector('main').innerHTML = `<div class="card notice">Couldn't load the price list (${esc(err.message)}).
      If you opened index.html straight from disk, run a local web server instead (see README).</div>`;
    return;
  }
  // A shared link opened in a browser with no plan of its own just loads; otherwise it asks first
  const fresh = !readJSON(STORAGE_KEY);
  settings = loadSettings();
  const shared = await takeSharedPlan();
  if (shared && fresh) settings = adoptPlan(shared);
  init();
  if (!(shared && fresh)) offerSharedPlan(shared);
  window.addEventListener('hashchange', async () => offerSharedPlan(await takeSharedPlan()));
  watchConnection();
}

/** Keep the page working with no signal: sw.js saves it, and the price list, on the phone. */
function watchConnection() {
  const show = () => ($('#offline-note').hidden = navigator.onLine !== false);
  window.addEventListener('online', show);
  window.addEventListener('offline', show);
  show();
  if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
    navigator.serviceWorker.register('sw.js').catch(() => {
      /* the page still works online without it */
    });
  }
}

start();

import {
  calculate,
  calculateRestock,
  calculateItems,
  effectiveRecipe,
  effectiveItems,
  wizardProducts,
  applyWizardPrices,
  withCustomItems,
} from './calc.js';
import { buildSheet, toTSV } from './sheet.js';

const STORAGE_KEY = 'snagcalc:v2';
const OLD_STORAGE_KEY = 'snagcalc:v1';
const VIEWS = ['plan', 'restock', 'settings'];

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

function defaultMenuSettings(id) {
  const m = catalogue.menu[id];
  if (m.kind === 'items') return { items: {}, restock: { sold: {}, stock: {} } };
  const serves = m.defaultServes ?? 100;
  return {
    salePrice: m.defaultSalePrice ?? 3,
    planServes: serves,
    restock: { total: serves * 2, sold: 0, stock: {} },
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
  return { store: 'cheapest', buffer: 5, prices: {}, donated: {}, customItems: [], menu: menuIds()[0], view: 'plan', menus: {}, wizardDone: false, wizardMenus: null };
}

function readJSON(key) {
  try {
    const v = JSON.parse(localStorage.getItem(key) || 'null');
    return v && typeof v === 'object' ? v : null;
  } catch {
    return null;
  }
}

function loadSettings() {
  const base = defaultSettings();
  const saved = readJSON(STORAGE_KEY);
  if (saved) {
    const s = { ...base, ...saved, menus: saved.menus || {}, donated: saved.donated || {}, customItems: Array.isArray(saved.customItems) ? saved.customItems : [] };
    if (!catalogue.menu[s.menu]) s.menu = base.menu;
    if (!VIEWS.includes(s.view)) s.view = 'plan';
    return s;
  }
  // Carry over settings saved before there were several menu tabs.
  const old = readJSON(OLD_STORAGE_KEY);
  if (old) {
    const s = { ...base, store: old.store ?? base.store, buffer: old.buffer ?? base.buffer, prices: old.prices || {} };
    if (VIEWS.includes(old.tab)) s.view = old.tab;
    s.menus['sausage-sizzle'] = {
      salePrice: old.salePrice,
      planServes: old.planServes,
      restock: old.restock,
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

// ---------- Formatting ----------

const fmtPlain = (base, ing) => `${num(base, 1)} ${ing.unit}`;

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
    stats.push([restock ? 'Takings for the rest' : 'Takings if all sell', money(result.revenue)]);
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
    stats.push([`${cap(serveLabel())} still to sell`, num(result.remainingServes, 0)]);
    stats.push([`Takings at ${money(sale)} each`, money(result.remainingServes * sale)]);
  }
  return stats;
}

const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

function resultsCard(result, { restock = false, title }) {
  const rows = result.lines
    .map(
      (l) => `<tr>
        <td class="item"><strong>${esc(l.ingredient.name)}</strong></td>
        <td class="num" data-label="Need"><div>${fmtQty(l.needed, l.ingredient)}</div></td>
        ${restock ? `<td class="num" data-label="Have"><div>${fmtQty(l.onHand, l.ingredient)}</div></td>` : ''}
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
    ${result.lines.length ? '' : '<p class="hint">Nothing selected. Turn items on under Recipe &amp; prices.</p>'}
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

/** Food menus (sausages, egg & bacon): the ones sauces and other per-serve consumables scale from. */
const foodMenuIds = () => menuIds().filter((id) => !isItems(id));

/** Food serves per menu: planned, or still to sell for a restock. */
function servesByMenu(mode) {
  const out = {};
  for (const id of foodMenuIds()) {
    const m = ms(id);
    out[id] = mode === 'restock' ? Math.max(0, (m.restock.total ?? 0) - (m.restock.sold ?? 0)) : m.planServes ?? 0;
  }
  return out;
}

/** Whether the current items menu has lines scaled from food serves. */
const hasScaledItems = (id = settings.menu) =>
  isItems(id) && effectiveItems(catalogue, id, ms(id).items).some((r) => r.enabled && Number.isFinite(r.perServe));

function itemsResult(mode) {
  const m = ms();
  return calculateItems({
    catalogue,
    menuId: settings.menu,
    store: settings.store,
    itemOverrides: m.items,
    priceOverrides: settings.prices,
    donated: settings.donated,
    servesByMenu: servesByMenu(mode),
    bufferPct: settings.buffer,
    ...(mode === 'restock' ? { sold: m.restock.sold, stock: stockInBaseUnits(m.restock.stock) } : {}),
  });
}

function planResult() {
  const m = ms();
  if (isItems()) return itemsResult('plan');
  return calculate({
    catalogue,
    menuId: settings.menu,
    bufferPct: settings.buffer,
    store: settings.store,
    recipeOverrides: m.recipe,
    priceOverrides: settings.prices,
    donated: settings.donated,
    serves: m.planServes,
  });
}

function restockResult() {
  const m = ms();
  if (isItems()) return itemsResult('restock');
  return calculateRestock({
    catalogue,
    menuId: settings.menu,
    bufferPct: settings.buffer,
    store: settings.store,
    recipeOverrides: m.recipe,
    priceOverrides: settings.prices,
    donated: settings.donated,
    totalDesired: m.restock.total,
    sold: m.restock.sold,
    stock: stockInBaseUnits(m.restock.stock),
  });
}

function sheetText(result, mode, title) {
  const serves = servesByMenu(mode);
  const foodServes = foodMenuIds().map((id) => ({
    id,
    label: `${cap(serveLabel(id))} ${mode === 'restock' ? 'still to sell' : 'to sell'}`,
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
      storeName,
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

function renderRestockResults() {
  const result = restockResult();
  const menu = menuDef();
  let heading;
  if (isItems()) {
    $('#restock-summary').textContent = '';
    heading = `Snag Calc restock – ${menu.name}`;
  } else {
    const pct = result.totalDesired ? Math.round((result.sold / result.totalDesired) * 100) : 0;
    const label = serveLabel();
    $('#restock-summary').textContent =
      result.sold > result.totalDesired
        ? `Sold ${num(result.sold, 0)}, already more than the ${num(result.totalDesired, 0)} target.`
        : `Sold ${num(result.sold, 0)} of ${num(result.totalDesired, 0)} (${pct}%). ${num(result.remainingServes, 0)} ${label} still to sell.`;
    heading = `Snag Calc restock – ${num(result.remainingServes, 0)} ${label} to go`;
  }
  const el = $('#restock-results');
  el.innerHTML = resultsCard(result, { restock: true, title: `${menu.name}: restock shopping list` });
  wireActions(el, {
    list: () => shoppingListText(result, heading),
    sheet: () => sheetText(result, 'restock', heading),
  });
}

function renderResults() {
  renderPlanResults();
  renderRestockResults();
}

// ---------- Rendering: inputs (re-rendered when the menu changes) ----------

/** e.g. "200 sausages and 100 sandwiches" (planned, or still to sell for a restock). */
function foodServesText(mode = 'plan') {
  const serves = servesByMenu(mode);
  return foodMenuIds()
    .map((id) => `${num(serves[id], 0)} ${serveLabel(id)}`)
    .join(' and ');
}

/** "sausage or sandwich", for the menus a per-serve line scales from. */
function perServeLabel(r) {
  const ids = r.servesFrom ?? foodMenuIds();
  return ids.map((id) => serveNoun(id)).join(' or ');
}

function renderPlanInputs() {
  const m = ms();
  const menu = menuDef();
  if (!isItems()) {
    $('#plan-inputs').innerHTML = `<div class="grid-2">
      <label class="big-input">How many ${esc(serveLabel())} do you want to sell?
        <input data-field="planServes" type="number" min="0" step="10" inputmode="numeric" value="${valueAttr(m.planServes)}">
      </label>
      <label>Sale price per ${esc(serveNoun())}
        <span class="input-prefix"><span>$</span><input data-field="salePrice" type="number" min="0" step="0.5" inputmode="decimal" value="${valueAttr(m.salePrice)}"></span>
      </label>
    </div>`;
    return;
  }
  const items = effectiveItems(catalogue, settings.menu, m.items).filter((r) => r.enabled);
  const scaled = items.some((r) => Number.isFinite(r.perServe));
  const hint = menu.sells
    ? `How many of each do you want to sell? Set the sale price for each one too.${
        menu.allowCustom
          ? ` <button type="button" class="link" data-goto-choose>Choose ${esc(menu.name.toLowerCase())} or add your own</button>`
          : ''
      }`
    : `${
        scaled
          ? `Sauces are worked out from your plans on the other tabs: <strong>${esc(foodServesText())}</strong>. Set how much each one uses. `
          : ''
      }For everything else, enter how many you need for the event. Napkins are usually about 1 per serve.`;
  $('#plan-inputs').innerHTML = `<h2>${esc(menu.name)}</h2>
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

function renderRestockInputs() {
  const m = ms();
  if (!isItems()) {
    const label = serveLabel();
    const recipe = effectiveRecipe(catalogue, settings.menu, m.recipe).filter((r) => r.enabled);
    $('#restock-inputs').innerHTML = `<p class="hint">At the end of day 1, count what's left and enter it below. Snag Calc works out what to buy for the rest of the event.</p>
      <div class="grid-2">
        <label>Total ${esc(label)} wanted (whole event)
          <input data-field="restock.total" type="number" min="0" step="10" inputmode="numeric" value="${valueAttr(m.restock.total)}">
        </label>
        <label>${esc(cap(label))} sold so far
          <input data-field="restock.sold" type="number" min="0" step="1" inputmode="numeric" value="${valueAttr(m.restock.sold)}">
        </label>
      </div>
      <p id="restock-summary" class="summary"></p>
      <h3>Stock left over</h3>
      <div class="stock-grid">${recipe
        .map((r) => {
          const ing = catalogue.ingredients[r.ingredient];
          const unitLabel = ing.stockUnit?.label ?? ing.unit;
          const step = (ing.stockUnit?.size ?? 1) > 1 ? '0.1' : '1';
          return `<label>${esc(ing.name)}
            <span class="input-suffix"><input type="number" min="0" step="${step}" inputmode="decimal"
              data-stock="${esc(r.ingredient)}" value="${valueAttr(m.restock.stock[r.ingredient])}" placeholder="0"><span>${esc(unitLabel)}</span></span>
          </label>`;
        })
        .join('')}</div>`;
    return;
  }
  const items = effectiveItems(catalogue, settings.menu, m.items).filter((r) => r.enabled);
  const scaled = items.some((r) => Number.isFinite(r.perServe));
  $('#restock-inputs').innerHTML = `<p class="hint">At the end of day 1, enter how many of each you've ${
    menuDef().sells ? 'sold' : 'used'
  } and how many are left. Snag Calc buys enough to reach the quantities on the Plan tab.${
    scaled
      ? ` Sauces are worked out from what's still to sell on the other tabs' Restock: <strong>${esc(foodServesText('restock'))}</strong>, so just enter what's left.`
      : ''
  }</p>
    <p id="restock-summary" class="summary"></p>
    <div class="item-grid">${items
      .map((r) => {
        const ing = catalogue.ingredients[r.ingredient];
        const perServe = Number.isFinite(r.perServe);
        return `<div class="item-row">
          <span class="item-name">${esc(ing.name)}<span class="sub">${
            perServe
              ? `${num(r.perServe, 1)} ${esc(ing.unit)} per ${esc(perServeLabel(r))}`
              : `Planned: ${num(r.quantity, 0)} ${esc(ing.unit)}`
          }</span></span>
          ${
            perServe
              ? '<span aria-hidden="true"></span>'
              : `<label>${menuDef().sells ? 'Sold' : 'Used'}
            <span class="input-suffix"><input type="number" min="0" step="1" inputmode="numeric" data-sold="${esc(r.ingredient)}"
              value="${valueAttr(m.restock.sold[r.ingredient])}" placeholder="0"><span>${esc(ing.unit)}</span></span>
          </label>`
          }
          <label>Left over
            <span class="input-suffix"><input type="number" min="0" step="${(ing.stockUnit?.size ?? 1) > 1 ? '0.1' : '1'}" inputmode="decimal" data-stock="${esc(r.ingredient)}"
              value="${valueAttr(m.restock.stock[r.ingredient])}" placeholder="0"><span>${esc(ing.stockUnit?.label ?? ing.unit)}</span></span>
          </label>
        </div>`;
      })
      .join('')}</div>`;
}

function renderRecipeTable() {
  const m = ms();
  if (isItems()) {
    const custom = Boolean(menuDef().allowCustom);
    $('#recipe-title').textContent = custom ? `Choose ${menuDef().name.toLowerCase()}` : 'Items';
    $('#recipe-hint').textContent = custom
      ? `Tick the ${menuDef().name.toLowerCase()} you're selling, or add your own below. Set how many on the Plan tab.`
      : "Untick anything you don't need. Set quantities on the Plan tab.";
    const items = effectiveItems(catalogue, settings.menu, m.items);
    $('#recipe-table').innerHTML = `<thead><tr><th>Use</th><th>Item</th><th>Notes</th></tr></thead>
      <tbody>${items
        .map((r) => {
          const ing = catalogue.ingredients[r.ingredient];
          return `<tr>
            <td><input type="checkbox" data-enable="${esc(r.ingredient)}" ${r.enabled ? 'checked' : ''} aria-label="Use ${esc(ing.name)}"></td>
            <td>${esc(ing.name)}</td>
            <td class="sub">${
              r.custom
                ? `Added by you <button type="button" class="link danger" data-remove-custom="${esc(r.ingredient)}">Remove</button>`
                : esc(r.note ?? '')
            }</td>
          </tr>`;
        })
        .join('')}</tbody>`;
    renderCustomForm();
    return;
  }
  $('#custom-items').innerHTML = '';
  const noun = serveNoun();
  $('#recipe-title').textContent = `Recipe (per ${noun})`;
  $('#recipe-hint').textContent = `Untick the items you don't need, or change how much each ${noun} uses.`;
  const recipe = effectiveRecipe(catalogue, settings.menu, m.recipe);
  $('#recipe-table').innerHTML = `<thead><tr><th>Use</th><th>Item</th><th>Per ${esc(noun)}</th><th>Notes</th></tr></thead>
    <tbody>${recipe
      .map((r) => {
        const ing = catalogue.ingredients[r.ingredient];
        return `<tr>
          <td><input type="checkbox" data-enable="${esc(r.ingredient)}" ${r.enabled ? 'checked' : ''} aria-label="Use ${esc(ing.name)}"></td>
          <td>${esc(ing.name)}</td>
          <td><span class="input-suffix"><input type="number" min="0" step="any" data-per="${esc(r.ingredient)}" value="${r.perServe}" aria-label="${esc(ing.name)} per ${esc(noun)}"><span>${esc(ing.unit)}</span></span></td>
          <td class="sub">${esc(r.note ?? '')}</td>
        </tr>`;
      })
      .join('')}</tbody>`;
}

// ---------- The user's own items (e.g. drinks) ----------

function rebuildCatalogue() {
  catalogue = withCustomItems(baseCatalogue, settings.customItems);
}

function renderCustomForm() {
  const menu = menuDef();
  if (!menu.allowCustom) {
    $('#custom-items').innerHTML = '';
    return;
  }
  const noun = menu.name.toLowerCase().replace(/s$/, '');
  const stores = Object.entries(catalogue.stores)
    .map(([id, st]) => `<option value="${esc(id)}">${esc(st.name)}</option>`)
    .join('');
  $('#custom-items').innerHTML = `<form class="custom-form" novalidate>
    <h3>Add a ${esc(noun)}</h3>
    <div class="custom-grid">
      <label class="wide">Name
        <input type="text" name="name" required maxlength="60" placeholder="e.g. Lift, iced tea, juice boxes" autocomplete="off">
      </label>
      <label>Comes in
        <select name="unit"><option value="cans">Cans</option><option value="bottles">Bottles</option><option value="poppers">Poppers</option></select>
      </label>
      <label>How many in a pack
        <input type="number" name="packSize" min="1" step="1" inputmode="numeric" value="24" required>
      </label>
      <label>Pack price
        <span class="input-prefix"><span>$</span><input type="number" name="price" min="0" step="0.01" inputmode="decimal" required placeholder="0.00"></span>
      </label>
      <label>Store
        <select name="store">${stores}</select>
      </label>
      ${
        menu.sells
          ? `<label>Sale price each
        <span class="input-prefix"><span>$</span><input type="number" name="salePrice" min="0" step="0.5" inputmode="decimal" value="2"></span>
      </label>`
          : ''
      }
      <label>How many to ${menu.sells ? 'sell' : 'get'}
        <input type="number" name="quantity" min="0" step="1" inputmode="numeric" value="24">
      </label>
    </div>
    <p class="notice" data-custom-error hidden></p>
    <div class="actions"><button type="submit" class="primary">Add ${esc(noun)}</button></div>
  </form>`;
}

function addCustomItem(form) {
  const f = new FormData(form);
  const name = String(f.get('name') || '').trim();
  const packSize = toNumber(f.get('packSize'));
  const price = toNumber(f.get('price'));
  const error = !name
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
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 30) || 'item';
  settings.customItems.push({
    id: `custom-${slug}-${Date.now().toString(36)}`,
    menu: settings.menu,
    name,
    unit: String(f.get('unit') || 'cans'),
    packSize: Math.round(packSize),
    price,
    store: String(f.get('store')),
    quantity: Math.max(0, toNumber(f.get('quantity')) ?? 0),
    salePrice: Math.max(0, toNumber(f.get('salePrice')) ?? 0),
  });
  save();
  rebuildCatalogue();
  renderMenu();
  $('#custom-items [name=name]')?.focus();
}

function removeCustomItem(id) {
  const item = settings.customItems.find((it) => it.id === id);
  if (!item || !confirm(`Remove ${item.name}?`)) return;
  settings.customItems = settings.customItems.filter((it) => it.id !== id);
  const productId = `${id}-pack`;
  delete settings.prices[productId];
  delete settings.donated[productId];
  for (const m of Object.values(settings.menus)) {
    if (m.items) delete m.items[id];
    if (m.restock?.sold) delete m.restock.sold[id];
    if (m.restock?.stock) delete m.restock.stock[id];
  }
  save();
  rebuildCatalogue();
  renderMenu();
}

function renderPriceTable() {
  // A menu you can add to (drinks) offers more than you'll sell, so only list the ones ticked
  const lines = menuDef().allowCustom ? menuDef().recipe.filter((r) => isOn(settings.menu, r.ingredient)) : menuDef().recipe;
  const ids = [...new Set(lines.map((r) => r.ingredient))];
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
        <td class="your-price"><span class="input-prefix"><span>$</span><input type="number" min="0" step="0.01" data-price="${esc(p.id)}"
          value="${valueAttr(override)}" placeholder="${p.price ?? ''}" aria-label="Your price for ${esc(p.name)} at ${esc(storeName(p.store))}"></span>
          <label class="donated-check"><input type="checkbox" data-donated="${esc(p.id)}" ${settings.donated[p.id] ? 'checked' : ''}>Donated</label></td>
      </tr>`;
    }
  }
  $('#price-table').innerHTML = `<thead><tr><th>Product</th><th>Store</th><th class="num">Listed price</th><th>Your price</th></tr></thead><tbody>${rows}</tbody>`;
  $('#price-info').textContent =
    'Listed prices come from the shared price list in this site. Prices marked "estimate" haven\'t been checked against the store yet. ' +
    'Enter your own price to override one for this browser. Prices are shared across all tabs. ' +
    'Tick Donated for anything given to the group: it costs nothing on the shopping list, and its price counts as the value of the donation.';
}

function renderMenuTabs() {
  $('#menu-tabs').innerHTML = menuIds()
    .map((id) => {
      const m = catalogue.menu[id];
      return `<button role="tab" data-menu="${esc(id)}" aria-selected="${id === settings.menu}">
        <span class="icon" aria-hidden="true">${esc(m.icon ?? '')}</span><span class="tab-label">${esc(m.tabLabel ?? m.name)}</span></button>`;
    })
    .join('');
}

function renderMenu() {
  for (const b of document.querySelectorAll('#menu-tabs [data-menu]')) {
    b.setAttribute('aria-selected', String(b.dataset.menu === settings.menu));
  }
  $('#buffer-label').hidden = isItems() && !hasScaledItems();
  renderPlanInputs();
  renderRestockInputs();
  renderRecipeTable();
  renderPriceTable();
  renderResults();
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
  wiz = { step: 0, menus: saved.length ? saved : menuIds(), items: [], answers: {}, donated: {} };
  renderWizard();
  const dlg = $('#wizard');
  if (!dlg.open) {
    if (typeof dlg.showModal === 'function') dlg.showModal();
    else dlg.setAttribute('open', '');
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
  const list = isItems(menuId) ? effectiveItems(catalogue, menuId, ms(menuId).items) : effectiveRecipe(catalogue, menuId, ms(menuId).recipe);
  return list.some((r) => r.ingredient === ingredientId && r.enabled);
}

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
      <p>Snag Calc uses a price for every product. Check each one against your local store so the shopping totals are right. It takes a minute or two, and you can redo it any time from <strong>Recipe &amp; prices</strong>.</p>
      <p><strong>What are you planning?</strong></p>
      <div class="menu-choices">${menuIds()
        .map((id) => `<label><input type="checkbox" data-wiz-menu="${esc(id)}" ${wiz.menus.includes(id) ? 'checked' : ''}>${esc(menuTag(id))}</label>`)
        .join('')}</div>
      <p class="notice" data-wiz-error hidden>Pick at least one.</p>
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
    const all = wizardProducts(catalogue, wiz.menus, isOn);
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
  const input = $('#wizard [data-wiz-price]');
  if (input) wizardPriceWording($('#wizard [data-wiz-donated]').checked);
  if (input) {
    input.focus();
    input.select();
  } else {
    $('#wizard button[type=submit]')?.focus();
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
    wiz.items = wizardProducts(catalogue, menus, isOn);
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
    save();
    closeWizard();
    renderPriceTable();
    renderResults();
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

  $('#menu-tabs').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-menu]');
    if (!btn || btn.dataset.menu === settings.menu) return;
    settings.menu = btn.dataset.menu;
    save();
    renderMenu();
  });

  // Plan and restock inputs (rendered per menu, so delegate).
  for (const panel of ['#plan-inputs', '#restock-inputs']) {
    $(panel).addEventListener('input', (e) => {
      const t = e.target;
      const m = ms();
      const { field, qty, sale, sold, stock, perItem } = t.dataset;
      const v = toNumber(t.value);
      const clamp = v == null || v < 0 ? null : v;
      if (field === 'planServes') m.planServes = nonNeg(t.value);
      else if (field === 'salePrice') m.salePrice = nonNeg(t.value);
      else if (field === 'restock.total') m.restock.total = nonNeg(t.value);
      else if (field === 'restock.sold') m.restock.sold = nonNeg(t.value);
      else if (qty) setOverride(m.items, qty, 'quantity', clamp);
      else if (perItem) setOverride(m.items, perItem, 'perServe', clamp);
      else if (sale) setOverride(m.items, sale, 'salePrice', clamp);
      else if (sold) {
        if (clamp == null) delete m.restock.sold[sold];
        else m.restock.sold[sold] = clamp;
      } else if (stock) {
        if (clamp == null) delete m.restock.stock[stock];
        else m.restock.stock[stock] = clamp;
      } else return;
      changed();
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
      if (menuDef().allowCustom) renderPriceTable();
    } else if (per) {
      const v = toNumber(e.target.value);
      setOverride(m.recipe, per, 'perServe', v == null || v < 0 ? null : v);
    } else return;
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
    if (!e.target.closest('[data-goto-choose]')) return;
    selectView('settings');
    $('#panel-settings').scrollIntoView({ behavior: 'smooth', block: 'start' });
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

  $('#reset').addEventListener('click', () => {
    if (!confirm('Reset all settings, stock counts and price overrides on every tab?')) return;
    settings = defaultSettings();
    save();
    init();
  });
}

let bound = false;
function init() {
  rebuildCatalogue();
  $('#group-name').textContent = catalogue.groupName || 'Scout Group';
  if (!bound) {
    renderMenuTabs();
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
  settings = loadSettings();
  init();
}

start();

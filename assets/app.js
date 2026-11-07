import { calculate, calculateRestock, calculateItems, effectiveRecipe, effectiveItems } from './calc.js';
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

let catalogue;
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
  return { store: 'cheapest', buffer: 5, prices: {}, menu: menuIds()[0], view: 'plan', menus: {} };
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
    const s = { ...base, ...saved, menus: saved.menus || {} };
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
    .map(({ product, count }) => `${count} × ${esc(product.name)} <span class="sub">${esc(product.packLabel)}</span>`)
    .join('');
  return `${items}<span class="sub">Gives ${esc(fmtPlain(p.units, line.ingredient))}${
    p.store ? ` <span class="store-tag">${esc(storeName(p.store))}</span>` : ''
  }</span>`;
}

function shoppingListText(result, heading) {
  const byStore = new Map();
  for (const line of result.lines) {
    for (const { product, count } of line.purchase.packs) {
      const key = line.purchase.store ?? 'other';
      if (!byStore.has(key)) byStore.set(key, []);
      const cost = Number.isFinite(product.price) ? ` (${money(product.price * count)})` : '';
      byStore.get(key).push(`- ${count} × ${product.name} – ${product.packLabel}${cost}`);
    }
  }
  if (!byStore.size) return `${heading}\nNothing to buy.`;
  const parts = [heading];
  for (const [store, items] of byStore) parts.push(`\n${storeName(store)}:\n${items.join('\n')}`);
  parts.push(`\nTotal: ${money(result.totalCost)}${result.incomplete ? ' (some prices missing)' : ''}`);
  return parts.join('\n');
}

function statsFor(result, restock) {
  const stats = [['Shopping total', money(result.totalCost)]];
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
          l.purchase.packs.some(({ product }) => !product.priceUpdated && !product.overridden)
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

function planResult() {
  const m = ms();
  if (isItems()) {
    return calculateItems({ catalogue, menuId: settings.menu, store: settings.store, itemOverrides: m.items, priceOverrides: settings.prices });
  }
  return calculate({
    catalogue,
    menuId: settings.menu,
    bufferPct: settings.buffer,
    store: settings.store,
    recipeOverrides: m.recipe,
    priceOverrides: settings.prices,
    serves: m.planServes,
  });
}

function restockResult() {
  const m = ms();
  if (isItems()) {
    return calculateItems({
      catalogue,
      menuId: settings.menu,
      store: settings.store,
      itemOverrides: m.items,
      priceOverrides: settings.prices,
      sold: m.restock.sold,
      stock: m.restock.stock,
    });
  }
  return calculateRestock({
    catalogue,
    menuId: settings.menu,
    bufferPct: settings.buffer,
    store: settings.store,
    recipeOverrides: m.recipe,
    priceOverrides: settings.prices,
    totalDesired: m.restock.total,
    sold: m.restock.sold,
    stock: stockInBaseUnits(m.restock.stock),
  });
}

function sheetText(result, mode, title) {
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

function foodServesNote() {
  const parts = menuIds()
    .filter((id) => !isItems(id))
    .map((id) => `${num(ms(id).planServes ?? 0, 0)} ${serveLabel(id)}`);
  return parts.length ? `Your plans add up to ${parts.join(' and ')}.` : '';
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
  const hint = menu.sells
    ? 'How many of each do you want to sell? Set the sale price for each one too.'
    : `How many of each do you need for the event? ${esc(foodServesNote())} Napkins are usually about 1 per serve.`;
  $('#plan-inputs').innerHTML = `<h2>${esc(menu.name)}</h2>
    <p class="hint">${hint}</p>
    ${items.length ? '' : '<p class="hint">Nothing selected. Turn items on under Recipe &amp; prices.</p>'}
    <div class="item-grid">${items
      .map((r) => {
        const ing = catalogue.ingredients[r.ingredient];
        return `<div class="item-row">
          <span class="item-name">${esc(ing.name)}${r.note ? `<span class="sub">${esc(r.note)}</span>` : ''}</span>
          <label>Quantity
            <span class="input-suffix"><input type="number" min="0" step="1" inputmode="numeric" data-qty="${esc(r.ingredient)}" value="${valueAttr(r.quantity)}"><span>${esc(ing.unit)}</span></span>
          </label>
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
  $('#restock-inputs').innerHTML = `<p class="hint">At the end of day 1, enter how many of each you've ${
    menuDef().sells ? 'sold' : 'used'
  } and how many are left. Snag Calc buys enough to reach the quantities on the Plan tab.</p>
    <p id="restock-summary" class="summary"></p>
    <div class="item-grid">${items
      .map((r) => {
        const ing = catalogue.ingredients[r.ingredient];
        return `<div class="item-row">
          <span class="item-name">${esc(ing.name)}<span class="sub">Planned: ${num(r.quantity, 0)} ${esc(ing.unit)}</span></span>
          <label>${menuDef().sells ? 'Sold' : 'Used'}
            <span class="input-suffix"><input type="number" min="0" step="1" inputmode="numeric" data-sold="${esc(r.ingredient)}"
              value="${valueAttr(m.restock.sold[r.ingredient])}" placeholder="0"><span>${esc(ing.unit)}</span></span>
          </label>
          <label>Left over
            <span class="input-suffix"><input type="number" min="0" step="1" inputmode="numeric" data-stock="${esc(r.ingredient)}"
              value="${valueAttr(m.restock.stock[r.ingredient])}" placeholder="0"><span>${esc(ing.unit)}</span></span>
          </label>
        </div>`;
      })
      .join('')}</div>`;
}

function renderRecipeTable() {
  const m = ms();
  if (isItems()) {
    $('#recipe-title').textContent = 'Items';
    $('#recipe-hint').textContent = "Untick anything you don't need. Set quantities on the Plan tab.";
    const items = effectiveItems(catalogue, settings.menu, m.items);
    $('#recipe-table').innerHTML = `<thead><tr><th>Use</th><th>Item</th><th>Notes</th></tr></thead>
      <tbody>${items
        .map((r) => {
          const ing = catalogue.ingredients[r.ingredient];
          return `<tr>
            <td><input type="checkbox" data-enable="${esc(r.ingredient)}" ${r.enabled ? 'checked' : ''} aria-label="Use ${esc(ing.name)}"></td>
            <td>${esc(ing.name)}</td>
            <td class="sub">${esc(r.note ?? '')}</td>
          </tr>`;
        })
        .join('')}</tbody>`;
    return;
  }
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

function renderPriceTable() {
  const ids = [...new Set(menuDef().recipe.map((r) => r.ingredient))];
  let rows = '';
  for (const id of ids) {
    for (const p of catalogue.ingredients[id].products) {
      const override = settings.prices[p.id];
      rows += `<tr>
        <td>${esc(p.name)}<span class="sub">${esc(p.packLabel)}</span></td>
        <td>${esc(storeName(p.store))}</td>
        <td class="num">${money(p.price)}<span class="sub">${
          p.priceUpdated ? `checked ${esc(p.priceUpdated)}` : '<span class="badge-estimate">estimate</span>'
        }</span></td>
        <td class="your-price"><span class="input-prefix"><span>$</span><input type="number" min="0" step="0.01" data-price="${esc(p.id)}"
          value="${valueAttr(override)}" placeholder="${p.price ?? ''}" aria-label="Your price for ${esc(p.name)} at ${esc(storeName(p.store))}"></span></td>
      </tr>`;
    }
  }
  $('#price-table').innerHTML = `<thead><tr><th>Product</th><th>Store</th><th class="num">Listed price</th><th>Your price</th></tr></thead><tbody>${rows}</tbody>`;
  $('#price-info').textContent =
    'Listed prices come from the shared price list in this site. Prices marked "estimate" haven\'t been checked against the store yet. ' +
    'Enter your own price to override one for this browser. Prices are shared across all tabs.';
}

function renderMenuTabs() {
  $('#menu-tabs').innerHTML = menuIds()
    .map((id) => {
      const m = catalogue.menu[id];
      return `<button role="tab" data-menu="${esc(id)}" aria-selected="${id === settings.menu}">
        <span class="icon" aria-hidden="true">${esc(m.icon ?? '')}</span><span>${esc(m.tabLabel ?? m.name)}</span></button>`;
    })
    .join('');
}

function renderMenu() {
  for (const b of document.querySelectorAll('#menu-tabs [data-menu]')) {
    b.setAttribute('aria-selected', String(b.dataset.menu === settings.menu));
  }
  $('#buffer-label').hidden = isItems();
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
      const { field, qty, sale, sold, stock } = t.dataset;
      const v = toNumber(t.value);
      const clamp = v == null || v < 0 ? null : v;
      if (field === 'planServes') m.planServes = nonNeg(t.value);
      else if (field === 'salePrice') m.salePrice = nonNeg(t.value);
      else if (field === 'restock.total') m.restock.total = nonNeg(t.value);
      else if (field === 'restock.sold') m.restock.sold = nonNeg(t.value);
      else if (qty) setOverride(m.items, qty, 'quantity', clamp);
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
    } else if (per) {
      const v = toNumber(e.target.value);
      setOverride(m.recipe, per, 'perServe', v == null || v < 0 ? null : v);
    } else return;
    changed();
  });

  $('#price-table').addEventListener('input', (e) => {
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
  $('#group-name').textContent = catalogue.groupName || 'Scout Group';
  if (!bound) {
    renderMenuTabs();
    bindInputs();
    bound = true;
  }
  $('#store').value = settings.store;
  $('#buffer').value = settings.buffer;
  renderMenu();
  selectView(settings.view || 'plan');
}

async function start() {
  try {
    const res = await fetch('data/catalogue.json', { cache: 'no-cache' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    catalogue = await res.json();
  } catch (err) {
    document.querySelector('main').innerHTML = `<div class="card notice">Couldn't load the price list (${esc(err.message)}).
      If you opened index.html straight from disk, run a local web server instead (see README).</div>`;
    return;
  }
  settings = loadSettings();
  init();
}

start();

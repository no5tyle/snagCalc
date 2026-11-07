import { calculate, calculateRestock, effectiveRecipe } from './calc.js';

const MENU_ID = 'sausage-sizzle';
const STORAGE_KEY = 'snagcalc:v1';

const $ = (sel) => document.querySelector(sel);
const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const money = (n) => (n == null ? '—' : n.toLocaleString('en-AU', { style: 'currency', currency: 'AUD' }));
const num = (n, dp = 2) => Number(n.toFixed(dp)).toLocaleString('en-AU');
const toNumber = (v) => (v === '' || v == null ? null : Number(v));

let catalogue;
let settings;

function defaultSettings() {
  return {
    store: 'cheapest',
    buffer: 5,
    salePrice: catalogue.menu[MENU_ID].defaultSalePrice ?? 3,
    planServes: 200,
    restock: { total: 400, sold: 0, stock: {} },
    recipe: {},
    prices: {},
    tab: 'plan',
  };
}

function loadSettings() {
  const base = defaultSettings();
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
    if (saved && typeof saved === 'object') {
      return { ...base, ...saved, restock: { ...base.restock, ...(saved.restock || {}) } };
    }
  } catch {
    /* storage unavailable or corrupt: use defaults */
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

  const stats = [];
  stats.push(['Shopping total', money(result.totalCost)]);
  if (!restock && result.serves > 0) {
    const revenue = result.serves * settings.salePrice;
    stats.push(['Cost per sausage', money(result.totalCost / result.serves)]);
    stats.push([`Takings at ${money(settings.salePrice)} each`, money(revenue)]);
    stats.push(['Profit if all sell', money(revenue - result.totalCost)]);
  }
  if (restock) {
    const revenue = result.remainingServes * settings.salePrice;
    stats.push(['Sausages still to sell', num(result.remainingServes, 0)]);
    stats.push([`Takings at ${money(settings.salePrice)} each`, money(revenue)]);
  }

  return `<div class="card">
    <h2>${esc(title)}</h2>
    ${result.incomplete ? '<p class="notice">Some items have no price, so the total is incomplete.</p>' : ''}
    <div class="table-scroll"><table class="data results">
      <thead><tr>
        <th>Item</th><th class="num">Need</th>${restock ? '<th class="num">Have</th>' : ''}<th>Buy</th><th class="num">Cost</th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table></div>
    <div class="totals">${stats
      .map(([label, value]) => `<div class="stat"><span class="label">${esc(label)}</span><span class="value">${value}</span></div>`)
      .join('')}</div>
    <div class="actions">
      <button class="primary" data-copy>Copy shopping list</button>
      <button class="secondary" data-print>Print</button>
    </div>
  </div>`;
}

// ---------- Calculation wrappers ----------

function common() {
  return {
    catalogue,
    menuId: MENU_ID,
    bufferPct: settings.buffer,
    store: settings.store,
    recipeOverrides: settings.recipe,
    priceOverrides: settings.prices,
  };
}

function stockInBaseUnits() {
  const out = {};
  for (const [id, v] of Object.entries(settings.restock.stock)) {
    const ing = catalogue.ingredients[id];
    if (ing && Number.isFinite(v)) out[id] = v * (ing.stockUnit?.size ?? 1);
  }
  return out;
}

// ---------- Rendering ----------

function renderPlan() {
  const result = calculate({ ...common(), serves: settings.planServes });
  const el = $('#plan-results');
  el.innerHTML = resultsCard(result, { title: `Shopping list for ${num(result.serves, 0)} sausages` });
  wireActions(el, () => shoppingListText(result, `Snag Calc – ${num(result.serves, 0)} sausages`));
}

function renderRestock() {
  const result = calculateRestock({
    ...common(),
    totalDesired: settings.restock.total,
    sold: settings.restock.sold,
    stock: stockInBaseUnits(),
  });
  const pct = result.totalDesired ? Math.round((result.sold / result.totalDesired) * 100) : 0;
  $('#restock-summary').textContent =
    result.sold > result.totalDesired
      ? `Day 1 sold ${num(result.sold, 0)}, already more than the ${num(result.totalDesired, 0)} target.`
      : `Day 1 sold ${num(result.sold, 0)} of ${num(result.totalDesired, 0)} (${pct}%). ${num(result.remainingServes, 0)} sausages still to sell.`;
  const el = $('#restock-results');
  el.innerHTML = resultsCard(result, { restock: true, title: 'Restock shopping list' });
  wireActions(el, () => shoppingListText(result, `Snag Calc restock – ${num(result.remainingServes, 0)} sausages to go`));
}

function renderStockInputs() {
  const recipe = effectiveRecipe(catalogue, MENU_ID, settings.recipe).filter((r) => r.enabled);
  $('#stock-inputs').innerHTML = recipe
    .map((r) => {
      const ing = catalogue.ingredients[r.ingredient];
      const label = ing.stockUnit?.label ?? ing.unit;
      const step = (ing.stockUnit?.size ?? 1) > 1 ? '0.1' : '1';
      const v = settings.restock.stock[r.ingredient];
      return `<label>${esc(ing.name)}
        <span class="input-suffix"><input type="number" min="0" step="${step}" inputmode="decimal"
          data-stock="${esc(r.ingredient)}" value="${Number.isFinite(v) ? v : ''}" placeholder="0"><span>${esc(label)}</span></span>
      </label>`;
    })
    .join('');
}

function renderRecipeTable() {
  const recipe = effectiveRecipe(catalogue, MENU_ID, settings.recipe);
  $('#recipe-table').innerHTML = `<thead><tr><th>Use</th><th>Item</th><th>Per sausage</th><th>Notes</th></tr></thead>
    <tbody>${recipe
      .map((r) => {
        const ing = catalogue.ingredients[r.ingredient];
        return `<tr>
          <td><input type="checkbox" data-enable="${esc(r.ingredient)}" ${r.enabled ? 'checked' : ''} aria-label="Use ${esc(ing.name)}"></td>
          <td>${esc(ing.name)}</td>
          <td><span class="input-suffix"><input type="number" min="0" step="any" data-per="${esc(r.ingredient)}" value="${r.perServe}" aria-label="${esc(ing.name)} per sausage"><span>${esc(ing.unit)}</span></span></td>
          <td class="sub">${esc(r.note ?? '')}</td>
        </tr>`;
      })
      .join('')}</tbody>`;
}

function renderPriceTable() {
  let rows = '';
  for (const ing of Object.values(catalogue.ingredients)) {
    for (const p of ing.products) {
      const override = settings.prices[p.id];
      rows += `<tr>
        <td>${esc(p.name)}<span class="sub">${esc(p.packLabel)}</span></td>
        <td>${esc(storeName(p.store))}</td>
        <td class="num">${money(p.price)}<span class="sub">${
          p.priceUpdated ? `checked ${esc(p.priceUpdated)}` : '<span class="badge-estimate">estimate</span>'
        }</span></td>
        <td class="your-price"><span class="input-prefix"><span>$</span><input type="number" min="0" step="0.01" data-price="${esc(p.id)}"
          value="${Number.isFinite(override) ? override : ''}" placeholder="${p.price ?? ''}" aria-label="Your price for ${esc(p.name)} at ${esc(storeName(p.store))}"></span></td>
      </tr>`;
    }
  }
  $('#price-table').innerHTML = `<thead><tr><th>Product</th><th>Store</th><th class="num">Listed price</th><th>Your price</th></tr></thead><tbody>${rows}</tbody>`;
  $('#price-info').textContent =
    'Listed prices come from the shared price list in this site. Prices marked "estimate" haven\'t been checked against the store yet. ' +
    'Enter your own price to override one for this browser (useful for your local Drakes).';
}

function renderAll() {
  renderPlan();
  renderRestock();
}

function wireActions(container, getText) {
  container.querySelector('[data-copy]')?.addEventListener('click', async (e) => {
    const text = getText();
    try {
      await navigator.clipboard.writeText(text);
      e.target.textContent = 'Copied!';
    } catch {
      window.prompt('Copy the shopping list:', text);
    }
    setTimeout(() => (e.target.textContent = 'Copy shopping list'), 2000);
  });
  container.querySelector('[data-print]')?.addEventListener('click', () => window.print());
}

// ---------- Tabs ----------

function selectTab(name) {
  for (const t of ['plan', 'restock', 'settings']) {
    const on = t === name;
    $(`#tab-${t}`).setAttribute('aria-selected', String(on));
    $(`#panel-${t}`).hidden = !on;
  }
  settings.tab = name;
  save();
}

// ---------- Init ----------

function bindInputs() {
  const store = $('#store');
  store.innerHTML =
    `<option value="cheapest">Cheapest per item</option>` +
    Object.entries(catalogue.stores)
      .map(([id, s]) => `<option value="${esc(id)}">${esc(s.name)} only</option>`)
      .join('');
  store.value = settings.store;
  $('#buffer').value = settings.buffer;
  $('#sale-price').value = settings.salePrice;
  $('#plan-serves').value = settings.planServes;
  $('#restock-total').value = settings.restock.total;
  $('#restock-sold').value = settings.restock.sold;

  const onChange = (fn) => (e) => {
    fn(e);
    save();
    renderAll();
  };

  store.addEventListener('change', onChange((e) => (settings.store = e.target.value)));
  $('#buffer').addEventListener('input', onChange((e) => (settings.buffer = Math.max(0, toNumber(e.target.value) ?? 0))));
  $('#sale-price').addEventListener('input', onChange((e) => (settings.salePrice = Math.max(0, toNumber(e.target.value) ?? 0))));
  $('#plan-serves').addEventListener('input', onChange((e) => (settings.planServes = Math.max(0, toNumber(e.target.value) ?? 0))));
  $('#restock-total').addEventListener('input', onChange((e) => (settings.restock.total = Math.max(0, toNumber(e.target.value) ?? 0))));
  $('#restock-sold').addEventListener('input', onChange((e) => (settings.restock.sold = Math.max(0, toNumber(e.target.value) ?? 0))));

  $('#stock-inputs').addEventListener(
    'input',
    onChange((e) => {
      const id = e.target.dataset.stock;
      if (!id) return;
      const v = toNumber(e.target.value);
      if (v == null) delete settings.restock.stock[id];
      else settings.restock.stock[id] = Math.max(0, v);
    })
  );

  $('#recipe-table').addEventListener(
    'input',
    onChange((e) => {
      const { enable, per } = e.target.dataset;
      if (enable) {
        settings.recipe[enable] = { ...settings.recipe[enable], enabled: e.target.checked };
        renderStockInputs();
      } else if (per) {
        const v = toNumber(e.target.value);
        const o = { ...settings.recipe[per] };
        if (v == null || v < 0) delete o.perServe;
        else o.perServe = v;
        settings.recipe[per] = o;
      }
    })
  );

  $('#price-table').addEventListener(
    'input',
    onChange((e) => {
      const id = e.target.dataset.price;
      if (!id) return;
      const v = toNumber(e.target.value);
      if (v == null || v < 0) delete settings.prices[id];
      else settings.prices[id] = v;
    })
  );

  for (const t of ['plan', 'restock', 'settings']) $(`#tab-${t}`).addEventListener('click', () => selectTab(t));

  $('#reset').addEventListener('click', () => {
    if (!confirm('Reset all settings, stock counts and price overrides?')) return;
    settings = defaultSettings();
    save();
    init();
  });
}

let bound = false;
function init() {
  $('#group-name').textContent = catalogue.groupName || 'Scout Group';
  if (!bound) {
    bindInputs();
    bound = true;
  } else {
    // Re-sync values after a reset.
    $('#store').value = settings.store;
    $('#buffer').value = settings.buffer;
    $('#sale-price').value = settings.salePrice;
    $('#plan-serves').value = settings.planServes;
    $('#restock-total').value = settings.restock.total;
    $('#restock-sold').value = settings.restock.sold;
  }
  renderRecipeTable();
  renderPriceTable();
  renderStockInputs();
  renderAll();
  selectTab(settings.tab || 'plan');
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

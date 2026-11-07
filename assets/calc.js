// Pure calculation helpers for snagCalc. No DOM access here so they can be
// unit-tested with `node --test`.

const gcd = (a, b) => (b === 0 ? a : gcd(b, a % b));

// Cap on DP table size; beyond this we fall back to the best single product.
const MAX_DP_STEPS = 200000;

/**
 * Work out the cheapest combination of packs that covers `needed` units.
 *
 * @param {number} needed  Units required (may be fractional; rounded up).
 * @param {Array<{packSize:number, price:number|null}>} products
 * @returns {{ packs: Array<{product:object, count:number}>, units:number, cost:number|null }}
 *   `cost` is null when any chosen product has no known price.
 */
export function cheapestPacks(needed, products) {
  const options = (products || []).filter((p) => p && p.packSize > 0);
  const empty = { packs: [], units: 0, cost: 0 };
  if (!options.length) return { ...empty, cost: needed > 0 ? null : 0, unavailable: needed > 0 };

  const target = Math.ceil(needed - 1e-9);
  if (target <= 0) return empty;

  // Products without a price are only used if nothing at this store is priced;
  // in that case minimise the number of packs instead.
  const priced = options.filter((p) => Number.isFinite(p.price));
  const pool = priced.length ? priced : options;
  const costOf = (p) => (priced.length ? p.price : 1);

  const sizes = pool.map((p) => Math.max(1, Math.round(p.packSize)));
  const step = sizes.reduce(gcd);
  const steps = Math.ceil(target / step);

  let chosen;
  if (steps > MAX_DP_STEPS) {
    chosen = bestSingle(target, pool, costOf);
  } else {
    // dp[u] = min cost to supply at least u*step units.
    const cost = new Float64Array(steps + 1).fill(Infinity);
    const count = new Uint32Array(steps + 1);
    const pick = new Int16Array(steps + 1).fill(-1);
    cost[0] = 0;
    for (let u = 1; u <= steps; u++) {
      for (let i = 0; i < pool.length; i++) {
        const prev = Math.max(0, u - sizes[i] / step);
        const c = cost[prev] + costOf(pool[i]);
        const n = count[prev] + 1;
        if (c < cost[u] - 1e-9 || (Math.abs(c - cost[u]) <= 1e-9 && n < count[u])) {
          cost[u] = c;
          count[u] = n;
          pick[u] = i;
        }
      }
    }
    const tally = new Map();
    for (let u = steps; u > 0; ) {
      const i = pick[u];
      tally.set(i, (tally.get(i) || 0) + 1);
      u = Math.max(0, u - sizes[i] / step);
    }
    chosen = [...tally].map(([i, n]) => ({ product: pool[i], count: n }));
  }

  chosen.sort((a, b) => b.product.packSize - a.product.packSize);
  const units = chosen.reduce((s, c) => s + c.product.packSize * c.count, 0);
  const cost = priced.length
    ? round2(chosen.reduce((s, c) => s + c.product.price * c.count, 0))
    : null;
  return { packs: chosen, units, cost };
}

function bestSingle(target, pool, costOf) {
  let best = null;
  for (const p of pool) {
    const n = Math.ceil(target / p.packSize);
    const c = n * costOf(p);
    if (!best || c < best.c) best = { c, chosen: [{ product: p, count: n }] };
  }
  return best.chosen;
}

export const round2 = (n) => Math.round(n * 100) / 100;
const roundQty = (n) => Math.round(n * 1e6) / 1e6;

/**
 * Resolve the effective recipe for a menu item, applying user overrides.
 * overrides: { [ingredientId]: { perServe?: number, enabled?: boolean } }
 */
export function effectiveRecipe(catalogue, menuId, overrides = {}) {
  const menu = catalogue.menu[menuId];
  if (!menu) throw new Error(`Unknown menu item: ${menuId}`);
  return menu.recipe.map((r) => {
    const o = overrides[r.ingredient] || {};
    return {
      ...r,
      perServe: Number.isFinite(o.perServe) ? o.perServe : r.perServe,
      enabled: typeof o.enabled === 'boolean' ? o.enabled : r.enabled,
    };
  });
}

/**
 * Apply price overrides ({ [productId]: price }) and donations
 * ({ [productId]: true }) to a product list. A donated product costs nothing;
 * its price is kept as `value`, what it would have cost.
 */
export function pricedProducts(products, priceOverrides = {}, donated = {}) {
  return products.map((p) => {
    const q = Number.isFinite(priceOverrides[p.id]) ? { ...p, price: priceOverrides[p.id], overridden: true } : p;
    return donated[p.id] ? { ...q, price: 0, value: Number.isFinite(q.price) ? q.price : 0, donated: true } : q;
  });
}

/** Value of the donated packs in a purchase. */
const donatedValueOf = (purchase) =>
  round2(purchase.packs.reduce((s, { product, count }) => s + (product.donated ? product.value * count : 0), 0));

/**
 * Choose products for an ingredient given the store mode.
 * store: a store id, or 'cheapest' to pick the cheapest store per ingredient.
 */
export function purchaseFor(needed, products, store, storeIds) {
  if (store !== 'cheapest') {
    return { store, ...cheapestPacks(needed, products.filter((p) => p.store === store)) };
  }
  let best = null;
  for (const s of storeIds) {
    const opts = products.filter((p) => p.store === s);
    if (!opts.length) continue;
    const r = { store: s, ...cheapestPacks(needed, opts) };
    if (r.unavailable) continue;
    if (!best || compareCost(r.cost, best.cost) < 0) best = r;
  }
  return best || { store: null, packs: [], units: 0, cost: needed > 0 ? null : 0, unavailable: needed > 0 };
}

const compareCost = (a, b) => (a ?? Infinity) - (b ?? Infinity);

/**
 * Main calculation.
 *
 * @param {object} args
 * @param {object} args.catalogue   Parsed data/catalogue.json
 * @param {string} args.menuId      e.g. 'sausage-sizzle'
 * @param {number} args.serves      Number of serves still to be supplied
 * @param {number} [args.bufferPct] Extra % added for wastage
 * @param {string} [args.store]     Store id or 'cheapest'
 * @param {object} [args.stock]     Stock on hand in base units { [ingredientId]: number }
 * @param {object} [args.recipeOverrides]
 * @param {object} [args.priceOverrides]
 */
export function calculate({
  catalogue,
  menuId,
  serves,
  bufferPct = 0,
  store = 'cheapest',
  stock = {},
  recipeOverrides = {},
  priceOverrides = {},
  donated = {},
}) {
  const storeIds = Object.keys(catalogue.stores);
  const servesClean = Math.max(0, Number(serves) || 0);
  const factor = 1 + Math.max(0, Number(bufferPct) || 0) / 100;

  const lines = effectiveRecipe(catalogue, menuId, recipeOverrides)
    .filter((r) => r.enabled)
    .map((r) => {
      const ingredient = catalogue.ingredients[r.ingredient];
      if (!ingredient) throw new Error(`Unknown ingredient: ${r.ingredient}`);
      const needed = roundQty(servesClean * r.perServe * factor);
      const onHand = Math.max(0, Number(stock[r.ingredient]) || 0);
      const shortfall = roundQty(Math.max(0, needed - onHand));
      const products = pricedProducts(ingredient.products, priceOverrides, donated);
      const purchase = purchaseFor(shortfall, products, store, storeIds);
      purchase.donatedValue = donatedValueOf(purchase);
      return { id: r.ingredient, ingredient, perServe: r.perServe, needed, onHand, shortfall, products, purchase };
    });

  return { serves: servesClean, lines, ...totals(lines) };
}

function totals(lines) {
  const knownCosts = lines.map((l) => l.purchase.cost).filter((c) => c != null);
  const totalCost = round2(knownCosts.reduce((s, c) => s + c, 0));
  const incomplete = lines.some((l) => l.purchase.cost == null && l.shortfall > 0);
  const donatedValue = round2(lines.reduce((s, l) => s + (l.purchase.donatedValue || 0), 0));
  return { totalCost, incomplete, donatedValue };
}

/**
 * Resolve the item list for a quantity-based menu (drinks, consumables),
 * applying user overrides.
 * overrides: { [ingredientId]: { quantity?: number, perServe?: number, salePrice?: number, enabled?: boolean } }
 *
 * A line with `perServe` is scaled from food serves (see calculateItems)
 * instead of having a fixed `quantity`.
 */
export function effectiveItems(catalogue, menuId, overrides = {}) {
  const menu = catalogue.menu[menuId];
  if (!menu) throw new Error(`Unknown menu item: ${menuId}`);
  return menu.recipe.map((r) => {
    const o = overrides[r.ingredient] || {};
    return {
      ...r,
      quantity: Number.isFinite(o.quantity) ? o.quantity : r.quantity ?? 0,
      perServe: r.perServe == null ? undefined : Number.isFinite(o.perServe) ? o.perServe : r.perServe,
      salePrice: Number.isFinite(o.salePrice) ? o.salePrice : r.salePrice ?? 0,
      enabled: typeof o.enabled === 'boolean' ? o.enabled : r.enabled !== false,
    };
  });
}

/**
 * Quantity-based calculation: each line has its own planned quantity rather
 * than being scaled from a number of serves. No wastage buffer is applied.
 *
 * Lines with `perServe` (e.g. sauces) are the exception: they are scaled from
 * the food serves in `servesByMenu` ({ [menuId]: serves }), counting the menus
 * listed in the line's `servesFrom` (all of them if it has none), plus the
 * wastage buffer. Their sold/used count is ignored, since a restock passes
 * day 2's expected serves.
 *
 * For a day 2 restock, pass `day2Pct`, `sold` (sold or used on day 1) and
 * `stock` (left over), both { [ingredientId]: number } in base units. Each
 * line then needs day2Pct% of its day 1 count, and buys whatever stock
 * doesn't cover. Scaled lines use `servesByMenu` as day 2's expected serves.
 *
 * Revenue is quantity × salePrice for lines still to sell.
 */
export function calculateItems({
  catalogue,
  menuId,
  store = 'cheapest',
  itemOverrides = {},
  priceOverrides = {},
  sold = {},
  stock = {},
  donated = {},
  servesByMenu = {},
  bufferPct = 0,
  day2Pct = null,
}) {
  const restock = day2Pct != null;
  const storeIds = Object.keys(catalogue.stores);
  const factor = 1 + Math.max(0, Number(bufferPct) || 0) / 100;
  const lines = effectiveItems(catalogue, menuId, itemOverrides)
    .filter((r) => r.enabled)
    .map((r) => {
      const ingredient = catalogue.ingredients[r.ingredient];
      if (!ingredient) throw new Error(`Unknown ingredient: ${r.ingredient}`);
      const scaled = Number.isFinite(r.perServe);
      const servesFrom = scaled ? r.servesFrom ?? Object.keys(servesByMenu) : [];
      const serves = servesFrom.reduce((sum, id) => sum + Math.max(0, Number(servesByMenu[id]) || 0), 0);
      const planned = scaled ? roundQty(serves * r.perServe * factor) : Math.max(0, Number(r.quantity) || 0);
      const soldQty = scaled ? 0 : Math.max(0, Number(sold[r.ingredient]) || 0);
      const needed = scaled ? planned : restock ? expectedDay2(soldQty, day2Pct) : planned;
      const onHand = Math.max(0, Number(stock[r.ingredient]) || 0);
      const shortfall = roundQty(Math.max(0, needed - onHand));
      const products = pricedProducts(ingredient.products, priceOverrides, donated);
      const purchase = purchaseFor(shortfall, products, store, storeIds);
      purchase.donatedValue = donatedValueOf(purchase);
      const salePrice = Math.max(0, Number(r.salePrice) || 0);
      return {
        id: r.ingredient,
        ingredient,
        ...(scaled ? { perServe: r.perServe, servesFrom, serves } : {}),
        planned,
        sold: soldQty,
        needed,
        onHand,
        shortfall,
        salePrice,
        products,
        purchase,
      };
    });
  const revenue = round2(lines.reduce((s, l) => s + l.needed * l.salePrice, 0));
  return { lines, revenue, ...totals(lines) };
}

/** Day 2's expected sales: day 1's, scaled by a percentage, in whole units. */
export const expectedDay2 = (soldDay1, day2Pct) =>
  Math.max(0, Math.ceil((Math.max(0, Number(soldDay1) || 0) * Math.max(0, Number(day2Pct) || 0)) / 100 - 1e-9));

/**
 * Restock for day 2 of an event: day 2 is expected to sell `day2Pct`% of
 * what day 1 sold (`sold`), and stock left over (`stock`, base units) is
 * used first. E.g. 300 sold on day 1 at 50% means 150 expected on day 2;
 * with 100 left, 50 more are needed (plus the wastage buffer).
 */
export function calculateRestock({ sold, day2Pct = 100, ...rest }) {
  const soldClean = Math.max(0, Number(sold) || 0);
  const pct = Math.max(0, Number(day2Pct) || 0);
  const expectedServes = expectedDay2(soldClean, pct);
  return { sold: soldClean, day2Pct: pct, expectedServes, ...calculate({ ...rest, serves: expectedServes }) };
}

/** Amount of each ingredient a number of serves uses, without the buffer. */
export function recipeUsage(catalogue, menuId, recipeOverrides = {}, serves = 0) {
  const out = {};
  for (const r of effectiveRecipe(catalogue, menuId, recipeOverrides)) {
    if (r.enabled) out[r.ingredient] = roundQty(Math.max(0, Number(serves) || 0) * r.perServe);
  }
  return out;
}

/**
 * Amount of each item used on day 1: the sold/used count for fixed items,
 * and per serve × day 1 food serves for scaled ones (e.g. sauces).
 */
export function itemsUsage(catalogue, menuId, itemOverrides = {}, used = {}, servesByMenu = {}) {
  const out = {};
  for (const r of effectiveItems(catalogue, menuId, itemOverrides)) {
    if (!r.enabled) continue;
    if (Number.isFinite(r.perServe)) {
      const from = r.servesFrom ?? Object.keys(servesByMenu);
      const serves = from.reduce((sum, id) => sum + Math.max(0, Number(servesByMenu[id]) || 0), 0);
      out[r.ingredient] = roundQty(serves * r.perServe);
    } else {
      out[r.ingredient] = Math.max(0, Number(used[r.ingredient]) || 0);
    }
  }
  return out;
}

/**
 * What should be left after day 1: what the plan bought, minus what day 1
 * used. A starting point for the restock until someone counts the stock.
 */
export function leftoverEstimate(planResult, used = {}) {
  const out = {};
  for (const l of planResult.lines) out[l.id] = roundQty(Math.max(0, l.purchase.units - (Number(used[l.id]) || 0)));
  return out;
}

/**
 * Products to ask about in the price wizard, for the chosen menus.
 * Ordered by menu then recipe order, each product once, with the menus
 * that use it. `include(menuId, ingredientId)` can leave items out (e.g.
 * ones switched off); by default every item is included.
 * @returns {Array<{ product: object, ingredient: object, ingredientId: string, menus: string[] }>}
 */
export function wizardProducts(catalogue, menuIds = Object.keys(catalogue.menu), include = () => true) {
  const byId = new Map();
  for (const menuId of menuIds) {
    const menu = catalogue.menu[menuId];
    if (!menu) continue;
    for (const r of menu.recipe) {
      const ingredient = catalogue.ingredients[r.ingredient];
      if (!ingredient || !include(menuId, r.ingredient)) continue;
      for (const product of ingredient.products) {
        const entry = byId.get(product.id);
        if (entry) {
          if (!entry.menus.includes(menuId)) entry.menus.push(menuId);
        } else {
          byId.set(product.id, { product, ingredient, ingredientId: r.ingredient, menus: [menuId] });
        }
      }
    }
  }
  return [...byId.values()];
}

/**
 * Turn wizard answers ({ [productId]: price | null }) into price overrides.
 * An answer equal to the listed price, or left blank, removes the override.
 */
export function applyWizardPrices(catalogue, overrides, answers) {
  const listed = new Map();
  for (const ing of Object.values(catalogue.ingredients)) for (const p of ing.products) listed.set(p.id, p.price);
  const out = { ...overrides };
  for (const [id, v] of Object.entries(answers)) {
    if (!listed.has(id)) continue;
    if (v == null || !Number.isFinite(v) || v < 0 || round2(v) === listed.get(id)) delete out[id];
    else out[id] = round2(v);
  }
  return out;
}

/**
 * Add the user's own items (e.g. drinks not in the catalogue) to a copy of
 * the catalogue, so every calculation treats them like built-in ones.
 *
 * Each item: { id, menu, name, unit, packSize, price, store, quantity?, salePrice? }.
 * Items with an unknown menu or store, or no pack size, are skipped. Their
 * prices were entered by the user, so they're marked `custom` rather than
 * shown as estimates.
 */
export function withCustomItems(catalogue, items = []) {
  const ingredients = { ...catalogue.ingredients };
  const menu = { ...catalogue.menu };
  for (const it of items || []) {
    const m = menu[it?.menu];
    const packSize = Number(it?.packSize);
    if (!m || !it.id || ingredients[it.id] || !catalogue.stores[it.store] || !(packSize > 0)) continue;
    const unit = it.unit || 'items';
    ingredients[it.id] = {
      name: it.name || 'Drink',
      unit,
      stockUnit: { label: unit, size: 1 },
      custom: true,
      products: [
        {
          id: `${it.id}-pack`,
          store: it.store,
          name: `${it.name || 'Drink'} ${packSize} pack`,
          packSize,
          packLabel: `${packSize} ${unit}`,
          price: Number.isFinite(Number(it.price)) && it.price !== '' && it.price != null ? Number(it.price) : null,
          url: null,
          priceUpdated: null,
          custom: true,
        },
      ],
    };
    const line = { ingredient: it.id, quantity: Math.max(0, Number(it.quantity) || 0), enabled: true, custom: true };
    if (m.sells) line.salePrice = Math.max(0, Number(it.salePrice) || 0);
    menu[it.menu] = { ...m, recipe: [...m.recipe, line] };
  }
  return { ...catalogue, ingredients, menu };
}

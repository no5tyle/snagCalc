// Build a shopping list as tab-separated rows for pasting into Excel or
// Google Sheets. Quantities, packs, costs and totals are written as formulas
// that refer to the input cells, so changing a number in the spreadsheet
// recalculates the rest. No DOM access here so it can be unit-tested.

const colLetter = (i) => {
  let s = '';
  for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
};

const clean = (v) => (typeof v === 'string' ? v.replace(/[\t\r\n]+/g, ' ') : v);
const round = (n, dp = 6) => Math.round(n * 10 ** dp) / 10 ** dp;

/** Cheapest product per unit for a line when the optimiser bought nothing. */
function fallbackProduct(line) {
  const opts = (line.products || []).filter(
    (p) => p.packSize > 0 && (!line.purchase.store || p.store === line.purchase.store)
  );
  const priced = opts.filter((p) => Number.isFinite(p.price));
  const pool = priced.length ? priced : opts;
  return pool.reduce((best, p) => (!best || (p.price ?? 0) / p.packSize < (best.price ?? 0) / best.packSize ? p : best), null);
}

/** Rows to write for one line: one per product bought (or one fallback). */
function productRows(line) {
  const packs = line.purchase.packs;
  if (packs.length > 1) return packs.map(({ product, count }) => ({ product, count, live: false }));
  if (packs.length === 1) return [{ product: packs[0].product, count: packs[0].count, live: true }];
  const product = fallbackProduct(line);
  return [{ product, count: 0, live: Boolean(product) }];
}

/**
 * @param {object} args
 * @param {'recipe'|'items'} args.kind
 * @param {'plan'|'restock'} args.mode
 * @param {object} args.result       Output of calculate / calculateRestock / calculateItems
 * @param {string} args.title
 * @param {string} [args.serveLabel] e.g. 'sausages' (recipe kind)
 * @param {string} [args.serveNoun]  e.g. 'sausage' (recipe kind)
 * @param {number} [args.bufferPct]  (recipe kind)
 * @param {number} [args.salePrice]  per serve (recipe kind)
 * @param {boolean} [args.sells]     items kind: show sale price and takings
 * @param {(id:string)=>string} [args.storeName]
 * @returns {Array<Array<string|number>>}
 */
export function buildSheet({ kind, mode, result, title, serveLabel = 'serves', serveNoun = 'serve', bufferPct = 0, salePrice = 0, sells = false, storeName = (s) => s ?? '' }) {
  const restock = mode === 'restock';
  const rows = [[title]];
  const cell = {}; // named input cells, e.g. cell.serves = '$B$2'
  const input = (key, label, value) => {
    rows.push([label, value]);
    cell[key] = `$B$${rows.length}`;
  };

  let cols;
  if (kind === 'recipe') {
    const cap = serveLabel.charAt(0).toUpperCase() + serveLabel.slice(1);
    if (restock) {
      input('total', `${cap} wanted (whole event)`, result.totalDesired);
      input('sold', `${cap} sold so far`, result.sold);
      rows.push([`${cap} still to sell`, `=MAX(0,${cell.total}-${cell.sold})`]);
      cell.serves = `$B$${rows.length}`;
    } else {
      input('serves', `${cap} to sell`, result.serves);
    }
    input('buffer', 'Wastage buffer %', bufferPct);
    input('sale', `Sale price per ${serveNoun}`, salePrice);
    cols = ['item', 'per', 'unit', 'need', ...(restock ? ['have'] : []), 'product', 'store', 'size', 'packs', 'price', 'cost'];
  } else {
    cols = ['item', ...(restock ? ['planned', 'sold', 'have', 'need'] : ['need']), 'unit', 'product', 'store', 'size', 'packs', 'price', 'cost', ...(sells ? ['sale', 'takings'] : [])];
  }

  const headers = {
    item: 'Item',
    per: `Per ${serveNoun}`,
    unit: 'Unit',
    need: restock ? 'Still needed' : kind === 'items' ? 'Quantity' : 'Need',
    planned: 'Planned',
    sold: 'Sold / used',
    have: 'Have',
    product: 'Product',
    store: 'Store',
    size: 'Pack size',
    packs: 'Packs',
    price: 'Price per pack',
    cost: 'Cost',
    sale: 'Sale price each',
    takings: 'Takings',
  };
  const C = Object.fromEntries(cols.map((k, i) => [k, colLetter(i)]));

  rows.push([]);
  rows.push(cols.map((k) => headers[k]));
  const firstRow = rows.length + 1;

  for (const line of result.lines) {
    productRows(line).forEach(({ product, count, live }, idx) => {
      const r = rows.length + 1;
      const v = {};
      const first = idx === 0;
      if (first) {
        v.item = line.ingredient.name;
        v.unit = line.ingredient.unit;
        if (kind === 'recipe') {
          v.per = line.perServe;
          v.need = `=ROUND(${C.per}${r}*${cell.serves}*(1+${cell.buffer}/100),6)`;
          if (restock) v.have = round(line.onHand);
        } else if (restock) {
          v.planned = line.planned;
          v.sold = line.sold;
          v.have = round(line.onHand);
          v.need = `=MAX(0,${C.planned}${r}-${C.sold}${r})`;
        } else {
          v.need = line.planned;
        }
        if (sells) {
          v.sale = line.salePrice;
          v.takings = `=${C.need}${r}*${C.sale}${r}`;
        }
      }
      if (product) {
        v.product = product.name;
        v.store = storeName(product.store);
        v.size = product.packSize;
        v.price = Number.isFinite(product.price) ? product.price : '';
        const short = C.have ? `MAX(0,${C.need}${r}-${C.have}${r})` : `${C.need}${r}`;
        v.packs = live ? `=ROUNDUP(${short}/${C.size}${r},0)` : count;
        v.cost = `=${C.packs}${r}*${C.price}${r}`;
      } else {
        v.product = 'No product listed';
      }
      rows.push(cols.map((k) => clean(v[k] ?? '')));
    });
  }

  const lastRow = rows.length;
  const sum = (col) => (lastRow >= firstRow ? `=SUM(${col}${firstRow}:${col}${lastRow})` : 0);
  rows.push([]);
  rows.push(['Shopping total', sum(C.cost)]);
  const totalCell = `B${rows.length}`;

  if (kind === 'recipe') {
    if (!restock) rows.push([`Cost per ${serveNoun}`, `=IF(${cell.serves}>0,${totalCell}/${cell.serves},0)`]);
    rows.push([restock ? 'Takings for the rest of the event' : 'Takings if all sell', `=${cell.serves}*${cell.sale}`]);
    if (!restock) rows.push(['Profit if all sell', `=B${rows.length}-${totalCell}`]);
  } else if (sells) {
    rows.push([restock ? 'Takings for the rest of the event' : 'Takings if all sell', sum(C.takings)]);
    if (!restock) rows.push(['Profit if all sell', `=B${rows.length}-${totalCell}`]);
  }
  return rows;
}

export const toTSV = (rows) => rows.map((r) => r.map(clean).join('\t')).join('\n');

// Turning a plan into a link and back, so the person who planned and the
// person restocking see the same numbers without a server. No DOM access
// here so it can be unit-tested.
//
// A link carries the plan after `#plan=`: the JSON, deflated where the
// browser can (prefix `z`), plain otherwise (prefix `j`), as base64url.

const MAX_TEXT = 100;
const MAX_ENTRIES = 300;

const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
const text = (v) => (typeof v === 'string' ? v.slice(0, MAX_TEXT) : undefined);
const count = (v) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : undefined);
const flag = (v) => (typeof v === 'boolean' ? v : undefined);

/** Keep the fields of `v` named in `shape` ({ key: cleaner }), dropping anything a cleaner rejects. */
function pick(v, shape) {
  const out = {};
  if (!isObj(v)) return out;
  for (const [key, clean] of Object.entries(shape)) {
    const c = clean(v[key]);
    if (c !== undefined) out[key] = c;
  }
  return out;
}

/** A { [id]: value } map with every value cleaned. */
const mapOf = (clean) => (v) => {
  const out = {};
  if (!isObj(v)) return out;
  for (const [k, val] of Object.entries(v).slice(0, MAX_ENTRIES)) {
    const c = clean(val);
    if (c !== undefined && k.length <= MAX_TEXT && k !== '__proto__') out[k] = c;
  }
  return out;
};
const listOf = (clean) => (v) => (Array.isArray(v) ? v.slice(0, MAX_ENTRIES).map(clean).filter((x) => x && x.id) : []);

const line = (v) => pick(v, { quantity: count, perServe: count, salePrice: count, enabled: flag });
const restock = (v) =>
  pick(v, {
    // Food menus hold one number sold; drinks and consumables one per item
    sold: (s) => (isObj(s) ? mapOf(count)(s) : count(s)),
    leftPct: mapOf(count),
  });
const menu = (v) => pick(v, { salePrice: count, planServes: count, recipe: mapOf(line), items: mapOf(line), restock });
const customItem = (v) =>
  pick(v, { id: text, menu: text, ingredient: text, name: text, unit: text, store: text, packSize: count, price: count, quantity: count, perServe: count, salePrice: count });
const customMenu = (v) => pick(v, { id: text, name: text, icon: text, serveNoun: text, defaultServes: count, defaultSalePrice: count });

const SHAPE = {
  store: text,
  buffer: count,
  day2Pct: count,
  topupPct: count,
  day: (v) => (Number.isInteger(v) && v >= 1 && v <= 99 ? v : undefined),
  restockFor: (v) => (v === 'today' || v === 'next' ? v : undefined),
  prices: mapOf(count),
  donated: mapOf((v) => (v === true ? true : undefined)),
  active: mapOf((v) => (v === false ? false : undefined)),
  stock: mapOf(count),
  carry: (v) => (isObj(v) ? mapOf(count)(v) : undefined),
  customItems: listOf(customItem),
  customMenus: listOf(customMenu),
  menus: mapOf(menu),
};

/**
 * The part of the settings that makes up a plan, with everything that isn't
 * the expected kind of value dropped. Used both ways: what goes into a link,
 * and what's accepted out of one (a link can come from anyone).
 */
export const planOf = (settings) => pick(settings, SHAPE);

const toB64Url = (bytes) => {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};
const fromB64Url = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));

async function pipe(bytes, stream) {
  const out = new Response(new Blob([bytes]).stream().pipeThrough(stream));
  return new Uint8Array(await out.arrayBuffer());
}

/** A plan as the text that goes after `#plan=` in a link. */
export async function encodePlan(settings) {
  const bytes = new TextEncoder().encode(JSON.stringify(planOf(settings)));
  if (typeof CompressionStream === 'function') {
    try {
      return `z${toB64Url(await pipe(bytes, new CompressionStream('deflate-raw')))}`;
    } catch {
      /* fall through to plain */
    }
  }
  return `j${toB64Url(bytes)}`;
}

/** The plan in a link's text, or null if it can't be read. */
export async function decodePlan(code) {
  try {
    const kind = String(code)[0];
    let bytes = fromB64Url(String(code).slice(1));
    if (kind === 'z') bytes = await pipe(bytes, new DecompressionStream('deflate-raw'));
    else if (kind !== 'j') return null;
    const v = JSON.parse(new TextDecoder().decode(bytes));
    return isObj(v) ? planOf(v) : null;
  } catch {
    return null;
  }
}

/** The plan text in a URL's hash (`#plan=…`), or null. */
export const planInHash = (hash) => /^#?plan=([\w-]+)$/.exec(hash || '')?.[1] ?? null;

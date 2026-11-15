// What to do with a price that's just been looked up. No network or file
// access here so it can be unit-tested.

const tokens = (s) =>
  String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .split(' ')
    .filter((t) => t.length >= 2);

/**
 * Whether a looked-up product is plausibly the one in the catalogue: at least
 * half the words of the catalogue name appear in the store's name. Guards
 * against a wrong stockcode or a page that now shows something else.
 */
export function namesMatch(catalogueName, storeName) {
  const want = tokens(catalogueName);
  if (!want.length || !storeName) return true;
  const have = new Set(tokens(storeName));
  return want.filter((t) => have.has(t)).length * 2 >= want.length;
}

const round2 = (n) => Math.round(n * 100) / 100;

/**
 * Record a looked-up price on a product (in place).
 *
 * @param {object} product  Catalogue product
 * @param {object} found    { price, name?, special?, wasPrice? }. `special`
 *   is true when the store marks it as on special, false when the store
 *   would have said so and didn't, undefined when it can't tell.
 * @param {string} today    ISO date
 * @returns {{ changed: boolean, special: boolean, from: number|null }}
 * @throws if the store's product doesn't look like the catalogue's
 *
 * A special keeps the usual price as `regularPrice`, so the site can say
 * "usually $11.00" and a plan for a later week isn't budgeted on it.
 */
export function recordPrice(product, found, today) {
  if (!namesMatch(product.name, found.name)) throw new Error(`looks like a different product: "${found.name}"`);
  const price = round2(found.price);
  if (!Number.isFinite(price) || price <= 0) throw new Error('no usable price');
  const from = product.price ?? null;
  const before = JSON.stringify([product.price, product.regularPrice ?? null]);

  if (found.special === true) {
    const was = Number.isFinite(found.wasPrice) ? round2(found.wasPrice) : product.regularPrice ?? (from > price ? from : null);
    if (was > price) product.regularPrice = was;
    else delete product.regularPrice;
  } else if (found.special === false) {
    delete product.regularPrice;
  } else if (product.regularPrice != null && price >= product.regularPrice) {
    delete product.regularPrice; // can't tell, but it's back at the usual price or above
  }
  product.price = price;
  product.priceUpdated = today;
  return { changed: before !== JSON.stringify([product.price, product.regularPrice ?? null]), special: product.regularPrice != null, from };
}

/** Whole days between an ISO date and today (ISO); null if either isn't a date. */
export function daysSince(iso, today) {
  const a = Date.parse(`${iso}T00:00:00Z`);
  const b = Date.parse(`${today}T00:00:00Z`);
  return Number.isNaN(a) || Number.isNaN(b) ? null : Math.round((b - a) / 86400000);
}

/**
 * The saving on a Drakes product page's "save $1.50" special sticker.
 * @returns {{ special: boolean, saving: number|null }}
 */
export function drakesSpecial(html) {
  const m = /talker__sticker--Special[^>]*>([\s\S]{0,400}?)<\/span>\s*<\/span>/i.exec(html || '');
  if (!m) return { special: false, saving: null };
  const save = /save[\s\S]*?\$\s*([\d.]+)/i.exec(m[1].replace(/<[^>]+>/g, ' '));
  return { special: true, saving: save ? Number(save[1]) : null };
}

# Snag Calc 🌭

A shopping list and restock calculator for scout group fundraising sausage sizzles. It runs as a static site on GitHub Pages, so there is no server and nothing to install.

## What it does

- **Plan:** enter how many sausages you want to sell. Snag Calc works out how much bread, onion, sauce, oil and napkins you need, picks the cheapest mix of pack sizes, and totals the cost. It also shows cost per sausage and the expected profit.
- **Restock:** after day 1, enter the total you want to sell across the event, how many sold on day 1, and what stock is left. Snag Calc works out what to buy for the rest of the event.
- **Shop at:** Woolworths only, Drakes only, or the cheapest store for each item.
- **Recipe & prices:** turn items on or off (mustard and gloves start off), change how much each sausage uses, and enter your own local prices. Your changes are saved in your browser.
- Copy the shopping list (grouped by store) to paste into a group chat, or print it.

## Hosting on GitHub Pages

1. Merge into `main`.
2. In the repo, go to **Settings → Pages**. Under **Build and deployment**, choose **Deploy from a branch**, then pick `main` and the `/ (root)` folder.
3. The site appears at `https://<user>.github.io/snagCalc/`.

## Running locally

The page loads `data/catalogue.json` with `fetch`, so it needs a web server. Opening `index.html` straight from disk won't work.

```sh
npm start          # python3 -m http.server 8000, then open http://localhost:8000
npm test           # unit tests for the calculator (Node 20+)
```

## Prices and products (`data/catalogue.json`)

Everything the calculator knows lives in one JSON file:

- `ingredients`: each ingredient has a base `unit` (sausages, slices, g, ml…). Its `stockUnit` sets how leftover stock is counted (for example, bread is counted in loaves of 20 slices). Its `products` lists what each store sells.
- Each product has a `store`, `packSize` (in the base unit), `packLabel`, `price` and `priceUpdated`.
- `menu`: the recipe for each menu item, with the quantity used per serve.

> ⚠️ **Sausages (Slape & Sons 1.5kg, Drakes Aston Hills, $11.00) and bread (Woolworths White Soft Sandwich 650g, $2.80) were checked on 2026-11-07. The other prices are still placeholder estimates.** The site labels them "estimate" until they're checked. Update them by hand, or add stockcodes and URLs so the updater can fetch them (see below).

### Automatic price updates

`.github/workflows/update-prices.yml` runs `scripts/update-prices.mjs` every week (and on demand from the Actions tab). If any price changed, it commits the new catalogue.

- **Woolworths:** set `stockcode` on a product. It's the number in the product URL, e.g. `woolworths.com.au/shop/productdetails/`**`123456`**`/...`. The script uses the Woolworths product API.
- **Drakes (or any store):** set `url` to the product page. The script reads the price from the page's structured data (JSON-LD or meta tags).

Products with no stockcode or url are skipped. A failed lookup keeps the old price and is logged. Neither supermarket has an official public API, and both may block automated requests from GitHub's servers, so treat automatic updates as best-effort. Drakes prices also vary between stores, which is why each person can override prices on the site.

## Adding more menu items later

The calculator works from data, so a new item such as an egg and bacon sandwich mostly needs JSON:

1. Add any new ingredients (eggs, bacon, rolls…) with their products under `ingredients`.
2. Add a new entry under `menu` with its `recipe` (for example, 1 roll, 1 egg and 2 rashers of bacon per serve).
3. The UI is currently fixed to `sausage-sizzle` (`MENU_ID` in `assets/app.js`). Showing several menu items needs a small UI change. The calculation functions already take a `menuId`.

## Project layout

```
index.html                 page
assets/calc.js             pure calculation logic (pack optimisation, plan, restock)
assets/app.js              UI
assets/styles.css          styles (light/dark, mobile, print)
data/catalogue.json        products, prices, recipes
scripts/update-prices.mjs  price updater used by the scheduled workflow
tests/                     node:test unit tests
```

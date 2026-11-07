# Snag Calc 🌭

A shopping list and restock calculator for scout group fundraising sausage sizzles. It runs as a static site on GitHub Pages, so there is no server and nothing to install.

## What it does

Pick what you're planning from the tabs at the top: **Sausages**, **Egg & bacon**, **Drinks** or **Consumables** (napkins, gloves, paper towels, bin bags, dishwashing liquid). Each one has its own Plan, Restock and Recipe & prices views.

- **Plan (sausages, egg & bacon):** enter how many you want to sell. Snag Calc works out how much of each ingredient you need, picks the cheapest mix of pack sizes, and totals the cost. It also shows cost per serve and the expected profit.
- **Plan (drinks, consumables):** enter how many of each item you want. Drinks also get a sale price each, so you can see takings and profit.
- **Restock:** after day 1, enter what's sold (or used) and what's left. Snag Calc works out what to buy for the rest of the event.
- **Shop at:** Woolworths only, Drakes only, or the cheapest store for each item.
- **Recipe & prices:** turn items on or off, change how much each serve uses, and enter your own local prices (shared across all tabs). Your changes are saved in your browser.
- **Copy shopping list** (grouped by store) to paste into a group chat, or print it.
- **Copy for spreadsheet** copies the list as a table with live formulas. Paste it into cell A1 of an empty Excel or Google Sheets sheet. Change the number of serves, buffer, quantities or prices there and the packs, costs, takings and profit recalculate.

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
- `menu`: one entry per tab. A normal menu item has a `recipe` with the quantity used per serve (`perServe`). A menu with `"kind": "items"` (drinks, consumables) instead lists a `quantity` for each item, plus a `salePrice` if `"sells": true`.

> ⚠️ **Prices were checked on 2026-11-07 against the group's shopping list: sausages from Drakes Aston Hills, everything else from Woolworths. Eggs, bacon and disposable gloves are still placeholder estimates.** Prices without a `priceUpdated` date show as "estimate" on the site. Update prices by hand, or add stockcodes and URLs so the updater can fetch them (see below).

### Automatic price updates

`.github/workflows/update-prices.yml` runs `scripts/update-prices.mjs` every week (and on demand from the Actions tab). If any price changed, it commits the new catalogue.

- **Woolworths:** set `stockcode` on a product. It's the number in the product URL, e.g. `woolworths.com.au/shop/productdetails/`**`123456`**`/...`. The script uses the Woolworths product API.
- **Drakes (or any store):** set `url` to the product page. The script reads the price from the page's structured data (JSON-LD or meta tags).

Products with no stockcode or url are skipped. A failed lookup keeps the old price and is logged. Neither supermarket has an official public API, and both may block automated requests from GitHub's servers, so treat automatic updates as best-effort. Drakes prices also vary between stores, which is why each person can override prices on the site.

## Adding more menu items

Each entry under `menu` becomes a tab, so a new item is just JSON:

1. Add any new ingredients (rolls, cheese…) with their products under `ingredients`.
2. Add a new entry under `menu` with a `name`, `icon`, `tabLabel`, `serveLabel` (e.g. "rolls"), `serveNoun` ("roll"), `defaultServes`, `defaultSalePrice` and its `recipe`.

## Project layout

```
index.html                 page
assets/calc.js             pure calculation logic (pack optimisation, plan, restock)
assets/sheet.js            spreadsheet export (tab-separated rows with formulas)
assets/app.js              UI
assets/styles.css          styles (light/dark, mobile, print)
data/catalogue.json        products, prices, recipes
scripts/update-prices.mjs  price updater used by the scheduled workflow
tests/                     node:test unit tests
```

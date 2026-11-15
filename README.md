# Snag Calc 🌭

A shopping list and restock calculator for scout group fundraising sausage sizzles. It runs as a static site on GitHub Pages, so there is no server and nothing to install.

## What it does

The **Shop** tab is the whole order on one page. Switch on what you're selling (**Sausages**, **Egg & bacon**, **Drinks**, **Consumables**, plus any recipes of your own), set how many, and it gives one shopping list split into a Woolworths list and a Drakes list, each with its own total. Its **Plan** view is the first shop; its **Restock** view is the day 2 top-up. Tick items off as they go in the trolley.

- Anything two menus share is added up before packs are chosen, so bread for sausages and sandwiches is bought once.
- A menu that's switched off is left off the Shop list, and its serves don't count towards sauces.
- **Your own recipes:** selling burgers or pancakes? **Add your own recipe** gives it a tab like the built-in ones. Say what goes into each serve: ingredients already on the price list (bread, onions, bacon…) or new ones with a pack size, price and store. You can also add an ingredient to a built-in recipe, or an item to Consumables, under **Recipe & prices**.

- **Share a plan:** **Share plan** makes a link that carries the whole plan (what's being sold, prices, recipes, sales and stock counts). Whoever opens it sees the same numbers, so one person can plan and another restock. It's a copy, not a live link: share it again after changing something.
- **Buying for the rest of today, or tomorrow:** on the Restock view, **Buying for** switches between a restock for the next day and a top-up part-way through the day (sales so far, and how busy the rest of the day will be as a % of that).
- **More than two days:** once a restock is bought, **Start day 3** (and so on) carries what's left plus what was bought into the next day, and clears the day's sales ready for the new ones. After a top-up, **Add it to today's stock** does the same without ending the day.
- **Start a new event** (under Recipe & prices) clears sales, stock counts and ticks, and keeps prices, recipes and planned numbers.
- **Works with no signal:** after the first visit the page, the price list and your plan are saved on the phone, so it opens with poor or no reception. It can be added to the home screen.

- **Specials and prices to check:** an item on special is marked with its usual price, and the list says how much more it would cost at usual prices, for anyone shopping in a later week. Prices that are estimates, or were checked over a month ago, are flagged with a link to the price check.
- **Edit what you've added:** an ingredient, drink or item you added has an **Edit** link under Recipe & prices for its name, pack size, price and store. For bread and bacon you can set how many usable slices or rashers you get from a pack.

Each menu also has its own tab, with its own Plan, Restock and Recipe & prices views, for the detail (cost per serve, profit, the recipe).

- **Plan (sausages, egg & bacon):** enter how many you want to sell. Snag Calc works out how much of each ingredient you need, picks the cheapest mix of pack sizes, and totals the cost. It also shows cost per serve and the expected profit.
- **Plan (drinks, consumables):** enter how many of each item you want. Drinks also get a sale price each, so you can see takings and profit. Sauces are the exception: set how much each sausage or sandwich uses, and Snag Calc works it out from the Sausages and Egg & bacon plans combined (mustard counts sausages only).
- **Drinks list:** Coca-Cola, Coke No Sugar, Pepsi, Pepsi Max, Sprite, Fanta, Solo and water are offered (the group's usual Pepsi, Pepsi Max, Solo and water start ticked). Tick the ones you're selling under Drinks → Recipe & prices, or add your own with **Add a drink** (name, cans or bottles, pack size, pack price, store, sale price). Drinks you add are saved in your browser and can be removed.
- **Restock (day 2):** after day 1, enter how many sold (or were used) and how busy you expect day 2 to be, as a % of day 1. Snag Calc buys day 2's expected sales minus what's left. For example, 400 sausages bought, 300 sold and half the sales expected on day 2: 150 expected, 100 left, so 50 to buy (plus the wastage buffer, rounded up to whole packs). Leftovers are estimated from what the first shop bought minus what day 1 used, until you type in a count. Stock is counted once for the whole stall, so on a menu's own tab a shared ingredient shows that tab's share. The % is shared by every tab, and sauces follow day 2's expected sausages and sandwiches. Oil and dishwashing liquid are checked by eye instead: enter how much of the bottle is left (an unopened bottle counts as 100%) and Snag Calc says whether another is needed. Day 1 used the bottle minus what's left, and day 2 needs the day 2 % of that.
- **Shop at:** Woolworths only, Drakes only, or the cheapest store for each item.
- **Price check wizard:** on first visit, Snag Calc asks what you're planning and where you shop, then steps through each product's price one at a time so you can enter what your local store charges, or mark an item as **Donated**. A donated item costs nothing on the shopping list; its price is kept as the donation's value and shown as "Donations worth". Run it again any time from **Recipe & prices** or the link at the bottom of the page.
- **Recipe & prices:** turn items on or off, change how much each serve uses, and enter your own local prices (shared across all tabs). Your changes are saved in your browser.
- **Copy shopping list** (grouped by store) to paste into a group chat, or print it.
- **Copy for spreadsheet** copies the list as a table with live formulas. Paste it into cell A1 of an empty Excel or Google Sheets sheet. Change the number of serves, buffer, quantities or prices there and the packs, costs, takings and profit recalculate.

## Hosting on GitHub Pages

1. Merge into `main`.
2. In the repo, go to **Settings → Pages**. Under **Build and deployment**, choose **Deploy from a branch**, then pick `main` and the `/ (root)` folder.
3. The site appears at `https://<user>.github.io/snagCalc/`.

## Look

Snag Calc shares one look with [Beacon](https://no5tyle.github.io/Beacon/), the [Program Builder](https://no5tyle.github.io/programmer/) and the [homepage](https://no5tyle.github.io/): Apple's system colours (light and dark), rounded cards, capsule buttons and Liquid Glass. Those colours, the rounding and the font come from the shared stylesheet, https://no5tyle.github.io/shared/no5tyle.css (kept in [no5tyle.github.io](https://github.com/no5tyle/no5tyle.github.io)), which `index.html` links before `assets/styles.css`. `assets/styles.css` has only Snag Calc's own styles.

## Running locally

The page loads `data/catalogue.json` with `fetch`, so it needs a web server. Opening `index.html` straight from disk won't work.

```sh
npm start          # python3 -m http.server 8000, then open http://localhost:8000
npm test           # unit tests for the calculator (Node 20+)
npm run test:e2e   # the real page in a browser at phone width (needs `npm ci` and `npx playwright install chromium` first)
```

## Prices and products (`data/catalogue.json`)

Everything the calculator knows lives in one JSON file:

- `ingredients`: each ingredient has a base `unit` (sausages, slices, g, ml…). Its `stockUnit` sets how leftover stock is counted (for example, bread is counted in loaves of 20 slices). Its `products` lists what each store sells.
- Each product has a `store`, `packSize` (in the base unit), `packLabel`, `price` and `priceUpdated`. `regularPrice` is set while it's on special. `"packApprox": true` marks a pack whose count is a judgement (slices in a loaf), which people can change on the site.
- `menu`: one entry per tab. A normal menu item has a `recipe` with the quantity used per serve (`perServe`). A menu with `"kind": "items"` (drinks, consumables) instead lists a `quantity` for each item, plus a `salePrice` if `"sells": true`. An item with `perServe` instead of `quantity` is scaled from the food menus' serves; `servesFrom` limits which menus count (e.g. mustard: `["sausage-sizzle"]`).

> ⚠️ **Every item has a Woolworths product and a Drakes product, so either store can supply the whole list. Drakes prices are read from the Drakes Aston Hills online store (last checked 2026-11-15) and refresh weekly. Woolworths prices were checked on 2026-11-07 against the group's shopping list, except sausages, eggs, bacon, gloves and the Coke-brand drinks, which are still placeholder estimates.** Prices without a `priceUpdated` date show as "estimate" on the site. Update prices by hand, or add stockcodes and URLs so the updater can fetch them (see below).

### Keeping prices up to date

`.github/workflows/update-prices.yml` runs `scripts/update-prices.mjs` every week (and on demand from the Actions tab). If any price changed, it commits the new catalogue. The run's summary page lists what changed, what's on special, lookups that failed, and prices worth checking by hand.

- **Drakes (or any store):** set `url` to the product page. The script reads the price from the page's structured data, and for Drakes the "save $x" sticker, so a special keeps the usual price as `regularPrice`.
- **Woolworths:** set `stockcode` on a product. It's the number in the product URL, e.g. `woolworths.com.au/shop/productdetails/`**`123456`**`/...`. **Woolworths blocks requests from GitHub's servers, so the weekly run does not refresh Woolworths prices.** Run `npm run update-prices` from a home connection to refresh the products that have a stockcode, then commit the result.
- **By hand:** `npm run set-prices -- ww-eggs-12=6.20 ww-bacon-1kg=13` records prices someone checked in store and marks them checked today. On the site, **Copy my prices** (under Recipe & prices, once you've entered a price) copies your prices in that form to send to whoever keeps the list; the text can be piped in as it is: `npm run set-prices < prices.txt`.

A looked-up product whose name doesn't resemble the catalogue's is refused, so a wrong stockcode can't write a wrong price. Products with no stockcode or url are skipped. A failed lookup keeps the old price. Drakes prices also vary between stores, which is why each person can override prices on the site.

## Adding more menu items

Each entry under `menu` becomes a tab, so a new item is just JSON:

1. Add any new ingredients (rolls, cheese…) with their products under `ingredients`.
2. Add a new entry under `menu` with a `name`, `icon`, `tabLabel`, `serveLabel` (e.g. "rolls"), `serveNoun` ("roll"), `defaultServes`, `defaultSalePrice` and its `recipe`.

That adds it for everyone. One person can add a recipe just for their own browser with **Add your own recipe** on the Shop tab.

## Project layout

```
index.html                 page
assets/calc.js             pure calculation logic (pack optimisation, plan, restock, combined list)
assets/sheet.js            spreadsheet export (tab-separated rows with formulas)
assets/share.js            a plan as a link, and back (checked on the way in)
assets/app.js              UI
sw.js                      service worker: keeps the page working with no signal
manifest.webmanifest       name and icons for adding it to a home screen
assets/styles.css          styles (light/dark, mobile, print)
data/catalogue.json        products, prices, recipes
scripts/update-prices.mjs  price updater used by the scheduled workflow
scripts/price-rules.mjs    what the updater does with a looked-up price (specials, wrong-product check)
scripts/set-prices.mjs     record prices checked by hand
tests/                     node:test unit tests
tests/e2e/                 browser tests (Playwright)
```

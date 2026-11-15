# Notes for Claude

## Workflow
- When work is finished and tests pass, merge it into `main` and push `main`. GitHub Pages deploys from `main`, so the change goes live straight away. Do this without asking.
- Run `npm test` before merging, and `npm run test:e2e` after UI changes (browser tests in `tests/e2e/`; CI runs both).
- Check UI changes at phone width (~390px) as well as desktop. Most users will open this on a phone at the BBQ.

## Project
- Static site, no build step. `index.html` + `assets/` + `data/`.
- `assets/calc.js` holds the pure calculation logic and is unit-tested in `tests/`. `assets/sheet.js` (spreadsheet export) and `assets/share.js` (plan links) are pure and tested too. Keep DOM code in `assets/app.js`.
- `sw.js` saves the site for offline use. When a file the page loads is added or renamed, update the `SHELL` list there.
- Anything added to the saved settings that belongs to a plan also needs adding to `SHAPE` in `assets/share.js`, or shared links won't carry it.
- Ingredients and menus live in `data/catalogue.json`. Each entry under `menu` is a tab in the UI, so new menu items should be added as data there. Products and prices live in one file per store: `data/woolworths.json` and `data/drakes.json`. In Node, read them with `scripts/catalogue-files.mjs`.
- `data/drakes.json` is rewritten weekly by the Update Drakes prices workflow, and `data/woolworths.json` by people uploading the site's export. Pull before editing either, and write them with `storeFileText` so diffs stay small.
- Prices without `priceUpdated` are placeholder estimates. Don't present them as real prices.
- Woolworths blocks lookups from GitHub's servers and from Claude's cloud sessions, so only Drakes prices refresh automatically; Woolworths prices are collected through the site (`assets/woolworths.js`), which can't be tested against the real Woolworths from here. Don't hard-code listed prices in tests; read them from the catalogue.

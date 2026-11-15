# Notes for Claude

## Workflow
- When work is finished and tests pass, merge it into `main` and push `main`. GitHub Pages deploys from `main`, so the change goes live straight away. Do this without asking.
- Run `npm test` before merging.
- Check UI changes at phone width (~390px) as well as desktop. Most users will open this on a phone at the BBQ.

## Project
- Static site, no build step. `index.html` + `assets/` + `data/catalogue.json`.
- `assets/calc.js` holds the pure calculation logic and is unit-tested in `tests/`. `assets/sheet.js` (spreadsheet export) and `assets/share.js` (plan links) are pure and tested too. Keep DOM code in `assets/app.js`.
- `sw.js` saves the site for offline use. When a file the page loads is added or renamed, update the `SHELL` list there.
- Anything added to the saved settings that belongs to a plan also needs adding to `SHAPE` in `assets/share.js`, or shared links won't carry it.
- Products, prices and recipes live in `data/catalogue.json`. Each entry under `menu` is a tab in the UI, so new menu items should be added as data there.
- Prices without `priceUpdated` are placeholder estimates. Don't present them as real prices.

# Notes for Claude

## Workflow
- When work is finished and tests pass, merge it into `main` and push `main`. GitHub Pages deploys from `main`, so the change goes live straight away. Do this without asking.
- Run `npm test` before merging.
- Check UI changes at phone width (~390px) as well as desktop. Most users will open this on a phone at the BBQ.

## Project
- Static site, no build step. `index.html` + `assets/` + `data/catalogue.json`.
- `assets/calc.js` holds the pure calculation logic and is unit-tested in `tests/`. Keep DOM code in `assets/app.js`.
- Products, prices and recipes live in `data/catalogue.json`. New menu items (e.g. egg and bacon sandwiches) should be added as data under `menu`.
- Prices without `priceUpdated` are placeholder estimates. Don't present them as real prices.

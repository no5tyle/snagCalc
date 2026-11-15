// Runs the real page in a browser at phone width: plan, restock across a
// weekend, your own recipe, sharing a plan. `npm run test:e2e`.
//
// CommonJS so `require('playwright')` also finds a globally installed copy.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');

const ROOT = path.join(__dirname, '..', '..');
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.png': 'image/png' };
const PHONE = { width: 390, height: 844 };

let server;
let browser;
let base;

before(async () => {
  server = http.createServer((req, res) => {
    const rel = decodeURIComponent(new URL(req.url, 'http://x').pathname).replace(/^\/+/, '') || 'index.html';
    const file = path.join(ROOT, rel);
    if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] ?? 'application/octet-stream' }).end(fs.readFileSync(file));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}/`;
  browser = await chromium.launch();
});

after(async () => {
  await browser?.close();
  server?.close();
});

/** A fresh phone-sized browser with the page open and the first-visit price check skipped. */
async function open(url = base, { skipWizard = true } = {}) {
  // No service worker, so every run loads the files as they are now
  const context = await browser.newContext({ viewport: PHONE, serviceWorkers: 'block' });
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  // The shared stylesheet and app switcher live on another site; the page must work without them
  await context.route((u) => !u.href.startsWith(base), (route) => route.abort());
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(url);
  if (skipWizard) await page.click('#wizard [data-act=skip]');
  return { context, page, errors };
}

const text = async (page, sel) => (await page.innerText(sel)).replace(/\s+/g, ' ').trim();
const total = async (page, panel) => Number((await text(page, `#${panel}-results .stat .value`)).replace(/[$,]/g, ''));
const confirm = async (page) => {
  await page.click('#confirm-ok');
  await page.waitForSelector('#confirm', { state: 'hidden' });
  // The page acts on the answer just after the dialog closes
  await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 50)));
};
const noSidewaysScroll = (page) => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);

test('first visit: the price check opens, then the Shop tab lists both stores', async () => {
  const { context, page, errors } = await open(base, { skipWizard: false });
  assert.ok(await page.isVisible('#wizard'));
  assert.match(await text(page, '#wizard h2'), /Check your prices/);
  await page.click('#wizard [data-act=skip]');
  assert.match(await text(page, '#plan-results'), /First shop/);
  const stores = await page.$$eval('#plan-results .store-card h2', (els) => els.map((e) => e.firstChild.textContent));
  assert.deepEqual(stores, ['Woolworths', 'Drakes']);
  assert.ok((await total(page, 'plan')) > 0);
  assert.ok(await noSidewaysScroll(page));
  assert.deepEqual(errors, []);
  await context.close();
});

test('changing how many to sell, the store, and what is switched on changes the list', async () => {
  const { context, page, errors } = await open();
  const before = await total(page, 'plan');
  await page.fill('[data-menu-id="sausage-sizzle"] [data-field="planServes"]', '400');
  const more = await total(page, 'plan');
  assert.ok(more > before, 'more sausages cost more');
  await page.uncheck('[data-active="egg-bacon"]');
  assert.ok((await total(page, 'plan')) < more, 'switching a menu off takes it off the list');
  assert.ok(!(await text(page, '#plan-results')).includes('Eggs'));
  await page.selectOption('#store', 'drakes');
  assert.deepEqual(await page.$$eval('#plan-results .store-card h2', (els) => els.map((e) => e.firstChild.textContent)), ['Drakes']);
  assert.equal(await page.locator('#plan-results .notice').count(), 0, 'Drakes can supply everything');
  // Ticks survive a reload
  const tick = page.locator('#plan-results [data-tick]').first();
  await tick.check();
  await page.reload();
  assert.ok(await page.locator('#plan-results [data-tick]').first().isChecked());
  assert.deepEqual(errors, []);
  await context.close();
});

test('a weekend: mid-day top-up, then day 2, then day 3', async () => {
  const { context, page, errors } = await open();
  await page.click('#tab-restock');
  const sold = '[data-menu-id="sausage-sizzle"] [data-field="restock.sold"]';
  const sausagesToBuy = async () => {
    const row = page.locator('#restock-results .shop-item', { hasText: 'Sausages:' });
    return (await row.count()) ? Number((await row.first().innerText()).match(/^(\d+) ×/)[1]) : 0;
  };

  // 1pm on day 1: 190 of the 210 sausages bought have gone
  await page.click('[data-restock-for=today]');
  assert.match(await text(page, '#restock-inputs h2'), /Top-up for today/);
  await page.fill(sold, '190');
  await page.click('[data-pct="50"]');
  assert.match(await text(page, '[data-summary="sausage-sizzle"]'), /expect 95 sausages/);
  assert.equal(await sausagesToBuy(), 4); // 99.8 needed with the buffer, 20 left, packs of 21
  await page.click('[data-roll=today]');
  await confirm(page);
  assert.equal(await sausagesToBuy(), 0, 'the top-up is now on the stall');
  assert.equal(await page.getAttribute('[data-stock=sausages]', 'placeholder'), '~104');

  // End of day 1
  await page.click('[data-restock-for=next]');
  await page.fill(sold, '260');
  await page.click('[data-pct="100"]');
  assert.match(await text(page, '#restock-inputs h2'), /Day 2 restock/);
  assert.equal(await sausagesToBuy(), 12); // 273 needed, 34 left
  await page.click('[data-roll=next]');
  await confirm(page);

  // Day 2 starts with what was left plus what was bought, and day 1's sales are gone
  assert.match(await text(page, '#restock-inputs h2'), /Day 3 restock/);
  assert.equal(await page.inputValue(sold), '0');
  assert.equal(await page.getAttribute('[data-stock=sausages]', 'placeholder'), '~286');
  assert.match(await text(page, '#restock-inputs'), /Sausages sold on day 2/);

  // A new event goes back to day 1 and keeps the plan
  await page.click('#tab-settings');
  await page.click('#new-event');
  await confirm(page);
  await page.click('#tab-restock');
  assert.match(await text(page, '#restock-inputs h2'), /Day 2 restock/);
  assert.ok(await noSidewaysScroll(page));
  assert.deepEqual(errors, []);
  await context.close();
});

test('your own recipe: add it, give it ingredients, edit one, and it joins the Shop list', async () => {
  const { context, page, errors } = await open();
  await page.click('#plan-inputs [data-new-recipe]');
  await page.fill('#recipe-dialog [name=name]', 'Burgers');
  await page.fill('#recipe-dialog [name=serveNoun]', 'burger');
  await page.click('#recipe-dialog button[type=submit]');
  assert.match(await text(page, '#recipe-title'), /per burger/);

  await page.fill('#custom-items [name=name]', 'Beef patties');
  await page.fill('#custom-items [name=unit]', 'patties');
  await page.fill('#custom-items [name=packSize]', '10');
  await page.fill('#custom-items [name=price]', '9');
  await page.click('#custom-items button[type=submit]');
  await page.selectOption('#custom-items [name=ingredient]', 'bread');
  await page.fill('#custom-items [name=perServe]', '2');
  await page.click('#custom-items button[type=submit]');
  assert.match(await text(page, '#recipe-table'), /Beef patties.*Bread/);

  // Edit the pack: 12 for $10 instead of 10 for $9
  await page.click('[data-edit-custom]');
  assert.equal(await page.inputValue('#custom-items [name=packSize]'), '10');
  await page.fill('#custom-items [name=packSize]', '12');
  await page.fill('#custom-items [name=price]', '10');
  await page.click('#custom-items button[type=submit]');

  await page.click('[data-menu=all]');
  await page.click('#tab-plan');
  // 100 burgers plus the 5% buffer: 105 patties is 9 packs of 12
  assert.match(await text(page, '#plan-results'), /9 × Beef patties 12 pack/);
  assert.match(await text(page, '#menu-tabs'), /Burgers/);

  await page.click('[data-menu^="recipe-burgers"]');
  await page.click('#tab-settings');
  await page.click('[data-delete-recipe]');
  await confirm(page);
  assert.ok(!(await text(page, '#menu-tabs')).includes('Burgers'));
  assert.ok(await noSidewaysScroll(page));
  assert.deepEqual(errors, []);
  await context.close();
});

test('a shared link opens the same plan in another browser', async () => {
  const { context, page, errors } = await open();
  await page.fill('[data-menu-id="sausage-sizzle"] [data-field="planServes"]', '350');
  await page.selectOption('#store', 'woolworths');
  const mine = await total(page, 'plan');
  await page.click('footer [data-share-plan]');
  await page.waitForFunction(() => document.querySelector('footer [data-share-plan]').textContent === 'Link copied!');
  const link = await page.evaluate(() => navigator.clipboard.readText());
  assert.match(link, /#plan=[\w-]+$/);

  const other = await open(link, { skipWizard: false });
  await other.page.waitForSelector('#plan-results .stat');
  assert.ok(!(await other.page.isVisible('#wizard')), 'the sharer already checked the prices');
  assert.equal(await total(other.page, 'plan'), mine);
  assert.equal(await other.page.inputValue('#store'), 'woolworths');
  assert.ok(!other.page.url().includes('#plan'), 'the plan is dropped from the address bar');
  assert.deepEqual([...errors, ...other.errors], []);
  await other.context.close();
  await context.close();
});

test('prices: a special is flagged, and your own bread count changes the loaves', async () => {
  const { context, page, errors } = await open();
  // Whatever is on special this week is marked, with the usual price
  const specials = await page.evaluate(async () => {
    const c = await (await fetch('data/catalogue.json')).json();
    return Object.values(c.ingredients).flatMap((i) => i.products).filter((p) => p.regularPrice > p.price).length;
  });
  await page.click('#tab-settings');
  assert.equal(await page.locator('#price-table .badge-special').count() > 0, specials > 0);

  await page.click('[data-menu=sausage-sizzle]');
  await page.click('#tab-settings');
  await page.selectOption('#store', 'woolworths');
  await page.fill('[data-pack="ww-bread-white"]', '15');
  await page.click('#tab-plan');
  // 200 sausages plus 5%: 210 slices is 14 loaves of 15, not 11 of 20
  assert.match(await text(page, '#plan-results'), /14 × Woolworths White Soft Sandwich Bread/);
  assert.deepEqual(errors, []);
  await context.close();
});

test('pack sizes and brands are compared by unit price, on your own prices too', async () => {
  const { context, page, errors } = await open();
  await page.click('[data-menu=consumables]');
  await page.click('#tab-settings');
  const firstTomato = () => text(page, '#price-table tr.group + tr');
  assert.match(await text(page, '#price-table tr.group'), /Tomato sauce.*cheapest per 100 ml first/);
  assert.equal(await page.locator('#price-table .badge-best').count() > 0, true);
  // Ozesauce has no price on the list yet: it sorts last until someone enters one
  assert.ok(!(await firstTomato()).includes('Ozesauce'));
  await page.fill('[data-price="ww-ozesauce-tomato-500"]', '1');
  await page.locator('[data-price="ww-ozesauce-tomato-500"]').blur();
  assert.match(await firstTomato(), /Ozesauce.*cheapest.*\$0\.20 per 100 ml/);
  // ...and the shopping list now buys it
  await page.selectOption('#store', 'woolworths');
  await page.click('#tab-plan');
  assert.match(await text(page, '#plan-results'), /Ozesauce Tomato Sauce 500mL/);
  assert.ok(await noSidewaysScroll(page));
  assert.deepEqual(errors, []);
  await context.close();
});

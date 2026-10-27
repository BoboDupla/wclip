// The browser validates the sanitizer independently of the HTML file's CSP.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { renderMarkdown, noteToHtml } from '../dist/render.js';

const executable = process.env.WCLIP_CHROMIUM;
test('real sandboxed Chromium renders sanitized content without executing article handlers',
  { skip: !executable || !existsSync(executable) ? 'no explicit Chromium executable' : false }, async () => {
    const { chromium } = await import('playwright-core');
    const browser = await chromium.launch({ executablePath: executable, headless: true, chromiumSandbox: true });
    try {
      const context = await browser.newContext({ acceptDownloads: false, serviceWorkers: 'block' });
      await context.route('**/*', route => route.abort());
      const page = await context.newPage();
      const dialogs = [];
      page.on('dialog', async d => { dialogs.push(d.message()); await d.dismiss(); });
      const input = '<img src="x" onerror="window.__wclipAttack=1;alert(1)">\n\n' +
        '[click](javascript:window.__wclipAttack=2)\n\n' +
        '<details open ontoggle="window.__wclipAttack=3">text</details>\n\n' +
        '<math><mtext><img src=x onerror="window.__wclipAttack=4"></mtext></math>\n\n' +
        '$\\frac{a}{b}$';
      await page.setContent(renderMarkdown(input)); // no CSP: sanitizer must stand on its own
      await page.locator('a').first().click();
      await page.waitForTimeout(150);
      assert.deepEqual(dialogs, []);
      assert.equal(await page.evaluate(() => window.__wclipAttack), undefined);
      assert.equal(await page.locator('script,iframe,object,svg,[onerror],[ontoggle],[onclick]').count(), 0);
      assert.equal(await page.locator('math mfrac').count(), 1);
      await page.setContent(noteToHtml(input, 'sanitized'));
      assert.equal(await page.locator('meta[http-equiv="Content-Security-Policy"]').count(), 1);
    } finally { await browser.close(); }
  });

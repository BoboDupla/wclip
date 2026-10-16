// Last-resort fetch through headless Chromium (Playwright), for pages that only render with
// JavaScript. Only used when the plain fetch gives nothing or a stub, or with --browser.
// It keeps Chromium's own "HeadlessChrome" user agent: the point is running JS, not disguise.
import { existsSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import type { Page } from './fetch.js';
import { envVar, warn } from './util.js';

const SYSTEM_BROWSERS = ['chromium', 'chromium-browser', 'google-chrome', 'google-chrome-stable', 'brave-browser'];

function onPath(name: string): string | null {
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    const p = join(dir, name);
    if (dir && existsSync(p)) return p;
  }
  return null;
}

export async function fetchWithBrowser(url: string, executable: string, timeoutSec: number): Promise<Page | null> {
  let chromium: typeof import('playwright-core').chromium;
  try {
    ({ chromium } = await import('playwright-core'));
  } catch {
    warn('browser fallback unavailable: playwright-core is not installed (npm install playwright-core)');
    return null;
  }
  // Candidates in order: config, $WCLIP_CHROMIUM, Playwright's own download, system browsers.
  const candidates: (string | undefined)[] = [];
  if (executable) candidates.push(executable);
  const envExe = envVar('CHROMIUM');
  if (envExe) candidates.push(envExe);
  candidates.push(undefined);
  for (const name of SYSTEM_BROWSERS) {
    const p = onPath(name);
    if (p) candidates.push(p);
  }
  let browser;
  const errors: string[] = [];
  for (const exe of candidates) {
    try {
      browser = await chromium.launch({ executablePath: exe, headless: true });
      break;
    } catch (e) {
      errors.push(`${exe ?? "Playwright's Chromium"}: ${(e as Error).message.split('\n')[0]}`);
    }
  }
  if (!browser) {
    warn('browser fallback unavailable: no Chromium could be started. Install one ' +
         '(e.g. your distro\'s chromium package, or `npx playwright install chromium`) ' +
         'or set browser.executable in the config.\n  ' + errors.join('\n  '));
    return null;
  }
  try {
    const page = await browser.newPage();
    await page.goto(url, { waitUntil: 'load', timeout: timeoutSec * 1000 });
    // Give client-side rendering a moment to settle; some pages never go fully idle.
    await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
    return { html: await page.content(), url: page.url(), via: 'headless browser' };
  } catch (e) {
    warn(`headless browser: ${(e as Error).message.split('\n')[0]}`);
    return null;
  } finally {
    await browser.close();
  }
}

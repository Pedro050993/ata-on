// Utilidades dos testes no navegador (Playwright + Chromium real).
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
let pw;
try { pw = require('playwright'); } catch { pw = require('/opt/node-tools/node_modules/playwright'); }
export const { chromium } = pw;

export const BASE = process.env.PEDRO_URL || 'http://localhost:8787/';

export async function launch({ audioFile, headless = true, extraArgs = [], fakeDevices = true } = {}) {
  const args = [...(fakeDevices ? ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] : []), '--autoplay-policy=no-user-gesture-required', ...extraArgs];
  if (audioFile) args.push(`--use-file-for-fake-audio-capture=${audioFile}%noloop`);
  const browser = await chromium.launch({ headless, args });
  const ctx = await browser.newContext({ permissions: fakeDevices ? ['microphone'] : [], acceptDownloads: true, viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
  page.on('dialog', d => d.accept());
  return { browser, ctx, page, errors };
}

/** Aceita a próxima caixa do app (dialog#dlg) clicando no botão com o texto. */
export async function dlg(page, label, timeout = 15000) {
  const b = page.locator('#dlg[open] button', { hasText: label });
  await b.first().waitFor({ state: 'visible', timeout });
  await b.first().click();
}

export const db = (page, fn, arg) => page.evaluate(async ([src, a]) => {
  const db = await import('/js/db.js');
  return (0, eval)(src)(db, a);
}, [fn.toString(), arg]);

export async function waitFor(page, check, { timeout = 600000, every = 2000, label = '' } = {}) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    const r = await check();
    if (r) return r;
    await page.waitForTimeout(every);
  }
  throw new Error('tempo esgotado: ' + label);
}

export const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

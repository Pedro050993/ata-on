// TESTE NO NAVEGADOR: PWA — service worker, manifesto, abertura offline,
// isolamento (WASM multithread) e preservação dos dados após atualização.
import { launch, BASE, db } from './helpers.mjs';

const { browser, ctx, page, errors } = await launch({});
const out = {};
try {
  await page.goto(BASE);
  await page.waitForSelector('text=Nova reunião');
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.waitForTimeout(1500); // 1ª ativação recarrega uma vez para habilitar o isolamento
  await page.waitForSelector('text=Nova reunião');
  out.swAtivo = await page.evaluate(() => !!navigator.serviceWorker.controller);
  out.crossOriginIsolated = await page.evaluate(() => self.crossOriginIsolated);
  out.manifesto = await page.evaluate(async () => { const r = await fetch('manifest.webmanifest'); const j = await r.json(); return { nome: j.name, display: j.display, icones: j.icons.map(i => i.sizes) }; });
  // dado de teste
  const id = await page.evaluate(async () => { const db = await import('/js/db.js'); const m = await db.newMeeting({ title: 'Reunião que deve sobreviver', status: 'gravada' }); return m.id; });
  // offline: o app ainda abre a partir do cache
  await ctx.setOffline(true);
  await page.reload();
  await page.waitForSelector('text=Nova reunião', { timeout: 15000 });
  out.abreOffline = true;
  await page.goto(BASE + '#/reunioes');
  out.reuniaoOffline = await page.locator('text=Reunião que deve sobreviver').count() > 0;
  await ctx.setOffline(false);
  // "atualização": força novo service worker e confere que os dados continuam
  await page.evaluate(async () => { const r = await navigator.serviceWorker.getRegistration(); await r.update(); });
  await page.reload(); await page.waitForSelector('text=Nova reunião');
  out.dadosAposAtualizar = !!(await db(page, (d, id) => d.get('meetings', id), id));
} catch (e) { out.error = e.message; }
out.errors = errors;
console.log(JSON.stringify(out, null, 1));
await browser.close(); process.exit(0);

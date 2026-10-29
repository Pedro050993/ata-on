// TESTE NO NAVEGADOR: a aba/navegador fecha NO MEIO da gravação → ao reabrir,
// a reunião é recuperada até o último trecho salvo e pode ser ouvida/transcrita.
// Uso: node tests/browser/e2e-recuperacao.mjs <fala.wav>
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { chromium, BASE, db } from './helpers.mjs';
const wav = process.argv[2];
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pedro-rec-'));
const args = ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-audio-capture=${wav}`];
const out = {};
let ctx = await chromium.launchPersistentContext(dir, { headless: true, args });
let page = ctx.pages()[0] || await ctx.newPage();
page.on('dialog', d => d.accept());
await page.goto(BASE); await page.waitForSelector('text=Nova reunião');
await page.click('button.card:has-text("Presencial")');
await page.click('button:has-text("Iniciar gravação")');
await page.waitForSelector('.clock');
await page.waitForTimeout(25000);
out.relogioAntesDeFechar = await page.textContent('.clock');
await ctx.close(); // simula travamento/fechamento sem "Encerrar"
ctx = await chromium.launchPersistentContext(dir, { headless: true, args });
page = ctx.pages()[0] || await ctx.newPage();
const toasts = [];
page.on('console', () => {});
await page.goto(BASE); await page.waitForSelector('text=Nova reunião');
out.aviso = await page.locator('#toast').textContent().catch(() => '');
const ms = await db(page, async d => (await d.getAll('meetings')).map(m => ({ status: m.status, recovered: m.recovered, durationSec: m.durationSec, tracks: Object.keys(m.tracks || {}) })));
out.reunioes = ms;
const id = await db(page, async d => (await d.getAll('meetings'))[0]?.id);
out.blobs = await db(page, async (d, id) => { const r = {}; for (const b of await d.byMeeting('blobs', id)) r[b.track] = (r[b.track] || 0) + b.data.size; return r; }, id);
console.log(JSON.stringify(out, null, 1));
await ctx.close(); process.exit(0);

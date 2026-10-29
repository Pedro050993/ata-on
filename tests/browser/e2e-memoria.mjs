// TESTE NO NAVEGADOR (Whisper real): corrigir texto → confirmar "lembrar" →
// regra salva → retranscrever → regra aplicada; regra com número é recusada;
// desativar a regra é reversível.
// Uso: node tests/browser/e2e-memoria.mjs <reuniao.wav>
import { launch, BASE, db, waitFor, dlg } from './helpers.mjs';

const wav = process.argv[2];
const { browser, page, errors } = await launch({});
const out = {};
const meeting = id => db(page, (d, id) => d.get('meetings', id), id);
try {
  await page.goto(BASE); await page.waitForSelector('text=Nova reunião');
  await page.evaluate(async () => { const app = await import('/js/app.js'); await app.saveSettings({ asrModel: 'rapido', asrDevice: 'wasm' }); });
  await page.click('button.card:has-text("Importar arquivo")');
  await page.setInputFiles('input[type=file]', wav);
  await page.waitForSelector('.tabs', { timeout: 120000 });
  const id = page.url().split('/').pop();
  await page.click('button:has-text("Transcrever")');
  await waitFor(page, async () => (await meeting(id)).transcription?.status === 'concluída', { label: 'transcrição' });
  await page.waitForSelector('.seg .tx[contenteditable=true]');
  const tx = page.locator('.seg .tx').first();
  const before = (await tx.textContent()).trim();
  const word = before.split(/\s+/).map(w => w.replace(/[^\p{L}]/gu, '')).find(w => w.length >= 6 && !/n[aã]o/i.test(w));
  out.palavra = word;
  // edição 1: troca uma palavra e também um número (o número não pode virar regra)
  await tx.click();
  await page.evaluate(([w]) => { const el = document.querySelector('.seg .tx'); el.textContent = el.textContent.replace(w, 'Construtora Iben').replace(/\b(dois|2)\b/, '3'); }, [word]);
  await page.locator('h3, .player').first().click().catch(() => page.mouse.click(5, 5));
  await page.evaluate(() => document.querySelector('.seg .tx').blur());
  await page.waitForSelector('#dlg[open]', { timeout: 10000 });
  out.dialogo = (await page.textContent('#dlg')).replace(/\s+/g, ' ').slice(0, 300);
  await page.locator('#dlg[open] input[type=checkbox]').first().check();
  await dlg(page, 'Lembrar selecionadas');
  out.regras = await db(page, async (d) => (await d.getAll('corrections')).map(r => `${r.from} → ${r.to} (${r.category})`));
  // retranscreve: a regra deve ser aplicada automaticamente
  await page.click('button:has-text("Transcrever de novo")');
  await dlg(page, 'Transcrever de novo');
  await waitFor(page, async () => (await meeting(id)).transcription?.status === 'em andamento', { every: 300, label: 'início' });
  await waitFor(page, async () => (await meeting(id)).transcription?.status === 'concluída', { label: 're-transcrição' });
  await page.waitForTimeout(1500);
  const segs = await db(page, (d, id) => d.byMeeting('segments', id), id);
  out.aplicadaNaNovaTranscricao = segs.some(s => (s.text || '').includes('Construtora Iben') && s.correctionsUsed?.length);
  out.textoBrutoPreservado = segs.some(s => (s.rawText || '').includes(word));
  // desativar (reversível)
  await page.goto(BASE + '#/memoria'); await page.waitForSelector('table.t');
  await page.locator('table.t input[type=checkbox]').first().uncheck();
  await page.waitForTimeout(500);
  out.desativada = await db(page, async (d) => (await d.getAll('corrections')).map(r => r.enabled));
  // regra manual com número é recusada
  await page.fill('input[placeholder^="Como o modelo"]', 'trezentos'); await page.fill('input[placeholder^="Grafia correta"]', 'duzentos');
  await page.click('button:has-text("Adicionar")');
  out.recusaNumero = (await page.textContent('.alert.bad')).trim();
} catch (e) { out.error = e.stack; }
out.errors = errors;
console.log(JSON.stringify(out, null, 1));
await browser.close(); process.exit(0);

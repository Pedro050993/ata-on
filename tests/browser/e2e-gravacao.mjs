// TESTE NO NAVEGADOR (Chromium real, modelo real):
// gravar pelo microfone (alimentado com fala conhecida) → ouvir → transcrever
// com Whisper → verificar texto. Uso:
//   node tests/browser/e2e-gravacao.mjs <arquivo.wav> [modelo=rapido|equilibrado|preciso] [segundos]
import fs from 'node:fs';
import { launch, BASE, db, waitFor, dlg, log } from './helpers.mjs';
import { wer } from '../../app/js/core/text.js';

const [audio, model = 'equilibrado', secs = '72'] = process.argv.slice(2);
const ref = JSON.parse(fs.readFileSync(new URL('referencia.json', 'file://' + audio.replace(/[^/]+$/, '')), 'utf8'));
const { browser, page, errors } = await launch({ audioFile: audio });
const out = { model };
try {
  await page.goto(BASE);
  await page.waitForSelector('text=Nova reunião');
  await page.evaluate(async (m) => { const app = await import('/js/app.js'); await app.saveSettings({ asrModel: m, asrDevice: 'wasm' }); }, model);
  await page.click('button.card:has-text("Presencial")');
  await page.fill('input[placeholder^="Ex.: Reunião"]', 'Teste E2E — planejamento Torre B');
  await page.fill('input[placeholder^="Opcional: nomes"]', 'Pedro, Marcos, Ana');
  await page.click('button:has-text("Iniciar gravação")');
  await page.waitForSelector('.clock');
  log('gravando…');
  await page.waitForTimeout(Number(secs) * 1000 / 2);
  await page.click('button:has-text("Pausar")'); await page.waitForTimeout(3000);
  await page.click('button:has-text("Retomar")');
  await page.waitForTimeout(Number(secs) * 1000 / 2);
  const shownClock = await page.textContent('.clock');
  await page.click('button:has-text("Encerrar")');
  await dlg(page, 'Encerrar');
  await dlg(page, 'Transcrever agora', 30000);
  await page.waitForSelector('.tabs');
  const id = page.url().split('/').pop();
  out.meetingId = id;
  const m0 = await db(page, (d, id) => d.get('meetings', id), id);
  out.recordedSec = m0.durationSec; out.clock = shownClock; out.tracks = Object.keys(m0.tracks);
  const blobs = await db(page, async (d, id) => (await d.byMeeting('blobs', id)).map(b => ({ t: b.track, s: b.data.size })), id);
  out.audioBytes = blobs.reduce((a, b) => a + b.s, 0);
  log('gravado', out);
  // reprodução: o player carrega o WAV sincronizado
  const dur = await page.evaluate(async () => { const a = document.querySelector('audio'); for (let i = 0; i < 50 && !(a?.duration > 0); i++) await new Promise(r => setTimeout(r, 200)); return a?.duration; });
  out.playerDuration = dur;
  const t0 = Date.now();
  const m = await waitFor(page, async () => { const m = await db(page, (d, id) => d.get('meetings', id), id); return ['concluída', 'sem texto', 'sem fala', 'interrompida'].includes(m.transcription?.status) ? m : null; }, { timeout: 40 * 60000, label: 'transcrição' });
  out.transcribeSec = (Date.now() - t0) / 1000;
  out.status = m.transcription.status; out.engine = m.transcription.engine; out.rtf = m.transcription.rtf;
  const segs = (await db(page, (d, id) => d.byMeeting('segments', id), id)).sort((a, b) => a.i - b.i);
  const text = segs.map(s => s.text).join(' ');
  const refText = ref.roteiro.map(r => r[1]).join(' ');
  out.wer = +wer(refText, text).toFixed(3);
  out.segments = segs.length; out.silentSegments = segs.filter(s => s.silent).length; out.flags = segs.flatMap(s => s.flags || []);
  out.text = text;
  log('resultado', JSON.stringify(out, null, 1));
} catch (e) { out.error = e.message; log('ERRO', e); await page.screenshot({ path: '/tmp/claude-0/-home-user/4e355cad-acb7-57db-865a-548d779f52b0/scratchpad/e2e-erro.png' }); }
out.browserErrors = errors;
fs.writeFileSync(process.env.OUT || '/tmp/claude-0/-home-user/4e355cad-acb7-57db-865a-548d779f52b0/scratchpad/e2e-gravacao.json', JSON.stringify(out, null, 1));
console.log('erros do navegador:', errors);
await browser.close();

// TESTE NO NAVEGADOR (modelo real): importar arquivo → transcrever → medir WER.
// Também salva o PCM 16 kHz da reunião para comparação.
// Uso: node tests/browser/e2e-importar.mjs <arquivo.wav> [modelo] [refKey=normal]
import fs from 'node:fs';
import path from 'node:path';
import { launch, BASE, db, waitFor, log } from './helpers.mjs';
import { wer } from '../../app/js/core/text.js';

const [file, model = 'equilibrado', refKey = 'normal'] = process.argv.slice(2);
const ref = JSON.parse(fs.readFileSync(path.join(path.dirname(file), 'referencia.json'), 'utf8'));
const { browser, page, errors } = await launch({});
const out = { file: path.basename(file), model };
try {
  await page.goto(BASE);
  await page.waitForSelector('text=Nova reunião');
  await page.evaluate(async (m) => { const app = await import('/js/app.js'); await app.saveSettings({ asrModel: m, asrDevice: process.env?.DEV || 'wasm' }); }, model).catch(async () => page.evaluate(async (m) => { const app = await import('/js/app.js'); await app.saveSettings({ asrModel: m, asrDevice: 'wasm' }); }, model));
  await page.click('button.card:has-text("Importar arquivo")');
  await page.setInputFiles('input[type=file]', file);
  await page.waitForSelector('.tabs', { timeout: 300000 });
  const id = page.url().split('/').pop(); out.meetingId = id;
  await page.click('button:has-text("Transcrever")');
  const t0 = Date.now();
  let lastProg = 0;
  const m = await waitFor(page, async () => {
    const m = await db(page, (d, id) => d.get('meetings', id), id);
    const done = await db(page, async (d, id) => (await d.byMeeting('segments', id)).length, id);
    if (Date.now() - lastProg > 60000) { lastProg = Date.now(); log(`trechos salvos: ${done}/${m.transcription?.plan?.length || '?'}`); }
    return ['concluída', 'sem texto', 'sem fala', 'interrompida'].includes(m.transcription?.status) ? m : null;
  }, { timeout: 120 * 60000, every: 5000, label: 'transcrição' });
  out.durationSec = m.durationSec; out.transcribeSec = (Date.now() - t0) / 1000; out.status = m.transcription.status; out.error = m.transcription.error;
  out.engine = m.transcription.engine; out.rtf = m.transcription.rtf;
  const segs = (await db(page, (d, id) => d.byMeeting('segments', id), id)).sort((a, b) => a.i - b.i);
  const text = segs.map(s => s.text).join(' ');
  const refText = (ref[refKey] || []).map(r => r.texto).join(' ');
  if (refText) out.wer = +wer(refText, text).toFixed(3);
  out.segments = segs.length; out.silent = segs.filter(s => s.silent).length; out.maxSegSec = Math.max(...segs.map(s => s.end - s.start));
  out.flags = segs.flatMap(s => s.flags || []);
  out.gaps = segs.slice(1).filter((s, i) => Math.abs(s.start - segs[i].end) > 1e-3).length;
  if (refKey !== 'normal' && ref[refKey]) {
    // completude: quantas falas do roteiro aparecem (aproximadamente) na transcrição
    const norm = s => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ');
    const T = norm(text);
    const keys = ref[refKey].map(r => norm(r.texto).split(' ').filter(w => w.length > 4).slice(0, 3).join(' '));
    out.expectedUtterances = ref[refKey].length;
    out.keyPhraseHits = keys.filter(k => T.includes(k)).length;
  }
  out.sample = text.slice(0, 1200);
  out.segmentsData = segs.map(({ id, i, start, end, text, silent, done }) => ({ id, i, start, end, text, silent, done }));
  out.plan = m.transcription.plan;
  if (process.env.SAVE_PCM) {
    const b64 = await page.evaluate(async (id) => { const ex = await import('/js/export.js'); const db = await import('/js/db.js'); const m = await db.get('meetings', id); const b = await ex.pcmWavBlob(m); return await new Promise(r => { const fr = new FileReader(); fr.onload = () => r(fr.result.split(',')[1]); fr.readAsDataURL(b); }); }, id);
    fs.writeFileSync(process.env.SAVE_PCM, Buffer.from(b64, 'base64'));
  }
} catch (e) { out.error = e.message; log('ERRO', e); }
out.browserErrors = errors;
log(JSON.stringify(out, null, 1));
if (process.env.OUT) fs.writeFileSync(process.env.OUT, JSON.stringify(out, null, 1));
await browser.close();

// TESTES NO NAVEGADOR de robustez (Chromium real, Whisper real "rapido"):
//  A) GPU indisponível → reinício limpo na CPU          (falha REAL de inicialização do WebGPU)
//  B) falha do motor no meio da transcrição → motor novo (falha SIMULADA por gancho de teste)
//  C) fechar o navegador no meio → reabrir → retomar sem reprocessar trechos prontos
//  D) excluir a reunião durante o processamento → nada é recriado
//  E) capturas de tela: deduplicação com conteúdo estático x conteúdo que muda
// Uso: node tests/browser/e2e-robustez.mjs <reuniao_curta.wav> <reuniao_3min.wav>
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium, BASE, db, waitFor, log } from './helpers.mjs';

const [shortWav, longWav] = process.argv.slice(2);
const results = {};
const ARGS = ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required'];

async function open(userDataDir) {
  const ctx = await chromium.launchPersistentContext(userDataDir, { headless: true, args: ARGS, viewport: { width: 1280, height: 900 } });
  const page = ctx.pages()[0] || await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('dialog', d => d.accept());
  await page.goto(BASE);
  await page.waitForSelector('text=Nova reunião');
  return { ctx, page, errors };
}
async function importAudio(page, file) {
  await page.goto(BASE + '#/inicio');
  await page.click('button.card:has-text("Importar arquivo")');
  await page.setInputFiles('input[type=file]', file);
  await page.waitForSelector('.tabs', { timeout: 300000 });
  return page.url().split('/').pop();
}
const meetingOf = (page, id) => db(page, (d, id) => d.get('meetings', id), id);
const segsOf = (page, id) => db(page, async (d, id) => (await d.byMeeting('segments', id)).sort((a, b) => a.i - b.i), id);
const setS = (page, patch) => page.evaluate(async (p) => { const app = await import('/js/app.js'); await app.saveSettings(p); }, patch);
const until = (page, id, sts, timeout = 20 * 60000) => waitFor(page, async () => { const m = await meetingOf(page, id); return m && sts.includes(m.transcription?.status) ? m : null; }, { timeout, label: sts.join('/') });

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pedro-rob-'));
let { ctx, page, errors } = await open(dir);
try {
  // ---------- A + B ----------
  await setS(page, { asrModel: 'rapido', asrDevice: 'webgpu', debugFailAt: [1], debugFailKind: 'gpu' });
  const idA = await importAudio(page, longWav);
  await page.click('button:has-text("Transcrever")');
  const mA = await until(page, idA, ['concluída', 'interrompida', 'sem texto']);
  const logs = await db(page, (d, id) => d.byMeeting('logs', id), idA);
  results.A_gpu_fallback = { status: mA.transcription.status, engineFinal: mA.transcription.engine, logs: logs.map(l => `${l.stage} | ${l.engine} | ${l.kind} | ${l.message.slice(0, 140)}`) };
  results.B_falha_meio = { segmentoComFalha: 1, segmentos: (await segsOf(page, idA)).map(s => ({ i: s.i, ok: !!s.done, chars: (s.text || '').length, engine: s.engine?.device })) };
  await setS(page, { asrDevice: 'wasm', debugFailAt: null });

  // ---------- C ----------
  const idC = await importAudio(page, longWav);
  await page.click('button:has-text("Transcrever")');
  await waitFor(page, async () => (await segsOf(page, idC)).filter(s => s.done && !s.silent).length >= 2, { label: '2 trechos' });
  const before = await segsOf(page, idC);
  const firstJob = before[0].jobId;
  log('fechando o navegador no meio da transcrição; trechos prontos:', before.length);
  await ctx.close();
  ({ ctx, page, errors } = await open(dir));
  await page.goto(BASE + '#/reuniao/' + idC);
  await page.waitForSelector('.tabs');
  const mC0 = await meetingOf(page, idC);
  const resumeBtn = await page.textContent('button:has-text("Retomar")').catch(() => null);
  await page.click('button:has-text("Retomar")');
  await until(page, idC, ['em andamento'], 60000);
  const mC = await until(page, idC, ['concluída', 'interrompida']);
  const after = await segsOf(page, idC);
  results.C_retomada = {
    statusAoReabrir: mC0.transcription.status, botao: resumeBtn, statusFinal: mC.transcription.status,
    prontosAntes: before.length, preservadosDaPrimeiraExecucao: after.filter(s => s.jobId === firstJob).length,
    totalTrechos: after.length, planejados: mC.transcription.plan.length, semLacunas: after.every((s, k) => s.i === k),
  };

  // ---------- D ----------
  const idD = await importAudio(page, longWav);
  await page.click('button:has-text("Transcrever")');
  await waitFor(page, async () => (await segsOf(page, idD)).filter(s => s.done).length >= 1, { label: '1 trecho' });
  await page.click('button:has-text("Excluir reunião")');
  await page.locator('#dlg[open] button:has-text("Excluir")').click();
  await page.waitForURL(/reunioes/);
  await page.waitForTimeout(20000); // tempo para respostas atrasadas tentarem gravar
  const leftovers = await db(page, async (d, id) => { const r = {}; for (const st of ['blobs', 'pcm', 'segments', 'shots', 'logs']) r[st] = (await d.byMeeting(st, id)).length; r.meeting = !!(await d.get('meetings', id)); return r; }, idD);
  results.D_exclusao = leftovers;

  // ---------- E ----------
  results.E_capturas = await page.evaluate(async () => {
    const db = await import('/js/db.js'); const { ScreenCapturer } = await import('/js/screens.js');
    const m = await db.newMeeting({ title: 'teste capturas', status: 'gravada' });
    const c = document.createElement('canvas'); c.width = 800; c.height = 450; const g = c.getContext('2d');
    const draw = (txt, bg) => { g.fillStyle = bg; g.fillRect(0, 0, 800, 450); g.fillStyle = '#fff'; g.font = '48px sans-serif'; g.fillText(txt, 60, 220); };
    draw('Slide 1 — Cronograma', '#234');
    const stream = c.captureStream(5);
    const tick = setInterval(() => { g.fillStyle = 'rgba(0,0,0,0.01)'; g.fillRect(0, 0, 1, 1); }, 200); // mantém quadros fluindo
    let t = 0; const cap = new ScreenCapturer(m.id, stream, { intervalSec: 0, threshold: 12, clock: () => t });
    await cap.start(); await new Promise(r => setTimeout(r, 800));
    const res = [];
    for (let k = 0; k < 4; k++) { t += 5; res.push(!!(await cap.capture(false))); await new Promise(r => setTimeout(r, 300)); } // mesmo slide
    draw('Slide 2 — Orçamento R$ 320 mil', '#523'); await new Promise(r => setTimeout(r, 500)); t += 5; res.push(!!(await cap.capture(false)));
    t += 5; res.push(!!(await cap.capture(false)));
    draw('Slide 2 — Riscos e restrições', '#523'); await new Promise(r => setTimeout(r, 500)); t += 5; res.push(!!(await cap.capture(false))); // só o texto muda
    t += 5; res.push(!!(await cap.capture(true, 'marcado')));
    clearInterval(tick); stream.getTracks().forEach(x => x.stop());
    const shots = await db.byMeeting('shots', m.id);
    await db.deleteMeeting(m.id);
    return { salvasPorTentativa: res, total: shots.length, tempos: shots.map(s => s.t).sort((a, b) => a - b) };
  });
} catch (e) { results.error = e.stack; await page.screenshot({ path: path.join(dir, 'erro.png') }).catch(() => {}); }
results.browserErrors = errors;
console.log(JSON.stringify(results, null, 1));
await ctx.close();
process.exit(0);

// TESTE NO NAVEGADOR com MODELO REAL de IA (Transformers.js, CPU/WASM):
// importar → transcrever (Whisper) → gerar ata pela interface → conferir
// estrutura, refs e ausência de invenção; também confere a recusa com
// transcrição vazia.
// Uso: node tests/browser/e2e-ata.mjs <reuniao.wav> <silencio.wav> [modeloLLM] [modeloASR]
import fs from 'node:fs';
import { launch, BASE, db, waitFor, log } from './helpers.mjs';

const [wav, silence, llmModel = 'onnx-community/Qwen3-1.7B-ONNX', asr = 'equilibrado'] = process.argv.slice(2);
const { browser, page, errors } = await launch({});
const out = { llmModel, asr };
const meetingOf = (id) => db(page, (d, id) => d.get('meetings', id), id);
try {
  await page.goto(BASE); await page.waitForSelector('text=Nova reunião');
  await page.evaluate(async ([m, a]) => { const app = await import('/js/app.js'); await app.saveSettings({ asrModel: a, asrDevice: 'wasm', llm: { provider: 'transformers', model: m, device: 'wasm' } }); }, [llmModel, asr]);

  // 1) silêncio → sem transcrição → ata recusada
  await page.click('button.card:has-text("Importar arquivo")');
  await page.setInputFiles('input[type=file]', silence);
  await page.waitForSelector('.tabs', { timeout: 120000 });
  const idS = page.url().split('/').pop();
  await page.click('button:has-text("Transcrever")');
  await waitFor(page, async () => ['sem fala', 'interrompida'].includes((await meetingOf(idS)).transcription?.status), { label: 'silêncio' });
  await page.click('button.tab:has-text("Ata")');
  out.silencioTelaAta = (await page.textContent('#view')).match(/Transcreva a reunião primeiro[^.]*\./)?.[0] || null;
  const r = await page.evaluate(async (id) => { const app = await import('/js/app.js'); const j = await app.startMinutes(id, { allowPartial: true }); return { erro: j.error?.message, kind: j.error?.kind, ata: !!(await (await import('/js/db.js')).get('meetings', id)).minutes }; }, idS);
  out.silencioGerarAta = r;

  // 2) reunião real
  await page.goto(BASE + '#/inicio');
  await page.click('button.card:has-text("Importar arquivo")');
  await page.setInputFiles('input[type=file]', wav);
  await page.waitForSelector('.tabs', { timeout: 120000 });
  const id = page.url().split('/').pop(); out.meetingId = id;
  await page.click('button:has-text("Transcrever")');
  await waitFor(page, async () => (await meetingOf(id)).transcription?.status === 'concluída', { timeout: 30 * 60000, label: 'transcrição' });
  await page.click('button.tab:has-text("Ata")');
  const t0 = Date.now();
  await page.click('button:has-text("Gerar ata com IA")');
  let last = '';
  const m = await waitFor(page, async () => {
    const st = await page.textContent('.stages').catch(() => '');
    if (st && st !== last) { last = st; log('etapa:', st.replace(/\s+/g, ' ').slice(0, 160)); }
    const m = await meetingOf(id); if (m.minutes?.status === 'pronta') return m;
    const err = await page.$('.alert.bad'); if (err) throw new Error(await err.textContent());
    return null;
  }, { timeout: 90 * 60000, every: 5000, label: 'ata' });
  out.ataSegundos = (Date.now() - t0) / 1000;
  const a = m.minutes;
  out.ata = { titulo: a.titulo, proposito: a.proposito, resumo: a.resumo.map(x => x.texto), decisoes: a.decisoes.map(d => `${d.status}: ${d.texto} ${d.refs.join(',')}`), propostas: a.propostas.map(p => `${p.tipo}: ${p.texto}`), riscos: a.riscos.map(r => r.texto), tarefas: a.tarefas.map(t => `${t.descricao} | ${t.responsavel} | ${t.prazo} | ${t.compromisso} | ${t.refs.join(',')}`), avisos: a.warnings, por: a.generatedBy };
  // sem locutores confirmados, nenhuma tarefa pode ter nome que não aparece no texto
  const segs = await db(page, (d, id) => d.byMeeting('segments', id), id);
  const all = segs.map(s => s.text).join(' ').toLowerCase();
  out.responsaveisSemRespaldo = a.tarefas.filter(t => t.responsavel !== 'A confirmar' && !all.includes(t.responsavel.toLowerCase().split(' ')[0])).map(t => t.responsavel);
  const refsOk = [...a.decisoes, ...a.tarefas].every(x => x.refs.every(r => segs.some(s => s.id === r)));
  out.refsValidas = refsOk;
  await page.click('button.tab:has-text("Formatos")');
  out.ataMarkdown = await page.inputValue('textarea.preview');
} catch (e) { out.error = e.message; await page.screenshot({ path: '/tmp/claude-0/-home-user/4e355cad-acb7-57db-865a-548d779f52b0/scratchpad/e2e-ata-erro.png' }); }
out.browserErrors = errors;
console.log(JSON.stringify(out, null, 1));
if (process.env.OUT) fs.writeFileSync(process.env.OUT, JSON.stringify(out, null, 1));
await browser.close(); process.exit(0);

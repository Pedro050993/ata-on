// TESTE COM MODELO REAL (fora do navegador): roda o MESMO pipeline da ata do app
// (app/js/core/minutes.js) com um LLM local via Transformers.js (ONNX, CPU).
// Uso: node tests/model/ata-real.mjs <transcricao.json|referencia.json> [modelo] [dtype] [comFalantes=0|1]
//  - transcricao.json: saída de tests/browser/e2e-importar.mjs (segmentsData)
//  - comFalantes=1: atribui os locutores reais (gabarito) aos trechos, simulando confirmação do usuário
import fs from 'node:fs';
import path from 'node:path';
import { pipeline } from '@huggingface/transformers';
import { runMinutesPipeline, toMinutesRecord } from '../../app/js/core/minutes.js';
import { render } from '../../app/js/core/formats.js';

const [file, model = 'onnx-community/Qwen3-4B-ONNX', dtype = 'q4f16', withSpk = '0'] = process.argv.slice(2);
const data = JSON.parse(fs.readFileSync(file, 'utf8'));
const ref = JSON.parse(fs.readFileSync(path.join(process.env.FIXTURES || path.dirname(file), 'referencia.json'), 'utf8'));
let segments = data.segmentsData;
if (withSpk === '1') {
  // locutor = quem fala mais tempo dentro do trecho, segundo o gabarito
  segments = segments.map(s => {
    const ov = {}; for (const r of ref.normal) { const o = Math.min(s.end, r.fim) - Math.max(s.start, r.inicio); if (o > 0) ov[r.quem] = (ov[r.quem] || 0) + o; }
    const quem = Object.entries(ov).sort((a, b) => b[1] - a[1])[0]?.[0];
    return { ...s, speaker: quem };
  });
}
// trechos de ~28 s misturam locutores: para o teste com falantes, quebramos por frase do gabarito
if (withSpk === '1') {
  segments = ref.normal.map((r, i) => ({ id: `T${i + 1}`, i, start: r.inicio, end: r.fim, text: r.texto, speaker: r.quem, done: true }));
}
const t0 = Date.now();
const gen = await pipeline('text-generation', model, { dtype });
console.log(`modelo carregado em ${((Date.now() - t0) / 1000).toFixed(0)} s`);
const chat = async (messages, { maxTokens }) => {
  const m = messages.map(x => ({ ...x })); if (/qwen3/i.test(model)) m.at(-1).content += ' /no_think';
  const t = Date.now();
  const out = await gen(m, { max_new_tokens: maxTokens, do_sample: false, repetition_penalty: 1.05 });
  const txt = out[0].generated_text.at(-1).content;
  console.log(`  chamada ao modelo: ${((Date.now() - t) / 1000).toFixed(0)} s, ${txt.length} caracteres`);
  return txt;
};
const speakerName = s => s.speaker || 'Locutor não identificado';
const participants = withSpk === '1' ? ['Pedro', 'Marcos', 'Ana'] : [];
const t1 = Date.now();
const r = await runMinutesPipeline({ segments, plan: data.plan || [], transcriptionDone: true, meta: { title: 'Planejamento Torre B', date: '29/10/2026', participants }, speakerName, participants, chat, contextTokens: 8192, onStage: s => console.log('etapa:', s) });
const rec = toMinutesRecord(r.facts, { partial: r.partial, coverage: r.coverage, provider: 'transformers.js (node)', model, warnings: r.warnings });
const md = render('ata', { meeting: { title: 'Planejamento Torre B', startedAt: '2026-10-29T10:00:00Z', durationSec: 66 }, minutes: rec, segments, segIndex: new Map(segments.map(s => [s.id, s])), shots: [], speakerName, participants });
const res = { model, dtype, withSpeakers: withSpk === '1', seconds: (Date.now() - t1) / 1000, warnings: r.warnings, facts: r.facts };
fs.writeFileSync(process.env.OUT || 'ata-real.json', JSON.stringify(res, null, 1));
fs.writeFileSync((process.env.OUT || 'ata-real.json').replace(/\.json$/, '.md'), md);
console.log(md);
console.log('\nAvisos da verificação:', r.warnings);

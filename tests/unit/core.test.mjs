// Testes unitários (SIMULADOS: sem modelo de IA). Rodar: node --test tests/unit
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { frameEnergies, detectSpeech, planSegments, prepareForAsr, signalReport, SR } from '../../app/js/core/audio-dsp.js';
import { isLikelyHallucination, trimRepetitions, ruleSafety, applyCorrections, proposeRules, wer } from '../../app/js/core/text.js';
import { parseJsonLoose, normalizeFacts, verifyFacts, windows, toMinutesRecord, A_CONFIRMAR } from '../../app/js/core/minutes.js';
import { render, tasksCsv, parseMd, mdToText, FORMATS } from '../../app/js/core/formats.js';

const tone = (sec, amp = 0.3, f = 220) => Float32Array.from({ length: sec * SR }, (_, i) => amp * Math.sin(2 * Math.PI * f * i / SR) * (0.6 + 0.4 * Math.sin(2 * Math.PI * 3 * i / SR)));
const noise = (sec, amp) => Float32Array.from({ length: sec * SR }, () => (Math.random() * 2 - 1) * amp);
const cat = (...a) => { const o = new Float32Array(a.reduce((n, x) => n + x.length, 0)); let k = 0; for (const x of a) { o.set(x, k); k += x.length; } return o; };

test('planejamento corta nas pausas e respeita o limite de 28 s', () => {
  const a = cat(tone(10), noise(0.8, 0.001), tone(12), noise(0.8, 0.001), tone(15), noise(3, 0.001), tone(5));
  const en = frameEnergies(a); const sp = detectSpeech(en); const plan = planSegments(en, sp);
  for (const s of plan) assert.ok(s.end - s.start <= 28.01, `trecho de ${s.end - s.start}s`);
  // cobertura contínua, sem buracos nem sobreposição
  for (let i = 1; i < plan.length; i++) assert.ok(Math.abs(plan[i].start - plan[i - 1].end) < 1e-6);
  assert.ok(Math.abs(plan.at(-1).end - a.length / SR) < 0.05);
  // os cortes devem cair em pausas (energia baixa)
  for (const s of plan.slice(0, -1)) { const f = Math.round(s.end * SR / 480); assert.ok(!sp.flags[f], `corte em fala em ${s.end}s`); }
});

test('fala contínua longa é dividida sem ultrapassar o limite', () => {
  const a = tone(70);
  const en = frameEnergies(a); const plan = planSegments(en, detectSpeech(en));
  assert.ok(plan.length >= 3);
  for (const s of plan) assert.ok(s.end - s.start <= 28.01);
});

test('silêncio é marcado como silencioso e não recebe ganho de "fala"', () => {
  const a = noise(30, 0.0003);
  const en = frameEnergies(a); const sp = detectSpeech(en); const plan = planSegments(en, sp);
  assert.ok(plan.every(p => p.silent), 'silêncio deveria ser pulado');
  const prep = prepareForAsr(a);
  assert.equal(prep.metrics.gainDb, 0);
  const rms = Math.sqrt(prep.samples.reduce((s, v) => s + v * v, 0) / prep.samples.length);
  assert.ok(rms <= 0.0003, 'silêncio não pode ser amplificado');
});

test('fala baixa é normalizada para perto de -20 dBFS sem saturar', () => {
  const a = cat(noise(1, 0.0005), tone(8, 0.01), noise(1, 0.0005));
  const prep = prepareForAsr(a);
  assert.ok(prep.metrics.gainDb > 10, `ganho ${prep.metrics.gainDb}`);
  const peak = prep.samples.reduce((m, v) => Math.max(m, Math.abs(v)), 0);
  assert.ok(peak <= 1);
});

test('relatório de sinal identifica sem-sinal, baixo e saturação', () => {
  assert.equal(signalReport(noise(10, 0.0001)).issues[0].kind, 'sem-sinal');
  assert.ok(signalReport(cat(noise(2, 0.0001), tone(8, 0.004))).issues.some(i => i.kind === 'sinal-baixo'));
  const clip = tone(5, 1.5).map(v => Math.max(-1, Math.min(1, v)));
  assert.ok(signalReport(clip).issues.some(i => i.kind === 'saturacao'));
});

test('filtro de alucinações e repetições', () => {
  assert.ok(isLikelyHallucination('Legendas pela comunidade Amara.org', 0.1));
  assert.ok(isLikelyHallucination('Obrigado.', 0.05));
  assert.ok(!isLikelyHallucination('O concreto atrasou na terça.', 0.8));
  const r = trimRepetitions('vamos lá ' + 'a gente vai '.repeat(12) + 'fim');
  assert.ok(r.trimmed && r.text.split('a gente vai').length < 5);
});

test('memória de correções: proteções contra números, datas, unidades e negações', () => {
  assert.ok(ruleSafety('Indayatuba', 'Indaiatuba').ok);
  assert.ok(ruleSafety('emi esse projeto', 'MS Project').ok);
  for (const [f, t] of [['320', '230'], ['trezentos', 'duzentos'], ['terça', 'quinta'], ['não', ''], ['não vamos', 'vamos'], ['m2', 'm3'], ['reais', 'dólares'], ['dia 6', 'dia 7']]) assert.ok(!ruleSafety(f, t).ok, `${f}→${t} deveria ser bloqueada`);
  const rules = [{ id: 'a', from: 'Indayatuba', to: 'Indaiatuba', enabled: true }, { id: 'b', from: 'Iben', to: 'IBEN', enabled: false }, { id: 'c', from: '320', to: '230', enabled: true }];
  const r = applyCorrections('Obra em Indayatuba da Iben por 320 mil. indayatuba!', rules);
  assert.equal(r.text, 'Obra em Indaiatuba da Iben por 320 mil. Indaiatuba!');
  assert.deepEqual(r.used, ['a']);
  // palavra inteira: não troca dentro de outra palavra
  assert.equal(applyCorrections('Indayatubano', rules).text, 'Indayatubano');
});

test('proposta de regras a partir de edição só sugere o trecho alterado', () => {
  const p = proposeRules('reunião da obra de Indayatuba com a usina', 'reunião da obra de Indaiatuba com a usina');
  assert.equal(p.length, 1); assert.equal(p[0].from, 'Indayatuba'); assert.equal(p[0].to, 'Indaiatuba'); assert.ok(p[0].safety.ok);
  const q = proposeRules('não vamos aprovar 320 mil', 'vamos aprovar 230 mil');
  assert.ok(q.every(x => !x.safety.ok));
});

test('WER', () => { assert.equal(wer('a b c d', 'a b c d'), 0); assert.equal(wer('a b c d', 'a x c d'), 0.25); });

// -------- ata --------
const SEGS = [
  { id: 'T1', i: 0, start: 0, end: 5, text: 'Bom dia. Vamos falar do cronograma da torre B.', speaker: 'Pedro' },
  { id: 'T2', i: 1, start: 5, end: 12, text: 'O concreto do quinto pavimento atrasou porque a usina não entregou na terça.', speaker: 'Marcos' },
  { id: 'T3', i: 2, start: 12, end: 20, text: 'Então ficou decidido: a nova concretagem será na quinta-feira, dia 6.', speaker: 'Pedro' },
  { id: 'T4', i: 3, start: 20, end: 28, text: 'Eu fico responsável por confirmar com a usina até amanhã.', speaker: 'Ana' },
  { id: 'T5', i: 4, start: 28, end: 35, text: 'Talvez valha a pena trocar de fornecedor, mas isso precisa ver com o diretor.', speaker: 'Marcos' },
];
const sn = s => s.speaker;

test('leitura tolerante de JSON (cercas, <think>, vírgula final)', () => {
  const j = parseJsonLoose('<think>hmm</think>```json\n{"a": [1,2,], "b": "x}"}\n```');
  assert.deepEqual(j, { a: [1, 2], b: 'x}' });
  assert.throws(() => parseJsonLoose('sem json'));
});

test('verificação rebaixa responsável, prazo e números sem respaldo', () => {
  const raw = normalizeFacts({
    titulo: 'Torre B', proposito: 'Cronograma', resumo: ['x'], assuntos: [{ titulo: 'Concreto', pontos: ['atraso'], refs: ['T2'] }],
    decisoes: [{ texto: 'Nova concretagem dia 6', status: 'acordado', refs: ['T3'] }, { texto: 'Pagar 500 mil', status: 'acordado', refs: ['T3'] }, { texto: 'Inventada', status: 'acordado', refs: ['T99'] }],
    propostas: [{ texto: 'Trocar fornecedor', tipo: 'sugestão', refs: ['T5'] }], restricoes: [], riscos: [],
    tarefas: [
      { descricao: 'Confirmar com a usina', responsavel: 'Ana', prazo: 'amanhã', compromisso: 'assumido', refs: ['T4'] },
      { descricao: 'Confirmar com a usina', responsavel: 'Pedro', prazo: 'amanhã', compromisso: 'assumido', refs: ['T4'] },
      { descricao: 'Trocar fornecedor', responsavel: 'Marcos', prazo: 'dia 15', compromisso: 'sugerido', refs: ['T5'] },
    ],
  });
  const { facts, warnings } = verifyFacts(raw, SEGS, sn, ['Pedro', 'Marcos', 'Ana']);
  assert.equal(facts.tarefas[0].responsavel, 'Ana');
  assert.equal(facts.tarefas[1].responsavel, A_CONFIRMAR, 'Pedro não falou nem é citado em T4');
  assert.equal(facts.tarefas[2].prazo, A_CONFIRMAR, 'dia 15 não aparece em T5');
  assert.ok(facts.decisoes[1].verificar, '500 não aparece em T3');
  assert.equal(facts.decisoes[2].status, 'a confirmar'); assert.ok(facts.decisoes[2].semOrigem);
  assert.ok(warnings.length >= 4);
});

test('janelas de transcrição respeitam o orçamento de tokens', () => {
  const lines = Array.from({ length: 400 }, (_, i) => `[T${i} 00:00] Pessoa: ${'palavra '.repeat(30)}`);
  const w = windows(lines, 3000);
  assert.ok(w.length > 1); assert.equal(w.flat().length, 400);
});

test('formatos: todos renderizam, ata parcial é sinalizada, CSV abre no Excel', () => {
  const facts = verifyFacts(normalizeFacts({ titulo: 'Torre B', proposito: 'p', resumo: ['r'], assuntos: [{ titulo: 'A', pontos: ['p'], refs: ['T2'] }], decisoes: [{ texto: 'd', status: 'acordado', refs: ['T3'] }], propostas: [], restricoes: [], riscos: [{ texto: 'r', refs: ['T5'] }], tarefas: [{ descricao: 'Confirmar com a usina', responsavel: 'Ana', prazo: 'amanhã', compromisso: 'assumido', refs: ['T4'] }] }), SEGS, sn, []).facts;
  const minutes = toMinutesRecord(facts, { partial: true, coverage: 0.6, provider: 'teste', model: 'simulado', warnings: [] });
  const ctx = { meeting: { title: 'R', startedAt: '2026-10-29T10:00:00Z', durationSec: 35 }, minutes, segments: SEGS, segIndex: new Map(SEGS.map(s => [s.id, s])), shots: [{ id: 's1', t: 6, caption: 'Planilha' }], speakerName: sn, participants: ['Ana'], renditions: {} };
  for (const f of FORMATS.filter(f => !f.ai)) { const md = render(f.key, ctx); assert.ok(md.length > 20, f.key); }
  const ata = render('ata', ctx);
  assert.match(ata, /ATA PARCIAL/);
  assert.match(ata, /\(shot:s1\)/, 'captura anexada ao assunto do mesmo horário');
  assert.match(ata, /\[T4 00:20\]/);
  assert.match(tasksCsv(ctx), /^﻿"Responsável";"Tarefa"/);
  assert.ok(parseMd(ata).some(b => b.type === 'check'));
  assert.ok(mdToText(ata).includes('☐'));
  assert.throws(() => render('narrativo', ctx), /IA/);
});

// -------- pipeline da ata com modelo FALSO (simulado) --------
import { runMinutesPipeline } from '../../app/js/core/minutes.js';
const META = { title: 'T', date: 'hoje', participants: [] };
const okJson = JSON.stringify({ titulo: 'T', proposito: 'p', resumo: ['a'], assuntos: [], decisoes: [{ texto: 'nova concretagem dia 6', status: 'acordado', refs: ['T3'] }], propostas: [], restricoes: [], riscos: [], tarefas: [] });

test('pipeline recusa transcrição vazia (não gera ata "concluída")', async () => {
  let called = 0;
  await assert.rejects(runMinutesPipeline({ segments: [{ id: 'T1', i: 0, text: '  ' }], meta: META, speakerName: sn, chat: async () => { called++; return okJson; }, contextTokens: 8000, transcriptionDone: true }), e => e.kind === 'sem-texto');
  assert.equal(called, 0, 'o modelo nem deve ser chamado');
});

test('pipeline exige confirmação para ata parcial e a identifica', async () => {
  const plan = SEGS.map(s => ({ i: s.i })).concat([{ i: 9 }, { i: 10 }]);
  await assert.rejects(runMinutesPipeline({ segments: SEGS, plan, meta: META, speakerName: sn, chat: async () => okJson, contextTokens: 8000, transcriptionDone: false }), e => e.kind === 'parcial');
  const r = await runMinutesPipeline({ segments: SEGS, plan, meta: META, speakerName: sn, chat: async () => okJson, contextTokens: 8000, transcriptionDone: false, allowPartial: true });
  assert.ok(r.partial); assert.ok(r.coverage < 1);
});

test('pipeline repete uma vez quando o JSON vem inválido e divide transcrições longas', async () => {
  let n = 0;
  const r = await runMinutesPipeline({ segments: SEGS, meta: META, speakerName: sn, chat: async () => (++n === 1 ? 'desculpe, não sei' : okJson), contextTokens: 8000, transcriptionDone: true });
  assert.equal(n, 2); assert.equal(r.facts.decisoes.length, 1);
  const many = Array.from({ length: 300 }, (_, i) => ({ id: `T${i + 1}`, i, start: i * 10, end: i * 10 + 9, text: 'texto de reunião '.repeat(20), speaker: 'Pedro' }));
  let calls = 0;
  const r2 = await runMinutesPipeline({ segments: many, meta: META, speakerName: sn, chat: async () => { calls++; return okJson; }, contextTokens: 8000, transcriptionDone: true });
  assert.ok(r2.windows > 1); assert.equal(calls, r2.windows + 1, 'uma chamada por parte + consolidação');
});

test('conferência entende números por extenso', async () => {
  const { numbersIn } = await import('../../app/js/core/minutes.js');
  assert.ok(numbersIn('dia seis, às sete horas').includes('6'));
  assert.ok(numbersIn('dia seis, às sete horas').includes('7'));
  assert.ok(numbersIn('veio em trezentos e vinte mil reais').includes('320000'));
  assert.ok(numbersIn('o quinto pavimento').includes('5'));
  assert.ok(numbersIn('R$ 320.000,00').includes('32000000') || numbersIn('R$ 320 mil').includes('320'));
  const segs = [{ id: 'T1', i: 0, text: 'a nova concretagem será na quinta-feira, dia seis, às sete horas', speaker: 'Pedro' }];
  const f = normalizeFacts({ decisoes: [{ texto: 'Concretagem dia 6 às 7h', status: 'acordado', refs: ['T1'] }, { texto: 'Concretagem dia 8', status: 'acordado', refs: ['T1'] }] });
  const { facts } = verifyFacts(f, segs, s => s.speaker, []);
  assert.ok(!facts.decisoes[0].verificar, 'seis/sete por extenso devem bater com 6/7');
  assert.ok(facts.decisoes[1].verificar, '8 não aparece');
});

test('referências escritas no texto pelo modelo são aproveitadas e removidas do texto', () => {
  const f = normalizeFacts({ tarefas: [{ descricao: 'Marcos atualiza o cronograma até sexta (T6, T7).' }], riscos: ['Elevador atrasado (T10)'], decisoes: [{ texto: 'Nova data', refs: ['t3'] }] });
  assert.deepEqual(f.tarefas[0].refs, ['T6', 'T7']); assert.equal(f.tarefas[0].descricao, 'Marcos atualiza o cronograma até sexta.');
  assert.deepEqual(f.riscos[0].refs, ['T10']); assert.equal(f.riscos[0].texto, 'Elevador atrasado');
  assert.deepEqual(f.decisoes[0].refs, ['T3']);
  assert.equal(f.tarefas[0].responsavel, 'A confirmar', 'não extrai responsável do texto por regra');
});

test('reparo de JSON: aspas internas, vírgulas e resposta cortada', async () => {
  const { repairJson } = await import('../../app/js/core/minutes.js');
  assert.deepEqual(parseJsonLoose('{"resumo": ["Pedro disse "vamos aprovar" amanhã", "b"]}'), { resumo: ['Pedro disse "vamos aprovar" amanhã', 'b'] });
  assert.deepEqual(parseJsonLoose('{"a": ["x" "y"], "b": [{"c": 1} {"c": 2}]}'), { a: ['x', 'y'], b: [{ c: 1 }, { c: 2 }] });
  assert.deepEqual(parseJsonLoose('{"titulo": "T", "resumo": ["um", "do'), { titulo: 'T', resumo: ['um', 'do'] });
  assert.equal(JSON.parse(repairJson('{"a":"linha1\nlinha2"}')).a, 'linha1\nlinha2');
});

test('salvamento por seção quando o modelo erra a estrutura', () => {
  const bad = `{"titulo": "T", "riscos": [ {"texto": "Elevador atrasado"}, "refs": ["T3"] ], "tarefas": [{"descricao": "Confirmar usina", "responsavel": "Ana", "prazo": "amanhã", "compromisso": "assumido", "refs": ["T4"]}]}`;
  const j = parseJsonLoose(bad);
  assert.equal(j.titulo, 'T');
  assert.equal(j.riscos.length, 1); assert.equal(j.riscos[0].texto, 'Elevador atrasado');
  assert.equal(j.tarefas[0].responsavel, 'Ana');
  assert.ok(j.__reparado);
});

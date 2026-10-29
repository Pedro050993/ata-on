// Geração da ata (parte pura): montagem dos prompts, esquema JSON, leitura
// tolerante da resposta do modelo e VERIFICAÇÃO contra a transcrição.
// A geração em si é feita por um modelo de IA real (ver js/llm.js).
// A verificação não cria conteúdo: só rebaixa para "A confirmar" o que não
// tem respaldo no trecho citado.

import { fmtTime, normalizeWord } from './text.js';

export const NAO_DEFINIDO = 'Não definido';
export const A_CONFIRMAR = 'A confirmar';

const itemRefs = { type: 'array', items: { type: 'string' } };
export const EXTRACT_SCHEMA = {
  type: 'object',
  properties: {
    titulo: { type: 'string' },
    proposito: { type: 'string' },
    resumo: { type: 'array', items: { type: 'string' } },
    assuntos: { type: 'array', items: { type: 'object', properties: { titulo: { type: 'string' }, pontos: { type: 'array', items: { type: 'string' } }, refs: itemRefs }, required: ['titulo', 'pontos', 'refs'] } },
    decisoes: { type: 'array', items: { type: 'object', properties: { texto: { type: 'string' }, status: { type: 'string', enum: ['acordado', 'a confirmar'] }, refs: itemRefs }, required: ['texto', 'status', 'refs'] } },
    propostas: { type: 'array', items: { type: 'object', properties: { texto: { type: 'string' }, tipo: { type: 'string', enum: ['sugestão', 'pedido', 'pendente de confirmação'] }, autor: { type: 'string' }, refs: itemRefs }, required: ['texto', 'tipo', 'refs'] } },
    restricoes: { type: 'array', items: { type: 'object', properties: { texto: { type: 'string' }, refs: itemRefs }, required: ['texto', 'refs'] } },
    riscos: { type: 'array', items: { type: 'object', properties: { texto: { type: 'string' }, refs: itemRefs }, required: ['texto', 'refs'] } },
    tarefas: { type: 'array', items: { type: 'object', properties: { descricao: { type: 'string' }, responsavel: { type: 'string' }, prazo: { type: 'string' }, compromisso: { type: 'string', enum: ['assumido', 'atribuído', 'solicitado', 'sugerido'] }, refs: itemRefs }, required: ['descricao', 'responsavel', 'prazo', 'compromisso', 'refs'] } },
  },
  required: ['titulo', 'proposito', 'resumo', 'assuntos', 'decisoes', 'propostas', 'restricoes', 'riscos', 'tarefas'],
};

export const SYSTEM_PROMPT = `Você é o Pedro Agent, assistente que redige atas de reunião em português do Brasil, para obras de construção civil e projetos industriais.
Regras obrigatórias:
- Use SOMENTE o que está na transcrição. Não invente decisões, responsáveis, prazos, valores ou compromissos.
- Cada item deve citar em "refs" os identificadores dos trechos que o sustentam (ex.: "T12").
- "decisoes" = apenas o que foi efetivamente acordado. Se houver dúvida, status "a confirmar". Sugestões, pedidos e ideias vão em "propostas".
- "tarefas": "assumido" quando a própria pessoa diz que fará; "atribuído" quando alguém com autoridade designa outra pessoa e isso fica aceito; "solicitado" quando alguém pede e não há aceite; "sugerido" quando é só uma ideia.
- Responsável: use o nome do locutor só se ele assumiu ou foi claramente designado. Quem apenas citou o assunto ou pediu algo NÃO é responsável. Se não estiver claro, escreva "A confirmar".
- Prazo: copie como foi dito ("até sexta", "dia 6"). Se ninguém falou prazo, escreva "Não definido".
- Preserve nomes, empresas, siglas, números, valores, datas e unidades exatamente como aparecem.
- Responda apenas com JSON válido, sem comentários e sem texto fora do JSON.`;

/** Linhas da transcrição no formato usado pelo modelo. */
export function transcriptLines(segments, speakerName) {
  return segments
    .filter(s => (s.text || '').trim())
    .map(s => `[${s.id} ${fmtTime(s.start)}] ${speakerName(s)}: ${s.text.trim()}`);
}

/** Estima tokens (português ≈ 3,3 caracteres por token nos tokenizadores atuais). */
export const estTokens = s => Math.ceil((s || '').length / 3.3);

/** Divide as linhas em janelas que cabem no contexto do modelo. */
export function windows(lines, maxTokens) {
  const out = []; let cur = [], tok = 0;
  for (const l of lines) {
    const t = estTokens(l) + 1;
    if (cur.length && tok + t > maxTokens) { out.push(cur); cur = []; tok = 0; }
    cur.push(l); tok += t;
  }
  if (cur.length) out.push(cur);
  return out;
}

export function extractPrompt({ meta, lines, part, parts, glossary }) {
  const ctx = [
    `Reunião: ${meta.title || 'Sem título'} — ${meta.date}`,
    meta.participants?.length ? `Participantes confirmados: ${meta.participants.join(', ')}` : 'Participantes: não confirmados (não atribua nomes que não apareçam na transcrição).',
    glossary?.length ? `Grafias corretas de nomes e termos: ${glossary.join(', ')}` : '',
    parts > 1 ? `Esta é a parte ${part} de ${parts} da transcrição. Extraia apenas o que estiver nesta parte.` : '',
  ].filter(Boolean).join('\n');
  return `${ctx}\n\nTranscrição:\n${lines.join('\n')}\n\nGere o JSON com: titulo, proposito, resumo (bullet points curtos), assuntos (titulo, pontos, refs), decisoes, propostas, restricoes, riscos, tarefas. Listas sem conteúdo ficam vazias [].`;
}

export function mergePrompt({ meta, partials }) {
  return `Reunião: ${meta.title || 'Sem título'} — ${meta.date}
Abaixo estão extrações parciais (JSON) de partes consecutivas da mesma reunião. Una tudo em um único JSON no mesmo formato:
- remova duplicidades mantendo todas as refs;
- escreva "titulo", "proposito" e "resumo" para a reunião inteira;
- não acrescente nada que não esteja nas extrações.

${partials.map((p, i) => `Parte ${i + 1}:\n${JSON.stringify(p)}`).join('\n\n')}`;
}

export function rewritePrompt({ facts, style }) {
  return `Reescreva o conteúdo da ata abaixo no formato pedido. Não altere fatos, nomes, valores, datas, responsáveis ou prazos; não acrescente informação. Mantenha "A confirmar" e "Não definido" onde aparecem.
Formato pedido: ${style}
Responda em Markdown.

Conteúdo da ata (JSON):
${JSON.stringify(facts)}`;
}

/** Leitura tolerante: remove cercas de código, bloco <think>, pega o maior JSON. */
export function parseJsonLoose(text) {
  let t = (text || '').replace(/<think>[\s\S]*?<\/think>/g, '').replace(/```(?:json)?/gi, '').trim();
  const start = t.indexOf('{');
  if (start < 0) throw new Error('A resposta do modelo não contém JSON.');
  let depth = 0, inStr = false, esc = false, end = -1;
  for (let i = start; i < t.length; i++) {
    const c = t[i];
    if (inStr) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inStr = false; continue; }
    if (c === '"') inStr = true; else if (c === '{') depth++; else if (c === '}') { depth--; if (!depth) { end = i; break; } }
  }
  if (end < 0) throw new Error('JSON incompleto na resposta do modelo (resposta cortada?).');
  const raw = t.slice(start, end + 1).replace(/,\s*([}\]])/g, '$1');
  return JSON.parse(raw);
}

const arr = v => Array.isArray(v) ? v : (v == null || v === '' ? [] : [v]);
const str = v => (typeof v === 'string' ? v : v == null ? '' : String(v)).trim();
const refsOf = v => arr(v?.refs ?? v?.ref).map(r => str(r).replace(/[\[\]\s]/g, '').toUpperCase()).filter(Boolean);

/** Normaliza o JSON do modelo para o formato interno (tolera chaves ausentes). */
export function normalizeFacts(j) {
  return {
    titulo: str(j.titulo),
    proposito: str(j.proposito),
    resumo: arr(j.resumo).map(str).filter(Boolean),
    assuntos: arr(j.assuntos).map(a => ({ titulo: str(a.titulo ?? a), pontos: arr(a.pontos).map(str).filter(Boolean), refs: refsOf(a) })).filter(a => a.titulo),
    decisoes: arr(j.decisoes).map(d => ({ texto: str(d.texto ?? d), status: /confirmar/i.test(str(d.status)) ? 'a confirmar' : 'acordado', refs: refsOf(d) })).filter(d => d.texto),
    propostas: arr(j.propostas).map(p => ({ texto: str(p.texto ?? p), tipo: str(p.tipo) || 'sugestão', autor: str(p.autor), refs: refsOf(p) })).filter(p => p.texto),
    restricoes: arr(j.restricoes).map(r => ({ texto: str(r.texto ?? r), refs: refsOf(r) })).filter(r => r.texto),
    riscos: arr(j.riscos).map(r => ({ texto: str(r.texto ?? r), refs: refsOf(r) })).filter(r => r.texto),
    tarefas: arr(j.tarefas).map(t => ({ descricao: str(t.descricao ?? t.texto ?? t), responsavel: str(t.responsavel) || A_CONFIRMAR, prazo: str(t.prazo) || NAO_DEFINIDO, compromisso: str(t.compromisso) || 'sugerido', refs: refsOf(t) })).filter(t => t.descricao),
  };
}

const NUM_RE = /\d+(?:[.,]\d+)*/g;
const UNID = { zero: 0, um: 1, uma: 1, primeiro: 1, primeira: 1, dois: 2, duas: 2, segundo: 2, segunda: 2, tres: 3, terceiro: 3, terceira: 3, quatro: 4, quarto: 4, quarta: 4, cinco: 5, quinto: 5, quinta: 5, seis: 6, sexto: 6, sexta: 6, sete: 7, setimo: 7, setima: 7, oito: 8, oitavo: 8, oitava: 8, nove: 9, nono: 9, nona: 9, dez: 10, decimo: 10, decima: 10, onze: 11, doze: 12, treze: 13, quatorze: 14, catorze: 14, quinze: 15, dezesseis: 16, dezessete: 17, dezoito: 18, dezenove: 19, vinte: 20, trinta: 30, quarenta: 40, cinquenta: 50, sessenta: 60, setenta: 70, oitenta: 80, noventa: 90, cem: 100, cento: 100, duzentos: 200, duzentas: 200, trezentos: 300, trezentas: 300, quatrocentos: 400, quinhentos: 500, seiscentos: 600, setecentos: 700, oitocentos: 800, novecentos: 900 };
/** Números do texto, inclusive por extenso ("trezentos e vinte mil" → 320000; "dia seis" → 6). */
export function numbersIn(text) {
  const t = str(text);
  const out = (t.match(NUM_RE) || []).map(n => n.replace(/[.,]/g, ''));
  const words = normalizeWord(t).replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter(Boolean);
  let cur = null, total = 0;
  const flush = () => { if (cur !== null || total) { const v = total + (cur || 0); out.push(String(v)); if (total && cur) out.push(String(cur)); } cur = null; total = 0; };
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    if (w in UNID) { cur = (cur || 0) + UNID[w]; continue; }
    if (w === 'mil' && (cur !== null || i === 0 || true)) { total += (cur || 1) * 1000; cur = null; continue; }
    if (w === 'e' && (cur !== null || total) && words[i + 1] in UNID) continue;
    flush();
  }
  flush();
  return out;
}
const nums = s => numbersIn(s);                                     // fonte: dígitos e por extenso
const digits = s => (str(s).match(NUM_RE) || []).map(n => n.replace(/[.,]/g, '')); // item: só dígitos (evita "uma" = 1)

/**
 * Verificação contra a transcrição (não gera conteúdo, só marca/rebaixa):
 *  - refs inexistentes são removidas; item sem ref válida recebe aviso;
 *  - números em decisões/tarefas que não aparecem nos trechos citados → aviso;
 *  - responsável sem respaldo (não é quem falou no trecho e não é citado nele) → "A confirmar";
 *  - prazo com número/data que não aparece no trecho → "A confirmar".
 */
export function verifyFacts(facts, segments, speakerName, participants = []) {
  const byId = new Map(segments.map(s => [s.id, s]));
  const known = new Set(participants.map(p => normalizeWord(p)));
  const warnings = [];
  const textOf = refs => refs.map(r => byId.get(r)?.text || '').join(' ');
  const fixRefs = (item, label) => {
    const valid = item.refs.filter(r => byId.has(r));
    if (valid.length !== item.refs.length) warnings.push(`${label}: referência(s) inexistente(s) removida(s) (${item.refs.filter(r => !byId.has(r)).join(', ')}).`);
    item.refs = valid;
    if (!valid.length) { item.semOrigem = true; }
    return item;
  };
  const checkNums = (item, field, label) => {
    const src = nums(textOf(item.refs)).join(' ');
    const bad = digits(item[field]).filter(n => !src.split(' ').some(x => x === n || x.startsWith(n) && /0+$/.test(x.slice(n.length))));
    if (item.refs.length && bad.length) { item.verificar = `Número(s) ${bad.join(', ')} não encontrado(s) no trecho citado.`; warnings.push(`${label}: ${item.verificar}`); }
  };
  for (const k of ['assuntos', 'decisoes', 'propostas', 'restricoes', 'riscos']) facts[k].forEach((it, i) => fixRefs(it, `${k} ${i + 1}`));
  facts.decisoes.forEach((d, i) => checkNums(d, 'texto', `Decisão ${i + 1}`));
  facts.decisoes.forEach(d => { if (d.semOrigem) d.status = 'a confirmar'; });
  facts.tarefas.forEach((t, i) => {
    fixRefs(t, `Tarefa ${i + 1}`);
    checkNums(t, 'descricao', `Tarefa ${i + 1}`);
    const src = textOf(t.refs);
    const speakers = t.refs.map(r => byId.get(r)).filter(Boolean).map(s => speakerName(s));
    const resp = t.responsavel;
    if (resp && resp !== A_CONFIRMAR) {
      const nr = normalizeWord(resp);
      const first = nr.split(/\s+/)[0];
      const isSpeaker = speakers.some(s => normalizeWord(s) === nr || normalizeWord(s).split(/\s+/)[0] === first);
      const mentioned = first.length > 2 && normalizeWord(src).includes(first);
      const genericSpeaker = /^(locutor|participante|voce|você|nao identificado|remoto)/i.test(resp);
      if (!(isSpeaker || mentioned) || (genericSpeaker && !isSpeaker)) {
        warnings.push(`Tarefa ${i + 1}: responsável "${resp}" sem respaldo no trecho citado → "A confirmar".`);
        t.responsavelSugerido = resp; t.responsavel = A_CONFIRMAR;
      } else if (participants.length && !known.has(nr) && !isSpeaker) {
        t.responsavelNaoConfirmado = true;
      }
    }
    if (t.prazo && t.prazo !== NAO_DEFINIDO) {
      const pn = digits(t.prazo);
      const srcN = nums(src).join(' ');
      if (pn.some(n => !srcN.split(' ').includes(n))) { warnings.push(`Tarefa ${i + 1}: prazo "${t.prazo}" não aparece no trecho → "A confirmar".`); t.prazoSugerido = t.prazo; t.prazo = A_CONFIRMAR; }
    }
    if (t.semOrigem && t.compromisso === 'assumido') t.compromisso = 'sugerido';
  });
  return { facts, warnings };
}

/** Une extrações parciais sem IA (usado só se a etapa de união falhar). */
export function concatFacts(list) {
  const out = normalizeFacts({});
  for (const f of list) {
    for (const k of ['resumo', 'assuntos', 'decisoes', 'propostas', 'restricoes', 'riscos', 'tarefas']) out[k].push(...f[k]);
    out.titulo = out.titulo || f.titulo; out.proposito = out.proposito || f.proposito;
  }
  return out;
}

/** Converte fatos verificados no registro persistido (com ids estáveis e estado editável). */
export function toMinutesRecord(facts, { partial, provider, model, warnings, coverage }) {
  let n = 0; const id = p => `${p}${++n}`;
  const wrap = (list, p) => list.map(x => ({ id: id(p), ...x, ai: { ...x } }));
  return {
    status: 'pronta',
    partial: !!partial,
    coverage,
    generatedAt: new Date().toISOString(),
    generatedBy: { provider, model },
    warnings,
    titulo: facts.titulo, proposito: facts.proposito,
    resumo: facts.resumo.map(t => ({ id: id('r'), texto: t })),
    assuntos: wrap(facts.assuntos, 'a'),
    decisoes: wrap(facts.decisoes, 'd'),
    propostas: wrap(facts.propostas, 'p'),
    restricoes: wrap(facts.restricoes, 'c'),
    riscos: wrap(facts.riscos, 'k'),
    tarefas: facts.tarefas.map(t => ({ id: id('t'), ...t, situacao: 'aberta', ai: { ...t } })),
  };
}

/**
 * Pipeline completo da ata (puro): o MESMO código usado pelo app e pelos testes
 * com modelo real. `chat(messages, {schema, maxTokens})` é o modelo de IA.
 */
export async function runMinutesPipeline({ segments, plan = [], transcriptionDone, meta, speakerName, participants = [], glossary = [], chat, contextTokens, allowPartial = false, onStage, onProgress, onLog }) {
  segments = [...segments].sort((a, b) => a.i - b.i);
  const withText = segments.filter(s => (s.text || '').trim());
  if (!withText.length) { const e = new Error('A transcrição está vazia: não há conteúdo para gerar uma ata. Nada foi gerado.'); e.kind = 'sem-texto'; throw e; }
  const speaking = plan.filter(p => !p.silent);
  const doneIdx = new Set(segments.filter(s => s.done !== false).map(s => s.i));
  const coverage = speaking.length ? speaking.filter(p => doneIdx.has(p.i)).length / speaking.length : 1;
  const partial = coverage < 0.999 || !transcriptionDone;
  if (partial && !allowPartial) { const e = new Error(`A transcrição está incompleta (${Math.round(coverage * 100)}%). Conclua a transcrição ou confirme a geração de uma ATA PARCIAL.`); e.kind = 'parcial'; e.coverage = coverage; throw e; }
  const lines = transcriptLines(withText, speakerName);
  const budget = Math.max(1500, contextTokens - estTokens(SYSTEM_PROMPT) - 3500);
  const wins = windows(lines, budget);
  const ask = async (prompt, label) => {
    let lastErr;
    for (let attempt = 0; attempt < 2; attempt++) {
      const text = await chat([{ role: 'system', content: SYSTEM_PROMPT }, { role: 'user', content: attempt ? prompt + '\n\nATENÇÃO: responda apenas com o JSON, completo e válido.' : prompt }], { schema: EXTRACT_SCHEMA, maxTokens: 3500 });
      try { return normalizeFacts(parseJsonLoose(text)); }
      catch (e) { lastErr = Object.assign(new Error(`${label}: o modelo não devolveu JSON válido (${e.message}). Início da resposta: ${String(text).slice(0, 300)}`), { kind: 'resposta-invalida' }); onLog?.(lastErr.message); }
    }
    throw lastErr;
  };
  const partials = [];
  for (let w = 0; w < wins.length; w++) {
    onStage?.(wins.length > 1 ? `IA analisando a parte ${w + 1} de ${wins.length} da transcrição…` : 'IA redigindo a ata…');
    onProgress?.(w / (wins.length + (wins.length > 1 ? 1 : 0)));
    partials.push(await ask(extractPrompt({ meta, lines: wins[w], part: w + 1, parts: wins.length, glossary }), `Parte ${w + 1}`));
  }
  let facts;
  if (partials.length === 1) facts = partials[0];
  else {
    onStage?.('IA consolidando as partes da ata…');
    try { facts = await ask(mergePrompt({ meta, partials }), 'Consolidação'); }
    catch (e) { onLog?.('Consolidação falhou; usando extrações parciais concatenadas. ' + e.message); facts = concatFacts(partials); }
  }
  onStage?.('Conferindo referências, responsáveis e prazos contra a transcrição…');
  const { facts: verified, warnings } = verifyFacts(facts, segments, speakerName, participants);
  onProgress?.(1);
  return { facts: verified, warnings, partial, coverage, windows: wins.length };
}

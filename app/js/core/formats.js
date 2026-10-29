// Formatos de saída (puro). Todos partem do MESMO registro de ata e da
// transcrição; trocar de formato nunca altera os fatos nem as edições.
// Saída em Markdown simples, que depois vira DOCX/PDF/TXT/MD.
// Imagens: ![legenda](shot:ID)

import { fmtTime } from './text.js';
import { A_CONFIRMAR, NAO_DEFINIDO } from './minutes.js';

export const FORMATS = [
  { key: 'notas', label: 'Notas da reunião' },
  { key: 'ata', label: 'Ata completa' },
  { key: 'bullets', label: 'Bullet points' },
  { key: 'executivo', label: 'Resumo executivo' },
  { key: 'narrativo', label: 'Texto narrativo (IA)', ai: true },
  { key: 'cronologico', label: 'Registro cronológico' },
  { key: 'tarefas', label: 'Tarefas por pessoa' },
  { key: 'tabela', label: 'Tabela de ações' },
  { key: 'resumo_transcricao', label: 'Resumo + transcrição' },
  { key: 'transcricao', label: 'Transcrição integral' },
  { key: 'personalizado', label: 'Formato personalizado (IA)', ai: true },
];

const refStr = (refs, segIndex) => {
  if (!refs?.length) return ' _(sem trecho de origem — a confirmar)_';
  return ' ' + refs.map(r => { const s = segIndex.get(r); return s ? `[${r} ${fmtTime(s.start)}]` : `[${r}]`; }).join(' ');
};
const flag = it => (it.verificar ? ` ⚠ ${it.verificar}` : '');

export function groupTasks(tarefas) {
  const g = new Map();
  for (const t of tarefas) {
    const k = t.responsavel && t.responsavel !== NAO_DEFINIDO ? t.responsavel : A_CONFIRMAR;
    if (!g.has(k)) g.set(k, []);
    g.get(k).push(t);
  }
  // "A confirmar" por último
  return [...g.entries()].sort((a, b) => (a[0] === A_CONFIRMAR) - (b[0] === A_CONFIRMAR) || a[0].localeCompare(b[0]));
}

const COMPROMISSO = { assumido: 'assumida pelo responsável', 'atribuído': 'atribuída', solicitado: 'solicitada (sem aceite registrado)', sugerido: 'sugerida' };

function taskLine(t, segIndex, withOwner = false) {
  const box = t.situacao === 'concluída' ? '[x]' : '[ ]';
  return `- ${box} ${t.descricao}${withOwner ? ` — **${t.responsavel}**` : ''} · Prazo: ${t.prazo || NAO_DEFINIDO} · ${COMPROMISSO[t.compromisso] || t.compromisso}${refStr(t.refs, segIndex)}${flag(t)}`;
}

function header(ctx) {
  const m = ctx.meeting, a = ctx.minutes;
  const L = [];
  L.push(`# ${a.titulo || m.title || 'Reunião'}`);
  if (a.partial) L.push(`> **ATA PARCIAL** — gerada com ${Math.round((a.coverage || 0) * 100)}% da transcrição concluída. Conteúdo posterior não está contemplado.`);
  L.push(`**Data:** ${new Date(m.startedAt || m.createdAt).toLocaleString('pt-BR', { dateStyle: 'full', timeStyle: 'short' })}  `);
  L.push(`**Duração:** ${fmtTime(m.durationSec)}  `);
  L.push(`**Participantes:** ${ctx.participants.length ? ctx.participants.join(', ') : 'Não confirmados'}  `);
  return L;
}

function shotsFor(ctx, refs) {
  if (!ctx.shots?.length || !refs?.length) return [];
  const ranges = refs.map(r => ctx.segIndex.get(r)).filter(Boolean);
  if (!ranges.length) return [];
  const lo = Math.min(...ranges.map(s => s.start)) - 15, hi = Math.max(...ranges.map(s => s.end)) + 15;
  return ctx.shots.filter(s => s.t >= lo && s.t <= hi);
}

function section(L, title, items, fn) {
  L.push('', `## ${title}`);
  if (!items.length) L.push('- Nenhum item registrado.');
  else items.forEach(it => L.push(fn(it)));
}

function imagesBlock(ctx, used) {
  const rest = (ctx.shots || []).filter(s => !used.has(s.id));
  if (!rest.length) return [];
  const L = ['', '## Capturas da tela compartilhada'];
  for (const s of rest) L.push('', `![${fmtTime(s.t)} — ${s.caption || 'Captura'}](shot:${s.id})`);
  return L;
}

const R = {
  ata(ctx) {
    const a = ctx.minutes, si = ctx.segIndex, used = new Set();
    const L = header(ctx);
    L.push('', '## Propósito', a.proposito || NAO_DEFINIDO);
    section(L, 'Resumo', a.resumo, r => `- ${r.texto}`);
    L.push('', '## Assuntos discutidos');
    if (!a.assuntos.length) L.push('- Nenhum assunto registrado.');
    a.assuntos.forEach((s, i) => {
      L.push('', `### ${i + 1}. ${s.titulo}${refStr(s.refs, si)}`);
      s.pontos.forEach(p => L.push(`- ${p}`));
      for (const sh of shotsFor(ctx, s.refs)) if (!used.has(sh.id)) { used.add(sh.id); L.push('', `![${fmtTime(sh.t)} — ${sh.caption || 'Captura'}](shot:${sh.id})`); }
    });
    section(L, 'Decisões (acordadas)', a.decisoes.filter(d => d.status === 'acordado'), d => `- ${d.texto}${refStr(d.refs, si)}${flag(d)}`);
    section(L, 'Pontos a confirmar', a.decisoes.filter(d => d.status !== 'acordado'), d => `- ${d.texto}${refStr(d.refs, si)}${flag(d)}`);
    section(L, 'Propostas, sugestões e pedidos', a.propostas, p => `- (${p.tipo}${p.autor ? ` — ${p.autor}` : ''}) ${p.texto}${refStr(p.refs, si)}`);
    section(L, 'Restrições', a.restricoes, r => `- ${r.texto}${refStr(r.refs, si)}`);
    section(L, 'Riscos', a.riscos, r => `- ${r.texto}${refStr(r.refs, si)}`);
    L.push('', '## Próximos passos');
    if (!a.tarefas.length) L.push('- Nenhuma tarefa registrada.');
    for (const [who, ts] of groupTasks(a.tarefas)) { L.push('', `**${who}**`); ts.forEach(t => L.push(taskLine(t, si))); }
    L.push(...imagesBlock(ctx, used));
    L.push('', '---', `_Ata gerada por IA (${a.generatedBy?.provider} · ${a.generatedBy?.model}) a partir da transcrição e revisada no Pedro Agent. Referências [T#] apontam para o trecho e horário da transcrição._`);
    return L.join('\n');
  },
  notas(ctx) {
    const a = ctx.minutes, si = ctx.segIndex;
    const L = header(ctx);
    L.push('', '## Visão geral');
    a.resumo.forEach(r => L.push(`- ${r.texto}`));
    L.push('', '## Notas por assunto');
    a.assuntos.forEach(s => { L.push('', `**${s.titulo}**${refStr(s.refs, si)}`); s.pontos.forEach(p => L.push(`- ${p}`)); });
    L.push('', '## Itens de ação');
    for (const [who, ts] of groupTasks(a.tarefas)) { L.push('', `**${who}**`); ts.forEach(t => L.push(taskLine(t, si))); }
    L.push(...imagesBlock(ctx, new Set()));
    return L.join('\n');
  },
  bullets(ctx) {
    const a = ctx.minutes;
    const L = [`# ${a.titulo || ctx.meeting.title}`];
    if (a.partial) L.push('> **ATA PARCIAL**');
    a.resumo.forEach(r => L.push(`- ${r.texto}`));
    a.decisoes.forEach(d => L.push(`- Decisão${d.status !== 'acordado' ? ' (a confirmar)' : ''}: ${d.texto}`));
    a.tarefas.forEach(t => L.push(`- Ação: ${t.descricao} — ${t.responsavel} — ${t.prazo}`));
    a.riscos.forEach(r => L.push(`- Risco: ${r.texto}`));
    return L.join('\n');
  },
  executivo(ctx) {
    const a = ctx.minutes;
    const L = [`# Resumo executivo — ${a.titulo || ctx.meeting.title}`];
    if (a.partial) L.push('> **ATA PARCIAL**');
    L.push('', `**Objetivo:** ${a.proposito || NAO_DEFINIDO}`, '');
    L.push('**Principais pontos**'); a.resumo.slice(0, 6).forEach(r => L.push(`- ${r.texto}`));
    L.push('', '**Decisões**'); (a.decisoes.length ? a.decisoes : [{ texto: 'Nenhuma decisão registrada.', status: 'acordado' }]).forEach(d => L.push(`- ${d.texto}${d.status !== 'acordado' ? ' _(a confirmar)_' : ''}`));
    if (a.riscos.length) { L.push('', '**Riscos**'); a.riscos.forEach(r => L.push(`- ${r.texto}`)); }
    L.push('', '**Próximos passos**'); a.tarefas.filter(t => t.situacao !== 'concluída').forEach(t => L.push(`- ${t.descricao} — ${t.responsavel} — ${t.prazo}`));
    return L.join('\n');
  },
  cronologico(ctx) {
    const a = ctx.minutes, si = ctx.segIndex;
    const ev = [];
    const add = (kind, it, text) => { const s = it.refs?.map(r => si.get(r)).filter(Boolean).sort((x, y) => x.start - y.start)[0]; ev.push({ t: s ? s.start : Infinity, line: `${kind}: ${text}` }); };
    a.assuntos.forEach(s => add('Assunto', s, s.titulo));
    a.decisoes.forEach(d => add(d.status === 'acordado' ? 'Decisão' : 'A confirmar', d, d.texto));
    a.propostas.forEach(p => add(p.tipo[0].toUpperCase() + p.tipo.slice(1), p, p.texto));
    a.riscos.forEach(r => add('Risco', r, r.texto));
    a.tarefas.forEach(t => add('Tarefa', t, `${t.descricao} (${t.responsavel}; ${t.prazo})`));
    (ctx.shots || []).forEach(s => ev.push({ t: s.t, line: `![${s.caption || 'Captura'}](shot:${s.id})` }));
    ev.sort((x, y) => x.t - y.t);
    const L = header(ctx); L.push('', '## Registro cronológico');
    ev.forEach(e => L.push(`- **${isFinite(e.t) ? fmtTime(e.t) : '--:--'}** ${e.line}`));
    return L.join('\n');
  },
  tarefas(ctx) {
    const a = ctx.minutes, si = ctx.segIndex;
    const L = [`# Tarefas por pessoa — ${a.titulo || ctx.meeting.title}`];
    if (a.partial) L.push('> **ATA PARCIAL**');
    if (!a.tarefas.length) L.push('', 'Nenhuma tarefa registrada.');
    for (const [who, ts] of groupTasks(a.tarefas)) { L.push('', `## ${who}`); ts.forEach(t => L.push(taskLine(t, si))); }
    return L.join('\n');
  },
  tabela(ctx) {
    const a = ctx.minutes, si = ctx.segIndex;
    const L = [`# Tabela de ações — ${a.titulo || ctx.meeting.title}`, ''];
    L.push('| # | Ação | Responsável | Prazo | Situação | Origem |', '|---|---|---|---|---|---|');
    a.tarefas.forEach((t, i) => L.push(`| ${i + 1} | ${t.descricao.replace(/\|/g, '/')} | ${t.responsavel} | ${t.prazo} | ${t.situacao} | ${t.refs.map(r => `${r} ${si.get(r) ? fmtTime(si.get(r).start) : ''}`).join(', ') || '—'} |`));
    return L.join('\n');
  },
  transcricao(ctx) {
    const L = [`# Transcrição — ${ctx.meeting.title}`];
    if (ctx.transcriptionIncomplete) L.push('> Transcrição incompleta.');
    for (const s of ctx.segments) if (s.text?.trim()) L.push('', `**[${fmtTime(s.start)}] ${ctx.speakerName(s)}:** ${s.text.trim()}`);
    return L.join('\n');
  },
  resumo_transcricao(ctx) {
    return R.executivo(ctx) + '\n\n---\n\n' + R.transcricao(ctx);
  },
};

/** Gera o markdown de um formato. Formatos de IA usam ctx.renditions. */
export function render(key, ctx) {
  if (key === 'transcricao') return R.transcricao(ctx);
  if (!ctx.minutes || ctx.minutes.status !== 'pronta') throw new Error('A ata ainda não foi gerada.');
  if (R[key]) return R[key](ctx);
  const rd = ctx.renditions?.[key];
  if (!rd?.text) throw new Error('Este formato é escrito pela IA: clique em "Gerar com IA".');
  return rd.text;
}

/** Fatos "limpos" (o que vai para a IA ao reescrever um formato). */
export function factsForRewrite(minutes, participants) {
  const pick = l => l.map(({ texto, titulo, pontos, status, tipo, autor, descricao, responsavel, prazo, situacao, compromisso }) =>
    Object.fromEntries(Object.entries({ texto, titulo, pontos, status, tipo, autor, descricao, responsavel, prazo, situacao, compromisso }).filter(([, v]) => v !== undefined)));
  return {
    titulo: minutes.titulo, proposito: minutes.proposito, participantes: participants, ataParcial: minutes.partial,
    resumo: minutes.resumo.map(r => r.texto), assuntos: pick(minutes.assuntos), decisoes: pick(minutes.decisoes),
    propostas: pick(minutes.propostas), restricoes: pick(minutes.restricoes), riscos: pick(minutes.riscos), tarefas: pick(minutes.tarefas),
  };
}

/** CSV das tarefas (separador ; e BOM para abrir corretamente no Excel pt-BR). */
export function tasksCsv(ctx) {
  const q = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const rows = [['Responsável', 'Tarefa', 'Prazo', 'Situação', 'Compromisso', 'Trecho', 'Horário', 'Texto de origem', 'Reunião', 'Data']];
  for (const t of ctx.minutes.tarefas) {
    const segs = t.refs.map(r => ctx.segIndex.get(r)).filter(Boolean);
    rows.push([t.responsavel, t.descricao, t.prazo, t.situacao, t.compromisso, t.refs.join(' '), segs.map(s => fmtTime(s.start)).join(' '), segs.map(s => s.text).join(' | '), ctx.minutes.titulo || ctx.meeting.title, new Date(ctx.meeting.startedAt || ctx.meeting.createdAt).toLocaleDateString('pt-BR')]);
  }
  return '﻿' + rows.map(r => r.map(q).join(';')).join('\r\n');
}

/** Markdown → blocos simples (usado por DOCX/PDF/TXT). */
export function parseMd(md) {
  const blocks = [];
  const lines = md.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    let m;
    if (!l.trim()) continue;
    if ((m = l.match(/^(#{1,3})\s+(.*)/))) blocks.push({ type: 'h', level: m[1].length, text: m[2] });
    else if ((m = l.match(/^!\[(.*?)\]\(shot:([^)]+)\)/))) blocks.push({ type: 'img', caption: m[1], id: m[2] });
    else if ((m = l.match(/^-\s+\[( |x)\]\s+(.*)/))) blocks.push({ type: 'check', done: m[1] === 'x', text: m[2] });
    else if ((m = l.match(/^-\s+(.*)/))) blocks.push({ type: 'li', text: m[1] });
    else if (/^\|/.test(l)) {
      const rows = [];
      while (i < lines.length && /^\|/.test(lines[i])) { if (!/^\|[-\s|]+\|$/.test(lines[i])) rows.push(lines[i].split('|').slice(1, -1).map(c => c.trim())); i++; }
      i--; blocks.push({ type: 'table', rows });
    } else if ((m = l.match(/^>\s?(.*)/))) blocks.push({ type: 'quote', text: m[1] });
    else if (/^---+$/.test(l.trim())) blocks.push({ type: 'hr' });
    else blocks.push({ type: 'p', text: l.replace(/\s{2,}$/, '') });
  }
  return blocks;
}

/** Remove marcações inline: **negrito**, _itálico_. Retorna trechos com estilo. */
export function inlineRuns(text) {
  const runs = []; const re = /(\*\*[^*]+\*\*|_[^_]+_)/g; let last = 0, m;
  while ((m = re.exec(text))) {
    if (m.index > last) runs.push({ text: text.slice(last, m.index) });
    const t = m[0];
    runs.push(t.startsWith('**') ? { text: t.slice(2, -2), bold: true } : { text: t.slice(1, -1), italics: true });
    last = m.index + t.length;
  }
  if (last < text.length) runs.push({ text: text.slice(last) });
  return runs;
}

export function mdToText(md) {
  return parseMd(md).map(b => {
    const plain = s => inlineRuns(s).map(r => r.text).join('');
    switch (b.type) {
      case 'h': return '\n' + plain(b.text).toUpperCase();
      case 'li': return '• ' + plain(b.text);
      case 'check': return (b.done ? '☑ ' : '☐ ') + plain(b.text);
      case 'img': return `[Imagem: ${b.caption}]`;
      case 'table': return b.rows.map(r => r.join(' | ')).join('\n');
      case 'quote': return plain(b.text);
      case 'hr': return '----------------------------------------';
      default: return plain(b.text);
    }
  }).join('\n').trim() + '\n';
}

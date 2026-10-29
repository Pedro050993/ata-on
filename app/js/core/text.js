// Pós-processamento de texto (puro): filtro de alucinações do Whisper,
// memória de correções com proteções e utilidades de diff.

// Frases que o Whisper costuma "inventar" em português quando recebe silêncio,
// música ou ruído (vêm de legendas do conjunto de treino).
const HALLUCINATIONS = [
  /legendas? (pela|por) (comunidade )?amara\.?org/i,
  /inscreva-se no canal/i,
  /obrigad[oa] por assistir/i,
  /^\s*(e aí|tchau|obrigad[oa])[.!]*\s*$/i,
  /^\s*\.+\s*$/,
  /^\s*\[?(música|musica|aplausos|risos)\]?\s*$/i,
  /legendado por/i,
  /transcrição (feita )?por/i,
  /^\s*sous-titres/i,
];

export function isLikelyHallucination(text, speechRatio = 1) {
  const t = (text || '').trim();
  if (!t) return true;
  if (HALLUCINATIONS.some(r => r.test(t))) return speechRatio < 0.5 || t.length < 60;
  return false;
}

/** Remove repetições em laço (ex.: "a gente vai a gente vai a gente vai ..."). */
export function trimRepetitions(text) {
  const words = (text || '').split(/\s+/).filter(Boolean);
  if (words.length < 12) return { text: (text || '').trim(), trimmed: false };
  for (let n = 1; n <= 8; n++) {
    for (let i = 0; i + n * 4 <= words.length; i++) {
      const gram = words.slice(i, i + n).join(' ').toLowerCase();
      let reps = 1, j = i + n;
      while (j + n <= words.length && words.slice(j, j + n).join(' ').toLowerCase() === gram) { reps++; j += n; }
      if (reps >= 4) {
        const kept = words.slice(0, i + n * 2).concat(words.slice(j));
        const r = trimRepetitions(kept.join(' '));
        return { text: r.text, trimmed: true };
      }
    }
  }
  return { text: words.join(' '), trimmed: false };
}

/** Taxa de compressão aproximada: texto muito repetitivo comprime demais. */
export function compressionRatio(text) {
  const t = (text || '').toLowerCase();
  if (t.length < 40) return 1;
  const uniq = new Set();
  for (let i = 0; i + 4 <= t.length; i++) uniq.add(t.slice(i, i + 4));
  return t.length / Math.max(1, uniq.size);
}

// ---------------- Memória de correções ----------------

const NEGATIONS = ['não', 'nao', 'nunca', 'nem', 'sem', 'jamais', 'nenhum', 'nenhuma', 'ninguém', 'ninguem', 'nada'];
const UNIT_RE = /\b(r\$|us\$|€|%|m²|m2|m³|m3|kg|t|ton|mm|cm|m|km|h|hh|min|seg|dias?|horas?|meses|mês|anos?|semanas?|mil|milhões?|bilhões?|reais|dólares?)\b/i;
const MONTHS = /\b(janeiro|fevereiro|março|marco|abril|maio|junho|julho|agosto|setembro|outubro|novembro|dezembro|segunda|terça|terca|quarta|quinta|sexta|sábado|sabado|domingo|ontem|hoje|amanhã|amanha)\b/i;
const NUMBER_WORDS = /\b(zero|um|uma|dois|duas|três|tres|quatro|cinco|seis|sete|oito|nove|dez|onze|doze|treze|quatorze|catorze|quinze|dezesseis|dezessete|dezoito|dezenove|vinte|trinta|quarenta|cinquenta|sessenta|setenta|oitenta|noventa|cem|cento|duzentos|trezentos|quinhentos|primeiro|segundo|terceiro|quarto|quinto|sexto|sétimo|oitavo|nono|décimo)\b/i;

export function normalizeWord(s) {
  return (s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
}

/**
 * Verifica se uma regra (de → para) pode ser salva com segurança.
 * Bloqueia regras que mexem em números, valores, datas, unidades ou negações.
 */
export function ruleSafety(from, to) {
  const reasons = [];
  const both = `${from} ${to}`;
  if (!from || !from.trim()) reasons.push('Texto original vazio.');
  if (!to || !to.trim()) reasons.push('Texto corrigido vazio (use a edição manual para apagar).');
  if (/\d/.test(both)) reasons.push('Contém números: valores e quantidades não viram regra automática.');
  if (UNIT_RE.test(from) || UNIT_RE.test(to)) reasons.push('Contém moeda ou unidade de medida.');
  if (MONTHS.test(from) || MONTHS.test(to)) reasons.push('Contém data, dia da semana ou referência temporal.');
  if (NUMBER_WORDS.test(from) || NUMBER_WORDS.test(to)) reasons.push('Contém número por extenso.');
  const negIn = w => w.split(/\s+/).some(x => NEGATIONS.includes(normalizeWord(x).replace(/[^\w]/g, '')) || NEGATIONS.includes(x.toLowerCase()));
  if (negIn(from) || negIn(to)) reasons.push('Contém negação ("não", "nunca", "sem"...): poderia inverter o sentido.');
  if (from.trim().split(/\s+/).length > 5) reasons.push('Trecho longo demais para regra (máx. 5 palavras).');
  if (normalizeWord(from) === normalizeWord(to) && from !== to && from.toLowerCase() === to.toLowerCase()) { /* só capitalização: permitido */ }
  return { ok: reasons.length === 0, reasons };
}

function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

/**
 * Aplica regras habilitadas. Casamento por palavra inteira, sem diferenciar
 * maiúsculas; nunca altera tokens que contenham dígitos.
 * Retorna o texto e a lista de regras usadas (para rastreabilidade).
 */
export function applyCorrections(text, rules) {
  let out = text || '';
  const used = [];
  for (const r of rules || []) {
    if (!r.enabled || !ruleSafety(r.from, r.to).ok) continue;
    const re = new RegExp(`(^|[^\\p{L}\\p{N}])(${escapeRe(r.from)})(?=$|[^\\p{L}\\p{N}])`, 'giu');
    let hit = false;
    out = out.replace(re, (m, pre, word) => { hit = true; return pre + r.to; });
    if (hit) used.push(r.id);
  }
  return { text: out, used };
}

/** Diff por palavras (LCS) para propor regras a partir de uma edição manual. */
export function wordDiff(a, b) {
  const A = (a || '').split(/\s+/).filter(Boolean), B = (b || '').split(/\s+/).filter(Boolean);
  const n = A.length, m = B.length;
  const dp = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--)
    dp[i][j] = normalizeWord(A[i]) === normalizeWord(B[j]) && A[i] === B[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const ops = []; let i = 0, j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && A[i] === B[j]) { ops.push({ t: '=', a: A[i] }); i++; j++; }
    else if (j < m && (i >= n || dp[i][j + 1] >= dp[i + 1][j])) { ops.push({ t: '+', b: B[j] }); j++; }
    else { ops.push({ t: '-', a: A[i] }); i++; }
  }
  // agrupa trocas contíguas
  const changes = []; let cur = null;
  for (const o of ops) {
    if (o.t === '=') { if (cur) { changes.push(cur); cur = null; } continue; }
    cur = cur || { from: [], to: [] };
    if (o.t === '-') cur.from.push(o.a); else cur.to.push(o.b);
  }
  if (cur) changes.push(cur);
  const strip = s => s.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');
  return changes
    .map(c => ({ from: strip(c.from.join(' ')), to: strip(c.to.join(' ')) }))
    .filter(c => c.from && c.to && c.from !== c.to);
}

/** Sugestões de regra a partir de uma edição, já filtradas pelas proteções. */
export function proposeRules(before, after) {
  return wordDiff(before, after).map(c => ({ ...c, safety: ruleSafety(c.from, c.to) }));
}

export function fmtTime(sec) {
  sec = Math.max(0, Math.floor(sec || 0));
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  const p = v => String(v).padStart(2, '0');
  return h ? `${h}:${p(m)}:${p(s)}` : `${p(m)}:${p(s)}`;
}

/** WER simples (usado nos testes de qualidade). */
export function wer(ref, hyp) {
  const norm = s => normalizeWord(s).replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter(Boolean);
  const R = norm(ref), H = norm(hyp);
  const d = Array.from({ length: R.length + 1 }, (_, i) => { const r = new Array(H.length + 1).fill(0); r[0] = i; return r; });
  for (let j = 0; j <= H.length; j++) d[0][j] = j;
  for (let i = 1; i <= R.length; i++) for (let j = 1; j <= H.length; j++)
    d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (R[i - 1] === H[j - 1] ? 0 : 1));
  return R.length ? d[R.length][H.length] / R.length : (H.length ? 1 : 0);
}

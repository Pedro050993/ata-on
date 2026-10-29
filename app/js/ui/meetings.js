import { h, confirmDlg, toast } from './dom.js';
import { go, state, cancelJob } from '../app.js';
import * as db from '../db.js';
import { fmtTime, normalizeWord } from '../core/text.js';

export function statusPills(m) {
  const p = [];
  const t = m.transcription?.status;
  if (m.status === 'gravando') p.push(['live', 'Gravando']);
  if (m.status === 'bot') p.push(['warn', `Bot: ${m.bot?.state || '…'}`]);
  if (m.status === 'erro') p.push(['bad', 'Erro na importação']);
  if (t === 'concluída') p.push(['ok', 'Transcrita']);
  else if (t && t !== 'pendente') p.push([/sem/.test(t) ? 'bad' : 'warn', `Transcrição ${t}`]);
  if (m.minutes?.status === 'pronta') p.push([m.minutes.partial ? 'warn' : 'ok', m.minutes.partial ? 'Ata parcial' : 'Ata pronta']);
  const open = m.minutes?.tarefas?.filter(t => t.situacao !== 'concluída').length;
  if (open) p.push(['', `${open} tarefa(s) aberta(s)`]);
  if (m.audioMissing) p.push(['warn', 'Sem áudio (backup)']);
  return p.map(([c, t]) => h('span', { class: `pill ${c}` }, t));
}

export async function deleteWithCleanup(m) {
  if (!await confirmDlg(`Excluir "${m.title}"? Serão apagados áudio, transcrição, ata, tarefas e capturas desta reunião. Não há como desfazer (a não ser por um backup).`, 'Excluir', true)) return false;
  cancelJob(m.id); // interrompe processamento em andamento; respostas atrasadas são descartadas
  if (m.bot?.sessionId && state.local) fetch(`/api/bot/sessions/${m.bot.sessionId}/leave`, { method: 'POST' }).catch(() => {});
  await db.deleteMeeting(m.id);
  state.jobs.delete(m.id);
  toast('Reunião excluída.');
  return true;
}

export async function render(view) {
  const q = h('input', { type: 'search', placeholder: 'Buscar por título, participante, texto da transcrição ou da ata…' });
  const list = h('div', { class: 'mlist' });
  view.append(h('div', { class: 'topbar' }, h('h1', {}, 'Reuniões'), h('span', { class: 'spacer' }), h('button', { class: 'btn primary', onclick: () => go('inicio') }, '+ Nova')), q, h('div', { style: { height: '12px' } }), list);
  let meetings = (await db.getAll('meetings')).sort((a, b) => (b.startedAt || b.createdAt).localeCompare(a.startedAt || a.createdAt));
  let segCache = null;

  async function paint() {
    const term = normalizeWord(q.value.trim());
    let rows = meetings;
    if (term) {
      if (!segCache) { segCache = new Map(); for (const s of await db.getAll('segments')) { if (!s.text) continue; segCache.set(s.meetingId, (segCache.get(s.meetingId) || '') + ' ' + s.text); } }
      rows = meetings.filter(m => normalizeWord([m.title, (m.participants || []).map(p => p.name).join(' '), JSON.stringify(m.minutes || ''), segCache.get(m.id) || ''].join(' ')).includes(term));
    }
    list.replaceChildren(...(rows.length ? rows.map(m => h('div', { class: 'mitem', onclick: () => go('reuniao', m.id) },
      h('div', {}, h('div', { class: 't' }, m.title), h('div', { class: 'small muted' }, `${new Date(m.startedAt || m.createdAt).toLocaleString('pt-BR', { dateStyle: 'medium', timeStyle: 'short' })} · ${fmtTime(m.durationSec)} · ${m.source}`)),
      h('div', { class: 'row' }, h('button', { class: 'btn sm danger', onclick: async (e) => { e.stopPropagation(); if (await deleteWithCleanup(m)) { meetings = meetings.filter(x => x.id !== m.id); paint(); } } }, 'Excluir')),
      h('div', { class: 'row', style: { gridColumn: '1 / -1' } }, ...statusPills(m)),
    )) : [h('p', { class: 'muted' }, term ? 'Nenhuma reunião encontrada.' : 'Nenhuma reunião ainda.')]));
  }
  let tm; q.addEventListener('input', () => { clearTimeout(tm); tm = setTimeout(paint, 200); });
  paint();
}

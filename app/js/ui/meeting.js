import { h, $, toast, dialog, confirmDlg, errorPanel, fmtBytes } from './dom.js';
import { state, go, startTranscription, startMinutes, cancelJob, subscribe, job, makeLLM } from '../app.js';
import * as db from '../db.js';
import { fmtTime, proposeRules } from '../core/text.js';
import { FORMATS, render as renderFormat, groupTasks } from '../core/formats.js';
import { A_CONFIRMAR, NAO_DEFINIDO } from '../core/minutes.js';
import { ASR_MODELS, meetingSignal, channelEvidence } from '../transcriber.js';
import { speakerNameFn, participantNames, generateRendition } from '../ata.js';
import * as ex from '../export.js';
import { statusPills, deleteWithCleanup } from './meetings.js';

const TABS = [['transcricao', 'Transcrição'], ['ata', 'Ata'], ['tarefas', 'Tarefas'], ['capturas', 'Capturas'], ['exportar', 'Formatos e exportação'], ['participantes', 'Participantes'], ['diagnostico', 'Diagnóstico']];

export async function render(view, id) {
  let m = await db.get('meetings', id);
  if (!m) { view.append(h('div', { class: 'alert bad' }, 'Reunião não encontrada (pode ter sido excluída).'), h('button', { class: 'btn', onclick: () => go('reunioes') }, 'Voltar')); return; }
  let tab = sessionStorage.getItem('tab:' + id) || (m.minutes ? 'ata' : 'transcricao');
  const reload = async () => { const x = await db.get('meetings', id); if (x) m = x; return x; };
  const titleIn = h('input', { type: 'text', value: m.title, style: { fontSize: '1.2rem', fontWeight: 600, border: 'none', background: 'transparent', padding: 0, width: 'auto', minWidth: '50%' }, onchange: async () => { m = await db.updateMeeting(id, x => { x.title = titleIn.value.trim() || x.title; }); } });
  const pills = h('div', { class: 'row' });
  const head = h('div', { class: 'topbar' }, titleIn, h('span', { class: 'spacer' }),
    h('button', { class: 'btn sm danger', onclick: async () => { if (await deleteWithCleanup(m)) go('reunioes'); } }, 'Excluir reunião'));
  const sub = h('div', { class: 'small muted', style: { marginTop: '-12px', marginBottom: '10px' } });
  const progress = h('div');
  const tabs = h('div', { class: 'tabs', role: 'tablist' });
  const body = h('div');
  const player = h('audio', { controls: true, preload: 'metadata' });
  const playerWrap = h('div', { class: 'player' }, player);
  view.append(head, sub, pills, h('div', { style: { height: '10px' } }), progress, tabs, body);

  // áudio sincronizado: WAV 16 kHz (mesma base de tempo da transcrição)
  let audioUrl = null;
  async function ensureAudio() {
    if (audioUrl || !m.pcm?.samples) return;
    audioUrl = URL.createObjectURL(await ex.pcmWavBlob(m));
    player.src = audioUrl;
  }
  const seek = async (t) => { await ensureAudio(); player.currentTime = Math.max(0, t - 0.3); player.play().catch(() => {}); };

  function paintHead() {
    sub.textContent = `${new Date(m.startedAt || m.createdAt).toLocaleString('pt-BR', { dateStyle: 'full', timeStyle: 'short' })} · ${fmtTime(m.durationSec)} · origem: ${m.source}${m.recovered ? ' · recuperada após interrupção' : ''}`;
    pills.replaceChildren(...statusPills(m));
  }
  paintHead();

  // ---------- painel de progresso (etapas separadas) ----------
  function paintProgress(j = job(id)) {
    if (!j) { progress.replaceChildren(); return; }
    const ST = j.kind === 'ata' ? [['ata', 'Geração da ata (IA)']] : [['preparo', 'Preparação do áudio'], ['modelo', 'Download/carga do modelo'], ['transcricao', 'Transcrição']];
    const el = (Date.now() / 1000 - 0) && ((performance.now() - j.startedAt) / 1000);
    const rows = ST.map(([k, label]) => {
      const s = j.stages[k] || { st: 'idle', text: '' };
      let extra = '';
      if (k === 'modelo' && s.st === 'run' && j.download?.total) extra = `${fmtBytes(j.download.loaded)} de ${fmtBytes(j.download.total)}`;
      if (k === 'ata' && s.st === 'run' && j.download?.text) extra = j.download.text;
      if (k === 'ata' && s.st === 'run' && j.chars) extra = `${j.chars} caracteres gerados`;
      if (k === 'transcricao' && j.progress != null) extra = `${Math.round(j.progress * 100)}%`;
      return h('div', { class: `stage ${s.st}` }, h('span', { class: 'ic' }), h('strong', {}, label), h('span', { class: 'small' }, s.text || ''), h('span', { class: 'small mono' }, extra));
    });
    const info = [];
    info.push(`Tempo decorrido: ${fmtTime(el)}`);
    if (j.kind === 'transcrição') {
      if (j.rtf) info.push(`velocidade medida: ${(1 / j.rtf).toFixed(2)}× o tempo real`);
      info.push(j.eta != null ? `estimativa para terminar: ~${fmtTime(j.eta)} (baseada no desempenho medido até agora)` : 'estimativa: aguardando medir os primeiros trechos');
      if (j.engine) info.push(`motor: ${j.engine.model} em ${j.engine.device === 'webgpu' ? 'GPU' : 'CPU'}`);
    }
    progress.replaceChildren(h('div', { class: 'card stack', style: { marginBottom: '14px' } },
      h('div', { class: 'stages' }, ...rows),
      j.kind === 'transcrição' && j.progress != null ? h('progress', { max: 1, value: j.progress }) : null,
      h('div', { class: 'small muted' }, info.join(' · ')),
      j.running ? h('div', { class: 'row' }, h('button', { class: 'btn sm', onclick: () => cancelJob(id) }, j.kind === 'ata' ? 'Cancelar geração' : 'Cancelar (o que já foi transcrito fica salvo)')) : null,
      !j.running && j.error && j.error.kind !== 'cancelado' && j.error.kind !== 'parcial' ? errorPanel(j.error, j.errorCtx) : null,
      !j.running && j.error?.kind === 'cancelado' ? h('div', { class: 'small muted' }, 'Cancelado. Use "Retomar" para continuar do último trecho salvo.') : null,
    ));
  }
  let lastPaint = 0, pendingTab = null;
  const onJob = async (j) => {
    const now = performance.now();
    if (now - lastPaint > 250 || !j.running) { lastPaint = now; paintProgress(j); }
    if (j.lastSeg && tab === 'transcricao' && j.lastSeg !== pendingTab) { pendingTab = j.lastSeg; await refreshSeg(j.lastSeg.i); }
    if (!j.running) { if (!await reload()) return; paintHead(); paintTabs(); paintBody(); } // reunião excluída: não repinta
  };
  let unsub = subscribe(id, onJob);
  paintProgress();

  // ---------- bot ----------
  let botTimer = null;
  if (m.source === 'bot' && m.bot?.sessionId && state.local) botTimer = setInterval(pollBot, 2000);
  async function pollBot() {
    try {
      const r = await fetch(`/api/bot/sessions/${m.bot.sessionId}`); if (!r.ok) return;
      const s = await r.json();
      if (s.state !== m.bot.state || (s.participants || []).length !== (m.bot.participants || []).length) {
        m = await db.updateMeeting(id, x => { x.bot = { ...x.bot, state: s.state, history: s.history, participants: s.participants, error: s.error }; if (s.participants?.length) { const known = new Set((x.participants || []).map(p => p.name)); for (const n of s.participants) if (!known.has(n)) (x.participants ||= []).push({ name: n, confirmed: true, evidence: 'lista de participantes da plataforma (bot)' }); } });
        paintHead(); if (tab === 'transcricao') paintBody();
      }
      if (['encerrado', 'recusado', 'erro'].includes(s.state)) {
        clearInterval(botTimer);
        if (s.audio && !m.pcm?.samples) await importBotAudio(s);
      }
    } catch { /* servidor local fora do ar */ }
  }
  async function importBotAudio(s) {
    toast('Bot encerrou. Importando o áudio gravado…');
    const r = await fetch(`/api/bot/sessions/${m.bot.sessionId}/audio`); if (!r.ok) return;
    const blob = await r.blob();
    const { importInto } = await import('../recorder.js');
    await importInto(id, blob);
    await reload(); paintHead(); paintBody();
  }

  // ---------- abas ----------
  function paintTabs() {
    tabs.replaceChildren(...TABS.map(([k, label]) => h('button', { class: 'tab', role: 'tab', 'aria-selected': String(k === tab), onclick: () => { tab = k; sessionStorage.setItem('tab:' + id, k); paintTabs(); paintBody(); } }, label)));
  }
  async function paintBody() {
    body.replaceChildren();
    const fn = { transcricao: tTranscript, ata: tAta, tarefas: tTasks, capturas: tShots, exportar: tExport, participantes: tPeople, diagnostico: tDiag }[tab];
    try { await fn(); } catch (e) { console.error(e); body.append(errorPanel(e, { stage: `aba ${tab}` })); }
  }

  // ======== TRANSCRIÇÃO ========
  let segEls = new Map();
  async function tTranscript() {
    const j = job(id);
    const tr = m.transcription || {};
    const actions = h('div', { class: 'row' });
    const modelSel = h('select', { style: { width: 'auto' }, onchange: async () => { const { saveSettings } = await import('../app.js'); await saveSettings({ asrModel: modelSel.value }); } },
      ...Object.entries(ASR_MODELS).map(([k, v]) => h('option', { value: k, selected: k === state.settings.asrModel }, v.label)));
    if (m.status === 'bot' && !m.pcm?.samples) {
      body.append(h('div', { class: 'card stack' }, h('h3', {}, 'Bot na reunião'), h('div', {}, `Estado: `, h('strong', {}, m.bot?.state || '—')),
        m.bot?.error ? h('div', { class: 'alert bad small' }, m.bot.error) : null,
        h('ul', { class: 'small' }, ...(m.bot?.history || []).map(x => h('li', {}, `${new Date(x.at).toLocaleTimeString('pt-BR')} — ${x.state}${x.detail ? ': ' + x.detail : ''}`))),
        h('div', { class: 'row' }, h('button', { class: 'btn', onclick: () => fetch(`/api/bot/sessions/${m.bot.sessionId}/leave`, { method: 'POST' }) }, 'Retirar o bot e encerrar'))));
      return;
    }
    if (!m.pcm?.samples) { body.append(h('div', { class: 'alert' }, 'Esta reunião não tem áudio disponível neste dispositivo.')); return; }
    const running = j?.running;
    if (!running) {
      const st = tr.status || 'pendente';
      if (st === 'pendente') actions.append(h('button', { class: 'btn primary', onclick: () => startTranscription(id) }, 'Transcrever'));
      else if (['interrompida', 'pausada', 'em andamento'].includes(st)) actions.append(h('button', { class: 'btn primary', onclick: () => startTranscription(id) }, `Retomar do trecho ${(tr.lastSegment ?? -1) + 2}`));
      if (st !== 'pendente') actions.append(h('button', { class: 'btn', onclick: async () => { if (await confirmDlg('Transcrever tudo de novo? As correções manuais desta transcrição serão substituídas (a memória de correções continua valendo).', 'Transcrever de novo', true)) startTranscription(id, { retranscribe: true }); } }, 'Transcrever de novo'));
      actions.append(h('label', { class: 'small muted row' }, 'Modelo:', modelSel));
    }
    actions.append(h('span', { class: 'spacer' }), h('a', { class: 'btn sm', href: '#', onclick: async (e) => { e.preventDefault(); downloadOriginal(); } }, '⬇ Áudio original'));
    body.append(h('div', { class: 'card stack' }, actions,
      h('div', { class: 'small muted' }, ASR_MODELS[state.settings.asrModel].note),
      tr.status === 'sem fala' || tr.status === 'sem texto' ? h('div', { class: 'alert bad small' }, tr.error?.message || '') : null));
    await ensureAudio();
    body.append(playerWrap);
    const segs = (await db.byMeeting('segments', id)).sort((a, b) => a.i - b.i);
    const plan = tr.plan || [];
    const list = h('div', { class: 'card' });
    segEls = new Map();
    const sn = speakerNameFn(m);
    const people = participantNames(m);
    const marks = m.marks || [];
    if (!plan.length && !segs.length) list.append(h('p', { class: 'muted' }, 'Ainda não transcrita.'));
    for (const p of plan) {
      const s = segs.find(x => x.i === p.i);
      if (p.silent && (!s || !s.text)) continue;
      const el = segRow(p, s, sn, people, marks);
      segEls.set(p.i, el); list.append(el);
    }
    body.append(list);
    player.ontimeupdate = () => {
      const t = player.currentTime;
      for (const [i, el] of segEls) { const p = plan.find(x => x.i === i); el.classList.toggle('playing', t >= p.start && t < p.end); }
    };
  }
  function segRow(p, s, sn, people, marks) {
    const tx = h('div', { class: 'tx', contentEditable: s?.done ? 'true' : 'false', spellcheck: true }, s?.done ? (s.text || '(sem fala reconhecida)') : 'aguardando transcrição…');
    const star = marks.some(t => t >= p.start && t < p.end) ? h('span', { class: 'pill warn' }, '★ ponto importante') : null;
    const who = h('div', { class: 'who' });
    if (s?.done && s.text) {
      const sel = h('select', { title: 'Confirme quem falou' }, h('option', { value: '' }, sn(s) + (s.speaker ? '' : ' (sem confirmação)')), ...people.map(n => h('option', { value: n, selected: s.speaker === n }, n)), h('option', { value: '__novo' }, '+ outro nome…'));
      sel.onchange = async () => {
        let v = sel.value;
        if (v === '__novo') { v = prompt('Nome de quem falou neste trecho:')?.trim(); if (!v) { sel.value = s.speaker || ''; return; } await db.updateMeeting(id, x => { (x.participants ||= []).push({ name: v, confirmed: true, evidence: 'confirmado pelo usuário' }); }); await reload(); }
        s.speaker = v || undefined; await db.guardedPut(id, 'segments', s);
      };
      who.append(sel);
      if (s.channel) who.append(h('span', { class: 'small' }, s.channel === 'mic' ? '🎙 fala captada no microfone' : s.channel === 'sys' ? '🔊 fala captada do áudio da reunião' : ''));
    }
    if (s?.edited) who.append(h('span', { class: 'pill' }, 'editado'));
    if (s?.flags?.length) who.append(h('span', { class: 'flag' }, '⚠ ' + s.flags.join('; ')));
    if (star) who.append(star);
    tx.addEventListener('blur', async () => {
      if (!s?.done) return;
      const nv = tx.textContent.trim();
      if (nv === (s.text || '').trim()) return;
      const before = s.text;
      s.text = nv; s.edited = true; s.editedAt = new Date().toISOString();
      await db.guardedPut(id, 'segments', s);
      offerRules(before, nv);
    });
    tx.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); tx.blur(); } });
    return h('div', { class: 'seg' + (s?.done ? '' : ' pending') }, h('button', { class: 'ts', title: 'Ouvir a partir daqui', onclick: () => seek(p.start) }, `▶ ${fmtTime(p.start)}`), h('div', {}, who, tx));
  }
  async function refreshSeg(i) {
    const el = segEls.get(i); if (!el) return;
    const s = await db.get('segments', [id, i]); const p = m.transcription?.plan?.find(x => x.i === i) || s;
    if (!s) return;
    el.replaceWith(segEls.set(i, segRow(p, s, speakerNameFn(m), participantNames(m), m.marks || [])).get(i));
  }
  async function offerRules(before, after) {
    const props = proposeRules(before, after);
    if (!props.length) return;
    const safe = props.filter(p => p.safety.ok);
    const blocked = props.filter(p => !p.safety.ok);
    const boxes = safe.map(p => ({ p, cat: h('select', { style: { width: 'auto' } }, ...['nome', 'empresa', 'sigla', 'termo técnico', 'outro'].map(c => h('option', {}, c))), cb: h('input', { type: 'checkbox' }) }));
    if (!safe.length) { if (blocked.length) toast(`Correção salva só neste trecho. Não vira regra: ${blocked[0].safety.reasons[0]}`, 7000); return; }
    const v = await dialog(h('div', { class: 'stack' }, h('strong', {}, 'Lembrar esta correção nas próximas transcrições?'),
      h('p', { class: 'small muted' }, 'Só vira regra o que você marcar. Isso não treina o modelo: é uma lista de substituições que você pode consultar, editar e desfazer em "Correções".'),
      ...boxes.map(b => h('label', { class: 'check' }, b.cb, h('span', {}, h('s', {}, b.p.from), ' → ', h('strong', {}, b.p.to), ' '), b.cat)),
      blocked.length ? h('div', { class: 'small muted' }, 'Não podem virar regra (proteção): ', blocked.map(b => `"${b.from}"→"${b.to}" (${b.safety.reasons[0]})`).join('; ')) : null),
    [{ label: 'Só neste trecho', value: '' }, { label: 'Lembrar selecionadas', value: 'ok', primary: true }]);
    if (v !== 'ok') return;
    let n = 0;
    for (const b of boxes) if (b.cb.checked) { await db.put('corrections', { id: 'c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5), from: b.p.from, to: b.p.to, category: b.cat.value, enabled: true, createdAt: new Date().toISOString(), origin: { meetingId: id, title: m.title } }); n++; }
    if (n) toast(`${n} correção(ões) adicionada(s) à memória.`);
  }
  async function downloadOriginal() {
    const tracks = Object.keys(m.tracks || {});
    if (!tracks.length) { ex.download(await ex.pcmWavBlob(m), ex.safeName(m.title) + '.wav'); return; }
    for (const t of tracks) {
      const b = await db.trackBlob(id, t); if (!b) continue;
      const ext = (m.tracks[t].name || '').split('.').pop() || (/mp4/.test(b.type) ? 'm4a' : 'webm');
      ex.download(b, `${ex.safeName(m.title)}_${t === 'original' ? 'original' : t === 'mic' ? 'microfone' : t === 'sys' ? 'reuniao' : 'mistura'}.${t === 'original' ? ext : (/mp4/.test(b.type) ? 'm4a' : 'webm')}`);
    }
  }

  // ======== ATA ========
  async function tAta() {
    const a = m.minutes;
    const j = job(id);
    const tr = m.transcription || {};
    const genBtn = h('button', { class: 'btn primary', disabled: !!j?.running, onclick: () => gen(false) }, a ? 'Gerar novamente' : 'Gerar ata com IA');
    async function gen(allowPartial) {
      if (a?.status === 'pronta' && !allowPartial && !await confirmDlg('Gerar uma nova ata? A versão atual (com suas edições) fica guardada no histórico da reunião.', 'Gerar nova')) return;
      const r = await startMinutes(id, { allowPartial });
      if (r.error?.kind === 'parcial') {
        if (await confirmDlg(`${r.error.message}\n\nGerar uma ATA PARCIAL agora? Ela será identificada como parcial em todas as exportações.`, 'Gerar ata parcial')) gen(true);
      }
    }
    body.append(h('div', { class: 'card row' }, genBtn,
      h('span', { class: 'small muted' }, `IA: ${state.settings.llm.provider} · ${state.settings.llm.model}`), h('a', { href: '#/config', class: 'small' }, 'alterar')));
    if (!a) {
      body.append(h('p', { class: 'muted', style: { marginTop: '12px' } }, tr.status === 'concluída' ? 'A ata ainda não foi gerada.' : 'Transcreva a reunião primeiro. Com a transcrição incompleta só é possível gerar uma ATA PARCIAL.'));
      return;
    }
    const segs = (await db.byMeeting('segments', id));
    const segIndex = new Map(segs.map(s => [s.id, s]));
    const save = async () => { m = await db.updateMeeting(id, x => { x.minutes = a; x.minutes.edited = true; for (const k of Object.keys(x.renditions || {})) x.renditions[k].stale = true; }); };
    const refs = (rs) => h('span', { class: 'refs' }, ...(rs || []).map(r => h('button', { class: 'ref', title: segIndex.get(r)?.text || '', onclick: () => { const s = segIndex.get(r); if (s) { ensureAudio().then(() => seek(s.start)); toast(`${r} ${fmtTime(s.start)}: ${s.text.slice(0, 160)}`, 8000); } } }, `${r} ${segIndex.get(r) ? fmtTime(segIndex.get(r).start) : '?'}`)));
    const editable = (obj, key, ph = '') => { const el = h('span', { contentEditable: 'true', 'data-ph': ph }, obj[key] || ''); el.onblur = async () => { const v = el.textContent.trim(); if (v !== obj[key]) { obj[key] = v; await save(); } }; return el; };
    const del = (list, it) => h('button', { class: 'btn sm ghost', title: 'Remover item', onclick: async () => { list.splice(list.indexOf(it), 1); await save(); paintBody(); } }, '✕');
    const add = (list, mk) => h('button', { class: 'btn sm', onclick: async () => { list.push(mk()); await save(); paintBody(); } }, '+ adicionar');
    const box = h('div', { class: 'card', style: { marginTop: '12px' } });
    if (a.partial) box.append(h('div', { class: 'alert bad' }, h('strong', {}, 'ATA PARCIAL'), ` — gerada com ${Math.round((a.coverage || 0) * 100)}% da transcrição. O restante da reunião não está contemplado.`));
    box.append(h('div', { class: 'small muted' }, `Gerada por IA em ${new Date(a.generatedAt).toLocaleString('pt-BR')} · ${a.generatedBy.provider} · ${a.generatedBy.model}${a.edited ? ' · editada por você' : ''}. Clique em qualquer texto para editar. Os códigos T# levam ao trecho da transcrição.`));
    if (a.warnings?.length) box.append(h('details', { class: 'alert small' }, h('summary', {}, `${a.warnings.length} ponto(s) rebaixado(s) para "A confirmar" pela conferência com a transcrição`), h('ul', {}, ...a.warnings.map(w => h('li', {}, w)))));
    const sec = (title, ...kids) => h('div', { class: 'ata-sec' }, h('h3', {}, title), ...kids);
    box.append(sec('Título', h('div', { class: 'item' }, editable(a, 'titulo'))));
    box.append(sec('Propósito', h('div', { class: 'item' }, editable(a, 'proposito'))));
    box.append(sec('Participantes', h('div', { class: 'small' }, participantNames(m).join(', ') || 'Não confirmados — veja a aba Participantes.')));
    box.append(sec('Resumo', ...a.resumo.map(r => h('div', { class: 'item' }, h('span', {}, '• ', editable(r, 'texto')), del(a.resumo, r))), add(a.resumo, () => ({ id: 'r' + Date.now(), texto: 'Novo ponto' }))));
    box.append(sec('Assuntos discutidos', ...a.assuntos.map((s, i) => h('div', { class: 'item' }, h('div', {}, h('strong', {}, `${i + 1}. `, editable(s, 'titulo')), ' ', refs(s.refs), h('ul', {}, ...s.pontos.map((p, k) => { const o = { v: p }; const el = h('li', { contentEditable: 'true' }, p); el.onblur = async () => { s.pontos[k] = el.textContent.trim(); await save(); }; return el; }))), del(a.assuntos, s)))));
    const decRow = d => h('div', { class: 'item' }, h('div', {}, editable(d, 'texto'), ' ', refs(d.refs), d.verificar ? h('div', { class: 'small', style: { color: 'var(--warn)' } }, '⚠ ' + d.verificar) : null, d.semOrigem ? h('div', { class: 'small', style: { color: 'var(--warn)' } }, '⚠ sem trecho de origem') : null),
      h('div', { class: 'row' }, h('select', { style: { width: 'auto' }, onchange: async (e) => { d.status = e.target.value; await save(); paintBody(); } }, h('option', { value: 'acordado', selected: d.status === 'acordado' }, 'Acordado'), h('option', { value: 'a confirmar', selected: d.status !== 'acordado' }, 'A confirmar')), del(a.decisoes, d)));
    box.append(sec('Decisões acordadas', ...a.decisoes.filter(d => d.status === 'acordado').map(decRow), add(a.decisoes, () => ({ id: 'd' + Date.now(), texto: 'Nova decisão', status: 'a confirmar', refs: [] }))));
    box.append(sec('Pontos a confirmar', ...a.decisoes.filter(d => d.status !== 'acordado').map(decRow)));
    box.append(sec('Propostas, sugestões e pedidos', ...a.propostas.map(p => h('div', { class: 'item' }, h('div', {}, h('span', { class: 'pill' }, p.tipo), ' ', editable(p, 'texto'), ' ', refs(p.refs)), del(a.propostas, p)))));
    box.append(sec('Restrições', ...a.restricoes.map(p => h('div', { class: 'item' }, h('div', {}, editable(p, 'texto'), ' ', refs(p.refs)), del(a.restricoes, p))), add(a.restricoes, () => ({ id: 'c' + Date.now(), texto: 'Nova restrição', refs: [] }))));
    box.append(sec('Riscos', ...a.riscos.map(p => h('div', { class: 'item' }, h('div', {}, editable(p, 'texto'), ' ', refs(p.refs)), del(a.riscos, p))), add(a.riscos, () => ({ id: 'k' + Date.now(), texto: 'Novo risco', refs: [] }))));
    box.append(sec('Próximos passos', h('div', { class: 'small muted' }, `${a.tarefas.length} tarefa(s) — edite na aba Tarefas.`), ...groupTasks(a.tarefas).map(([who, ts]) => h('div', {}, h('strong', {}, who), h('ul', {}, ...ts.map(t => h('li', {}, `${t.situacao === 'concluída' ? '☑' : '☐'} ${t.descricao} — prazo: ${t.prazo}`)))))));
    if (m.minutesHistory?.length) box.append(h('details', { class: 'small' }, h('summary', {}, `Versões anteriores (${m.minutesHistory.length})`), ...m.minutesHistory.map((v, i) => h('div', { class: 'row' }, `${new Date(v.generatedAt).toLocaleString('pt-BR')} · ${v.generatedBy?.model}${v.edited ? ' · editada' : ''}`, h('button', { class: 'btn sm', onclick: async () => { if (!await confirmDlg('Restaurar esta versão? A atual vai para o histórico.')) return; m = await db.updateMeeting(id, x => { const cur = x.minutes; x.minutes = x.minutesHistory[i]; x.minutesHistory[i] = cur; }); paintBody(); } }, 'Restaurar')))));
    body.append(box);
    await ensureAudio(); body.append(playerWrap);
  }

  // ======== TAREFAS ========
  async function tTasks() {
    const a = m.minutes;
    if (!a) { body.append(h('p', { class: 'muted' }, 'Gere a ata para listar as tarefas.')); return; }
    const segs = await db.byMeeting('segments', id);
    const segIndex = new Map(segs.map(s => [s.id, s]));
    const people = [...new Set([...participantNames(m), ...a.tarefas.map(t => t.responsavel)].filter(Boolean))];
    const save = async () => { m = await db.updateMeeting(id, x => { x.minutes = a; x.minutes.edited = true; }); };
    const card = h('div', { class: 'card' });
    card.append(h('div', { class: 'row' }, h('span', { class: 'small muted' }, 'Tarefas agrupadas por responsável. "A confirmar" = a IA ou a conferência não encontrou um responsável confiável.'), h('span', { class: 'spacer' }),
      h('button', { class: 'btn sm', onclick: async () => { a.tarefas.push({ id: 't' + Date.now(), descricao: 'Nova tarefa', responsavel: A_CONFIRMAR, prazo: NAO_DEFINIDO, compromisso: 'atribuído', refs: [], situacao: 'aberta', manual: true }); await save(); paintBody(); } }, '+ Nova tarefa'),
      h('button', { class: 'btn sm', onclick: () => ex.download(ex.toCsv(ctxFor(segIndex)), ex.safeName(m.title) + '_tarefas.csv') }, '⬇ CSV')));
    for (const [who, ts] of groupTasks(a.tarefas)) {
      card.append(h('h3', { style: { marginTop: '14px' } }, who, ' ', h('span', { class: 'pill' }, `${ts.filter(t => t.situacao !== 'concluída').length} aberta(s)`)));
      for (const t of ts) {
        const cb = h('input', { type: 'checkbox', checked: t.situacao === 'concluída', onchange: async () => { t.situacao = cb.checked ? 'concluída' : 'aberta'; t.concluidaEm = cb.checked ? new Date().toISOString() : undefined; await save(); paintBody(); } });
        const desc = h('div', { class: 'desc', contentEditable: 'true' }, t.descricao); desc.onblur = async () => { const v = desc.textContent.trim(); if (v && v !== t.descricao) { t.descricao = v; await save(); } };
        const resp = h('input', { type: 'text', value: t.responsavel, list: 'pessoas-' + id }); resp.onchange = async () => { t.responsavel = resp.value.trim() || A_CONFIRMAR; await save(); paintBody(); };
        const prazo = h('input', { type: 'text', value: t.prazo }); prazo.onchange = async () => { t.prazo = prazo.value.trim() || NAO_DEFINIDO; await save(); };
        const comp = h('select', { onchange: async () => { t.compromisso = comp.value; await save(); } }, ...['assumido', 'atribuído', 'solicitado', 'sugerido'].map(c => h('option', { selected: t.compromisso === c }, c)));
        const origin = t.refs.map(r => segIndex.get(r)).filter(Boolean);
        card.append(h('div', { class: 'task' + (t.situacao === 'concluída' ? ' done' : '') }, cb, h('div', {}, desc,
          h('div', { class: 'meta' }, h('label', { class: 'small' }, 'Responsável', resp), h('label', { class: 'small' }, 'Prazo informado', prazo), h('label', { class: 'small' }, 'Compromisso', comp),
            h('div', { class: 'small' }, 'Situação', h('div', {}, t.situacao === 'concluída' ? 'Concluída' : 'Aberta', ' ', h('button', { class: 'btn sm ghost', onclick: async () => { a.tarefas.splice(a.tarefas.indexOf(t), 1); await save(); paintBody(); } }, 'excluir')))),
          t.responsavelSugerido ? h('div', { class: 'small', style: { color: 'var(--warn)' } }, `A IA sugeriu "${t.responsavelSugerido}", mas o trecho não comprova. Confirme acima se for o caso.`) : null,
          t.prazoSugerido ? h('div', { class: 'small', style: { color: 'var(--warn)' } }, `Prazo sugerido pela IA ("${t.prazoSugerido}") não aparece no trecho.`) : null,
          origin.length ? h('div', { class: 'small muted' }, 'Origem: ', ...origin.map(s => h('button', { class: 'ref', onclick: () => seek(s.start) }, `${s.id} ${fmtTime(s.start)}`)), ' “', origin.map(s => s.text).join(' … ').slice(0, 300), '”') : h('div', { class: 'small muted' }, t.manual ? 'Tarefa adicionada manualmente.' : 'Sem trecho de origem.'))));
      }
    }
    card.append(h('datalist', { id: 'pessoas-' + id }, ...people.map(p => h('option', { value: p }))));
    body.append(card);
    await ensureAudio(); body.append(playerWrap);
  }

  // ======== CAPTURAS ========
  async function tShots() {
    const shots = (await db.byMeeting('shots', id)).sort((a, b) => a.t - b.t);
    const card = h('div', { class: 'card stack' });
    card.append(h('div', { class: 'small muted' }, shots.length ? `${shots.length} captura(s). Elas aparecem na ata junto do assunto discutido no mesmo horário e em DOCX, PDF e Markdown.` : 'Nenhuma captura. As capturas são feitas durante a gravação online quando há tela/aba compartilhada (intervalo configurável) ou pelo botão "Marcar ponto importante".'));
    const grid = h('div', { class: 'shots' });
    for (const s of shots) {
      const url = URL.createObjectURL(s.blob);
      const cap = h('input', { type: 'text', value: s.caption || '', placeholder: 'Legenda' });
      cap.onchange = async () => { s.caption = cap.value.trim(); await db.guardedPut(id, 'shots', s); };
      grid.append(h('div', { class: 'shot' }, h('img', { src: url, alt: s.caption || 'captura', onclick: () => dialog(h('div', {}, h('img', { src: url }), h('p', {}, `${fmtTime(s.t)} — ${s.caption || ''}`))) }),
        h('div', { class: 'b' }, h('div', { class: 'row small' }, h('button', { class: 'ref', onclick: () => seek(s.t) }, `▶ ${fmtTime(s.t)}`), s.manual ? h('span', { class: 'pill warn' }, '★ marcada') : null, h('span', { class: 'spacer' }),
          h('button', { class: 'btn sm danger', onclick: async () => { if (await confirmDlg('Excluir esta captura?', 'Excluir', true)) { await db.del('shots', s.id); paintBody(); } } }, 'Excluir')), cap)));
    }
    card.append(grid);
    body.append(card);
    await ensureAudio(); body.append(playerWrap);
  }

  // ======== FORMATOS / EXPORTAÇÃO ========
  function ctxFor(segIndex, segs = [], shots = []) {
    return { meeting: m, minutes: m.minutes, segments: segs.sort((a, b) => a.i - b.i), segIndex, shots, speakerName: speakerNameFn(m), participants: participantNames(m), renditions: m.renditions, transcriptionIncomplete: m.transcription?.status !== 'concluída' };
  }
  async function tExport() {
    const segs = await db.byMeeting('segments', id);
    const shots = (await db.byMeeting('shots', id)).sort((a, b) => a.t - b.t);
    const segIndex = new Map(segs.map(s => [s.id, s]));
    const shotsById = new Map(shots.map(s => [s.id, s]));
    let fmt = sessionStorage.getItem('fmt') || 'ata';
    const sel = h('select', { style: { width: 'auto' } }, ...FORMATS.map(f => h('option', { value: f.key, selected: f.key === fmt }, f.label)));
    const ta = h('textarea', { class: 'preview' });
    const status = h('div', { class: 'small muted' });
    const custom = h('input', { type: 'text', placeholder: 'Descreva o formato: ex. "e-mail curto para a diretoria com decisões e pendências"', value: m.renditions?.personalizado?.style || '' });
    const aiBtn = h('button', { class: 'btn' }, 'Gerar com IA');
    const customRow = h('div', { class: 'stack' }, custom);
    const userKey = () => `user:${fmt}`;
    async function show() {
      fmt = sel.value; sessionStorage.setItem('fmt', fmt);
      const def = FORMATS.find(f => f.key === fmt);
      customRow.classList.toggle('hidden', fmt !== 'personalizado');
      aiBtn.classList.toggle('hidden', !def.ai);
      const saved = m.renditions?.[userKey()];
      let base = '';
      try { base = renderFormat(fmt, ctxFor(segIndex, segs, shots)); } catch (e) { base = ''; status.textContent = e.message; }
      if (saved?.text) { ta.value = saved.text; status.textContent = `Mostrando a sua versão editada (${new Date(saved.at).toLocaleString('pt-BR')}).${saved.stale || m.renditions?.[fmt]?.stale ? ' A ata mudou depois desta edição.' : ''}`; }
      else { ta.value = base; if (base) status.textContent = def.ai ? `Texto escrito pela IA (${m.renditions?.[fmt]?.by || ''}) a partir dos fatos da ata.${m.renditions?.[fmt]?.stale ? ' A ata mudou desde então: gere de novo.' : ''}` : 'Gerado a partir da ata e da transcrição. Edite à vontade: a edição vale só para este formato e não altera a ata.'; }
    }
    sel.onchange = show;
    let tmr;
    ta.oninput = () => { clearTimeout(tmr); tmr = setTimeout(async () => { m = await db.updateMeeting(id, x => { x.renditions = x.renditions || {}; x.renditions[userKey()] = { text: ta.value, at: new Date().toISOString() }; }); status.textContent = 'Edição salva (vale só para este formato).'; }, 600); };
    aiBtn.onclick = async () => {
      aiBtn.disabled = true; status.textContent = 'Gerando com IA…';
      try {
        const style = fmt === 'narrativo' ? 'texto narrativo corrido, em parágrafos, tom formal de ata' : custom.value.trim();
        if (!style) throw Object.assign(new Error('Descreva o formato desejado.'), { kind: 'config' });
        const llm = makeLLM({ onToken: c => status.textContent = `Gerando com IA… ${c} caracteres` });
        await generateRendition(id, fmt, style, llm); llm.dispose();
        m = await db.updateMeeting(id, x => { delete x.renditions[userKey()]; });
        await show();
      } catch (e) { status.replaceChildren(errorPanel(e, { stage: 'formato com IA', model: state.settings.llm.model })); }
      aiBtn.disabled = false;
    };
    const restore = h('button', { class: 'btn sm', onclick: async () => { m = await db.updateMeeting(id, x => { delete x.renditions[userKey()]; }); show(); } }, 'Descartar minha edição deste formato');
    const base = ex.safeName(m.minutes?.titulo || m.title) + '_' + fmt;
    const exp = async (kind) => {
      try {
        const md = ta.value;
        if (!md.trim()) throw new Error('Nada para exportar neste formato.');
        if (kind === 'docx') ex.download(await ex.toDocx(md, shotsById), base + '.docx');
        if (kind === 'pdf') ex.download(await ex.toPdf(md, shotsById), base + '.pdf');
        if (kind === 'txt') ex.download(ex.toText(md), base + '.txt');
        if (kind === 'md') { const r = await ex.toMarkdownZip(md, shotsById, base); ex.download(r.blob, r.name); }
      } catch (e) { status.replaceChildren(errorPanel(e, { stage: 'exportação ' + kind })); }
    };
    body.append(h('div', { class: 'card stack' },
      h('div', { class: 'row' }, h('label', { class: 'small muted' }, 'Formato'), sel, aiBtn, h('span', { class: 'spacer' }), restore),
      customRow, status, ta,
      h('div', { class: 'row' }, h('strong', {}, 'Exportar:'),
        h('button', { class: 'btn', onclick: () => exp('docx') }, 'Word (.docx)'), h('button', { class: 'btn', onclick: () => exp('pdf') }, 'PDF'),
        h('button', { class: 'btn', onclick: () => exp('txt') }, 'Texto (.txt)'), h('button', { class: 'btn', onclick: () => exp('md') }, 'Markdown'),
        m.minutes ? h('button', { class: 'btn', onclick: () => ex.download(ex.toCsv(ctxFor(segIndex, segs, shots)), ex.safeName(m.title) + '_tarefas.csv') }, 'Tarefas (.csv)') : null,
        h('button', { class: 'btn', onclick: downloadOriginal }, 'Áudio original')),
      h('div', { class: 'small muted' }, 'Imagens das capturas entram no Word, PDF e Markdown (zip com pasta de imagens). O TXT indica a posição de cada imagem.')));
    show();
  }

  // ======== PARTICIPANTES ========
  async function tPeople() {
    const card = h('div', { class: 'card stack' });
    const list = h('div', { class: 'stack' });
    const paintList = () => list.replaceChildren(...(m.participants || []).map((p, i) => h('div', { class: 'row' }, h('strong', {}, p.name), h('span', { class: 'small muted' }, p.evidence || ''), h('span', { class: 'spacer' }),
      h('button', { class: 'btn sm ghost', onclick: async () => { m = await db.updateMeeting(id, x => { x.participants.splice(i, 1); }); paintList(); } }, 'remover'))));
    paintList();
    const nm = h('input', { type: 'text', placeholder: 'Nome do participante' });
    const micName = h('input', { type: 'text', value: m.speakerNames?.mic || state.settings.myName || '', placeholder: 'Ex.: Pedro' });
    const sysName = h('input', { type: 'text', value: m.speakerNames?.sys || '', placeholder: 'Ex.: Participantes remotos' });
    card.append(h('h3', {}, 'Participantes confirmados'),
      h('div', { class: 'small muted' }, 'Só entram aqui nomes informados por você, pela plataforma (bot) ou confirmados na transcrição. O app não associa automaticamente uma voz a uma pessoa.'),
      list, h('div', { class: 'row' }, nm, h('button', { class: 'btn', onclick: async () => { if (!nm.value.trim()) return; m = await db.updateMeeting(id, x => { (x.participants ||= []).push({ name: nm.value.trim(), confirmed: true, evidence: 'informado pelo usuário' }); }); nm.value = ''; paintList(); } }, 'Adicionar')));
    const hasStems = m.tracks?.mic && m.tracks?.sys;
    const evOut = h('div', { class: 'small' });
    card.append(h('hr'), h('h3', {}, 'Identificação pela trilha de áudio'),
      h('div', { class: 'small muted' }, hasStems ? 'Esta reunião tem o seu microfone e o áudio da reunião em trilhas separadas. Isso permite marcar, com evidência medida, quais trechos vieram do seu microfone e quais vieram dos demais participantes (sem distinguir entre eles).' : 'Disponível apenas em gravações online com microfone + áudio da reunião.'),
      hasStems ? h('div', { class: 'grid g2' }, h('label', {}, h('span', { class: 'f' }, 'Nome para a fala do microfone'), micName), h('label', {}, h('span', { class: 'f' }, 'Nome para a fala do áudio da reunião'), sysName)) : null,
      hasStems ? h('div', { class: 'row' }, h('button', { class: 'btn', onclick: async () => {
        m = await db.updateMeeting(id, x => { x.speakerNames = { mic: micName.value.trim() || undefined, sys: sysName.value.trim() || undefined }; });
        let n = { mic: 0, sys: 0, misto: 0 };
        for (const s of await db.byMeeting('segments', id)) { if (!s.text) continue; const ev = await channelEvidence(m, s); if (!ev) continue; s.channel = ev.source === 'misto' ? undefined : ev.source; s.channelDiffDb = Math.round(ev.diffDb); n[ev.source]++; await db.guardedPut(id, 'segments', s); }
        evOut.textContent = `Trechos do microfone: ${n.mic}; do áudio da reunião: ${n.sys}; indefinidos (ambos com som): ${n.misto}.`;
      } }, 'Aplicar identificação por trilha'), evOut) : null);
    body.append(card);
  }

  // ======== DIAGNÓSTICO ========
  async function tDiag() {
    const card = h('div', { class: 'card stack' });
    const blobs = await db.byMeeting('blobs', id);
    const size = blobs.reduce((a, b) => a + (b.data?.size || 0), 0);
    const tr = m.transcription || {};
    card.append(h('h3', {}, 'Resumo técnico'), h('table', { class: 't' },
      ...[['Trilhas gravadas', Object.entries(m.tracks || {}).map(([k, v]) => `${k}: ${v.label}`).join(' · ') || '—'], ['Tamanho do áudio original', fmtBytes(size)], ['Duração (base 16 kHz)', fmtTime(m.durationSec)],
        ['Status da transcrição', tr.status || 'pendente'], ['Motor usado', tr.engine ? `${tr.engine.model} · ${tr.engine.device}` : '—'], ['Velocidade medida', tr.rtf ? `${(1 / tr.rtf).toFixed(2)}× tempo real` : '—'],
        ['Trechos planejados', tr.plan ? `${tr.plan.length} (${tr.plan.filter(p => p.silent).length} silenciosos, não enviados ao modelo)` : '—'], ['Fala detectada', tr.speechSec ? fmtTime(tr.speechSec) : '—'], ['Piso de ruído', tr.noiseFloorDb != null ? `${tr.noiseFloorDb.toFixed(1)} dBFS` : '—'],
        ['Erros de gravação no armazenamento', m.writeErrors ?? 0]].map(([k, v]) => h('tr', {}, h('th', {}, k), h('td', {}, String(v))))));
    const sigOut = h('div');
    card.append(h('button', { class: 'btn', onclick: async () => {
      sigOut.textContent = 'Analisando…';
      try { const r = await meetingSignal(m); sigOut.replaceChildren(h('div', { class: `alert ${r.issues.length ? 'bad' : 'ok'} small` }, `Pico ${r.peakDb.toFixed(1)} dBFS · fala ${r.speechDb.toFixed(1)} dBFS · ruído ${r.noiseFloorDb.toFixed(1)} dBFS · fala em ${(r.speechRatio * 100).toFixed(0)}% do tempo · saturação ${(r.clippedRatio * 100).toFixed(3)}%${r.durationSec < m.durationSec - 1 ? ' (primeiros 30 min)' : ''}`, ...r.issues.map(i => h('div', {}, '• ' + i.msg)))); }
      catch (e) { sigOut.replaceChildren(errorPanel(e, { stage: 'diagnóstico de sinal' })); }
    } }, 'Analisar sinal do áudio'), sigOut);
    const logs = (await db.byMeeting('logs', id)).sort((a, b) => b.ts.localeCompare(a.ts));
    card.append(h('h3', {}, `Registro de erros (${logs.length})`));
    if (!logs.length) card.append(h('div', { class: 'small muted' }, 'Nenhum erro registrado.'));
    for (const l of logs.slice(0, 30)) card.append(h('details', { class: 'small' }, h('summary', {}, `${new Date(l.ts).toLocaleString('pt-BR')} — ${l.stage} — ${l.kind || '?'} — ${l.message.slice(0, 120)}`), h('div', { class: 'errbox' }, JSON.stringify(l, null, 2)), h('button', { class: 'btn sm', onclick: () => navigator.clipboard.writeText(JSON.stringify(l, null, 2)) }, 'Copiar')));
    body.append(card);
  }

  paintTabs(); paintBody();
  return () => { unsub(); clearInterval(botTimer); player.pause(); if (audioUrl) URL.revokeObjectURL(audioUrl); };
}

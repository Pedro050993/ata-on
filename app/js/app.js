// Ponto de entrada: rotas, configurações, trabalhos em segundo plano e PWA.

import * as db from './db.js';
import { h, $, $$, toast } from './ui/dom.js';
import { recoverInterrupted } from './recorder.js';
import { Transcriber } from './transcriber.js';
import { LLM } from './llm.js';
import { generateMinutes } from './ata.js';

export const VERSION = '1.0.0';

const DEFAULTS = {
  myName: '', theme: 'auto',
  asrModel: 'equilibrado', asrDevice: 'auto',
  micId: '', echoCancellation: true, noiseSuppression: false, autoGainControl: true,
  shotInterval: 20, shotThreshold: 12,
  llm: { provider: 'ollama', model: 'qwen3:8b', ollamaUrl: '', numCtx: 16384, device: 'wasm', openaiUrl: '', openaiKey: '' },
};

export const state = { settings: structuredClone(DEFAULTS), local: null, recording: null, jobs: new Map() };

export async function loadSettings() {
  const s = await db.getSetting('settings', {});
  state.settings = { ...structuredClone(DEFAULTS), ...s, llm: { ...DEFAULTS.llm, ...(s.llm || {}) } };
  if (!state.settings.llm.ollamaUrl) state.settings.llm.ollamaUrl = state.local ? `${location.origin}/ollama` : 'http://localhost:11434';
  applyTheme();
  return state.settings;
}
export async function saveSettings(patch) {
  state.settings = { ...state.settings, ...patch, llm: { ...state.settings.llm, ...(patch.llm || {}) } };
  await db.setSetting('settings', state.settings);
  applyTheme();
}
function applyTheme() {
  const t = state.settings.theme;
  if (t === 'auto') document.documentElement.removeAttribute('data-theme'); else document.documentElement.dataset.theme = t;
}

// ---------- trabalhos em segundo plano (continuam ao trocar de tela) ----------

export function job(meetingId) { return state.jobs.get(meetingId); }
const listeners = new Map(); // meetingId → Set(fn): vale para trabalhos atuais e futuros
function emit(j) { (listeners.get(j.meetingId) || []).forEach(fn => { try { fn(j); } catch (e) { console.error(e); } }); }
export function subscribe(meetingId, fn) {
  if (!listeners.has(meetingId)) listeners.set(meetingId, new Set());
  listeners.get(meetingId).add(fn); return () => listeners.get(meetingId)?.delete(fn);
}

export async function startTranscription(meetingId, { retranscribe = false } = {}) {
  if (state.jobs.get(meetingId)?.running) return state.jobs.get(meetingId);
  const corrections = (await db.getAll('corrections')).filter(c => c.enabled);
  const j = { meetingId, kind: 'transcrição', running: true, stages: {}, log: [], startedAt: performance.now(), lastSeg: null };
  state.jobs.set(meetingId, j);
  const setStage = (k, st, text) => { j.stages[k] = { st, text, at: performance.now() }; emit(j); };
  const tr = new Transcriber({
    onStage: (k, text) => {
      if (k === 'preparo') setStage('preparo', 'run', text);
      if (k === 'modelo') { setStage('preparo', 'ok', 'Áudio analisado'); setStage('modelo', 'run', text); }
      if (k === 'transcricao') { setStage('modelo', 'ok', `${tr.engine?.model} · ${tr.engine?.device === 'webgpu' ? 'GPU' : 'CPU'}`); setStage('transcricao', 'run', text); }
    },
    onDownload: (d) => { j.download = d; emit(j); },
    onEngine: (eng, ms) => { j.engine = eng; j.loadMs = ms; emit(j); },
    onPlan: (p) => { j.plan = p.plan; j.done = p.done; emit(j); },
    onSegment: (s) => { j.lastSeg = s; j.progress = s.progress; j.eta = s.etaSec; j.rtf = s.rtf; emit(j); },
    onNotice: (t) => { j.log.push(t); toast(t, 8000); emit(j); },
  });
  j.transcriber = tr;
  emit(j);
  tr.run(meetingId, { modelKey: state.settings.asrModel, device: state.settings.asrDevice, corrections, retranscribe, debugFailAt: state.settings.debugFailAt, debugFailKind: state.settings.debugFailKind })
    .then(r => { if (!r) return; setStage('transcricao', 'ok', 'Transcrição concluída'); j.result = r; })
    .catch(async (e) => {
      if (e.name === 'MeetingGone') return;
      j.error = e; j.errorCtx = { stage: Object.keys(j.stages).at(-1) || 'transcrição', model: tr.engine?.model, engine: tr.engine?.device };
      const k = Object.keys(j.stages).find(k => j.stages[k].st === 'run') || 'transcricao';
      setStage(k, e.kind === 'cancelado' ? 'idle' : 'err', e.message);
      if (e.kind !== 'cancelado') {
        await db.log({ meetingId, stage: j.errorCtx.stage, model: j.errorCtx.model, engine: j.errorCtx.engine, kind: e.kind, message: e.message, stack: e.stackText || e.stack });
        await db.updateMeeting(meetingId, m => { m.transcription = { ...(m.transcription || {}), status: m.transcription?.status === 'sem fala' ? 'sem fala' : 'interrompida', error: { kind: e.kind, message: e.message } }; }).catch(() => {});
      } else await db.updateMeeting(meetingId, m => { m.transcription.status = 'pausada'; }).catch(() => {});
    })
    .finally(() => { j.running = false; emit(j); refreshFoot(); });
  refreshFoot();
  return j;
}

export function cancelJob(meetingId) {
  const j = state.jobs.get(meetingId); if (!j?.running) return;
  j.transcriber?.cancel(); j.llm?.abort();
}

export function makeLLM(events) { return new LLM(state.settings.llm, events); }

export async function startMinutes(meetingId, { allowPartial = false } = {}) {
  if (state.jobs.get(meetingId)?.running) throw new Error('Já existe um processamento em andamento para esta reunião.');
  const j = { meetingId, kind: 'ata', running: true, stages: { ata: { st: 'run', text: 'Preparando…' } }, startedAt: performance.now(), chars: 0 };
  state.jobs.set(meetingId, j);
  const llm = makeLLM({ onDownload: d => { j.download = d; emit(j); }, onToken: c => { j.chars = c; emit(j); } });
  j.llm = llm; emit(j); refreshFoot();
  try {
    const rec = await generateMinutes(meetingId, llm, { onStage: t => { j.stages.ata = { st: 'run', text: t }; emit(j); }, onProgress: p => { j.progress = p; emit(j); } }, { allowPartial });
    j.stages.ata = { st: 'ok', text: `Ata gerada (${llm.provider} · ${llm.model})` };
    j.result = rec;
  } catch (e) {
    if (e.name !== 'MeetingGone') {
      j.error = e; j.errorCtx = { stage: 'geração da ata', model: `${llm.provider} · ${llm.model}`, engine: llm.provider };
      j.stages.ata = { st: e.kind === 'cancelado' ? 'idle' : 'err', text: e.message };
      if (e.kind !== 'cancelado' && e.kind !== 'parcial') await db.log({ meetingId, stage: 'ata', model: llm.model, engine: llm.provider, kind: e.kind, message: e.message, stack: e.stackText || e.stack });
    }
  } finally { j.running = false; llm.dispose(); emit(j); refreshFoot(); }
  return j;
}

// ---------- rotas ----------

const routes = {
  inicio: () => import('./ui/home.js'),
  gravar: () => import('./ui/record.js'),
  reunioes: () => import('./ui/meetings.js'),
  reuniao: () => import('./ui/meeting.js'),
  memoria: () => import('./ui/memory.js'),
  config: () => import('./ui/settings.js'),
  ajuda: () => import('./ui/help.js'),
};
let currentCleanup = null;

export function go(route, param) { location.hash = param ? `#/${route}/${param}` : `#/${route}`; }

async function router() {
  const [, route = 'inicio', param] = location.hash.split('/');
  if (state.recording && route !== 'gravar') {
    // não deixa sair da tela de gravação por engano: a gravação continua e a tela volta
    toast('Há uma gravação em andamento. Encerre-a antes de navegar.');
    if (location.hash !== `#/gravar/${state.recording.meeting.id}`) location.hash = `#/gravar/${state.recording.meeting.id}`;
    return;
  }
  const mod = await (routes[route] || routes.inicio)();
  currentCleanup?.(); currentCleanup = null;
  $$('.nav').forEach(b => b.setAttribute('aria-current', b.dataset.route === route || (route === 'reuniao' && b.dataset.route === 'reunioes') || (route === 'gravar' && b.dataset.route === 'inicio') ? 'page' : 'false'));
  const view = $('#view');
  view.replaceChildren();
  try { currentCleanup = await mod.render(view, param) || null; }
  catch (e) { console.error(e); view.replaceChildren(h('div', { class: 'alert bad' }, `Erro ao abrir a tela: ${e.message}`)); }
  view.focus({ preventScroll: true });
}

export function refreshFoot() {
  const running = [...state.jobs.values()].filter(j => j.running).length;
  $('#foot').replaceChildren(...[
    h('div', {}, `v${VERSION}`),
    state.local ? h('div', {}, '● Servidor local ativo') : null,
    running ? h('div', {}, `● ${running} processamento(s) em andamento`) : null,
  ].filter(Boolean));
}

async function boot() {
  $$('.nav').forEach(b => b.addEventListener('click', () => go(b.dataset.route)));
  try { const r = await fetch('/api/health', { cache: 'no-store' }); if (r.ok) { const j = await r.json(); if (j.app === 'pedro-agent-local') state.local = j; } } catch { /* sem servidor local */ }
  await db.openDb();
  await loadSettings();
  // pede armazenamento persistente para o navegador não apagar as reuniões
  if (navigator.storage?.persist) navigator.storage.persist().catch(() => {});
  const rec = await recoverInterrupted();
  if (rec.length) toast(`${rec.length} gravação(ões) interrompida(s) foram recuperadas até o último trecho salvo.`, 9000);
  // trabalhos que estavam em andamento quando o app fechou
  const ms = await db.getAll('meetings');
  for (const m of ms) if (m.transcription?.status === 'em andamento') await db.updateMeeting(m.id, x => { x.transcription.status = 'interrompida'; });
  window.addEventListener('hashchange', router);
  window.addEventListener('beforeunload', (e) => { if (state.recording || [...state.jobs.values()].some(j => j.running)) { e.preventDefault(); e.returnValue = ''; } });
  refreshFoot();
  router();
  if ('serviceWorker' in navigator && !/[?&]nosw/.test(location.search)) {
    // 1ª ativação: recarrega uma vez para o isolamento (WASM multithread) valer
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (!self.crossOriginIsolated && !sessionStorage.getItem('coi-reload') && !state.recording && ![...state.jobs.values()].some(j => j.running)) { sessionStorage.setItem('coi-reload', '1'); location.reload(); }
    });
    navigator.serviceWorker.register('sw.js').then(reg => {
      reg.addEventListener('updatefound', () => {
        const nw = reg.installing;
        nw?.addEventListener('statechange', () => { if (nw.state === 'installed' && navigator.serviceWorker.controller) toast('Nova versão instalada. Ela será usada na próxima abertura (seus dados são mantidos).', 9000); });
      });
    }).catch(e => console.warn('SW', e));
  }
}

window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); state.installPrompt = e; });
boot();

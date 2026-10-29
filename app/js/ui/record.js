import { h, toast, confirmDlg } from './dom.js';
import { state, go, startTranscription } from '../app.js';
import { fmtTime } from '../core/text.js';

export async function render(view, id) {
  const rec = state.recording;
  if (!rec || rec.meeting.id !== id) { go('reuniao', id); return; }
  const clock = h('div', { class: 'clock' }, fmtTime(rec.seconds));
  const pill = h('span', { class: 'pill live' }, 'Gravando');
  const meters = {};
  const meterRow = (k, label) => { const bar = h('i'), pk = h('b'), txt = h('span', { class: 'mono' }, '—'); meters[k] = { bar, pk, txt }; return h('div', { class: 'meter' }, h('span', {}, label), h('div', { class: 'bar' }, bar, pk), txt); };
  const warn = h('div', { class: 'stack' });
  const shotsInfo = h('div', { class: 'small muted' });
  const lastWarn = {};

  rec.ev.onLevel = (L) => {
    for (const [k, m] of Object.entries(meters)) {
      const v = L[k]; if (!v || !v.active) { m.txt.textContent = '—'; m.bar.style.width = '0'; continue; }
      const pct = d => Math.max(0, Math.min(100, (d + 60) / 60 * 100));
      m.bar.style.width = pct(v.db) + '%'; m.pk.style.left = pct(v.peakDb) + '%';
      m.txt.textContent = `${v.db.toFixed(0)} dB`;
    }
  };
  rec.ev.onTime = (s) => { clock.textContent = fmtTime(s); };
  rec.ev.onWarning = (k, msg) => {
    const now = Date.now(); if (lastWarn[k] && now - lastWarn[k] < 15000) return; lastWarn[k] = now;
    const el = h('div', { class: `alert ${k === 'saturacao' ? 'bad' : ''} small` }, `${new Date().toLocaleTimeString('pt-BR')} — ${msg}`);
    warn.prepend(el); while (warn.children.length > 4) warn.lastChild.remove();
  };
  rec.ev.onError = (e) => warn.prepend(h('div', { class: 'alert bad' }, `Erro na gravação: ${e.message}. O que já foi gravado está salvo.`));
  rec.ev.onState = (st) => { pill.textContent = st === 'pausado' ? 'Pausado' : st === 'gravando' ? 'Gravando' : 'Encerrado'; pill.className = 'pill ' + (st === 'gravando' ? 'live' : 'warn'); pauseBtn.textContent = st === 'pausado' ? '▶ Retomar' : '❚❚ Pausar'; };
  if (rec.shots) {
    rec.shots.opts.onShot = (s) => { shotsInfo.textContent = `${rec.shots.count} captura(s) — última em ${fmtTime(s.t)}${s.manual ? ' (marcada por você)' : ''}`; };
    rec.shots.opts.onState = (st, msg) => { shotsInfo.textContent = msg; };
  }

  const pauseBtn = h('button', { class: 'btn big', onclick: () => rec.state === 'pausado' ? rec.resume() : rec.pause() }, '❚❚ Pausar');
  const markBtn = h('button', { class: 'btn big', onclick: async () => {
    const t = rec.seconds;
    const shot = rec.shots ? await rec.shots.capture(true, `Ponto importante (${fmtTime(t)})`) : null;
    rec.marks = rec.marks || []; rec.marks.push(t);
    toast(shot ? `Ponto importante marcado em ${fmtTime(t)} com captura da tela.` : `Ponto importante marcado em ${fmtTime(t)} (sem tela compartilhada para capturar).`);
  } }, '★ Marcar ponto importante');
  const stopBtn = h('button', { class: 'btn primary big', onclick: async () => {
    if (!await confirmDlg('Encerrar a gravação?', 'Encerrar')) return;
    stopBtn.disabled = true; pauseBtn.disabled = true; stopBtn.textContent = 'Salvando…';
    rec.shots?.stop();
    await rec.stop();
    const marks = rec.marks || [];
    const { updateMeeting } = await import('../db.js');
    await updateMeeting(rec.meeting.id, m => { m.marks = marks; });
    state.recording = null;
    const auto = await confirmDlg('Gravação salva. Iniciar a transcrição agora? (Você pode fazer depois.)', 'Transcrever agora');
    if (auto) startTranscription(rec.meeting.id);
    go('reuniao', rec.meeting.id);
  } }, '■ Encerrar');

  const tracks = [];
  if (rec.micStream) tracks.push(meterRow('mic', 'Seu microfone'));
  if (rec.sysStream) tracks.push(meterRow('sys', 'Áudio da reunião'));
  tracks.push(meterRow('mix', 'Gravação (mistura)'));

  view.append(
    h('div', { class: 'topbar' }, h('h1', {}, rec.meeting.title), pill),
    h('div', { class: 'grid g2' },
      h('div', { class: 'card stack' }, clock, ...tracks, h('div', { class: 'small muted' }, 'Barra = nível médio; traço = pico. Verde = bom; laranja/vermelho = perto de saturar.'), warn),
      h('div', { class: 'card stack' },
        h('div', { class: 'row' }, pauseBtn, stopBtn), markBtn, shotsInfo,
        h('div', { class: 'small muted' }, 'O áudio é salvo neste dispositivo a cada 4–10 segundos. Se a janela fechar, a gravação é recuperada até o último trecho salvo.'),
        rec.sysStream ? h('div', { class: 'small muted' }, 'Microfone e áudio da reunião são gravados em trilhas separadas: assim o app diferencia a sua fala da fala dos demais participantes.') : h('div', { class: 'small muted' }, 'Gravação somente pelo microfone.'),
      )),
  );
}

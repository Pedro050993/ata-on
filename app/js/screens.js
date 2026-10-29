// Capturas da tela compartilhada. Só captura a fonte que o usuário autorizou
// no seletor do navegador (aba, janela ou tela). Evita imagens repetidas
// comparando uma miniatura em tons de cinza de cada quadro com a anterior.

import * as db from './db.js';

// Assinatura do quadro: miniatura 64×36 em tons de cinza. Duas capturas são
// "a mesma tela" quando quase nenhuma célula mudou de forma perceptível.
// (Um hash de gradientes não serve: ignora troca de cor e de texto em slides
// com o mesmo layout.)
export function signature(source) {
  const w = 64, h = 36;
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  const g = c.getContext('2d', { willReadFrequently: true });
  g.drawImage(source, 0, 0, w, h);
  const d = g.getImageData(0, 0, w, h).data;
  const out = new Uint8Array(w * h);
  for (let i = 0; i < out.length; i++) out[i] = Math.round(d[i * 4] * 0.299 + d[i * 4 + 1] * 0.587 + d[i * 4 + 2] * 0.114);
  return out;
}
/** Quantas células mudaram mais que 20 níveis de cinza. */
export function changedCells(a, b) {
  let n = 0;
  for (let i = 0; i < a.length; i++) if (Math.abs(a[i] - b[i]) > 20) n++;
  return n;
}

export class ScreenCapturer {
  /** opts: { intervalSec, threshold, clock: () => segundosDaReunião, onShot, onState } */
  constructor(meetingId, stream, opts) {
    this.meetingId = meetingId; this.opts = opts; this.lastHash = null; this.timer = null; this.count = 0;
    this.track = stream.getVideoTracks()[0];
    this.video = document.createElement('video'); this.video.muted = true; this.video.playsInline = true;
    this.video.srcObject = new MediaStream([this.track]);
    this.track.addEventListener('ended', () => { this.stop(); opts.onState?.('encerrada', 'O compartilhamento de tela foi encerrado; capturas interrompidas.'); });
  }
  async start() {
    await this.video.play().catch(() => {});
    if (this.opts.intervalSec > 0) this.timer = setInterval(() => this.capture(false), this.opts.intervalSec * 1000);
    this.opts.onState?.('ativa', `Capturando a cada ${this.opts.intervalSec} s (imagens repetidas são ignoradas).`);
  }
  stop() { clearInterval(this.timer); this.timer = null; }
  setInterval(sec) { this.opts.intervalSec = sec; this.stop(); if (sec > 0 && this.track.readyState === 'live') this.timer = setInterval(() => this.capture(false), sec * 1000); }

  async capture(manual, note = '') {
    if (this.track.readyState !== 'live' || !this.video.videoWidth) { if (manual) this.opts.onState?.('indisponível', 'Sem tela compartilhada ativa para capturar.'); return null; }
    const vw = this.video.videoWidth, vh = this.video.videoHeight;
    const scale = Math.min(1, 1600 / vw);
    const c = document.createElement('canvas'); c.width = Math.round(vw * scale); c.height = Math.round(vh * scale);
    c.getContext('2d').drawImage(this.video, 0, 0, c.width, c.height);
    const hash = signature(c);
    if (!manual && this.lastHash && changedCells(hash, this.lastHash) <= (this.opts.threshold ?? 12)) return null; // repetida
    this.lastHash = hash;
    const blob = await new Promise(r => c.toBlob(r, 'image/jpeg', 0.85));
    const shot = { id: 's' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5), meetingId: this.meetingId, t: this.opts.clock(), blob, w: c.width, h: c.height, manual, caption: note || (manual ? 'Ponto importante' : ''), createdAt: new Date().toISOString() };
    try { await db.guardedPut(this.meetingId, 'shots', shot); } catch (e) { if (e.name === 'MeetingGone') { this.stop(); return null; } throw e; }
    this.count++;
    this.opts.onShot?.(shot);
    return shot;
  }
}

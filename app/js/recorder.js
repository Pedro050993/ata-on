// Gravação: microfone + áudio da reunião (aba/tela compartilhada com áudio).
// - Cada fonte é gravada separadamente no formato original (Opus/WebM) e também
//   em uma mistura para reprodução e download.
// - Em paralelo, um AudioWorklet grava PCM 16 kHz (base da transcrição).
// - Tudo é salvo no IndexedDB a cada poucos segundos: se a aba fechar ou o
//   navegador travar, o que foi gravado até ali continua disponível.

import * as db from './db.js';
import { dbfs } from './core/audio-dsp.js';

export const PCM_CHUNK = 16000 * 10; // 10 s por registro

export function capabilities() {
  const md = navigator.mediaDevices;
  const ua = navigator.userAgent;
  const mobile = /Android|iPhone|iPad|iPod/i.test(ua) || (navigator.maxTouchPoints > 1 && /Macintosh/.test(ua));
  const isFirefox = /Firefox\//.test(ua);
  const isSafari = /Safari\//.test(ua) && !/Chrome|Chromium|Edg\//.test(ua);
  const isChromium = /Chrome|Chromium|Edg\//.test(ua);
  const isWindows = /Windows/.test(ua);
  const display = !!md?.getDisplayMedia && !mobile;
  let systemAudio, tabAudio;
  if (!display) { systemAudio = 'indisponível'; tabAudio = 'indisponível'; }
  else if (isChromium) { tabAudio = 'sim'; systemAudio = isWindows ? 'sim (tela inteira)' : 'limitado (macOS/Linux: use áudio da aba)'; }
  else if (isFirefox) { tabAudio = 'não'; systemAudio = 'não'; }
  else if (isSafari) { tabAudio = 'não'; systemAudio = 'não'; }
  else { tabAudio = 'incerto'; systemAudio = 'incerto'; }
  return {
    secure: window.isSecureContext, mic: !!md?.getUserMedia, display, mobile, isFirefox, isSafari, isChromium, isWindows,
    tabAudio, systemAudio, mediaRecorder: typeof MediaRecorder !== 'undefined',
    webgpu: !!navigator.gpu, worklet: typeof AudioWorkletNode !== 'undefined',
  };
}

export async function listMics() {
  const devs = await navigator.mediaDevices.enumerateDevices();
  return devs.filter(d => d.kind === 'audioinput');
}

function pickMime() {
  const c = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4;codecs=mp4a.40.2', 'audio/mp4', 'audio/ogg;codecs=opus'];
  return c.find(t => MediaRecorder.isTypeSupported?.(t)) || '';
}

export async function openMic(deviceId, opts = {}) {
  return navigator.mediaDevices.getUserMedia({
    audio: {
      deviceId: deviceId ? { exact: deviceId } : undefined,
      echoCancellation: opts.echoCancellation ?? true,
      noiseSuppression: opts.noiseSuppression ?? false,
      autoGainControl: opts.autoGainControl ?? true,
      channelCount: 1,
    },
  });
}

/** Pede a aba/janela/tela com áudio. Retorna {stream, hasAudio, surface}. */
export async function openDisplay() {
  const base = { video: { frameRate: 2 }, systemAudio: 'include', selfBrowserSurface: 'exclude', surfaceSwitching: 'include', preferCurrentTab: false };
  let stream, audioError = null;
  try {
    stream = await navigator.mediaDevices.getDisplayMedia({ ...base, audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, suppressLocalAudioPlayback: false } });
  } catch (e) {
    // o usuário cancelou ou negou: não insiste
    if (e.name === 'NotAllowedError' || e.name === 'AbortError') throw e;
    // falha ao abrir o ÁUDIO do compartilhamento: tenta só a imagem e avisa
    audioError = `${e.name}: ${e.message}`;
    stream = await navigator.mediaDevices.getDisplayMedia({ ...base, audio: false });
  }
  const v = stream.getVideoTracks()[0];
  return { stream, hasAudio: stream.getAudioTracks().length > 0, audioError, surface: v?.getSettings?.().displaySurface || 'desconhecida' };
}

/** Teste do microfone: grava alguns segundos e devolve um Blob para ouvir. */
export async function micTest(deviceId, seconds, onLevel, opts) {
  const stream = await openMic(deviceId, opts);
  const ctx = new AudioContext();
  const src = ctx.createMediaStreamSource(stream);
  const an = ctx.createAnalyser(); an.fftSize = 2048; src.connect(an);
  const buf = new Float32Array(an.fftSize);
  const rec = new MediaRecorder(stream, { mimeType: pickMime() });
  const chunks = []; rec.ondataavailable = e => e.data.size && chunks.push(e.data);
  let maxRms = 0, peak = 0, raf;
  const tick = () => {
    an.getFloatTimeDomainData(buf);
    let s = 0, p = 0; for (const v of buf) { s += v * v; p = Math.max(p, Math.abs(v)); }
    const rms = Math.sqrt(s / buf.length); maxRms = Math.max(maxRms, rms); peak = Math.max(peak, p);
    onLevel?.({ db: dbfs(rms), peakDb: dbfs(p) });
    raf = requestAnimationFrame(tick);
  };
  tick(); rec.start();
  await new Promise(r => setTimeout(r, seconds * 1000));
  rec.stop(); await new Promise(r => rec.onstop = r);
  cancelAnimationFrame(raf); stream.getTracks().forEach(t => t.stop()); ctx.close();
  return { blob: new Blob(chunks, { type: rec.mimeType }), maxDb: dbfs(maxRms), peakDb: dbfs(peak), label: stream.getAudioTracks()[0]?.label };
}

/**
 * Sessão de gravação.
 * events: onLevel({mic, sys, mix}), onWarning(kind,msg), onState(state), onTime(sec), onError(err)
 */
export class Recording {
  constructor(meeting, { micStream, displayStream, events = {} }) {
    this.meeting = meeting; this.micStream = micStream; this.displayStream = displayStream; this.ev = events;
    this.state = 'parado'; this.samples = 0; this.pcmBuf = []; this.pcmLen = 0; this.chunkSeq = 0;
    this.recorders = []; this.seq = {}; this.writes = Promise.resolve(); this.lowSince = null; this.energy = [];
    this.writeErrors = 0; this.sinceSave = 0;
  }
  get seconds() { return this.samples / 16000; }

  async start() {
    const mime = pickMime();
    this.ctx = new AudioContext({ latencyHint: 'playback' });
    await this.ctx.audioWorklet.addModule(new URL('./workers/pcm-tap.worklet.js', import.meta.url));
    const tap = new AudioWorkletNode(this.ctx, 'pcm-tap', { numberOfInputs: 3, numberOfOutputs: 1, channelCount: 1, channelCountMode: 'explicit', channelInterpretation: 'speakers' });
    // saída muda até o destino: garante que o worklet seja processado em todos os navegadores
    const mute = this.ctx.createGain(); mute.gain.value = 0; tap.connect(mute); mute.connect(this.ctx.destination);
    const mixGain = this.ctx.createGain();
    const dest = this.ctx.createMediaStreamDestination(); dest.channelCount = 1;
    mixGain.connect(dest); mixGain.connect(tap, 0, 0);
    const tracks = {};
    if (this.micStream) {
      const s = this.ctx.createMediaStreamSource(this.micStream);
      s.connect(mixGain); s.connect(tap, 0, 1);
      tracks.mic = { label: this.micStream.getAudioTracks()[0]?.label || 'Microfone', mime };
    }
    const sysAudio = this.displayStream?.getAudioTracks()[0];
    if (sysAudio) {
      const sysStream = new MediaStream([sysAudio]);
      const s = this.ctx.createMediaStreamSource(sysStream);
      s.connect(mixGain); s.connect(tap, 0, 2);
      tracks.sys = { label: sysAudio.label || 'Áudio da reunião', mime };
      this.sysStream = sysStream;
    }
    if (!tracks.mic && !tracks.sys) throw new Error('Nenhuma fonte de áudio disponível para gravar.');
    tracks.mix = { label: 'Mistura (reprodução)', mime };
    tap.port.onmessage = (e) => this.onPcm(e.data);
    this.tap = tap;

    const mk = (track, stream) => {
      const r = new MediaRecorder(stream, { mimeType: mime || undefined, audioBitsPerSecond: 48000 });
      this.seq[track] = 0;
      r.ondataavailable = (e) => {
        if (!e.data.size) return;
        const rec = { meetingId: this.meeting.id, track, seq: this.seq[track]++, data: e.data, type: r.mimeType };
        this.queue(() => db.guardedPut(this.meeting.id, 'blobs', rec));
      };
      r.onerror = (e) => this.ev.onError?.(e.error || new Error('Falha no MediaRecorder'));
      this.recorders.push(r);
      return r;
    };
    if (tracks.mic) mk('mic', this.micStream);
    if (tracks.sys) mk('sys', this.sysStream);
    mk('mix', dest.stream);
    for (const r of this.recorders) r.start(4000);
    // fim da reunião: se o usuário parar o compartilhamento, a gravação continua só com o microfone
    sysAudio?.addEventListener('ended', () => this.ev.onWarning?.('compartilhamento', 'O compartilhamento de áudio foi encerrado. A gravação continua apenas com o microfone.'));
    this.micStream?.getAudioTracks()[0]?.addEventListener('ended', () => this.ev.onWarning?.('microfone', 'O microfone foi desconectado.'));
    await db.updateMeeting(this.meeting.id, m => { m.tracks = tracks; m.status = 'gravando'; m.source = tracks.sys ? (tracks.mic ? 'mic+reunião' : 'reunião') : 'microfone'; });
    this.setState('gravando');
    this.wakeLock = await navigator.wakeLock?.request('screen').catch(() => null);
  }

  queue(fn) {
    this.writes = this.writes.then(fn).catch(err => {
      this.writeErrors++;
      if (err?.name === 'MeetingGone') return;
      if (err?.name === 'QuotaExceededError') this.ev.onError?.(new Error('Espaço de armazenamento esgotado no navegador. Exporte/exclua reuniões antigas.'));
      db.log({ meetingId: this.meeting.id, stage: 'gravação', kind: 'armazenamento', message: String(err?.message || err), stack: err?.stack });
    });
  }

  onPcm({ pcm, lv, paused }) {
    if (paused || !pcm) return;
    this.pcmBuf.push(pcm); this.pcmLen += pcm.length; this.samples += pcm.length;
    const L = { mix: lv[0], mic: lv[1], sys: lv[2] };
    // energia por fonte a cada ~100 ms (evidência de quem falou: microfone x reunião)
    this.energy.push([Math.round(dbfs(L.mic.rms)), Math.round(dbfs(L.sys.rms))]);
    this.ev.onLevel?.(Object.fromEntries(Object.entries(L).map(([k, v]) => [k, { db: dbfs(v.rms), peakDb: dbfs(v.peak), clip: v.clip, active: v.n > 0 }])));
    this.ev.onTime?.(this.seconds);
    // alertas
    const mixDb = dbfs(L.mix.rms);
    if (mixDb < -55) { this.lowSince ??= this.seconds; if (this.seconds - this.lowSince > 8) { this.ev.onWarning?.('sinal-baixo', 'Sinal muito baixo há mais de 8 s. Verifique se o microfone está mudo ou longe.'); this.lowSince = this.seconds; } }
    else this.lowSince = null;
    if (L.mix.clip > 3) this.ev.onWarning?.('saturacao', 'Saturação detectada (som estourado). Reduza o volume/ganho de entrada.');
    if (this.pcmLen >= PCM_CHUNK) this.flushPcm();
    else if (++this.sinceSave >= 30) this.savePartial(); // ~3 s: perda máxima em travamento
  }

  /** Grava o bloco ainda incompleto (é sobrescrito quando completar). */
  savePartial() {
    this.sinceSave = 0;
    if (!this.pcmLen) return;
    const part = new Int16Array(this.pcmLen); let o = 0;
    for (const b of this.pcmBuf) { part.set(b, o); o += b.length; }
    const seq = this.chunkSeq, samples = seq * PCM_CHUNK + part.length;
    const rec = { meetingId: this.meeting.id, seq, data: part.buffer, energy: this.energy.slice(0, Math.round(part.length / 1600)), partial: true };
    this.queue(async () => {
      await db.guardedPut(this.meeting.id, 'pcm', rec);
      await db.updateMeeting(this.meeting.id, m => { if ((m.pcm?.samples || 0) < samples) { m.pcm = { sampleRate: 16000, chunkSamples: PCM_CHUNK, samples, chunks: seq + 1 }; m.durationSec = samples / 16000; } });
    });
  }

  flushPcm(final = false) {
    if (!this.pcmLen) return;
    const total = this.pcmBuf.reduce((a, b) => a + b.length, 0);
    const all = new Int16Array(total); let o = 0;
    for (const b of this.pcmBuf) { all.set(b, o); o += b.length; }
    let off = 0;
    while (total - off >= PCM_CHUNK || (final && off < total)) {
      const part = all.slice(off, off + PCM_CHUNK); off += part.length;
      const seq = this.chunkSeq++;
      const energy = this.energy.splice(0, Math.round(part.length / 1600));
      const rec = { meetingId: this.meeting.id, seq, data: part.buffer, energy };
      const samples = seq * PCM_CHUNK + part.length;
      this.queue(async () => {
        await db.guardedPut(this.meeting.id, 'pcm', rec);
        await db.updateMeeting(this.meeting.id, m => { if ((m.pcm?.samples || 0) <= samples) { m.pcm = { sampleRate: 16000, chunkSamples: PCM_CHUNK, samples, chunks: seq + 1 }; m.durationSec = samples / 16000; } });
      });
    }
    const rest = all.slice(off);
    this.pcmBuf = rest.length ? [rest] : []; this.pcmLen = rest.length;
  }

  pause() {
    if (this.state !== 'gravando') return;
    this.tap.port.postMessage('pause'); this.recorders.forEach(r => r.state === 'recording' && r.pause());
    this.setState('pausado');
  }
  resume() {
    if (this.state !== 'pausado') return;
    this.tap.port.postMessage('resume'); this.recorders.forEach(r => r.state === 'paused' && r.resume());
    this.setState('gravando');
  }
  async stop() {
    if (this.state === 'parado') return;
    this.tap.port.postMessage('flush');
    await new Promise(r => setTimeout(r, 250));
    await Promise.all(this.recorders.map(r => new Promise(res => { if (r.state === 'inactive') return res(); r.addEventListener('stop', res, { once: true }); r.stop(); })));
    this.flushPcm(true);
    await this.writes;
    this.tap.disconnect(); await this.ctx.close().catch(() => {});
    this.micStream?.getTracks().forEach(t => t.stop());
    this.displayStream?.getTracks().forEach(t => t.stop());
    this.wakeLock?.release?.().catch(() => {});
    await db.updateMeeting(this.meeting.id, m => { m.status = 'gravada'; m.endedAt = new Date().toISOString(); m.writeErrors = this.writeErrors; }).catch(() => {});
    this.setState('parado');
  }
  setState(s) { this.state = s; this.ev.onState?.(s); }
}

/** Recupera gravações interrompidas (aba fechada/travada durante a gravação). */
export async function recoverInterrupted() {
  const ms = await db.getAll('meetings');
  const fixed = [];
  for (const m of ms.filter(m => m.status === 'gravando')) {
    await db.updateMeeting(m.id, x => { x.status = 'gravada'; x.recovered = true; });
    fixed.push(m);
  }
  return fixed;
}

/**
 * Importa um arquivo de áudio/vídeo: guarda o original e gera o PCM 16 kHz.
 * decodeAudioData já reamostra para a taxa do contexto (16 kHz).
 */
export async function importFile(file, onStage) {
  const m = await db.newMeeting({ title: file.name.replace(/\.[^.]+$/, ''), source: 'importado', status: 'importando', startedAt: new Date(file.lastModified || Date.now()).toISOString() });
  return importInto(m.id, file, onStage);
}

/** Converte um arquivo/Blob em PCM e anexa a uma reunião existente (importação ou áudio do bot). */
export async function importInto(meetingId, file, onStage) {
  const name = file.name || 'audio-bot.webm';
  try {
    await db.guardedPut(meetingId, 'blobs', { meetingId, track: 'original', seq: 0, data: file, type: file.type || 'application/octet-stream', name });
    onStage?.('Decodificando o áudio…');
    const buf = await file.arrayBuffer();
    const ctx = new OfflineAudioContext(1, 16000, 16000);
    let audio;
    try { audio = await ctx.decodeAudioData(buf); }
    catch (e) { const err = new Error(`Não foi possível decodificar o arquivo (${file.type || 'tipo desconhecido'}). Formatos aceitos dependem do navegador: WAV, MP3, M4A/AAC, OGG/Opus, WebM e vídeos MP4/WebM. Detalhe: ${e.message || e}`); err.kind = 'formato'; throw err; }
    onStage?.('Convertendo para 16 kHz mono…');
    const n = audio.length, chs = audio.numberOfChannels;
    const mono = new Float32Array(n);
    for (let c = 0; c < chs; c++) { const d = audio.getChannelData(c); for (let i = 0; i < n; i++) mono[i] += d[i] / chs; }
    let seq = 0;
    for (let off = 0; off < n; off += PCM_CHUNK) {
      const part = mono.subarray(off, off + PCM_CHUNK);
      const i16 = new Int16Array(part.length);
      for (let i = 0; i < part.length; i++) { const v = Math.max(-1, Math.min(1, part[i])); i16[i] = v < 0 ? v * 32768 : v * 32767; }
      await db.guardedPut(meetingId, 'pcm', { meetingId, seq: seq++, data: i16.buffer, energy: null });
      if (seq % 30 === 0) onStage?.(`Convertendo… ${Math.round(100 * off / n)}%`);
    }
    return await db.updateMeeting(meetingId, x => { x.pcm = { sampleRate: 16000, chunkSamples: PCM_CHUNK, samples: n, chunks: seq }; x.durationSec = n / 16000; x.status = 'gravada'; x.tracks = { original: { label: name, mime: file.type, name } }; });
  } catch (e) {
    if (/memory|allocation/i.test(e.message)) e.kind = 'memória';
    await db.updateMeeting(meetingId, x => { x.status = 'erro'; x.error = { stage: 'importação', message: e.message, kind: e.kind || 'importação' }; }).catch(() => {});
    throw e;
  }
}

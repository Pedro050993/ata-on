// Orquestrador da transcrição.
//  - Planeja trechos cortados nas pausas (sem perder nem repetir frases).
//  - Salva cada trecho concluído (checkpoint) → pode cancelar, fechar e retomar.
//  - Cada execução tem um jobId; respostas de execuções antigas são ignoradas.
//  - Falha do motor: o worker é DESCARTADO e outro é criado do zero; se a GPU
//    falhar, a retomada é feita em CPU (WASM).

import * as db from './db.js';
import { frameEnergies, detectSpeech, planSegments, prepareForAsr, signalReport, FRAME, SR } from './core/audio-dsp.js';
import { isLikelyHallucination, trimRepetitions, compressionRatio, applyCorrections } from './core/text.js';

export const ASR_MODELS = {
  rapido: {
    label: 'Rápido (Whisper Base)', id: 'onnx-community/whisper-base',
    dtype: { wasm: { encoder_model: 'fp32', decoder_model_merged: 'q8' }, webgpu: { encoder_model: 'fp32', decoder_model_merged: 'q4' } },
    sizeMB: { wasm: 135, webgpu: 205 }, ramMB: 600,
    note: 'Baixa ~135 MB. Mais rápido, porém erra mais nomes, termos técnicos e números. Bom para teste ou máquinas fracas/celular.',
  },
  equilibrado: {
    label: 'Equilibrado (Whisper Small)', id: 'onnx-community/whisper-small',
    dtype: { wasm: { encoder_model: 'fp32', decoder_model_merged: 'q8' }, webgpu: { encoder_model: 'fp32', decoder_model_merged: 'q4' } },
    sizeMB: { wasm: 510, webgpu: 585 }, ramMB: 1500,
    note: 'Baixa ~510 MB. Boa qualidade em português na maioria das reuniões. Recomendado para CPU.',
  },
  preciso: {
    label: 'Preciso (Whisper Large v3 Turbo)', id: 'onnx-community/whisper-large-v3-turbo',
    dtype: { wasm: { encoder_model: 'q8', decoder_model_merged: 'q8' }, webgpu: { encoder_model: 'fp16', decoder_model_merged: 'q4' } },
    sizeMB: { wasm: 1085, webgpu: 1610 }, ramMB: 3500,
    note: 'Baixa 1,1–1,6 GB. Melhor reconhecimento de nomes e termos. Em CPU é lento (pode levar mais que a duração da reunião); ideal com GPU (WebGPU).',
  },
};

export async function webgpuUsable() {
  try {
    if (!navigator.gpu) return { ok: false, reason: 'Navegador sem WebGPU.' };
    const a = await navigator.gpu.requestAdapter();
    if (!a) return { ok: false, reason: 'WebGPU presente, mas nenhum adaptador de GPU disponível.' };
    const d = await a.requestDevice();
    d.destroy?.();
    return { ok: true, info: a.info ? `${a.info.vendor || ''} ${a.info.architecture || ''}`.trim() : '' };
  } catch (e) { return { ok: false, reason: String(e.message || e) }; }
}

/** Monta o plano de trechos a partir do PCM salvo. */
export async function buildPlan(meeting) {
  const chunkSamples = meeting.pcm.chunkSamples, total = meeting.pcm.samples;
  if (!total) throw Object.assign(new Error('Não há áudio gravado nesta reunião.'), { kind: 'sem-sinal' });
  // energia em blocos de 10 min para não carregar a reunião inteira na memória
  const energies = []; const block = 600;
  for (let t = 0; t < total / SR; t += block) {
    const pcm = await db.readPcm(meeting.id, t, Math.min(total / SR, t + block), chunkSamples);
    const e = frameEnergies(pcm);
    for (const v of e) energies.push(v);
  }
  const en = Float32Array.from(energies);
  const sp = detectSpeech(en);
  const plan = planSegments(en, sp);
  const speechSec = sp.flags.reduce((a, b) => a + b, 0) * FRAME / SR;
  return { plan, speechSec, noiseFloorDb: sp.noiseFloor, threshold: sp.threshold, speechRatio: sp.speechRatio };
}

export class Transcriber {
  constructor(events = {}) { this.ev = events; this.worker = null; this.jobId = null; this.cancelled = false; }

  newWorker() {
    this.worker?.terminate();
    this.worker = new Worker(new URL('./workers/asr.worker.js', import.meta.url), { type: 'module' });
    this.worker.onerror = (e) => { this.pending?.reject(Object.assign(new Error(e.message || 'Erro no worker de transcrição'), { kind: 'motor' })); };
    this.worker.onmessage = (e) => this.onMsg(e.data);
  }
  onMsg(d) {
    if (d.type === 'download') return this.ev.onDownload?.(d);
    if (d.jobId && d.jobId !== this.jobId) return; // resposta atrasada de execução cancelada
    if (d.type === 'loaded' || d.type === 'result') this.pending?.resolve(d);
    if (d.type === 'error') this.pending?.reject(Object.assign(new Error(d.message), { kind: d.kind, phase: d.phase, stackText: d.stack }));
  }
  call(msg, transfer) {
    return new Promise((resolve, reject) => {
      this.pending = { resolve, reject };
      this.worker.postMessage(msg, transfer || []);
    });
  }

  async loadEngine(modelKey, device) {
    const m = ASR_MODELS[modelKey];
    this.newWorker();
    this.ev.onStage?.('modelo', `Carregando ${m.label} em ${device === 'webgpu' ? 'GPU (WebGPU)' : 'CPU (WASM)'}…`);
    const t0 = performance.now();
    await this.call({ type: 'load', jobId: this.jobId, model: m.id, device, dtype: m.dtype[device] });
    this.engine = { model: m.id, modelKey, device };
    this.ev.onEngine?.(this.engine, performance.now() - t0);
  }

  cancel() {
    this.cancelled = true;
    this.jobId = null; // qualquer resposta posterior será descartada
    this.worker?.terminate(); this.worker = null;
    this.pending?.reject(Object.assign(new Error('Cancelado pelo usuário.'), { kind: 'cancelado' }));
  }

  /**
   * Executa (ou retoma) a transcrição.
   * opts: { modelKey, device: 'auto'|'webgpu'|'wasm', corrections, retranscribe }
   */
  async run(meetingId, opts) {
    this.cancelled = false;
    const jobId = this.jobId = 'j' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    let meeting = await db.get('meetings', meetingId);
    if (!meeting) throw new db.MeetingGone(meetingId);
    const t0 = performance.now();

    // 1) preparação do áudio
    this.ev.onStage?.('preparo', 'Analisando o áudio e planejando os trechos…');
    let tr = meeting.transcription || {};
    if (!tr.plan || opts.retranscribe) {
      const p = await buildPlan(meeting);
      if (this.jobId !== jobId) return;
      meeting = await db.updateMeeting(meetingId, m => {
        m.transcription = { status: 'em andamento', plan: p.plan, speechSec: p.speechSec, noiseFloorDb: p.noiseFloorDb, startedAt: new Date().toISOString(), modelKey: opts.modelKey };
      });
      if (opts.retranscribe) for (const s of await db.byMeeting('segments', meetingId)) await db.del('segments', [meetingId, s.i]);
      tr = meeting.transcription;
    }
    const plan = tr.plan;
    await db.updateMeeting(meetingId, m => { m.transcription.status = 'em andamento'; delete m.transcription.error; m.transcription.resumedAt = new Date().toISOString(); });
    const speaking = plan.filter(s => !s.silent);
    if (!speaking.length) {
      await db.updateMeeting(meetingId, m => { m.transcription.status = 'sem fala'; m.transcription.error = { kind: 'sem-sinal', message: 'Nenhum trecho com fala foi detectado no áudio. Nenhuma ata será gerada.' }; });
      throw Object.assign(new Error('Áudio sem sinal de fala detectável (silêncio, microfone mudo ou fonte errada). A gravação original foi preservada.'), { kind: 'sem-sinal' });
    }
    const doneSet = new Set((await db.byMeeting('segments', meetingId)).filter(s => s.done).map(s => s.i));
    this.ev.onPlan?.({ plan, done: doneSet });

    // 2) motor
    let device = opts.device;
    if (device === 'auto') device = (await webgpuUsable()).ok ? 'webgpu' : 'wasm';
    const tryLoad = async () => {
      try { await this.loadEngine(opts.modelKey, device); }
      catch (e) {
        if (this.cancelled || this.jobId !== jobId) throw e;
        await db.log({ meetingId, stage: 'carregar modelo', model: ASR_MODELS[opts.modelKey].id, engine: device, kind: e.kind, message: e.message, stack: e.stackText });
        if (device === 'webgpu' && e.kind !== 'download') {
          this.ev.onNotice?.(`Falha ao iniciar na GPU (${e.message}). Reiniciando em uma instância nova na CPU (WASM)…`);
          device = 'wasm';
          await this.loadEngine(opts.modelKey, device);
        } else throw e;
      }
    };
    await tryLoad();

    // 3) transcrição trecho a trecho
    let procAudio = 0, procMs = 0, emptyCount = 0;
    const totalSpeech = speaking.reduce((a, s) => a + (s.end - s.start), 0);
    let doneSpeech = speaking.filter(s => doneSet.has(s.i)).reduce((a, s) => a + (s.end - s.start), 0);
    this.ev.onStage?.('transcricao', 'Transcrevendo…');
    for (const seg of plan) {
      if (this.cancelled || this.jobId !== jobId) return;
      if (doneSet.has(seg.i)) continue;
      if (seg.silent) {
        await db.guardedPut(meetingId, 'segments', { meetingId, i: seg.i, id: `T${seg.i + 1}`, start: seg.start, end: seg.end, text: '', rawText: '', silent: true, done: true, jobId });
        continue;
      }
      const pcm = await db.readPcm(meetingId, seg.start, seg.end, meeting.pcm.chunkSamples);
      const prep = prepareForAsr(pcm);
      let res, attempts = 0;
      while (true) {
        try {
          const audio = prep.samples;
          // gancho de TESTE (só via console/testes automatizados): simula falha do motor neste trecho, uma vez
          const debugFail = opts.debugFailAt?.includes(seg.i) && !(this.failedOnce ||= new Set()).has(seg.i) ? (this.failedOnce.add(seg.i), opts.debugFailKind || 'gpu') : null;
          res = await this.call({ type: 'transcribe', jobId, i: seg.i, audio, debugFail }, [audio.buffer]);
          break;
        } catch (e) {
          if (this.cancelled || this.jobId !== jobId) return;
          await db.log({ meetingId, stage: 'transcrição', segment: seg.i, model: this.engine?.model, engine: this.engine?.device, kind: e.kind, message: e.message, stack: e.stackText });
          attempts++;
          if (attempts > 2) throw e;
          // motor comprometido: descarta e recria; GPU → CPU
          if (this.engine?.device === 'webgpu') { device = 'wasm'; this.ev.onNotice?.(`A GPU falhou no trecho ${seg.i + 1} (${e.message}). Recriando o motor na CPU e retomando deste trecho.`); }
          else this.ev.onNotice?.(`Falha do motor no trecho ${seg.i + 1} (${e.message}). Recriando uma instância limpa…`);
          await this.loadEngine(opts.modelKey, device);
          prep.samples = prepareForAsr(pcm).samples; // o buffer anterior foi transferido
        }
      }
      if (this.jobId !== jobId) return;
      // 4) limpeza e checkpoint
      let raw = (res.text || '').trim();
      const flags = [];
      if (isLikelyHallucination(raw, prep.metrics.speechRatio)) { if (raw) flags.push(`descartado: "${raw.slice(0, 60)}" (frase típica de alucinação)`); raw = ''; }
      const rep = trimRepetitions(raw);
      if (rep.trimmed) flags.push('repetição em laço removida');
      raw = rep.text;
      if (compressionRatio(raw) > 3.2) flags.push('texto muito repetitivo — revisar');
      const corr = applyCorrections(raw, opts.corrections);
      if (!raw) emptyCount++;
      const chunks = (res.chunks || []).map(c => ({ start: seg.start + (c.timestamp?.[0] ?? 0), end: seg.start + (c.timestamp?.[1] ?? (seg.end - seg.start)), text: (c.text || '').trim() })).filter(c => c.text);
      await db.guardedPut(meetingId, 'segments', {
        meetingId, i: seg.i, id: `T${seg.i + 1}`, start: seg.start, end: seg.end, rawText: raw, text: corr.text, correctionsUsed: corr.used,
        chunks, metrics: prep.metrics, flags, done: true, jobId, engine: this.engine,
      });
      procAudio += seg.end - seg.start; procMs += res.ms; doneSpeech += seg.end - seg.start;
      const rtf = procMs / 1000 / procAudio;
      this.ev.onSegment?.({
        i: seg.i, text: corr.text, flags,
        progress: doneSpeech / totalSpeech,
        rtf, etaSec: procAudio > 20 ? (totalSpeech - doneSpeech) * rtf : null,
        elapsedSec: (performance.now() - t0) / 1000,
      });
      await db.updateMeeting(meetingId, m => { m.transcription.lastSegment = seg.i; m.transcription.rtf = rtf; m.transcription.engine = this.engine; });
    }
    // 5) conclusão
    const segs = await db.byMeeting('segments', meetingId);
    const withText = segs.filter(s => (s.text || '').trim()).length;
    const status = withText ? 'concluída' : 'sem texto';
    await db.updateMeeting(meetingId, m => {
      m.transcription.status = status; m.transcription.finishedAt = new Date().toISOString();
      m.transcription.emptySegments = emptyCount;
      if (!withText) m.transcription.error = { kind: 'sem-texto', message: 'O modelo não reconheceu texto em nenhum trecho com fala. Verifique o sinal (Diagnóstico) ou tente o modelo "Preciso".' };
    });
    this.worker?.terminate(); this.worker = null;
    if (!withText) throw Object.assign(new Error('Reconhecimento sem texto: o modelo processou o áudio mas não retornou nenhuma frase.'), { kind: 'sem-texto' });
    return { status, segments: segs.length };
  }
}

/** Relatório de sinal da reunião inteira (para o diagnóstico). */
export async function meetingSignal(meeting) {
  const pcm = await db.readPcm(meeting.id, 0, Math.min(meeting.pcm.samples / SR, 1800), meeting.pcm.chunkSamples);
  return signalReport(pcm);
}

/**
 * Atribuição de locutor com evidência: só quando houve gravação separada de
 * microfone e áudio da reunião, comparando a energia das duas fontes no trecho.
 */
export async function channelEvidence(meeting, seg) {
  if (!meeting.tracks?.mic || !meeting.tracks?.sys) return null;
  const cs = meeting.pcm.chunkSamples, per = cs / 1600; // blocos de 100 ms por registro
  const a = Math.floor(seg.start * 10), b = Math.ceil(seg.end * 10);
  let mic = 0, sys = 0, n = 0;
  for (let c = Math.floor(a / per); c <= Math.floor((b - 1) / per); c++) {
    const rec = await db.get('pcm', [meeting.id, c]);
    const en = rec?.energy; if (!en) continue;
    for (let k = 0; k < en.length; k++) {
      const idx = c * per + k; if (idx < a || idx >= b) continue;
      mic += Math.pow(10, en[k][0] / 10); sys += Math.pow(10, en[k][1] / 10); n++;
    }
  }
  if (!n) return null;
  const d = 10 * Math.log10((mic + 1e-12) / (sys + 1e-12));
  if (d > 8) return { source: 'mic', diffDb: d };
  if (d < -8) return { source: 'sys', diffDb: d };
  return { source: 'misto', diffDb: d };
}

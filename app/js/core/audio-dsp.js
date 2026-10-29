// Processamento de áudio puro (sem DOM): análise de energia, detecção de fala,
// planejamento de trechos e preparação do sinal para o Whisper.
// Funciona no navegador e no Node (usado pelos testes).

export const SR = 16000;
export const FRAME = 480; // 30 ms a 16 kHz

export function dbfs(rms) {
  return rms > 0 ? 20 * Math.log10(rms) : -120;
}

/** Energia RMS (dBFS) por quadro de 30 ms. */
export function frameEnergies(samples, frame = FRAME) {
  const n = Math.floor(samples.length / frame);
  const out = new Float32Array(n);
  for (let f = 0; f < n; f++) {
    let s = 0;
    const o = f * frame;
    for (let i = 0; i < frame; i++) { const v = samples[o + i]; s += v * v; }
    out[f] = dbfs(Math.sqrt(s / frame));
  }
  return out;
}

function percentile(arr, p) {
  if (!arr.length) return -120;
  const a = Array.from(arr).sort((x, y) => x - y);
  return a[Math.min(a.length - 1, Math.max(0, Math.floor(p * (a.length - 1))))];
}

/**
 * Classifica quadros como fala/silêncio.
 * Limiar adaptativo: piso de ruído (percentil 10) + margem, nunca abaixo de um
 * mínimo absoluto. Isso impede que o reforço de volume transforme silêncio em "fala".
 */
export function detectSpeech(energies, opts = {}) {
  // Limiar mínimo relativo ao nível da própria gravação: fala gravada baixa
  // continua sendo fala; ruído constante (sem picos) continua sendo silêncio.
  const loud = percentile(energies, 0.95);
  const absMin = opts.absMinDb ?? Math.max(-75, Math.min(-55, loud - 30));
  const margin = opts.marginDb ?? 9;
  const floor = percentile(energies, 0.1);
  const thr = Math.max(absMin, floor + margin);
  const raw = new Uint8Array(energies.length);
  for (let i = 0; i < energies.length; i++) raw[i] = energies[i] >= thr ? 1 : 0;
  // suavização: preenche buracos curtos (< 300 ms) e remove estalos isolados (< 90 ms)
  const hang = opts.hangFrames ?? 10, minRun = opts.minRunFrames ?? 3;
  const sm = raw.slice();
  let last = -1e9;
  for (let i = 0; i < sm.length; i++) {
    if (raw[i]) { if (i - last <= hang) for (let j = last + 1; j < i; j++) sm[j] = 1; last = i; }
  }
  let i = 0;
  while (i < sm.length) {
    if (!sm[i]) { i++; continue; }
    let j = i; while (j < sm.length && sm[j]) j++;
    if (j - i < minRun) for (let k = i; k < j; k++) sm[k] = 0;
    i = j;
  }
  let speechFrames = 0; for (const v of sm) speechFrames += v;
  return { flags: sm, threshold: thr, noiseFloor: floor, speechRatio: sm.length ? speechFrames / sm.length : 0 };
}

/**
 * Divide o áudio em trechos de até maxSec, cortando nas pausas (nunca no meio
 * de uma palavra quando há pausa disponível). Trechos sem fala são marcados como
 * silenciosos e não vão para o modelo (evita frases inventadas em silêncio).
 */
export function planSegments(energies, speech, opts = {}) {
  const fps = SR / FRAME; // ~33,3 quadros/s
  const maxF = Math.floor((opts.maxSec ?? 28) * fps);
  const minF = Math.floor((opts.minSec ?? 8) * fps);
  const flags = speech.flags;
  const total = flags.length;
  const segs = [];
  let start = 0;
  while (start < total) {
    // pula silêncio inicial longo e registra-o como trecho silencioso
    let s = start;
    while (s < total && !flags[s]) s++;
    if (s - start >= fps * 2 || s >= total) {
      segs.push({ startF: start, endF: s, silent: true });
      start = s;
      if (s >= total) break;
    }
    const limit = Math.min(total, start + maxF);
    if (limit >= total) { segs.push({ startF: start, endF: total }); break; }
    // procura a pausa mais longa entre minF e maxF; empate → a mais tardia
    let bestCut = -1, bestLen = 0, runStart = -1;
    for (let f = start + minF; f < limit; f++) {
      if (!flags[f]) { if (runStart < 0) runStart = f; const len = f - runStart + 1; if (len >= bestLen) { bestLen = len; bestCut = runStart + Math.floor(len / 2); } }
      else runStart = -1;
    }
    let cut;
    if (bestCut > 0 && bestLen >= 3) cut = bestCut;
    else {
      // fala contínua: corta no quadro de menor energia nos últimos 6 s
      cut = limit - 1; let minE = Infinity;
      for (let f = Math.max(start + minF, limit - Math.floor(6 * fps)); f < limit; f++) if (energies[f] < minE) { minE = energies[f]; cut = f; }
    }
    segs.push({ startF: start, endF: cut });
    start = cut;
  }
  return segs.filter(s => s.endF > s.startF).map((s, i) => {
    let sp = 0; for (let f = s.startF; f < s.endF; f++) sp += flags[f];
    const silent = s.silent || sp < 5; // < 150 ms de fala → silêncio
    return { i, start: s.startF * FRAME / SR, end: s.endF * FRAME / SR, silent, speechRatio: sp / (s.endF - s.startF) };
  });
}

/** Filtro passa-altas de 1ª ordem (~80 Hz) para remover ronco e componente DC. */
export function highPass(samples, cutoff = 80) {
  const out = new Float32Array(samples.length);
  const rc = 1 / (2 * Math.PI * cutoff), dt = 1 / SR, a = rc / (rc + dt);
  let prevX = 0, prevY = 0;
  for (let i = 0; i < samples.length; i++) { const x = samples[i]; const y = a * (prevY + x - prevX); out[i] = y; prevX = x; prevY = y; }
  return out;
}

/**
 * Prepara um trecho para o modelo SEM alterar o original:
 *  - passa-altas;
 *  - ganho calculado só sobre os quadros de fala (alvo -20 dBFS, máx. +30 dB);
 *  - expansor: quadros fora da fala são atenuados em vez de amplificados;
 *  - limitador suave para não gerar saturação.
 * Retorna também métricas para o diagnóstico.
 */
export function prepareForAsr(samples, opts = {}) {
  const target = opts.targetDb ?? -20, maxGain = opts.maxGainDb ?? 30;
  let clipped = 0;
  for (let i = 0; i < samples.length; i++) if (Math.abs(samples[i]) >= 0.985) clipped++;
  const x = highPass(samples);
  const en = frameEnergies(x);
  const sp = detectSpeech(en, opts);
  let sum = 0, n = 0;
  for (let f = 0; f < en.length; f++) if (sp.flags[f]) { sum += Math.pow(10, en[f] / 10); n++; }
  const speechDb = n ? 10 * Math.log10(sum / n) : -120;
  let gainDb = n ? Math.min(maxGain, Math.max(-12, target - speechDb)) : 0;
  const g = Math.pow(10, gainDb / 20);
  const out = new Float32Array(x.length);
  // ganho por quadro com rampa (evita cliques): fala → g ; silêncio → min(g, 1) * 0.3
  const gq = new Float32Array(en.length + 1);
  const ns = opts.nonSpeechGain ?? 0.5;
  for (let f = 0; f < en.length; f++) gq[f] = sp.flags[f] ? g : Math.min(g, 1) * ns;
  gq[en.length] = gq[en.length - 1] ?? 1;
  let cur = gq[0] ?? 1;
  for (let i = 0; i < x.length; i++) {
    const f = Math.min(en.length, Math.floor(i / FRAME));
    cur += (gq[f] - cur) * 0.002;
    let v = x[i] * cur;
    // limitador suave (tanh acima de 0,9)
    const av = Math.abs(v);
    if (av > 0.9) v = Math.sign(v) * (0.9 + 0.1 * Math.tanh((av - 0.9) / 0.1));
    out[i] = v;
  }
  return {
    samples: out,
    metrics: {
      speechDb: Math.round(speechDb * 10) / 10,
      noiseFloorDb: Math.round(sp.noiseFloor * 10) / 10,
      gainDb: Math.round(gainDb * 10) / 10,
      speechRatio: Math.round(sp.speechRatio * 1000) / 1000,
      clippedRatio: samples.length ? clipped / samples.length : 0,
    },
  };
}

/** Diagnóstico global do sinal de uma gravação. */
export function signalReport(samples) {
  const en = frameEnergies(samples);
  const sp = detectSpeech(en);
  let peak = 0, clipped = 0;
  for (let i = 0; i < samples.length; i++) { const a = Math.abs(samples[i]); if (a > peak) peak = a; if (a >= 0.985) clipped++; }
  let sum = 0, n = 0;
  for (let f = 0; f < en.length; f++) if (sp.flags[f]) { sum += Math.pow(10, en[f] / 10); n++; }
  const speechDb = n ? 10 * Math.log10(sum / n) : -120;
  const issues = [];
  if (sp.speechRatio < 0.02) issues.push({ kind: 'sem-sinal', msg: 'Praticamente não há fala detectável na gravação (silêncio ou microfone mudo).' });
  else if (speechDb < -42) issues.push({ kind: 'sinal-baixo', msg: `Sinal de fala muito baixo (${speechDb.toFixed(1)} dBFS). A transcrição pode falhar; aproxime o microfone ou aumente o ganho de entrada.` });
  if (clipped / Math.max(1, samples.length) > 0.001) issues.push({ kind: 'saturacao', msg: `Saturação em ${(100 * clipped / samples.length).toFixed(2)}% das amostras. Reduza o ganho de entrada.` });
  return { durationSec: samples.length / SR, peakDb: dbfs(peak), speechDb, noiseFloorDb: sp.noiseFloor, speechRatio: sp.speechRatio, clippedRatio: clipped / Math.max(1, samples.length), issues };
}

/** Converte Int16 → Float32. */
export function int16ToFloat(i16) {
  const f = new Float32Array(i16.length);
  for (let i = 0; i < i16.length; i++) f[i] = i16[i] / 32768;
  return f;
}

export function floatToInt16(f32) {
  const o = new Int16Array(f32.length);
  for (let i = 0; i < f32.length; i++) { const v = Math.max(-1, Math.min(1, f32[i])); o[i] = v < 0 ? v * 32768 : v * 32767; }
  return o;
}

/** Reamostragem com filtro passa-baixas (sinc janelado) para 16 kHz. */
export function resampleTo16k(input, fromRate) {
  if (fromRate === SR) return Float32Array.from(input);
  const ratio = fromRate / SR;
  const outLen = Math.floor(input.length / ratio);
  const out = new Float32Array(outLen);
  const cutoff = 0.5 / ratio * 0.92, half = 16;
  for (let i = 0; i < outLen; i++) {
    const c = i * ratio, ci = Math.floor(c);
    let acc = 0, wsum = 0;
    for (let k = -half; k <= half; k++) {
      const j = ci + k; if (j < 0 || j >= input.length) continue;
      const t = j - c;
      const sinc = t === 0 ? 2 * cutoff : Math.sin(2 * Math.PI * cutoff * t) / (Math.PI * t);
      const w = 0.5 + 0.5 * Math.cos(Math.PI * t / (half + 1));
      acc += input[j] * sinc * w; wsum += sinc * w;
    }
    out[i] = wsum ? acc / wsum : 0;
  }
  return out;
}

/** WAV PCM 16 bits mono (para reprodução sincronizada e download do áudio preparado). */
export function wavHeader(numSamples, sampleRate = SR) {
  const b = new ArrayBuffer(44), v = new DataView(b);
  const w = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  w(0, 'RIFF'); v.setUint32(4, 36 + numSamples * 2, true); w(8, 'WAVE'); w(12, 'fmt ');
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, sampleRate, true); v.setUint32(28, sampleRate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  w(36, 'data'); v.setUint32(40, numSamples * 2, true);
  return b;
}

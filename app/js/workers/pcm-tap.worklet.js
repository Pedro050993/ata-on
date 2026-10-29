// AudioWorklet: recebe [mistura, microfone, sistema], converte a mistura para
// 16 kHz mono (com filtro anti-aliasing) e envia blocos de ~100 ms com os níveis
// de cada fonte (para medidor, alerta de sinal baixo/saturação e para
// identificar se a fala veio do microfone ou do áudio da reunião).

class PcmTap extends AudioWorkletProcessor {
  constructor() {
    super();
    this.ratio = sampleRate / 16000;
    this.pos = 0;             // posição fracionária na entrada
    this.hist = new Float32Array(64);
    this.histLen = 0;
    this.buf = new Int16Array(1600);
    this.n = 0;
    this.paused = false;
    this.lv = [this.zero(), this.zero(), this.zero()];
    // FIR passa-baixas (sinc janelado) para ~7,2 kHz na taxa de entrada
    const taps = 31, fc = 7200 / sampleRate;
    this.fir = new Float32Array(taps);
    let s = 0;
    for (let i = 0; i < taps; i++) {
      const t = i - (taps - 1) / 2;
      const sinc = t === 0 ? 2 * fc : Math.sin(2 * Math.PI * fc * t) / (Math.PI * t);
      const w = 0.54 - 0.46 * Math.cos(2 * Math.PI * i / (taps - 1));
      this.fir[i] = sinc * w; s += this.fir[i];
    }
    for (let i = 0; i < taps; i++) this.fir[i] /= s;
    this.ring = new Float32Array(taps);
    this.ri = 0;
    this.filtered = [];
    this.port.onmessage = (e) => {
      if (e.data === 'pause') this.paused = true;
      else if (e.data === 'resume') this.paused = false;
      else if (e.data === 'flush') this.flush(true);
    };
  }
  zero() { return { sum: 0, n: 0, peak: 0, clip: 0 }; }
  level(i, ch) {
    if (!ch) return;
    const l = this.lv[i];
    for (let k = 0; k < ch.length; k++) { const a = Math.abs(ch[k]); l.sum += ch[k] * ch[k]; if (a > l.peak) l.peak = a; if (a >= 0.985) l.clip++; }
    l.n += ch.length;
  }
  flush(force) {
    if (this.n === 0 && !force) return;
    const out = this.buf.slice(0, this.n);
    const lv = this.lv.map(l => ({ rms: l.n ? Math.sqrt(l.sum / l.n) : 0, peak: l.peak, clip: l.clip, n: l.n }));
    this.port.postMessage({ pcm: out, lv }, [out.buffer]);
    this.buf = new Int16Array(1600); this.n = 0;
    this.lv = [this.zero(), this.zero(), this.zero()];
  }
  process(inputs) {
    const mix = inputs[0]?.[0];
    this.level(0, mix); this.level(1, inputs[1]?.[0]); this.level(2, inputs[2]?.[0]);
    if (!mix) return true;
    if (this.paused) { if (this.lv[0].n > sampleRate / 10) { this.lv = [this.zero(), this.zero(), this.zero()]; this.port.postMessage({ pcm: null, lv: null, paused: true }); } return true; }
    // filtra e reamostra (interpolação linear sobre o sinal filtrado)
    for (let k = 0; k < mix.length; k++) {
      this.ring[this.ri] = mix[k];
      let acc = 0; const L = this.fir.length;
      for (let j = 0; j < L; j++) acc += this.fir[j] * this.ring[(this.ri - j + L) % L];
      this.ri = (this.ri + 1) % L;
      this.filtered.push(acc);
    }
    while (this.pos + 1 < this.filtered.length) {
      const i = Math.floor(this.pos), fr = this.pos - i;
      const v = this.filtered[i] * (1 - fr) + this.filtered[i + 1] * fr;
      const c = Math.max(-1, Math.min(1, v));
      this.buf[this.n++] = c < 0 ? c * 32768 : c * 32767;
      if (this.n === this.buf.length) this.flush();
      this.pos += this.ratio;
    }
    const drop = Math.floor(this.pos);
    this.filtered = this.filtered.slice(drop);
    this.pos -= drop;
    return true;
  }
}
registerProcessor('pcm-tap', PcmTap);

// Script injetado na página da reunião ANTES de qualquer código da plataforma.
// Intercepta as conexões WebRTC para receber as trilhas de áudio dos
// participantes, mistura tudo e grava com MediaRecorder. Os pedaços gravados
// vão para o Node via window.__pedroChunk (exposeBinding).
(() => {
  if (window.__pedroInjected) return;
  window.__pedroInjected = true;
  const Orig = window.RTCPeerConnection;
  if (!Orig) return;
  const seen = new Set();
  let ctx = null, dest = null, rec = null;
  const ensure = () => { if (!ctx) { ctx = new AudioContext(); dest = ctx.createMediaStreamDestination(); } };
  const keep = []; // mantém elementos/nós vivos
  function addTrack(track) {
    if (!track || track.kind !== 'audio' || seen.has(track.id)) return;
    seen.add(track.id);
    ensure();
    const ms = new MediaStream([track]);
    // o Chrome só entrega áudio remoto ao WebAudio se a trilha também estiver num elemento de mídia
    const a = new Audio(); a.muted = true; a.srcObject = ms; a.play().catch(() => {});
    const src = ctx.createMediaStreamSource(ms); src.connect(dest);
    keep.push(a, src);
    window.__pedroAudioTracks = seen.size;
  }
  function Patched(...args) {
    const pc = new Orig(...args);
    pc.addEventListener('track', (e) => addTrack(e.track));
    return pc;
  }
  Patched.prototype = Orig.prototype;
  Object.setPrototypeOf(Patched, Orig);
  window.RTCPeerConnection = Patched;
  window.webkitRTCPeerConnection = Patched;

  window.__pedroStart = async () => {
    ensure();
    await ctx.resume();
    if (rec) return 'já gravando';
    const mime = MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus' : 'audio/webm';
    rec = new MediaRecorder(dest.stream, { mimeType: mime, audioBitsPerSecond: 48000 });
    rec.ondataavailable = (e) => {
      if (!e.data.size) return;
      const fr = new FileReader();
      fr.onload = () => window.__pedroChunk(String(fr.result).split(',')[1]);
      fr.readAsDataURL(e.data);
    };
    rec.start(5000);
    return 'gravando';
  };
  window.__pedroStop = () => new Promise((res) => { if (!rec || rec.state === 'inactive') return res('parado'); rec.onstop = () => setTimeout(() => res('parado'), 300); rec.stop(); });
  // nível do áudio recebido (para confirmar que há som chegando)
  window.__pedroLevel = () => {
    if (!ctx) return -120;
    if (!window.__pedroAn) { window.__pedroAn = ctx.createAnalyser(); const s = ctx.createMediaStreamSource(dest.stream); s.connect(window.__pedroAn); }
    const b = new Float32Array(2048); window.__pedroAn.getFloatTimeDomainData(b);
    let s = 0; for (const v of b) s += v * v; const r = Math.sqrt(s / b.length);
    return r > 0 ? 20 * Math.log10(r) : -120;
  };
})();

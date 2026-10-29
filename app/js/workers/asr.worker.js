// Worker de transcrição (Whisper via Transformers.js / ONNX Runtime Web).
// Uma instância = um motor. Em caso de falha, o orquestrador DESCARTA o worker
// (terminate) e cria outro limpo; este código nunca tenta "se recuperar" sozinho.

import { pipeline, env } from 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.3.2/dist/transformers.min.js';

env.allowLocalModels = false;
env.useBrowserCache = true;
// Transformers.js e os arquivos WASM do ONNX Runtime vêm do jsDelivr em versão FIXA
// e ficam no cache do service worker (funciona offline depois do 1º uso).

let asr = null, cfg = null;

function classify(err) {
  const m = String(err?.message || err);
  if (/fetch|network|Failed to fetch|NetworkError|404|403|ERR_|load.*model|Could not locate file/i.test(m)) return 'download';
  if (/memory|OOM|alloc|RangeError|Array buffer allocation|bad_alloc|out of bounds/i.test(m)) return 'memória';
  if (/webgpu|GPU|adapter|device lost|dawn/i.test(m)) return 'gpu';
  return 'motor';
}

async function load({ model, device, dtype }) {
  cfg = { model, device, dtype };
  const files = {};
  asr = await pipeline('automatic-speech-recognition', model, {
    device,
    dtype,
    progress_callback: (p) => {
      if (p.status === 'progress' || p.status === 'initiate' || p.status === 'done') {
        if (p.file) files[p.file] = { loaded: p.loaded ?? files[p.file]?.loaded ?? 0, total: p.total ?? files[p.file]?.total ?? 0, done: p.status === 'done' };
        const vals = Object.values(files);
        const loaded = vals.reduce((a, f) => a + (f.loaded || 0), 0), total = vals.reduce((a, f) => a + (f.total || 0), 0);
        postMessage({ type: 'download', file: p.file, loaded, total, files: vals.length });
      }
    },
  });
  // aquecimento: 1 s de silêncio confirma que o motor executa de fato
  await asr(new Float32Array(16000), { language: 'portuguese', task: 'transcribe' });
}

self.onmessage = async (e) => {
  const msg = e.data;
  try {
    if (msg.type === 'load') {
      const t0 = performance.now();
      await load(msg);
      postMessage({ type: 'loaded', ms: performance.now() - t0, device: msg.device, model: msg.model });
    } else if (msg.type === 'transcribe') {
      if (!asr) throw new Error('Motor não carregado.');
      if (msg.debugFail === 'gpu') throw new Error('WebGPU device lost (falha simulada pelo teste)');
      if (msg.debugFail === 'memória') throw new RangeError('Array buffer allocation failed (falha simulada pelo teste)');
      const t0 = performance.now();
      const out = await asr(msg.audio, {
        language: 'portuguese', task: 'transcribe', return_timestamps: true,
        // decodificação gulosa evita frases inventadas; limite protege contra laços
        num_beams: 1, max_new_tokens: 220,
      });
      postMessage({ type: 'result', jobId: msg.jobId, i: msg.i, text: out.text || '', chunks: out.chunks || [], ms: performance.now() - t0 });
    }
  } catch (err) {
    postMessage({ type: 'error', jobId: msg.jobId, i: msg.i, phase: msg.type, kind: classify(err), message: String(err?.message || err), stack: err?.stack, cfg });
  }
};

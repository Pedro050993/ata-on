// Worker de IA no navegador. Dois motores, ambos gratuitos e locais:
//  - "webllm": MLC WebLLM (exige WebGPU) — mais rápido, modelos até 8B.
//  - "transformers": Transformers.js (WebGPU ou CPU/WASM) — funciona sem GPU, mais lento.
// Um worker = um motor. Em caso de erro o orquestrador descarta o worker.

const WEBLLM_URL = 'https://cdn.jsdelivr.net/npm/@mlc-ai/web-llm@0.2.86/+esm';
let engine = null, kind = null, gen = null, abort = false;

function classify(err) {
  const m = String(err?.message || err);
  if (/fetch|network|Failed to fetch|NetworkError|404|403|Could not locate/i.test(m)) return 'download';
  if (/memory|OOM|alloc|RangeError|bad_alloc|exceed|maxBufferSize|maxStorageBufferBindingSize/i.test(m)) return 'memória';
  if (/webgpu|GPU|adapter|device lost|shader/i.test(m)) return 'gpu';
  return 'motor';
}

async function load({ engineKind, model, device, dtype }) {
  kind = engineKind;
  if (kind === 'webllm') {
    const webllm = await import(WEBLLM_URL);
    engine = await webllm.CreateMLCEngine(model, {
      initProgressCallback: (r) => postMessage({ type: 'download', text: r.text, progress: r.progress }),
    }, { context_window_size: 16384 });
  } else {
    const { pipeline, env } = await import('https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.3.2/dist/transformers.min.js');
    env.allowLocalModels = false;
    const files = {};
    gen = await pipeline('text-generation', model, {
      device, dtype,
      progress_callback: (p) => {
        if (p.file) files[p.file] = { loaded: p.loaded ?? files[p.file]?.loaded ?? 0, total: p.total ?? files[p.file]?.total ?? 0 };
        const v = Object.values(files);
        const loaded = v.reduce((a, f) => a + f.loaded, 0), total = v.reduce((a, f) => a + f.total, 0);
        postMessage({ type: 'download', progress: total ? loaded / total : 0, text: `${(loaded / 1e6).toFixed(0)} de ${(total / 1e6).toFixed(0)} MB` });
      },
    });
  }
}

async function chat({ messages, schema, maxTokens }) {
  abort = false;
  if (kind === 'webllm') {
    const req = { messages, temperature: 0.1, max_tokens: maxTokens, stream: true, stream_options: { include_usage: true } };
    if (schema) req.response_format = { type: 'json_object', schema: JSON.stringify(schema) };
    const it = await engine.chat.completions.create(req);
    let text = '', n = 0;
    for await (const ch of it) {
      if (abort) { engine.interruptGenerate(); break; }
      const d = ch.choices?.[0]?.delta?.content || '';
      text += d; n++;
      if (n % 8 === 0) postMessage({ type: 'token', chars: text.length });
    }
    return text;
  }
  const { TextStreamer } = await import('https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.3.2/dist/transformers.min.js');
  let chars = 0;
  const streamer = new TextStreamer(gen.tokenizer, { skip_prompt: true, callback_function: (t) => { chars += t.length; postMessage({ type: 'token', chars }); } });
  const out = await gen(messages, { max_new_tokens: maxTokens, do_sample: false, repetition_penalty: 1.05, streamer });
  return out[0].generated_text.at(-1).content;
}

self.onmessage = async (e) => {
  const m = e.data;
  try {
    if (m.type === 'load') { await load(m); postMessage({ type: 'loaded', reqId: m.reqId }); }
    else if (m.type === 'chat') { const text = await chat(m); postMessage({ type: 'result', reqId: m.reqId, text }); }
    else if (m.type === 'abort') abort = true;
  } catch (err) {
    postMessage({ type: 'error', reqId: m.reqId, kind: classify(err), message: String(err?.message || err), stack: err?.stack });
  }
};

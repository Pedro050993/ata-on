// Provedores de IA para a ata. Todos são opções gratuitas; nenhuma exige
// assinatura. A ata é SEMPRE produzida por um modelo de linguagem real —
// sem modelo configurado, o app informa e não gera nada.

export const PROVIDERS = {
  ollama: {
    label: 'Ollama (local no computador)',
    note: 'Gratuito e local. Instale o Ollama (ollama.com) e baixe um modelo, ex.: "ollama pull qwen3:8b" (~5,2 GB, 8–10 GB de RAM) ou "qwen3:4b" (~2,6 GB, 5–6 GB de RAM). Não precisa de internet depois do download.',
    models: ['qwen3:8b', 'qwen3:4b', 'qwen2.5:7b', 'gemma3:4b', 'llama3.1:8b'],
  },
  webllm: {
    label: 'Navegador com GPU (WebLLM)',
    note: 'Roda dentro do navegador usando a GPU (WebGPU). Baixa o modelo uma vez (2–5 GB) e funciona offline. Não funciona sem WebGPU.',
    models: ['Qwen3-4B-q4f16_1-MLC', 'Qwen3-8B-q4f16_1-MLC', 'Qwen2.5-7B-Instruct-q4f16_1-MLC', 'Qwen3-1.7B-q4f16_1-MLC'],
  },
  transformers: {
    label: 'Navegador (Transformers.js) — experimental',
    note: 'Roda no navegador e exige GPU (WebGPU) para modelos úteis (Qwen3-1.7B/4B). Sem GPU, os testes mostraram falta de memória do WebAssembly a partir de 1,7B; o Qwen3-0.6B coube, mas INVERTEU uma decisão da reunião e não é recomendado. Para PC sem GPU, use o Ollama.',
    models: ['onnx-community/Qwen3-4B-ONNX', 'onnx-community/Qwen3-1.7B-ONNX'],
  },
  openai: {
    label: 'Servidor compatível com OpenAI (opcional)',
    note: 'Opcional. Qualquer servidor local (LM Studio, llama.cpp, vLLM) ou serviço com chave própria. Serviços externos têm limites e termos próprios; o texto da reunião sai do computador.',
    models: [],
  },
};

const withNoThink = (model, messages) => {
  if (!/qwen3/i.test(model)) return messages;
  const m = messages.map(x => ({ ...x }));
  const last = m[m.length - 1]; last.content += ' /no_think';
  return m;
};

export class LlmError extends Error {
  constructor(message, kind, extra = {}) { super(message); this.kind = kind; Object.assign(this, extra); }
}

export class LLM {
  constructor(settings, events = {}) { this.s = settings; this.ev = events; this.worker = null; this.loadedKey = null; this.ctrl = null; }

  get provider() { return this.s.provider; }
  get model() { return this.s.model; }
  get contextTokens() {
    if (this.s.provider === 'ollama') return this.s.numCtx || 16384;
    if (this.s.provider === 'webllm') return 16384;
    if (this.s.provider === 'transformers') return 8192;
    return this.s.numCtx || 16384;
  }

  async check() {
    const p = this.s.provider;
    if (!p || !this.s.model) throw new LlmError('Nenhum modelo de IA configurado. Abra Configurações → IA da ata.', 'config');
    if (p === 'ollama') {
      let r;
      try { r = await fetch(this.ollamaUrl('/api/tags')); }
      catch (e) { throw new LlmError(`Não foi possível conectar ao Ollama em ${this.s.ollamaUrl}. Verifique se o Ollama está aberto. Se o app não estiver em localhost, configure OLLAMA_ORIGINS (ver Ajuda). Erro técnico: ${e.message}`, 'conexão'); }
      if (!r.ok) { const b = await r.json().catch(() => ({})); throw new LlmError(b.error || `Ollama respondeu HTTP ${r.status}. Ele está aberto?`, 'conexão'); }
      const tags = await r.json();
      const names = (tags.models || []).map(m => m.name);
      if (!names.some(n => n === this.s.model || n === this.s.model + ':latest')) throw new LlmError(`O modelo "${this.s.model}" não está instalado no Ollama. Instalados: ${names.join(', ') || 'nenhum'}. Rode: ollama pull ${this.s.model}`, 'config');
      return { models: names };
    }
    if (p === 'webllm' && !navigator.gpu) throw new LlmError('Este navegador/dispositivo não oferece WebGPU, necessário para o WebLLM. Use o Ollama no computador ou o motor "Navegador sem GPU".', 'gpu');
    return {};
  }

  ollamaUrl(path) {
    const base = (this.s.ollamaUrl || 'http://localhost:11434').replace(/\/$/, '');
    return base + path;
  }

  async ensureWorker(onStage) {
    const key = `${this.s.provider}|${this.s.model}|${this.s.device || ''}`;
    if (this.worker && this.loadedKey === key) return;
    this.dispose();
    this.worker = new Worker(new URL('./workers/llm.worker.js', import.meta.url), { type: 'module' });
    this.worker.onmessage = (e) => {
      const d = e.data;
      if (d.type === 'download') this.ev.onDownload?.(d);
      else if (d.type === 'token') this.ev.onToken?.(d.chars);
      else if (this.pending && d.reqId === this.pending.id) {
        if (d.type === 'error') this.pending.reject(new LlmError(d.message, d.kind, { stackText: d.stack }));
        else this.pending.resolve(d);
      }
    };
    this.worker.onerror = (e) => this.pending?.reject(new LlmError(e.message || 'Falha no worker de IA', 'motor'));
    onStage?.(`Carregando o modelo ${this.s.model}…`);
    const device = this.s.provider === 'transformers' ? (this.s.device !== 'wasm' && navigator.gpu ? 'webgpu' : 'wasm') : undefined;
    // WASM: arquivo do modelo precisa ter < 2 GB (limite de memória do WebAssembly)
    const dtype = this.s.provider === 'transformers' ? (this.s.dtype || 'q4f16') : undefined;
    await this.req({ type: 'load', engineKind: this.s.provider, model: this.s.model, device, dtype });
    this.loadedKey = key;
  }

  req(msg) {
    const id = Math.random().toString(36).slice(2);
    return new Promise((resolve, reject) => { this.pending = { id, resolve, reject }; this.worker.postMessage({ ...msg, reqId: id }); });
  }

  dispose() { this.worker?.terminate(); this.worker = null; this.loadedKey = null; }

  abort() {
    this.aborted = true;
    this.ctrl?.abort();
    if (this.worker) { this.dispose(); this.pending?.reject(new LlmError('Cancelado pelo usuário.', 'cancelado')); }
  }

  /** Conversa com o modelo. Retorna o texto bruto. */
  async chat(messages, { schema, maxTokens = 3000, onStage } = {}) {
    this.aborted = false;
    const p = this.s.provider;
    messages = withNoThink(this.s.model, messages);
    if (p === 'ollama') {
      this.ctrl = new AbortController();
      let r;
      try {
        r = await fetch(this.ollamaUrl('/api/chat'), {
          method: 'POST', signal: this.ctrl.signal, headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: this.s.model, messages, stream: true, think: false, format: schema || undefined, keep_alive: '10m', options: { temperature: 0.1, num_ctx: this.contextTokens, num_predict: maxTokens } }),
        });
      } catch (e) { if (this.aborted) throw new LlmError('Cancelado pelo usuário.', 'cancelado'); throw new LlmError(`Falha de conexão com o Ollama: ${e.message}`, 'conexão'); }
      if (!r.ok) { const t = await r.text().catch(() => ''); throw new LlmError(`Ollama HTTP ${r.status}: ${t.slice(0, 400)}`, /memory|ram/i.test(t) ? 'memória' : 'motor'); }
      const rd = r.body.getReader(); const dec = new TextDecoder(); let buf = '', text = '';
      while (true) {
        let chunk;
        try { chunk = await rd.read(); } catch (e) { if (this.aborted) throw new LlmError('Cancelado pelo usuário.', 'cancelado'); throw e; }
        if (chunk.done) break;
        buf += dec.decode(chunk.value, { stream: true });
        let nl;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
          if (!line.trim()) continue;
          const j = JSON.parse(line);
          if (j.error) throw new LlmError(`Ollama: ${j.error}`, /memory/i.test(j.error) ? 'memória' : 'motor');
          text += j.message?.content || '';
          this.ev.onToken?.(text.length);
        }
      }
      return text;
    }
    if (p === 'openai') {
      this.ctrl = new AbortController();
      const base = (this.s.openaiUrl || '').replace(/\/$/, '');
      if (!base) throw new LlmError('Informe a URL do servidor compatível com OpenAI.', 'config');
      const r = await fetch(base + '/chat/completions', {
        method: 'POST', signal: this.ctrl.signal,
        headers: { 'Content-Type': 'application/json', ...(this.s.openaiKey ? { Authorization: `Bearer ${this.s.openaiKey}` } : {}) },
        body: JSON.stringify({ model: this.s.model, messages, temperature: 0.1, max_tokens: maxTokens, ...(schema ? { response_format: { type: 'json_object' } } : {}) }),
      }).catch(e => { throw new LlmError(`Falha de conexão: ${e.message}`, 'conexão'); });
      if (!r.ok) throw new LlmError(`Servidor HTTP ${r.status}: ${(await r.text()).slice(0, 400)}`, r.status === 429 ? 'limite' : 'motor');
      const j = await r.json();
      return j.choices?.[0]?.message?.content || '';
    }
    await this.ensureWorker(onStage);
    onStage?.(`IA redigindo com ${this.s.model}…`);
    try {
      const d = await this.req({ type: 'chat', messages, schema, maxTokens });
      return d.text;
    } catch (e) {
      this.dispose(); // motor possivelmente comprometido: próxima chamada cria um novo
      throw e;
    }
  }
}

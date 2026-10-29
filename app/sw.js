// Service worker do Pedro Agent.
// - Cache dos arquivos do app (funciona offline).
// - Atualização: nova versão = novo cache de ARQUIVOS DO APP; os dados das
//   reuniões ficam no IndexedDB e os modelos no cache próprio do Transformers.js
//   / WebLLM — nada disso é apagado aqui.
// - Acrescenta COOP/COEP para habilitar WASM multithread (crossOriginIsolated)
//   mesmo em hospedagens que não permitem configurar cabeçalhos (ex.: GitHub Pages).

const VERSION = 'pedro-agent-app-v1.0.0';
const SHELL = [
  './', 'index.html', 'manifest.webmanifest', 'css/app.css',
  'js/app.js', 'js/db.js', 'js/recorder.js', 'js/transcriber.js', 'js/llm.js', 'js/ata.js', 'js/screens.js', 'js/export.js',
  'js/core/audio-dsp.js', 'js/core/text.js', 'js/core/minutes.js', 'js/core/formats.js',
  'js/ui/dom.js', 'js/ui/home.js', 'js/ui/record.js', 'js/ui/meetings.js', 'js/ui/meeting.js', 'js/ui/memory.js', 'js/ui/settings.js', 'js/ui/help.js',
  'js/workers/asr.worker.js', 'js/workers/llm.worker.js', 'js/workers/pcm-tap.worklet.js',
  'vendor/transformers.min.js', 'vendor/docx.iife.js', 'vendor/jspdf.umd.min.js', 'vendor/fflate.js',
  'icons/icon.svg', 'icons/icon-192.png', 'icons/icon-512.png',
];
// Arquivos de runtime vindos de CDN fixada em versão (ONNX Runtime, WebLLM)
const CDN_CACHE = 'pedro-agent-cdn-v1';
const CDN_HOSTS = ['cdn.jsdelivr.net'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k.startsWith('pedro-agent-app-') && k !== VERSION) await caches.delete(k);
    await self.clients.claim();
  })());
});

function isolate(resp) {
  if (!resp || resp.status === 0 || resp.type === 'opaque') return resp;
  const h = new Headers(resp.headers);
  h.set('Cross-Origin-Opener-Policy', 'same-origin');
  h.set('Cross-Origin-Embedder-Policy', 'credentialless');
  h.set('Cross-Origin-Resource-Policy', 'cross-origin');
  return new Response(resp.body, { status: resp.status, statusText: resp.statusText, headers: h });
}

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET') return;
  if (url.origin === location.origin) {
    if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/ollama/')) return; // servidor local: sempre rede
    // rede primeiro para pegar atualizações; cache como reserva (offline)
    e.respondWith((async () => {
      try {
        const r = await fetch(e.request);
        if (r.ok && SHELL.some(p => url.pathname.endsWith(p.replace('./', '/')) || url.pathname.endsWith('/'))) (await caches.open(VERSION)).put(e.request, r.clone());
        return isolate(r);
      } catch {
        const c = await caches.match(e.request, { ignoreSearch: true }) || (e.request.mode === 'navigate' ? await caches.match('index.html') : null);
        if (c) return isolate(c);
        throw new Error('offline');
      }
    })());
    return;
  }
  if (CDN_HOSTS.includes(url.hostname)) {
    e.respondWith((async () => {
      const c = await caches.open(CDN_CACHE);
      const hit = await c.match(e.request);
      if (hit) return hit;
      const r = await fetch(e.request);
      if (r.ok) c.put(e.request, r.clone());
      return r;
    })());
  }
});

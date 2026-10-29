#!/usr/bin/env node
// Servidor local do Pedro Agent.
//  - Serve o app (pasta ../app) em http://localhost:8787 com isolamento COOP/COEP.
//  - Encaminha /ollama/* para o Ollama local (evita configurar CORS).
//  - API do bot participante (/api/bot/*), se o Playwright estiver instalado.
// Sem dependências obrigatórias: sem Playwright, o app funciona e o bot fica indisponível.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BotSession } from './bot.js';
import { platformFor, meet } from './platforms.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const APP = path.resolve(here, '..', 'app');
const DATA = path.resolve(process.env.PEDRO_DATA || path.join(here, 'sessoes'));
const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || '127.0.0.1';
const OLLAMA = (process.env.OLLAMA_HOST || 'http://127.0.0.1:11434').replace(/\/$/, '');
const VERSION = '1.0.0';

let playwright = null, pwError = null;
try { playwright = (await import('playwright')).default ?? (await import('playwright')); } catch (e) { pwError = e.message; }

const sessions = new Map();
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml', '.png': 'image/png', '.wasm': 'application/wasm', '.ico': 'image/x-icon' };
const ISO = { 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'credentialless', 'Cross-Origin-Resource-Policy': 'same-origin' };

function json(res, code, obj) { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...ISO }); res.end(JSON.stringify(obj)); }
async function readBody(req) { let s = ''; for await (const c of req) { s += c; if (s.length > 1e5) throw new Error('corpo grande demais'); } return s ? JSON.parse(s) : {}; }

function serveStatic(req, res, urlPath) {
  let p = decodeURIComponent(urlPath.split('?')[0]);
  if (p === '/' || p === '') p = '/index.html';
  const file = path.resolve(APP, '.' + p);
  if (!file.startsWith(APP)) { res.writeHead(403); return res.end(); }
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) { res.writeHead(404, ISO); return res.end('não encontrado'); }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Content-Length': st.size, 'Cache-Control': 'no-cache', ...ISO });
    fs.createReadStream(file).pipe(res);
  });
}

function proxyOllama(req, res, urlPath) {
  const target = new URL(OLLAMA + urlPath.replace(/^\/ollama/, ''));
  const up = http.request(target, { method: req.method, headers: { 'content-type': req.headers['content-type'] || 'application/json' } }, (r) => {
    res.writeHead(r.statusCode, { 'Content-Type': r.headers['content-type'] || 'application/json', ...ISO }); r.pipe(res);
  });
  up.on('error', (e) => json(res, 502, { error: `Ollama inacessível em ${OLLAMA}: ${e.message}. O Ollama está aberto?` }));
  req.pipe(up);
  res.on('close', () => up.destroy());
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, `http://${req.headers.host}`);
  const p = u.pathname;
  try {
    if (p === '/api/health') return json(res, 200, { app: 'pedro-agent-local', version: VERSION, bot: !!playwright, botError: pwError, sessions: sessions.size });
    if (p.startsWith('/ollama/')) return proxyOllama(req, res, p);
    if (p === '/api/bot/join' && req.method === 'POST') {
      if (!playwright) return json(res, 503, { error: `Componente do bot não instalado (Playwright). Rode "Instalar bot.bat" ou "npm install && npx playwright install chromium" na pasta bot. Detalhe: ${pwError}` });
      const b = await readBody(req);
      const url = String(b.url || '').trim();
      let platform = platformFor(url);
      if (!platform && process.env.BOT_TEST_URL_PREFIX && url.startsWith(process.env.BOT_TEST_URL_PREFIX)) platform = meet; // somente testes automatizados
      if (!platform) return json(res, 400, { error: 'Link não reconhecido. Aceitos: meet.google.com, teams.microsoft.com, teams.live.com.' });
      const id = 'b' + Date.now().toString(36);
      const s = new BotSession({ id, url, name: (b.name || 'Pedro Agent').slice(0, 60), dir: path.join(DATA, id), platform, headless: process.env.BOT_HEADLESS === '1', playwright });
      sessions.set(id, s);
      s.run();
      return json(res, 200, { id, state: s.state });
    }
    const m = p.match(/^\/api\/bot\/sessions\/([\w-]+)(?:\/(audio|leave|screenshot))?$/);
    if (m) {
      const s = sessions.get(m[1]);
      if (!s) return json(res, 404, { error: 'Sessão do bot não encontrada (o servidor foi reiniciado?). Os arquivos ficam em ' + path.join(DATA, m[1]) });
      if (!m[2]) return json(res, 200, s.toJSON());
      if (m[2] === 'leave' && req.method === 'POST') { s.stop(); return json(res, 200, { ok: true }); }
      if (m[2] === 'audio') {
        if (!fs.existsSync(s.audioFile)) return json(res, 404, { error: 'Nenhum áudio gravado nesta sessão.' });
        res.writeHead(200, { 'Content-Type': 'audio/webm', 'Content-Disposition': `attachment; filename="pedro-agent-${s.id}.webm"`, ...ISO });
        return fs.createReadStream(s.audioFile).pipe(res);
      }
      if (m[2] === 'screenshot') {
        const shots = fs.readdirSync(s.dir).filter(f => f.endsWith('.png')).sort();
        if (!shots.length) return json(res, 404, { error: 'sem prints' });
        res.writeHead(200, { 'Content-Type': 'image/png', ...ISO });
        return fs.createReadStream(path.join(s.dir, shots.at(-1))).pipe(res);
      }
    }
    if (p.startsWith('/api/')) return json(res, 404, { error: 'rota desconhecida' });
    return serveStatic(req, res, p);
  } catch (e) { return json(res, 500, { error: e.message }); }
});

server.listen(PORT, HOST, () => {
  console.log(`Pedro Agent rodando em http://localhost:${PORT}`);
  console.log(playwright ? 'Bot participante: disponível.' : `Bot participante: indisponível (${pwError ? 'Playwright não instalado' : ''}).`);
  console.log(`Ollama esperado em ${OLLAMA} (acessado pelo app em /ollama).`);
  if (process.argv.includes('--abrir')) {
    const url = `http://localhost:${PORT}/`;
    const cmd = process.platform === 'win32' ? `start "" "${url}"` : process.platform === 'darwin' ? `open "${url}"` : `xdg-open "${url}"`;
    import('node:child_process').then(cp => cp.exec(cmd));
  }
});
server.on('error', (e) => { console.error(e.code === 'EADDRINUSE' ? `A porta ${PORT} já está em uso. O Pedro Agent já está aberto? Acesse http://localhost:${PORT}` : e.message); process.exit(1); });

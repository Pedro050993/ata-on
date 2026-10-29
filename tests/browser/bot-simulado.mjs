// TESTE SIMULADO DO BOT: usa uma página local que imita o Google Meet
// (tests/browser/fake-meet). Valida a máquina de estados, a captura do áudio
// recebido por WebRTC e a API do servidor local. NÃO comprova a entrada em
// uma reunião real do Meet/Teams.
// Uso: node tests/browser/bot-simulado.mjs <audio.wav>
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const audio = process.argv[2];
const DATA = process.env.PEDRO_DATA || fs.mkdtempSync('/tmp/pedro-bot-');
const FAKE = 8899, API = 8788;

const fake = http.createServer((req, res) => {
  const p = new URL(req.url, 'http://x').pathname;
  if (p === '/audio.wav') { res.writeHead(200, { 'Content-Type': 'audio/wav', 'Access-Control-Allow-Origin': '*' }); return fs.createReadStream(audio).pipe(res); }
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); fs.createReadStream(path.join(here, 'fake-meet', 'index.html')).pipe(res);
}).listen(FAKE);

const srv = spawn(process.execPath, [path.join(here, '..', '..', 'bot', 'server.js')], { env: { ...process.env, PORT: String(API), BOT_HEADLESS: '1', BOT_TEST_URL_PREFIX: `http://localhost:${FAKE}/`, PEDRO_DATA: DATA }, stdio: 'inherit' });
await new Promise(r => setTimeout(r, 1500));
const api = async (p, body) => { const r = await fetch(`http://localhost:${API}${p}`, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}); return { status: r.status, json: await r.json().catch(() => null) }; };
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function follow(id, until, max = 120000) {
  const t0 = Date.now(); let s, last;
  while (Date.now() - t0 < max) { s = (await api(`/api/bot/sessions/${id}`)).json; if (s.state !== last) { console.log(new Date().toISOString().slice(11, 19), id, '→', s.state); last = s.state; } if (until.includes(s.state)) return s; await sleep(1000); }
  return s;
}
const results = {};
try {
  const h = await api('/api/health'); results.health = h.json;
  // link inválido é recusado pelo servidor
  results.invalid = (await api('/api/bot/join', { url: 'https://exemplo.com/reuniao' })).status;

  // 1) admitido, grava e a reunião termina sozinha
  let r = await api('/api/bot/join', { url: `http://localhost:${FAKE}/?admit=4&end=45&audio=/audio.wav`, name: 'Pedro Agent' });
  let s = await follow(r.json.id, ['encerrado', 'recusado', 'erro'], 150000);
  results.admitted = { finalState: s.state, sequence: [...new Set(s.history.map(x => x.state))], audioBytes: s.audioBytes, tracks: s.tracks, participants: s.participants, error: s.error };
  const f = path.join(DATA, r.json.id, 'audio.webm');
  if (fs.existsSync(f)) results.admitted.ffprobeDur = Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', f]).toString().trim() || 0) || execFileSync('ffmpeg', ['-i', f, '-f', 'null', '-'], { stdio: ['ignore', 'pipe', 'pipe'] }).toString();
  if (fs.existsSync(f)) { fs.copyFileSync(f, path.join(DATA, 'audio_bot_admitido.webm')); }
  const dl = await fetch(`http://localhost:${API}/api/bot/sessions/${r.json.id}/audio`); results.admitted.download = { status: dl.status, bytes: (await dl.arrayBuffer()).byteLength };

  // 2) recusado pelo organizador
  r = await api('/api/bot/join', { url: `http://localhost:${FAKE}/?deny=4`, name: 'Pedro Agent' });
  s = await follow(r.json.id, ['encerrado', 'recusado', 'erro'], 60000);
  results.denied = { finalState: s.state, sequence: [...new Set(s.history.map(x => x.state))], audioBytes: s.audioBytes };

  // 3) usuário retira o bot no meio da reunião
  r = await api('/api/bot/join', { url: `http://localhost:${FAKE}/?admit=3&audio=/audio.wav`, name: 'Pedro Agent' });
  s = await follow(r.json.id, ['gravando'], 60000);
  await sleep(8000);
  await api(`/api/bot/sessions/${r.json.id}/leave`, {});
  s = await follow(r.json.id, ['encerrado', 'erro'], 60000);
  results.leave = { finalState: s.state, sequence: [...new Set(s.history.map(x => x.state))], audioBytes: s.audioBytes, lastDetail: s.history.at(-1)?.detail };
} catch (e) { results.error = e.stack; }
console.log(JSON.stringify(results, null, 1));
fs.writeFileSync(path.join(DATA, 'resultado.json'), JSON.stringify(results, null, 1));
console.log('arquivos em', DATA);
srv.kill(); fake.close(); fake.closeAllConnections?.();
process.exit(0);

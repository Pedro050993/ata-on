// TESTE NO NAVEGADOR: gravação "online" = microfone + áudio de OUTRA ABA
// (compartilhamento de aba com áudio) + capturas de tela.
// A aba "reunião" toca um áudio conhecido e exibe slides que mudam.
// Uso: node tests/browser/e2e-online.mjs <fala_microfone.wav> <fala_reuniao.wav>
import http from 'node:http';
import fs from 'node:fs';
import { launch, BASE, db, dlg, log } from './helpers.mjs';

const [micWav, meetWav] = process.argv.slice(2);
const PORT = 8898;
const page1 = `<!doctype html><title>Reuniao Falsa</title><body style="margin:0;font:40px sans-serif">
<div id=s style="height:100vh;display:flex;align-items:center;justify-content:center;background:#234;color:#fff">Slide 1 — Cronograma</div>
<script>const s=document.getElementById('s');let n=1;setInterval(()=>{n++;s.textContent='Slide '+n+' — '+['Cronograma','Orçamento','Riscos','Próximos passos'][n%4];s.style.background=['#234','#523','#352','#335'][n%4]},9000);
const a=new Audio('/meet.wav');a.loop=false;document.body.onclick=()=>a.play();window.play=()=>a.play();</script>`;
const srv = http.createServer((req, res) => {
  if (req.url === '/meet.wav') { res.writeHead(200, { 'Content-Type': 'audio/wav' }); return fs.createReadStream(meetWav).pipe(res); }
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(page1);
}).listen(PORT);

const REAL_TAB = process.env.REAL_TAB === '1';
const { browser, ctx, page, errors } = await launch({ audioFile: REAL_TAB ? undefined : micWav, fakeDevices: !REAL_TAB, extraArgs: [...(REAL_TAB ? ['--use-fake-ui-for-media-stream'] : []), '--auto-select-tab-capture-source-by-title=Reuniao Falsa'] });
const out = {};
try {
  const meet = await ctx.newPage();
  await meet.goto(`http://localhost:${PORT}/`);
  await meet.evaluate(() => window.play());
  await page.bringToFront();
  await page.goto(BASE);
  await page.waitForSelector('text=Nova reunião');
  await page.click('button.card:has-text("Online")');
  await page.fill('input[placeholder^="Ex.: Reunião"]', 'Teste online — aba com áudio');
  await page.fill('input[type=number]', '5');
  await page.click('button:has-text("Iniciar gravação")');
  const r = await Promise.race([page.waitForSelector('.clock', { timeout: 20000 }).then(() => 'gravando'), page.waitForSelector('#dlg[open]', { timeout: 20000 }).then(async () => 'dialogo: ' + await page.textContent('#dlg'))]);
  out.start = r;
  log('início:', r);
  if (r !== 'gravando') { await dlg(page, 'Continuar só com microfone'); await page.waitForSelector('.clock'); }
  await page.waitForTimeout(25000);
  out.meters = await page.$$eval('.meter', ms => ms.map(m => m.innerText.replace(/\s+/g, ' ')));
  await page.click('button:has-text("Marcar ponto importante")');
  await page.waitForTimeout(20000);
  await page.click('button:has-text("Encerrar")');
  await dlg(page, 'Encerrar');
  await dlg(page, 'Cancelar', 30000); // não transcrever agora
  await page.waitForSelector('.tabs');
  const id = page.url().split('/').pop();
  const m = await db(page, (d, id) => d.get('meetings', id), id);
  out.tracks = m.tracks; out.source = m.source; out.durationSec = m.durationSec; out.marks = m.marks;
  const shots = await db(page, async (d, id) => (await d.byMeeting('shots', id)).map(s => ({ t: Math.round(s.t), manual: s.manual, w: s.w, h: s.h, size: s.blob.size, caption: s.caption })), id);
  out.shots = shots;
  const blobs = await db(page, async (d, id) => { const r = {}; for (const b of await d.byMeeting('blobs', id)) r[b.track] = (r[b.track] || 0) + b.data.size; return r; }, id);
  out.blobBytes = blobs;
  // energia por trilha: o áudio da aba deve aparecer na trilha "sys"
  out.energySample = await db(page, async (d, id) => { const p = await d.get('pcm', [id, 1]); return p?.energy?.slice(0, 20); }, id);
  out.meetingId = id;
} catch (e) { out.error = e.message; await page.screenshot({ path: '/tmp/claude-0/-home-user/4e355cad-acb7-57db-865a-548d779f52b0/scratchpad/e2e-online-erro.png' }); }
out.browserErrors = errors;
console.log(JSON.stringify(out, null, 1));
await browser.close(); srv.close(); process.exit(0);

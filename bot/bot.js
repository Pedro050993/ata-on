// Sessão do bot: abre a reunião num Chromium controlado pelo Playwright,
// entra como convidado, acompanha o estado real (lido da tela) e grava o áudio
// recebido. Estados: iniciando → pre-entrada → aguardando → admitido →
// gravando → encerrado | recusado | erro.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { platformFor, meet, teams } from './platforms.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const INJECT = fs.readFileSync(path.join(here, 'inject.js'), 'utf8');

function silentWav(file, sec = 2) {
  const sr = 16000, n = sr * sec, b = Buffer.alloc(44 + n * 2);
  b.write('RIFF', 0); b.writeUInt32LE(36 + n * 2, 4); b.write('WAVEfmt ', 8); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
  b.writeUInt32LE(sr, 24); b.writeUInt32LE(sr * 2, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(n * 2, 40);
  fs.writeFileSync(file, b);
}

export class BotSession {
  constructor({ id, url, name, dir, platform, headless, maxMinutes = 240, lobbyMinutes = 15, playwright }) {
    Object.assign(this, { id, url, name, dir, headless, maxMinutes, lobbyMinutes, playwright });
    this.platform = platform || platformFor(url);
    this.state = 'iniciando'; this.history = []; this.participants = []; this.audioBytes = 0; this.error = null; this.stopRequested = false;
    fs.mkdirSync(dir, { recursive: true });
    this.audioFile = path.join(dir, 'audio.webm');
    this.set('iniciando', `${this.platform?.name || 'plataforma desconhecida'}`);
  }

  set(state, detail = '') {
    if (state === this.state && !detail) return;
    this.state = state;
    this.history.push({ at: new Date().toISOString(), state, detail });
    fs.writeFileSync(path.join(this.dir, 'status.json'), JSON.stringify(this.toJSON(), null, 2));
  }
  log(detail) { this.history.push({ at: new Date().toISOString(), state: this.state, detail }); }
  toJSON() {
    return { id: this.id, url: this.url, name: this.name, platform: this.platform?.name, state: this.state, history: this.history, participants: this.participants, audio: this.audioBytes > 0, audioBytes: this.audioBytes, error: this.error, tracks: this.tracks || 0, levelDb: this.levelDb };
  }
  async snap(tag) {
    try { await this.page?.screenshot({ path: path.join(this.dir, `tela_${Date.now()}_${tag}.png`) }); } catch { /* */ }
  }

  async run() {
    try {
      if (!this.platform) throw new Error('Link não reconhecido. Use um link do Google Meet (meet.google.com) ou do Microsoft Teams (teams.microsoft.com / teams.live.com).');
      const silence = path.join(this.dir, 'silencio.wav'); silentWav(silence);
      this.browser = await this.playwright.chromium.launch({
        headless: this.headless,
        args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-audio-capture=${silence}`, '--autoplay-policy=no-user-gesture-required', '--disable-blink-features=AutomationControlled', '--lang=pt-BR', '--window-size=1280,800'],
      });
      const ctx = await this.browser.newContext({ locale: 'pt-BR', viewport: { width: 1280, height: 800 }, permissions: ['microphone', 'camera'], userAgent: undefined });
      await ctx.exposeBinding('__pedroChunk', (_src, b64) => { const buf = Buffer.from(b64, 'base64'); fs.appendFileSync(this.audioFile, buf); this.audioBytes += buf.length; });
      await ctx.addInitScript(INJECT);
      this.page = await ctx.newPage();
      await this.page.goto(this.url, { waitUntil: 'domcontentloaded', timeout: 60000 });
      this.set('pre-entrada', 'página da reunião aberta');
      await this.page.waitForTimeout(2500);
      const asked = await this.platform.prejoin(this.page, this.name, (d) => this.log(d));
      await this.snap('pre-entrada');
      if (!asked) this.log('não foi possível confirmar o clique em participar; acompanhando a tela');
      await this.loop();
    } catch (e) {
      this.error = String(e?.message || e);
      await this.snap('erro');
      this.set('erro', this.error);
    } finally {
      await this.finish();
    }
  }

  async loop() {
    const t0 = Date.now(); let waitStart = null; let unknownSince = null; let lastSnap = '';
    while (!this.stopRequested) {
      await this.page.waitForTimeout(2000);
      let st = await this.platform.state(this.page);
      if (st !== lastSnap) { await this.snap(st); lastSnap = st; }
      if (st === 'recusado') { this.set('recusado', 'a reunião recusou a entrada (tela da plataforma)'); return; }
      if (st === 'encerrado') { this.set('encerrado', 'a reunião terminou ou o bot foi removido'); return; }
      if (st === 'aguardando' || st === 'pre-entrada') {
        if (this.state !== 'aguardando' && st === 'aguardando') this.set('aguardando', 'na sala de espera, aguardando o organizador admitir');
        waitStart ??= Date.now();
        if (Date.now() - waitStart > this.lobbyMinutes * 60000) { this.set('recusado', `ninguém admitiu o bot em ${this.lobbyMinutes} min`); return; }
      }
      if (st === 'admitido') {
        if (this.state !== 'admitido' && this.state !== 'gravando') {
          this.set('admitido', 'dentro da reunião');
          const r = await this.page.evaluate(() => window.__pedroStart?.()).catch(e => 'erro: ' + e.message);
          this.log(`gravador: ${r}`);
        }
        this.tracks = await this.page.evaluate(() => window.__pedroAudioTracks || 0).catch(() => 0);
        this.levelDb = await this.page.evaluate(() => window.__pedroLevel?.()).catch(() => null);
        if (this.state === 'admitido' && this.audioBytes > 0) this.set('gravando', `${this.tracks} trilha(s) de áudio recebidas`);
        const ps = await this.platform.participants(this.page);
        if (ps.length) this.participants = [...new Set([...this.participants, ...ps.filter(p => p !== this.name)])];
      }
      if (st === 'desconhecido') {
        unknownSince ??= Date.now();
        if (Date.now() - unknownSince > 60000 && !['admitido', 'gravando'].includes(this.state)) { this.log('tela não reconhecida há 1 min (veja os prints de diagnóstico)'); unknownSince = Date.now(); }
      } else unknownSince = null;
      if (Date.now() - t0 > this.maxMinutes * 60000) { this.log(`limite de ${this.maxMinutes} min atingido`); await this.platform.leave(this.page); this.set('encerrado', 'tempo máximo atingido'); return; }
    }
    await this.platform.leave(this.page);
    this.set('encerrado', 'retirado pelo usuário');
  }

  async finish() {
    try { await this.page?.evaluate(() => window.__pedroStop?.()); await this.page?.waitForTimeout(800); } catch { /* */ }
    try { await this.browser?.close(); } catch { /* */ }
    fs.writeFileSync(path.join(this.dir, 'status.json'), JSON.stringify(this.toJSON(), null, 2));
  }

  stop() { this.stopRequested = true; }
}

export { meet, teams };

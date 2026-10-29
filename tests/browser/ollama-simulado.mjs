// TESTE SIMULADO da integração com o Ollama: um servidor falso na porta 11434
// fala o protocolo HTTP do Ollama (/api/tags e /api/chat com streaming NDJSON)
// e devolve uma ata pronta. Valida o caminho app → servidor local (/ollama) →
// Ollama, o envio do esquema JSON ("format"), o streaming e as mensagens de erro.
// NÃO avalia a qualidade de um modelo real.
// Uso: node tests/browser/ollama-simulado.mjs <reuniao.wav>
import http from 'node:http';
import { launch, BASE, db, waitFor } from './helpers.mjs';

const wav = process.argv[2];
const seen = { tags: 0, chat: 0, format: null, model: null, think: null };
const ata = { titulo: 'Planejamento Torre B', proposito: 'Replanejar a concretagem', resumo: ['Concretagem atrasou'], assuntos: [{ titulo: 'Concretagem', pontos: ['Usina não entregou'], refs: ['T1'] }], decisoes: [{ texto: 'Nova concretagem na quinta-feira', status: 'acordado', refs: ['T1'] }], propostas: [], restricoes: [], riscos: [], tarefas: [{ descricao: 'Confirmar com a usina', responsavel: 'Fulano Inventado', prazo: 'dia 30', compromisso: 'assumido', refs: ['T1'] }] };
let mode = 'ok';
const mock = http.createServer(async (req, res) => {
  let body = ''; for await (const c of req) body += c;
  if (req.url === '/api/tags') { seen.tags++; res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ models: [{ name: 'qwen3:8b' }] })); }
  if (req.url === '/api/chat') {
    seen.chat++; const j = JSON.parse(body); seen.format = !!j.format?.properties?.tarefas; seen.model = j.model; seen.think = j.think;
    res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
    const txt = JSON.stringify(ata);
    for (let i = 0; i < txt.length; i += 40) { res.write(JSON.stringify({ message: { content: txt.slice(i, i + 40) }, done: false }) + '\n'); await new Promise(r => setTimeout(r, 5)); }
    return res.end(JSON.stringify({ done: true }) + '\n');
  }
  res.writeHead(404); res.end();
}).listen(11434, '127.0.0.1');

const { browser, page, errors } = await launch({});
const out = {};
try {
  await page.goto(BASE); await page.waitForSelector('text=Nova reunião');
  await page.evaluate(async () => { const app = await import('/js/app.js'); await app.saveSettings({ asrModel: 'rapido', asrDevice: 'wasm', llm: { provider: 'ollama', model: 'qwen3:8b', ollamaUrl: location.origin + '/ollama' } }); });
  await page.click('button.card:has-text("Importar arquivo")');
  await page.setInputFiles('input[type=file]', wav);
  await page.waitForSelector('.tabs', { timeout: 120000 });
  const id = page.url().split('/').pop();
  await page.click('button:has-text("Transcrever")');
  await waitFor(page, async () => (await db(page, (d, id) => d.get('meetings', id), id)).transcription?.status === 'concluída', { label: 'transcrição' });
  await page.click('button.tab:has-text("Ata")');
  await page.click('button:has-text("Gerar ata com IA")');
  const m = await waitFor(page, async () => { const m = await db(page, (d, id) => d.get('meetings', id), id); return m.minutes ? m : null; }, { timeout: 60000, label: 'ata' });
  out.ok = { titulo: m.minutes.titulo, tarefa: m.minutes.tarefas.map(t => `${t.responsavel} | ${t.prazo}`), avisos: m.minutes.warnings, por: m.minutes.generatedBy };
  out.pedidoAoOllama = { ...seen };
  // modelo não instalado
  const r1 = await page.evaluate(async () => { const { LLM } = await import('/js/llm.js'); try { await new LLM({ provider: 'ollama', model: 'llama9:70b', ollamaUrl: location.origin + '/ollama' }).check(); return 'sem erro'; } catch (e) { return `${e.kind}: ${e.message}`; } });
  out.modeloNaoInstalado = r1;
  // Ollama fechado
  mock.close(); mock.closeAllConnections?.();
  await new Promise(r => setTimeout(r, 300));
  const r2 = await page.evaluate(async () => { const { LLM } = await import('/js/llm.js'); try { await new LLM({ provider: 'ollama', model: 'qwen3:8b', ollamaUrl: location.origin + '/ollama' }).check(); return 'sem erro'; } catch (e) { return `${e.kind}: ${e.message}`; } });
  out.ollamaFechado = r2;
} catch (e) { out.error = e.message; }
out.errors = errors;
console.log(JSON.stringify(out, null, 1));
await browser.close(); process.exit(0);

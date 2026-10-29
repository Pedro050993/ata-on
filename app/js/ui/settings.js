import { h, toast, errorPanel, fmtBytes, confirmDlg } from './dom.js';
import { state, saveSettings, VERSION } from '../app.js';
import * as db from '../db.js';
import { ASR_MODELS, webgpuUsable } from '../transcriber.js';
import { PROVIDERS, LLM } from '../llm.js';
import { capabilities } from '../recorder.js';
import * as ex from '../export.js';

export async function render(view) {
  const s = state.settings;
  view.append(h('div', { class: 'topbar' }, h('h1', {}, 'Configurações')));

  // ---------- geral ----------
  const myName = h('input', { type: 'text', value: s.myName, placeholder: 'Seu nome (usado para a fala do seu microfone)' });
  const theme = h('select', {}, ...[['auto', 'Automático'], ['light', 'Claro'], ['dark', 'Escuro']].map(([v, l]) => h('option', { value: v, selected: s.theme === v }, l)));
  view.append(h('div', { class: 'card stack' }, h('h2', {}, 'Geral'), h('div', { class: 'grid g2' }, h('label', {}, h('span', { class: 'f' }, 'Meu nome'), myName), h('label', {}, h('span', { class: 'f' }, 'Tema'), theme)),
    h('button', { class: 'btn', onclick: async () => { await saveSettings({ myName: myName.value.trim(), theme: theme.value }); toast('Salvo.'); } }, 'Salvar')));

  // ---------- transcrição ----------
  const gpu = await webgpuUsable();
  const asrSel = h('select', {}, ...Object.entries(ASR_MODELS).map(([k, v]) => h('option', { value: k, selected: s.asrModel === k }, v.label)));
  const devSel = h('select', {}, h('option', { value: 'auto', selected: s.asrDevice === 'auto' }, 'Automático (GPU se disponível, senão CPU)'), h('option', { value: 'webgpu', selected: s.asrDevice === 'webgpu' }, 'GPU (WebGPU)'), h('option', { value: 'wasm', selected: s.asrDevice === 'wasm' }, 'CPU (WASM)'));
  const asrNote = h('div', { class: 'small muted' });
  const paintAsr = () => { const m = ASR_MODELS[asrSel.value]; asrNote.textContent = `${m.note} Memória estimada: ~${(m.ramMB / 1000).toFixed(1)} GB.`; };
  asrSel.onchange = paintAsr; paintAsr();
  view.append(h('div', { class: 'card stack' }, h('h2', {}, 'Transcrição (Whisper, local)'),
    h('div', { class: 'grid g2' }, h('label', {}, h('span', { class: 'f' }, 'Modelo — velocidade × precisão'), asrSel), h('label', {}, h('span', { class: 'f' }, 'Processador'), devSel)),
    asrNote,
    h('div', { class: `alert ${gpu.ok ? 'ok' : ''} small` }, gpu.ok ? `GPU disponível via WebGPU ${gpu.info ? `(${gpu.info})` : ''}. Se ela falhar durante o processamento, o app recria o motor na CPU automaticamente.` : `GPU indisponível: ${gpu.reason} A transcrição usará a CPU.`),
    h('div', { class: 'small muted' }, 'O modelo é baixado do Hugging Face uma única vez e fica guardado no navegador. Depois disso a transcrição funciona sem internet. Nenhum áudio é enviado para fora do dispositivo.'),
    h('button', { class: 'btn', onclick: async () => { await saveSettings({ asrModel: asrSel.value, asrDevice: devSel.value }); toast('Salvo.'); } }, 'Salvar')));

  // ---------- IA da ata ----------
  const prov = h('select', {}, ...Object.entries(PROVIDERS).map(([k, v]) => h('option', { value: k, selected: s.llm.provider === k }, v.label)));
  const model = h('input', { type: 'text', value: s.llm.model, list: 'llm-models' });
  const dl = h('datalist', { id: 'llm-models' });
  const ollamaUrl = h('input', { type: 'url', value: s.llm.ollamaUrl });
  const numCtx = h('input', { type: 'number', value: s.llm.numCtx, min: 2048, step: 1024 });
  const tfDev = h('select', {}, h('option', { value: 'wasm', selected: s.llm.device !== 'webgpu' }, 'CPU (WASM)'), h('option', { value: 'webgpu', selected: s.llm.device === 'webgpu' }, 'GPU (WebGPU)'));
  const oaUrl = h('input', { type: 'url', value: s.llm.openaiUrl, placeholder: 'http://localhost:1234/v1' });
  const oaKey = h('input', { type: 'password', value: s.llm.openaiKey, placeholder: 'chave (se o servidor exigir)' });
  const provNote = h('div', { class: 'small muted' });
  const extra = h('div', { class: 'stack' });
  const testOut = h('div');
  const paintProv = () => {
    const p = PROVIDERS[prov.value];
    provNote.textContent = p.note;
    dl.replaceChildren(...p.models.map(x => h('option', { value: x })));
    if (!p.models.includes(model.value) && p.models.length && prov.value !== s.llm.provider) model.value = p.models[0];
    extra.replaceChildren();
    if (prov.value === 'ollama') extra.append(h('div', { class: 'grid g2' }, h('label', {}, h('span', { class: 'f' }, 'Endereço do Ollama'), ollamaUrl), h('label', {}, h('span', { class: 'f' }, 'Contexto (tokens) — maior = reuniões longas em menos partes, mais RAM'), numCtx)));
    if (prov.value === 'transformers') extra.append(h('label', {}, h('span', { class: 'f' }, 'Processador'), tfDev));
    if (prov.value === 'openai') extra.append(h('div', { class: 'grid g2' }, h('label', {}, h('span', { class: 'f' }, 'URL base (…/v1)'), oaUrl), h('label', {}, h('span', { class: 'f' }, 'Chave (opcional)'), oaKey)),
      h('div', { class: 'alert small' }, 'Atenção: um serviço externo recebe o texto da reunião. Verifique os termos, limites gratuitos e a política de dados do serviço antes de usar com informações da empresa.'));
  };
  prov.onchange = paintProv; paintProv();
  const llmSettings = () => ({ provider: prov.value, model: model.value.trim(), ollamaUrl: ollamaUrl.value.trim(), numCtx: Number(numCtx.value) || 16384, device: tfDev.value, openaiUrl: oaUrl.value.trim(), openaiKey: oaKey.value });
  view.append(h('div', { class: 'card stack' }, h('h2', {}, 'IA da ata'),
    h('div', { class: 'grid g2' }, h('label', {}, h('span', { class: 'f' }, 'Motor'), prov), h('label', {}, h('span', { class: 'f' }, 'Modelo'), model, dl)),
    provNote, extra,
    h('div', { class: 'small muted' }, 'Testes feitos no desenvolvimento: modelos de ~4B parâmetros ou mais identificaram corretamente decisões e responsáveis; um modelo de 1,5B atribuiu tarefa à pessoa errada. Prefira qwen3:8b ou qwen3:4b. A ata sempre passa por conferência automática contra a transcrição.'),
    h('div', { class: 'row' }, h('button', { class: 'btn', onclick: async () => { await saveSettings({ llm: llmSettings() }); toast('Salvo.'); } }, 'Salvar'),
      h('button', { class: 'btn', onclick: async () => {
        testOut.replaceChildren(h('div', { class: 'small' }, 'Testando… (a primeira vez pode baixar o modelo)'));
        const llm = new LLM(llmSettings(), { onDownload: d => testOut.replaceChildren(h('div', { class: 'small' }, `Baixando modelo: ${d.text || ''} ${d.progress ? Math.round(d.progress * 100) + '%' : ''}`)) });
        const t0 = performance.now();
        try { await llm.check(); const r = await llm.chat([{ role: 'user', content: 'Responda apenas com a palavra: funcionando' }], { maxTokens: 20 }); testOut.replaceChildren(h('div', { class: 'alert ok small' }, `Resposta do modelo em ${((performance.now() - t0) / 1000).toFixed(1)} s: "${r.replace(/<think>[\s\S]*?<\/think>/g, '').trim().slice(0, 80)}"`)); }
        catch (e) { testOut.replaceChildren(errorPanel(e, { stage: 'teste da IA', model: model.value, engine: prov.value })); }
        finally { llm.dispose(); }
      } }, 'Testar conexão com a IA')), testOut));

  // ---------- capturas ----------
  const shotInt = h('input', { type: 'number', value: s.shotInterval, min: 0, max: 600 });
  const shotThr = h('input', { type: 'number', value: s.shotThreshold, min: 0, max: 500 });
  view.append(h('div', { class: 'card stack' }, h('h2', {}, 'Capturas de tela'), h('div', { class: 'grid g2' }, h('label', {}, h('span', { class: 'f' }, 'Intervalo padrão (s), 0 = só manual'), shotInt), h('label', {}, h('span', { class: 'f' }, 'Mudança mínima para nova captura (células de 2.304; maior ignora mais)'), shotThr)),
    h('button', { class: 'btn', onclick: async () => { await saveSettings({ shotInterval: Number(shotInt.value) || 0, shotThreshold: Number(shotThr.value) || 12 }); toast('Salvo.'); } }, 'Salvar')));

  // ---------- armazenamento e backup ----------
  const info = await db.storageInfo();
  const meetings = await db.getAll('meetings');
  const incAudio = h('input', { type: 'checkbox' });
  const stOut = h('div', { class: 'small' });
  const restoreIn = h('input', { type: 'file', accept: '.zip' });
  restoreIn.onchange = async () => {
    const f = restoreIn.files[0]; if (!f) return;
    try { const r = await ex.restore(f, t => stOut.textContent = t); stOut.replaceChildren(h('div', { class: 'alert ok' }, `Restauradas ${r.added} reunião(ões); ${r.skipped} já existiam e foram mantidas como estavam; ${r.corrections} regra(s) de correção. ${r.includesAudio ? '' : 'Este backup não continha áudio: as reuniões restauradas não podem ser retranscritas.'}`)); }
    catch (e) { stOut.replaceChildren(errorPanel(e, { stage: 'restauração' })); }
  };
  view.append(h('div', { class: 'card stack' }, h('h2', {}, 'Armazenamento, backup e restauração'),
    h('div', { class: 'small' }, `Uso: ${fmtBytes(info.usage)} de ${fmtBytes(info.quota)} disponíveis para o app · ${meetings.length} reunião(ões) · armazenamento ${info.persisted ? 'PERSISTENTE (o navegador não apaga sozinho)' : 'não persistente — o navegador pode liberar espaço se o disco encher; faça backups'}.`),
    h('div', { class: 'small muted' }, 'Os dados ficam no navegador deste dispositivo (IndexedDB). Atualizações do app não apagam nada. Limpar os dados do site no navegador ou desinstalar o app instalado APAGA as reuniões: faça backup antes.'),
    h('label', { class: 'check small' }, incAudio, 'Incluir o áudio no backup (arquivo bem maior; sem ele, a transcrição, a ata, as tarefas e as capturas são salvas, mas não é possível ouvir nem retranscrever)'),
    h('div', { class: 'row' }, h('button', { class: 'btn primary', onclick: async () => {
      try { const b = await ex.backup(meetings.map(m => m.id), incAudio.checked, t => stOut.textContent = t); ex.download(b, `pedro-agent-backup_${new Date().toISOString().slice(0, 10)}${incAudio.checked ? '_com-audio' : ''}.zip`); stOut.textContent = `Backup gerado (${fmtBytes(b.size)}).`; }
      catch (e) { stOut.replaceChildren(errorPanel(e, { stage: 'backup' })); }
    } }, 'Gerar backup (.zip)'), h('label', { class: 'btn' }, 'Restaurar backup…', h('span', { class: 'hidden' }, restoreIn))),
    stOut));

  // ---------- ambiente ----------
  const c = capabilities();
  const yes = v => (v === true ? 'sim' : v === false ? 'não' : v);
  view.append(h('div', { class: 'card stack' }, h('h2', {}, 'Este dispositivo'),
    h('table', { class: 't' }, ...[['Versão do app', VERSION], ['Contexto seguro (HTTPS/localhost)', yes(c.secure)], ['Microfone', yes(c.mic)], ['Captura de aba/tela', yes(c.display)], ['Áudio de aba', c.tabAudio], ['Áudio do sistema', c.systemAudio], ['WebGPU', yes(c.webgpu)], ['Isolamento (WASM multithread)', yes(self.crossOriginIsolated)], ['Servidor local / bot', state.local ? `ativo${state.local.bot ? ' · bot instalado' : ' · bot não instalado'}` : 'não'], ['Instalado como app', matchMedia('(display-mode: standalone)').matches ? 'sim' : 'não']].map(([k, v]) => h('tr', {}, h('th', {}, k), h('td', {}, String(v))))),
    h('details', {}, h('summary', { class: 'small' }, 'Remover modelos baixados (libera espaço; serão baixados de novo quando necessário)'), h('button', { class: 'btn sm danger', onclick: async () => { if (!await confirmDlg('Apagar os modelos de IA baixados? Suas reuniões NÃO são afetadas.', 'Apagar modelos', true)) return; for (const k of await caches.keys()) if (/transformers|webllm|mlc/i.test(k)) await caches.delete(k); toast('Modelos removidos do cache.'); } }, 'Apagar modelos do cache'))));
}

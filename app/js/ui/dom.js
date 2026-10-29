// Utilidades de interface.

export function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'class') el.className = v;
    else if (k === 'html') el.innerHTML = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k in el && typeof v !== 'string') el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of kids.flat(Infinity)) if (c != null && c !== false) el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  return el;
}

export const $ = (s, r = document) => r.querySelector(s);
export const $$ = (s, r = document) => [...r.querySelectorAll(s)];

export function toast(msg, ms = 4500) {
  const t = h('div', {}, msg);
  $('#toast').append(t);
  setTimeout(() => t.remove(), ms);
}

/** Caixa de diálogo simples. buttons: [{label, value, primary}] */
export function dialog(content, buttons = [{ label: 'Fechar', value: null }]) {
  const d = $('#dlg');
  d.replaceChildren(h('div', { class: 'stack' }, content, h('div', { class: 'row', style: { justifyContent: 'flex-end' } },
    buttons.map(b => h('button', { class: 'btn' + (b.primary ? ' primary' : '') + (b.danger ? ' danger' : ''), onclick: () => d.close(b.value ?? '') }, b.label)))));
  d.showModal();
  return new Promise(r => d.addEventListener('close', () => r(d.returnValue), { once: true }));
}

export async function confirmDlg(text, okLabel = 'Confirmar', danger = false) {
  const v = await dialog(h('p', {}, text), [{ label: 'Cancelar', value: '' }, { label: okLabel, value: 'ok', primary: !danger, danger }]);
  return v === 'ok';
}

/** Painel de erro técnico com botão copiar (requisito de diagnóstico). */
export function errorPanel(err, ctx = {}) {
  const KIND = {
    download: 'Falha no download do modelo', 'memória': 'Limite de memória', gpu: 'Falha da GPU (WebGPU)', motor: 'Falha do motor de processamento',
    'sem-sinal': 'Áudio sem sinal de fala', 'sem-texto': 'Reconhecimento sem texto', 'conexão': 'Sem conexão com o serviço de IA', config: 'Configuração incompleta',
    'resposta-invalida': 'Resposta inválida do modelo', cancelado: 'Cancelado', dispositivo: 'Dispositivo de áudio indisponível', parcial: 'Transcrição incompleta', limite: 'Limite do serviço externo', formato: 'Formato de arquivo', 'importação': 'Falha na importação',
  };
  const tech = [
    `Etapa: ${ctx.stage || '—'}`, `Tipo: ${err.kind || 'desconhecido'}`, ctx.model ? `Modelo: ${ctx.model}` : '', ctx.engine ? `Motor: ${ctx.engine}` : '',
    `Mensagem: ${err.message}`, err.stackText || err.stack ? `Pilha:\n${err.stackText || err.stack}` : '', `Navegador: ${navigator.userAgent}`, `Quando: ${new Date().toLocaleString('pt-BR')}`,
  ].filter(Boolean).join('\n');
  const RECOVER = {
    download: 'Confira a internet só para o primeiro download; o modelo fica em cache depois. Se o erro citar 404/403, o arquivo do modelo pode ter mudado de lugar: escolha outro modelo em Configurações.',
    'memória': 'Feche abas pesadas e tente o modelo menor (Rápido/Equilibrado) ou a CPU. A gravação e o que já foi transcrito estão preservados.',
    gpu: 'O processamento será refeito em uma instância nova na CPU. Se repetir, defina "CPU" em Configurações.',
    dispositivo: 'Feche programas que possam estar usando o microfone (Teams, Zoom, gravadores), confira o dispositivo nas configurações de som do Windows e tente de novo.',
    motor: 'Clique em "Retomar": o motor é recriado do zero e continua do último trecho salvo.',
    'sem-sinal': 'Ouça a gravação e veja o Diagnóstico de sinal. Se a fonte estava errada (ex.: microfone mudo), não há como recuperar a fala; o arquivo original continua disponível.',
    'sem-texto': 'Ouça a gravação. Se há fala audível, tente o modelo "Preciso" ou ajuste o volume e transcreva novamente.',
    'conexão': 'Abra o Ollama (ou o servidor configurado) e tente de novo. A transcrição não é afetada.',
    'resposta-invalida': 'Tente gerar de novo ou use um modelo maior (ex.: qwen3:8b). A transcrição não é afetada.',
  };
  return h('div', { class: 'alert bad stack' },
    h('strong', {}, KIND[err.kind] || 'Erro'),
    RECOVER[err.kind] ? h('div', { class: 'small' }, RECOVER[err.kind]) : null,
    h('details', { open: true }, h('summary', { class: 'small' }, 'Mensagem técnica original'), h('div', { class: 'errbox' }, tech)),
    h('div', { class: 'row' }, h('button', { class: 'btn sm', onclick: async (e) => { await navigator.clipboard.writeText(tech).catch(() => {}); e.target.textContent = 'Copiado'; } }, 'Copiar erro')));
}

export function fmtBytes(n) {
  if (n == null) return '—';
  const u = ['B', 'KB', 'MB', 'GB']; let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(i ? 1 : 0)} ${u[i]}`;
}

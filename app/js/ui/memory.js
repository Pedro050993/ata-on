import { h, toast, confirmDlg } from './dom.js';
import * as db from '../db.js';
import { ruleSafety, applyCorrections } from '../core/text.js';

export async function render(view) {
  view.append(h('div', { class: 'topbar' }, h('h1', {}, 'Memória de correções')),
    h('div', { class: 'alert info small' }, 'Lista de substituições aprendidas a partir das suas correções confirmadas (nomes, empresas, siglas, termos técnicos). Ela é aplicada às novas transcrições e informada à IA como grafia correta. Não é treinamento do modelo: pode ser consultada, editada, desativada e apagada a qualquer momento. Regras com números, valores, datas, unidades ou negações são bloqueadas.'));
  const q = h('input', { type: 'search', placeholder: 'Buscar…' });
  const list = h('div', { class: 'card' });
  const from = h('input', { type: 'text', placeholder: 'Como o modelo escreve (ex.: Indayatuba)' });
  const to = h('input', { type: 'text', placeholder: 'Grafia correta (ex.: Indaiatuba)' });
  const cat = h('select', {}, ...['nome', 'empresa', 'sigla', 'termo técnico', 'outro'].map(c => h('option', {}, c)));
  const msg = h('div', { class: 'small' });
  const test = h('input', { type: 'text', placeholder: 'Teste: digite uma frase para ver as regras aplicadas' });
  const testOut = h('div', { class: 'small mono' });
  view.append(h('div', { class: 'card stack' }, h('h3', {}, 'Adicionar regra'), h('div', { class: 'grid g3' }, from, to, cat),
    h('div', { class: 'row' }, h('button', { class: 'btn primary', onclick: async () => {
      const s = ruleSafety(from.value.trim(), to.value.trim());
      if (!s.ok) { msg.replaceChildren(h('div', { class: 'alert bad' }, s.reasons.join(' '))); return; }
      await db.put('corrections', { id: 'c' + Date.now().toString(36), from: from.value.trim(), to: to.value.trim(), category: cat.value, enabled: true, createdAt: new Date().toISOString(), origin: { manual: true } });
      from.value = to.value = ''; msg.replaceChildren(); paint();
    } }, 'Adicionar')), msg, h('hr'), test, testOut), h('div', { style: { height: '12px' } }), q, h('div', { style: { height: '8px' } }), list);

  async function paint() {
    const rules = (await db.getAll('corrections')).sort((a, b) => a.from.localeCompare(b.from));
    const t = q.value.trim().toLowerCase();
    const rows = rules.filter(r => !t || `${r.from} ${r.to} ${r.category}`.toLowerCase().includes(t));
    test.oninput = () => { const r = applyCorrections(test.value, rules); testOut.textContent = r.text + (r.used.length ? `   (${r.used.length} regra(s))` : ''); };
    list.replaceChildren(rows.length ? h('table', { class: 't' }, h('tr', {}, h('th', {}, 'Ativa'), h('th', {}, 'De'), h('th', {}, 'Para'), h('th', {}, 'Tipo'), h('th', {}, 'Origem'), h('th', {})),
      ...rows.map(r => {
        const en = h('input', { type: 'checkbox', checked: r.enabled, onchange: async () => { r.enabled = en.checked; await db.put('corrections', r); toast(r.enabled ? 'Regra reativada.' : 'Regra desativada (pode reativar depois).'); } });
        const f = h('input', { type: 'text', value: r.from }), tt = h('input', { type: 'text', value: r.to });
        const save = async () => { const s = ruleSafety(f.value.trim(), tt.value.trim()); if (!s.ok) { toast(s.reasons[0]); f.value = r.from; tt.value = r.to; return; } r.history = [...(r.history || []), { from: r.from, to: r.to, at: new Date().toISOString() }]; r.from = f.value.trim(); r.to = tt.value.trim(); await db.put('corrections', r); toast('Regra atualizada (versão anterior guardada).'); };
        f.onchange = save; tt.onchange = save;
        return h('tr', {}, h('td', {}, en), h('td', {}, f), h('td', {}, tt), h('td', { class: 'small' }, r.category), h('td', { class: 'small muted' }, r.origin?.title || (r.origin?.manual ? 'manual' : '—'), h('br'), new Date(r.createdAt).toLocaleDateString('pt-BR')),
          h('td', {}, r.history?.length ? h('button', { class: 'btn sm', title: 'Desfazer última edição', onclick: async () => { const p = r.history.pop(); r.from = p.from; r.to = p.to; await db.put('corrections', r); paint(); } }, '↶') : null,
            h('button', { class: 'btn sm danger', onclick: async () => { if (await confirmDlg(`Apagar a regra "${r.from}" → "${r.to}"? Transcrições já feitas não mudam.`, 'Apagar', true)) { await db.del('corrections', r.id); paint(); } } }, 'Apagar')));
      })) : h('p', { class: 'muted' }, 'Nenhuma regra. Elas surgem quando você corrige um trecho da transcrição e confirma "Lembrar".'));
  }
  q.oninput = paint;
  paint();
}

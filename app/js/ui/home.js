import { h, toast, errorPanel, dialog } from './dom.js';
import { state, go, saveSettings } from '../app.js';
import * as db from '../db.js';
import { capabilities, listMics, openMic, openDisplay, micTest, Recording, importFile } from '../recorder.js';
import { ScreenCapturer } from '../screens.js';

export async function render(view) {
  const caps = capabilities();
  const s = state.settings;
  view.append(h('div', { class: 'topbar' }, h('h1', {}, 'Nova reunião')));

  if (!caps.secure) view.append(h('div', { class: 'alert bad' }, 'Esta página não está em contexto seguro (HTTPS ou localhost). O navegador bloqueia microfone e captura de tela. Abra pelo endereço https:// ou pelo iniciador local.'));

  // ---- modo ----
  let mode = 'online';
  const modeBox = h('div', { class: 'grid g3' });
  const modes = [
    { k: 'presencial', t: 'Presencial', d: 'Grava pelo microfone do computador ou celular.' },
    { k: 'online', t: 'Online (Teams, Meet, Zoom…)', d: 'Grava seu microfone + o áudio da reunião capturado direto do sistema/aba, sem depender dos alto-falantes.', off: !caps.display },
    { k: 'importar', t: 'Importar arquivo', d: 'Áudio ou vídeo já gravado (MP3, M4A, WAV, WebM, MP4…).' },
    { k: 'bot', t: 'Enviar o Pedro Agent', d: 'O bot entra na reunião pelo link como participante. Requer o servidor local (computador).' },
  ];
  const cards = modes.map(m => h('button', { class: 'card', style: { textAlign: 'left', cursor: 'pointer', opacity: m.off ? .55 : 1 }, onclick: () => { mode = m.k; paint(); } },
    h('h3', {}, m.t), h('div', { class: 'small muted' }, m.d), m.off ? h('div', { class: 'small', style: { color: 'var(--warn)' } }, 'Indisponível neste navegador/dispositivo') : null));
  modeBox.append(...cards);
  view.append(modeBox);
  const panel = h('div', { class: 'card', style: { marginTop: '14px' } });
  view.append(panel);

  function paint() {
    cards.forEach((c, i) => c.style.outline = modes[i].k === mode ? '2px solid var(--accent)' : 'none');
    panel.replaceChildren();
    if (mode === 'importar') return paintImport();
    if (mode === 'bot') return paintBot();
    paintRecord();
  }

  // ---- gravação ----
  async function paintRecord() {
    const title = h('input', { type: 'text', placeholder: 'Ex.: Reunião de planejamento — Torre B', value: '' });
    const parts = h('input', { type: 'text', placeholder: 'Opcional: nomes separados por vírgula (só os confirmados)' });
    const micSel = h('select', {});
    const fillMics = async () => {
      try {
        const mics = await listMics();
        micSel.replaceChildren(h('option', { value: '' }, 'Microfone padrão do sistema'), ...mics.map(m => h('option', { value: m.deviceId, selected: m.deviceId === s.micId }, m.label || `Microfone ${m.deviceId.slice(0, 6)}`)));
        if (mics.length && !mics[0].label) micSel.append(h('option', { disabled: true }, '(nomes aparecem após permitir o microfone)'));
      } catch (e) { micSel.replaceChildren(h('option', {}, 'Não foi possível listar microfones')); }
    };
    await fillMics();
    const ec = h('input', { type: 'checkbox', checked: s.echoCancellation });
    const ns = h('input', { type: 'checkbox', checked: s.noiseSuppression });
    const agc = h('input', { type: 'checkbox', checked: s.autoGainControl });
    const meterBar = h('i'), meterTxt = h('span', { class: 'mono' }, '—');
    const testOut = h('div', { class: 'small' });
    const opts = () => ({ echoCancellation: ec.checked, noiseSuppression: ns.checked, autoGainControl: agc.checked });
    const testBtn = h('button', { class: 'btn', onclick: async () => {
      testBtn.disabled = true; testOut.replaceChildren('Fale normalmente por 5 segundos…');
      try {
        const r = await micTest(micSel.value, 5, ({ db: d }) => { meterBar.style.width = `${Math.max(0, Math.min(100, (d + 60) / 60 * 100))}%`; meterTxt.textContent = `${d.toFixed(0)} dB`; }, opts());
        await fillMics();
        const verdict = r.maxDb < -45 ? ['bad', 'Sinal MUITO BAIXO: a transcrição pode falhar. Verifique se o microfone certo está selecionado, se não está mudo e aproxime-o.'] : r.peakDb > -0.5 ? ['warn', 'Sinal saturando (estourado). Reduza o ganho/volume de entrada do microfone no sistema.'] : r.maxDb < -30 ? ['warn', 'Sinal um pouco baixo, mas utilizável. Se possível, aproxime o microfone.'] : ['ok', 'Sinal adequado.'];
        testOut.replaceChildren(h('div', { class: `alert ${verdict[0]}` }, `${r.label || 'Microfone'} — pico ${r.peakDb.toFixed(1)} dBFS, nível máx. ${r.maxDb.toFixed(1)} dBFS. ${verdict[1]}`), h('audio', { controls: true, src: URL.createObjectURL(r.blob), style: { width: '100%', marginTop: '6px' } }));
      } catch (e) { testOut.replaceChildren(errorPanel(Object.assign(e, { kind: e.name === 'NotAllowedError' ? 'config' : e.kind }), { stage: 'teste do microfone' })); }
      testBtn.disabled = false;
    } }, 'Testar microfone (5 s) e ouvir');

    const online = mode === 'online';
    const shotInt = h('input', { type: 'number', min: 0, max: 600, value: s.shotInterval, style: { width: '90px' } });
    const shareInfo = online ? h('div', { class: 'alert info small stack' },
      h('strong', {}, 'Como capturar o áudio da reunião'),
      h('div', {}, '• Teams ou Meet no navegador: ao iniciar, escolha a ABA da reunião e marque “Compartilhar áudio da aba”.'),
      h('div', {}, '• Teams instalado (aplicativo) no Windows: escolha “Tela inteira” e marque “Compartilhar áudio do sistema”.'),
      h('div', {}, '• Use fone de ouvido: evita que o microfone capte de novo a voz dos outros (eco/duplicação).'),
      h('div', {}, `Neste navegador: áudio de aba ${caps.tabAudio}; áudio do sistema ${caps.systemAudio}.`),
      !caps.isChromium ? h('div', { style: { color: 'var(--bad)' } }, 'Firefox e Safari não capturam áudio de aba/sistema. Use Chrome ou Edge no computador, ou envie o bot.') : null,
    ) : null;

    const startBtn = h('button', { class: 'btn rec big', onclick: start }, online ? '● Iniciar gravação (escolher aba/tela)' : '● Iniciar gravação');
    const out = h('div');
    panel.append(h('div', { class: 'grid g2' },
      h('div', { class: 'stack' },
        h('div', {}, h('label', { class: 'f' }, 'Título'), title),
        h('div', {}, h('label', { class: 'f' }, 'Participantes'), parts),
        h('div', {}, h('label', { class: 'f' }, 'Microfone'), micSel),
        h('label', { class: 'check small' }, ec, 'Cancelamento de eco (recomendado em reunião online)'),
        h('label', { class: 'check small' }, ns, 'Supressão de ruído do navegador (ajuda em ambiente barulhento; pode abafar vozes distantes)'),
        h('label', { class: 'check small' }, agc, 'Controle automático de ganho'),
        online ? h('div', {}, h('label', { class: 'f' }, 'Capturar a tela compartilhada a cada (s) — 0 desliga'), shotInt) : null,
      ),
      h('div', { class: 'stack' },
        h('div', { class: 'meter' }, h('span', {}, 'Nível do teste'), h('div', { class: 'bar' }, meterBar), meterTxt),
        testBtn, testOut, shareInfo,
      )),
      h('hr'), h('div', { class: 'row' }, startBtn), out);

    async function start() {
      startBtn.disabled = true; out.replaceChildren();
      let mic = null, disp = null;
      try {
        await saveSettings({ micId: micSel.value, ...opts(), shotInterval: Number(shotInt.value) || 0 });
        try { mic = await openMic(micSel.value, opts()); }
        catch (e) { if (!online) throw e; toast('Microfone indisponível: gravando só o áudio da reunião.'); }
        if (online) {
          const d = await openDisplay();
          disp = d.stream;
          if (!d.hasAudio) {
            const go2 = await dialog(h('div', { class: 'stack' }, h('strong', {}, 'O compartilhamento não trouxe áudio.'),
              d.audioError ? h('p', { class: 'small', style: { color: 'var(--bad)' } }, `O navegador não conseguiu abrir o áudio do compartilhamento (${d.audioError}).`) : null,
              h('p', {}, `Fonte escolhida: ${d.surface}. Para gravar os outros participantes, escolha a aba da reunião com “Compartilhar áudio da aba” ou a tela inteira com “Compartilhar áudio do sistema” (Windows).`),
              h('p', { class: 'small muted' }, 'Se continuar assim, só o seu microfone será gravado (e a tela, para capturas).')),
            [{ label: 'Escolher de novo', value: 'retry' }, { label: 'Continuar só com microfone', value: 'go', primary: true }]);
            if (go2 === 'retry') { disp.getTracks().forEach(t => t.stop()); mic?.getTracks().forEach(t => t.stop()); startBtn.disabled = false; return start(); }
            if (!mic) throw Object.assign(new Error('Sem microfone e sem áudio da reunião: nada para gravar.'), { kind: 'sem-sinal' });
          }
        }
        const participants = parts.value.split(',').map(x => x.trim()).filter(Boolean).map(name => ({ name, confirmed: true, evidence: 'informado pelo usuário' }));
        const meeting = await db.newMeeting({ title: title.value.trim() || undefined, participants, speakerNames: s.myName ? { mic: s.myName } : {} });
        const rec = new Recording(meeting, { micStream: mic, displayStream: disp });
        await rec.start();
        state.recording = rec;
        if (disp?.getVideoTracks().length) {
          rec.shots = new ScreenCapturer(meeting.id, disp, { intervalSec: Number(shotInt.value) || 0, threshold: s.shotThreshold, clock: () => rec.seconds });
          await rec.shots.start();
        }
        go('gravar', meeting.id);
      } catch (e) {
        mic?.getTracks().forEach(t => t.stop()); disp?.getTracks().forEach(t => t.stop());
        const kind = e.name === 'NotAllowedError' || e.name === 'NotFoundError' ? 'config' : e.name === 'NotReadableError' ? 'dispositivo' : e.kind;
        const msg = e.name === 'NotAllowedError' ? `Permissão negada (${e.message}). Libere o microfone/compartilhamento no cadeado da barra de endereço.` : e.name === 'NotFoundError' ? 'Nenhum microfone encontrado.' : e.name === 'NotReadableError' ? `O dispositivo de áudio está em uso por outro programa ou indisponível (${e.message}).` : e.message;
        out.replaceChildren(errorPanel(Object.assign(new Error(msg), { kind, stack: e.stack }), { stage: 'início da gravação' }));
        startBtn.disabled = false;
      }
    }
  }

  // ---- importação ----
  function paintImport() {
    const inp = h('input', { type: 'file', accept: 'audio/*,video/*,.m4a,.mp3,.wav,.webm,.ogg,.opus,.mp4,.mkv' });
    const st = h('div', { class: 'small muted' });
    const out = h('div');
    inp.onchange = async () => {
      const f = inp.files[0]; if (!f) return;
      if (f.size > 1.5e9) toast('Arquivo grande: a conversão pode exigir bastante memória.');
      st.textContent = 'Salvando o arquivo original…';
      try { const m = await importFile(f, t => st.textContent = t); st.textContent = 'Importado.'; go('reuniao', m.id); }
      catch (e) { st.textContent = ''; out.replaceChildren(errorPanel(e, { stage: 'importação' })); }
    };
    panel.append(h('div', { class: 'stack' }, h('h3', {}, 'Importar áudio ou vídeo'), inp, st,
      h('p', { class: 'small muted' }, 'O arquivo original é guardado sem alterações. Para transcrever, o app cria uma cópia em 16 kHz mono.'), out));
  }

  // ---- bot ----
  async function paintBot() {
    if (!state.local?.bot) {
      panel.append(h('div', { class: 'stack' }, h('h3', {}, 'Enviar o Pedro Agent para a reunião'),
        h('div', { class: 'alert' }, state.local ? 'O servidor local está ativo, mas o componente do bot não foi instalado. Rode "Instalar bot.bat" (Windows) ou "npm install" na pasta bot.' : 'Esta função precisa do servidor local do Pedro Agent rodando no seu computador (o navegador sozinho não consegue entrar em uma reunião como participante). Abra o app pelo "Iniciar Pedro Agent.bat".'),
        h('p', { class: 'small muted' }, 'Veja em Ajuda → Bot participante: como funciona, limitações do Teams/Meet e o que depende da sua organização.')));
      return;
    }
    const url = h('input', { type: 'url', placeholder: 'https://meet.google.com/abc-defg-hij ou link do Teams' });
    const name = h('input', { type: 'text', value: 'Pedro Agent' });
    const title = h('input', { type: 'text', placeholder: 'Título da reunião (opcional)' });
    const out = h('div');
    const btn = h('button', { class: 'btn primary', onclick: async () => {
      btn.disabled = true; out.replaceChildren();
      try {
        const meeting = await db.newMeeting({ title: title.value.trim() || undefined, source: 'bot', status: 'bot', bot: { url: url.value.trim(), state: 'iniciando' } });
        const r = await fetch('/api/bot/join', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url: url.value.trim(), name: name.value.trim(), meetingId: meeting.id }) });
        const j = await r.json();
        if (!r.ok) { await db.deleteMeeting(meeting.id); throw Object.assign(new Error(j.error || `HTTP ${r.status}`), { kind: 'config' }); }
        await db.updateMeeting(meeting.id, m => { m.bot.sessionId = j.id; });
        go('reuniao', meeting.id);
      } catch (e) { out.replaceChildren(errorPanel(e, { stage: 'envio do bot' })); btn.disabled = false; }
    } }, 'Enviar o bot');
    panel.append(h('div', { class: 'stack' }, h('h3', {}, 'Enviar o Pedro Agent para a reunião'),
      h('div', {}, h('label', { class: 'f' }, 'Link da reunião (Google Meet ou Microsoft Teams)'), url),
      h('div', { class: 'grid g2' }, h('div', {}, h('label', { class: 'f' }, 'Nome exibido'), name), h('div', {}, h('label', { class: 'f' }, 'Título'), title)),
      h('div', { class: 'alert info small' }, 'O bot entra como convidado e fica na sala de espera até o organizador admiti-lo. O estado mostrado é o lido na tela da reunião (aguardando, admitido, gravando, recusado, encerrado). Informe os participantes de que a reunião está sendo gravada.'),
      h('div', { class: 'row' }, btn), out));
  }

  paint();
}

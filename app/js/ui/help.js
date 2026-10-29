import { h } from './dom.js';
import { state } from '../app.js';

const S = (t, ...kids) => h('div', { class: 'card stack' }, h('h2', {}, t), ...kids);
const P = (...k) => h('p', {}, ...k);
const UL = (...items) => h('ul', {}, ...items.map(i => h('li', {}, i)));

export async function render(view) {
  const standalone = matchMedia('(display-mode: standalone)').matches;
  const installBtn = state.installPrompt && !standalone ? h('button', { class: 'btn primary', onclick: async () => { state.installPrompt.prompt(); await state.installPrompt.userChoice; state.installPrompt = null; } }, 'Instalar o Pedro Agent neste dispositivo') : null;
  view.append(h('div', { class: 'topbar' }, h('h1', {}, 'Ajuda')),
    S('Instalação: o que é cada opção',
      installBtn,
      UL(
        h('span', {}, h('strong', {}, 'PWA (aplicativo web instalado) — recomendado. '), 'Chrome/Edge no computador: ícone de instalar na barra de endereço ou o botão acima. Android (Chrome): menu ⋮ → "Instalar app". iPhone (Safari): Compartilhar → "Adicionar à Tela de Início". Abre em janela própria, aparece no menu Iniciar/tela inicial e funciona offline. Continua sendo o navegador por baixo: tem as mesmas permissões e limitações.'),
        h('span', {}, h('strong', {}, 'Atalho. '), 'Um link para a página no navegador. Não é instalação: abre como aba comum.'),
        h('span', {}, h('strong', {}, 'Iniciador para Windows ("Iniciar Pedro Agent.bat"). '), 'Sobe um servidor local (localhost) e abre o app. Necessário para o bot participante e para acessar o Ollama sem configuração extra. Não é um aplicativo nativo com instalador; é um script que roda o servidor.'),
        h('span', {}, h('strong', {}, 'Aplicativo nativo com instalador (.exe/.msi). '), 'NÃO entregue nesta versão. Seria necessário empacotar com Electron/Tauri; está descrito como próxima etapa na documentação.'),
      ),
      P('Atualizações substituem só os arquivos do app. Reuniões, áudios, transcrições, atas e capturas ficam no banco local do navegador e são mantidos. Desinstalar o PWA ou "limpar dados do site" APAGA esse banco: gere um backup antes.')),
    S('Gravar reunião online (Teams, Meet, Zoom)',
      UL('Chrome ou Edge no computador. Em "Nova reunião → Online", clique em Iniciar e escolha:',
        'Teams/Meet no navegador: a ABA da reunião, com "Compartilhar áudio da aba" marcado.',
        'Teams instalado (app) no Windows: "Tela inteira" com "Compartilhar áudio do sistema" marcado. Captura tudo que toca no computador.',
        'Use fone de ouvido. Sem fone, o microfone também capta os alto-falantes e a fala dos outros fica duplicada.',
        'macOS/Linux: o áudio do sistema (tela inteira) depende da versão do sistema/navegador; o áudio de aba funciona. Para o app Teams no Mac, use o Teams no navegador ou o bot.',
        'Celular: navegadores móveis não permitem capturar o áudio de outro aplicativo. No celular grave reuniões presenciais, ou use o viva-voz (qualidade menor), ou envie o bot a partir do computador.',
        'Firefox e Safari: não capturam áudio de aba/sistema.')),
    S('Bot participante (Pedro Agent entra na reunião)',
      P('O bot roda no seu computador (servidor local + navegador automatizado Chromium via Playwright). Ele abre o link, entra como convidado com o nome "Pedro Agent", aguarda na sala de espera e grava o áudio recebido pela reunião. O estado exibido é lido da própria tela da reunião.'),
      UL('Google Meet: o organizador precisa aceitar o pedido de participação. Reuniões restritas à organização (Workspace) recusam convidados externos.',
        'Microsoft Teams: depende de a organização permitir participantes anônimos ("Anonymous users can join a meeting"). Na Iben, isso é definido pelo administrador do Microsoft 365. O organizador admite pela sala de espera.',
        'A integração oficial de bots de mídia do Teams (Graph Communications API) exige registro no Azure AD, consentimento do administrador e um servidor Windows no Azure: não é gratuita nem viável sem a TI. Ver docs/BOT.md.',
        'As telas do Teams/Meet mudam com frequência. Se o bot não reconhecer um estado, ele mostra "desconhecido" e guarda um print de diagnóstico, em vez de fingir que entrou.',
        'Avise os participantes de que a reunião está sendo gravada (LGPD e políticas internas).')),
    S('Transcrição e IA: o que precisa de internet',
      UL('Primeiro uso de cada modelo: download (Whisper 135 MB a 1,6 GB; IA no navegador 1–5 GB). Depois, offline.',
        'Ollama: download do modelo uma vez ("ollama pull qwen3:8b", ~5,2 GB). Depois roda sem internet.',
        'Bot: precisa de internet (é uma reunião online).',
        'Servidor compatível com OpenAI externo (opcional): envia o texto da reunião para o serviço.'),
      P('Memória aproximada: Whisper Rápido ~0,6 GB, Equilibrado ~1,5 GB, Preciso ~3,5 GB; IA qwen3:4b ~5 GB, qwen3:8b ~8–10 GB. Reuniões longas são processadas em trechos, então a memória não cresce com a duração.')),
    S('Ollama: instalação rápida (Windows)',
      UL('Baixe em ollama.com e instale.', 'No terminal: ollama pull qwen3:8b (ou qwen3:4b em máquinas com 8 GB de RAM).',
        'Abrindo o app pelo iniciador local, nada mais é necessário.',
        'Abrindo o app por um endereço https (ex.: GitHub Pages), defina a variável de ambiente OLLAMA_ORIGINS com esse endereço e reinicie o Ollama. O Chrome pode pedir permissão de acesso à rede local.')),
    S('Privacidade', P('Áudio, transcrições e atas ficam somente neste dispositivo. Nada é enviado para servidores, exceto se você configurar um serviço de IA externo ou usar o bot (que participa da reunião online).')));
}

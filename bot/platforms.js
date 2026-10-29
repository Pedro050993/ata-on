// Fluxos de entrada por plataforma. As telas do Meet e do Teams mudam com
// frequência: a detecção usa textos (pt-BR e inglês) e atributos estáveis, e
// devolve "desconhecido" quando não tem certeza — nunca supõe que entrou.


async function clickByText(page, re, { timeout = 1500 } = {}) {
  const loc = page.getByRole('button', { name: re }).first();
  try { await loc.waitFor({ state: 'visible', timeout }); await loc.click({ timeout }); return true; } catch { return false; }
}
async function fillName(page, selectors, name) {
  for (const sel of selectors) {
    const loc = page.locator(sel).first();
    try { await loc.waitFor({ state: 'visible', timeout: 2500 }); await loc.fill(name); return true; } catch { /* tenta o próximo */ }
  }
  return false;
}
// só conta elementos VISÍVEIS (as plataformas mantêm botões ocultos no DOM)
async function visible(page, selector) {
  const loc = page.locator(selector);
  const n = await loc.count();
  for (let i = 0; i < n; i++) if (await loc.nth(i).isVisible().catch(() => false)) return true;
  return false;
}
async function bodyText(page) {
  try { return await page.evaluate(() => document.body?.innerText || ''); } catch { return ''; }
}

export const meet = {
  name: 'Google Meet',
  match: (u) => /^https:\/\/meet\.google\.com\//.test(u),
  async prejoin(page, name, log) {
    await clickByText(page, /^(Got it|Entendi|Dispensar|Dismiss)$/i);
    const filled = await fillName(page, ['input[aria-label="Your name"]', 'input[aria-label="Seu nome"]', 'input[placeholder*="name" i]', 'input[placeholder*="nome" i]', 'input[type="text"]'], name);
    log(filled ? 'nome preenchido' : 'campo de nome não encontrado (talvez já logado)');
    for (const re of [/Turn off microphone|Desativar microfone|Desligar microfone/i, /Turn off camera|Desativar câmera|Desligar câmera/i]) await clickByText(page, re, { timeout: 800 });
    const clicked = await clickByText(page, /^(Ask to join|Pedir para participar|Solicitar participação|Join now|Participar agora|Participar)$/i, { timeout: 8000 });
    log(clicked ? 'pedido de participação enviado' : 'botão de participar não encontrado');
    return clicked;
  },
  async state(page) {
    const t = await bodyText(page);
    if (/You can.t join this (video )?call|Você não pode participar|denied your request|negou (a sua|sua) solicitação|request to join was declined|ninguém respondeu|No one responded to your request/i.test(t)) return 'recusado';
    if (/You left the meeting|Você saiu da (reunião|chamada)|You.ve been removed|Você foi removid|call has ended|chamada (foi )?encerrada|Return to home screen|Voltar para a tela inicial/i.test(t)) return 'encerrado';
    if (await visible(page, 'button[aria-label*="Leave call" i], button[aria-label*="Sair da chamada" i], button[aria-label*="Sair da reunião" i]')) return 'admitido';
    if (/Asking to be let in|Pedindo para participar|Pedindo para entrar|Aguarde até que|Please wait until|You.ll join the call when someone lets you in|quando alguém permitir/i.test(t)) return 'aguardando';
    if (/Ready to join|Pronto para participar|What.s your name|Qual é o seu nome/i.test(t)) return 'pre-entrada';
    return 'desconhecido';
  },
  async participants(page) {
    try {
      return await page.evaluate(() => [...new Set([...document.querySelectorAll('[data-participant-id] [data-self-name], [data-participant-id] .zWGUib, [role="listitem"][aria-label]')].map(e => (e.getAttribute('aria-label') || e.textContent || '').trim()).filter(n => n && n.length < 60))]);
    } catch { return []; }
  },
  async leave(page) { await clickByText(page, /Leave call|Sair da chamada|Sair da reunião/i, { timeout: 2000 }); },
};

export const teams = {
  name: 'Microsoft Teams',
  match: (u) => /^https:\/\/(teams\.microsoft\.com|teams\.live\.com|teams\.cloud\.microsoft)\//.test(u),
  async prejoin(page, name, log) {
    await clickByText(page, /Continue on this browser|Continuar neste navegador|Join on the web instead|Ingressar na Web|Use the web app instead|Usar o aplicativo Web/i, { timeout: 8000 });
    await clickByText(page, /^(Continue without audio or video|Continuar sem áudio ou vídeo)$/i, { timeout: 3000 });
    const filled = await fillName(page, ['[data-tid="prejoin-display-name-input"]', 'input[placeholder*="name" i]', 'input[placeholder*="nome" i]'], name);
    log(filled ? 'nome preenchido' : 'campo de nome não encontrado');
    for (const sel of ['[data-tid="toggle-video"][aria-checked="true"]', '[data-tid="toggle-mute"][aria-checked="true"]']) { try { await page.locator(sel).first().click({ timeout: 800 }); } catch { /* já desligado */ } }
    let clicked = false;
    try { await page.locator('[data-tid="prejoin-join-button"]').first().click({ timeout: 8000 }); clicked = true; }
    catch { clicked = await clickByText(page, /^(Join now|Ingressar agora|Participar agora)$/i, { timeout: 4000 }); }
    log(clicked ? 'pedido de entrada enviado' : 'botão "Ingressar agora" não encontrado');
    return clicked;
  },
  async state(page) {
    const t = await bodyText(page);
    if (/denied access|acesso (foi )?negado|request to join was declined|Anonymous users can.t join|não (é possível|podem) ingressar|You can.t join this meeting|Não é possível ingressar/i.test(t)) return 'recusado';
    if (/You.ve been removed|Você foi removid|meeting has ended|reunião (foi )?encerrada|You left the meeting|Você saiu da reunião|Rate your call quality|Como foi a qualidade/i.test(t)) return 'encerrado';
    if (await visible(page, '[data-tid="hangup-main-btn"], #hangup-button, [data-tid="call-hangup"], button[aria-label^="Leave" i], button[aria-label^="Sair" i]')) {
      if (/Someone in the meeting should let you in|Alguém na reunião deve permitir|lobby|sala de espera|let people know you.re waiting|avisaremos que você está esperando/i.test(t)) return 'aguardando';
      return 'admitido';
    }
    if (/Someone in the meeting should let you in|Alguém na reunião deve permitir|let people know you.re waiting|lobby|sala de espera/i.test(t)) return 'aguardando';
    if (/Choose your audio and video settings|Escolha suas configurações de áudio e vídeo|Type your name|Digite seu nome|Join now|Ingressar agora/i.test(t)) return 'pre-entrada';
    return 'desconhecido';
  },
  async participants(page) {
    try { return await page.evaluate(() => [...new Set([...document.querySelectorAll('[data-tid^="participantsInCall"] [data-tid*="name"], [data-cid="roster-participant"] span[title], [data-tid="roster-participant"] [title]')].map(e => (e.getAttribute('title') || e.textContent || '').trim()).filter(n => n && n.length < 60))]); }
    catch { return []; }
  },
  async leave(page) { try { await page.locator('[data-tid="hangup-main-btn"], #hangup-button').first().click({ timeout: 2000 }); } catch { /* */ } },
};

export function platformFor(url) {
  if (meet.match(url)) return meet;
  if (teams.match(url)) return teams;
  return null;
}

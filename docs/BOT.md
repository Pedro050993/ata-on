# Bot participante "Pedro Agent"

## O que foi implementado

Um bot que roda **no seu computador**, dentro do servidor local (`bot/server.js`), usando o Playwright para controlar um Chromium:

1. Você cola o link da reunião no app ("Nova reunião → Enviar o Pedro Agent").
2. O servidor abre o link no Chromium, entra **como convidado** com o nome "Pedro Agent", desliga câmera e microfone (o microfone do bot é um arquivo de silêncio, então ele nunca transmite som) e pede para participar.
3. O estado exibido no app é **lido da tela da reunião** a cada 2 s:
   `iniciando → pre-entrada → aguardando → admitido → gravando → encerrado`, ou `recusado` / `erro`.
4. Um script injetado antes do código da plataforma intercepta as conexões WebRTC, recebe as trilhas de áudio dos participantes, mistura e grava em Opus/WebM (`bot/sessoes/<id>/audio.webm`).
5. Ao terminar, o app importa o áudio, e a reunião segue o fluxo normal (transcrição → ata).
6. Nomes de participantes lidos da tela da plataforma entram como "evidência: plataforma (bot)".

A cada mudança de estado o bot salva um print (`tela_*.png`) na pasta da sessão, para diagnóstico.

## O que foi testado e o que NÃO foi

| Item | Situação |
|---|---|
| Máquina de estados, captura WebRTC, API, download do áudio | Testado com uma **página local que imita o Meet** (`tests/browser/fake-meet`). Simulado. |
| Recusa pelo organizador, retirada pelo usuário, fim da reunião | Testado no simulador. |
| Áudio gravado pelo bot é transcrevível | Testado (o Whisper reconheceu a fala do áudio capturado). |
| Entrada real no **Google Meet** | **Não comprovado.** Não havia reunião real nem conta disponível no ambiente de desenvolvimento. |
| Entrada real no **Microsoft Teams** | **Não comprovado.** Mesmo motivo. |

Os seletores e textos do Meet/Teams (`bot/platforms.js`) foram escritos a partir das telas públicas conhecidas, em português e inglês. **Essas telas mudam com frequência.** Quando o bot não reconhece a tela, ele informa `desconhecido` no histórico e guarda o print, em vez de declarar que entrou.

## Dependências externas (fora do controle do app)

- **Google Meet**: o organizador precisa aceitar o pedido. Reuniões de contas Google Workspace configuradas para "somente pessoas da organização" recusam convidados sem login. O Google pode bloquear navegadores automatizados.
- **Microsoft Teams**: precisa que a organização permita **participantes anônimos** (Teams admin center → Meetings → "Anonymous users can join a meeting"). Na Iben isso é decidido pelo administrador do Microsoft 365. O organizador admite pela sala de espera (lobby).
- **Teams instalado vs. navegador**: o bot sempre usa o Teams **web**. O seu Teams instalado não é afetado.
- **Consentimento/LGPD**: o bot aparece com o nome "Pedro Agent". Avise os participantes de que a reunião está sendo gravada.

## Por que não a integração "oficial" do Teams

A forma suportada pela Microsoft para um bot receber o áudio de uma reunião é a **Graph Communications API com mídia hospedada pela aplicação** (application-hosted media bot):

- registro de aplicativo no Azure AD com permissões `Calls.JoinGroupCall.All` e `Calls.AccessMedia.All`, com **consentimento do administrador do tenant**;
- o SDK de mídia em tempo real é .NET e roda **somente em Windows Server hospedado no Azure** (VM ou serviço de nuvem com IP público e certificado);
- custo de infraestrutura contínuo e aprovação da TI.

Fonte: Microsoft Learn — [Requirements and considerations for application-hosted media bots](https://learn.microsoft.com/microsoftteams/platform/bots/calls-and-meetings/requirements-considerations-application-hosted-media-bots) (C#/.NET, Windows Server no Azure, IP público por instância, não pode ser Azure Web App). A gravação por essa API também exige chamar `updateRecordingStatus` antes de gravar.

Isso contraria as premissas de gratuidade e de independência do projeto. A arquitetura proposta, caso a Iben queira seguir esse caminho no futuro:

```
[Pedro Agent PWA] --link--> [API do bot (Azure Functions/App Service)]
                                   |
                         Graph Communications API (join, lobby, estados)
                                   |
                 [Bot de mídia .NET em Windows Server no Azure]
                    - recebe áudio por participante (com identidade do Teams)
                    - grava e envia ao armazenamento
                                   |
            [Pedro Agent baixa o áudio e as identidades → transcrição local]
```

Ganho real dessa via: identificação **confiável** de quem falou (o Teams informa a identidade de cada fluxo de áudio). Requer: tenant admin, Azure, certificado, e manutenção.

## Alternativa gratuita quando o bot não puder entrar

- Grave pelo app no computador: aba do Teams/Meet com "Compartilhar áudio da aba", ou tela inteira com "Compartilhar áudio do sistema" (Teams instalado no Windows).
- Ou use a transcrição do próprio Teams (se a licença tiver) e importe o arquivo de áudio/vídeo da gravação.

## Execução

```bash
cd bot
npm install
npx playwright install chromium
node server.js --abrir
```

Variáveis: `PORT` (8787), `BOT_HEADLESS=1` (sem janela; o Meet tende a bloquear mais), `PEDRO_DATA` (pasta das sessões), `OLLAMA_HOST`.

# Pedro Agent

Grava reuniões presenciais e online, transcreve **no próprio computador** e gera a ata com **IA local**: resumo em tópicos, decisões, propostas, riscos, tarefas por responsável e capturas da tela compartilhada. Não usa assinatura, cartão ou API paga, e não depende do ChatGPT.

> Estado: versão 1.0.0. O fluxo gravar/importar → transcrever → ata por IA → revisar → exportar está implementado e foi testado no Chromium com modelos reais. Pendências e o que não pôde ser comprovado estão em [docs/TESTES.md](docs/TESTES.md#o-que-ainda-não-foi-comprovado).

## Começar (Windows)

1. Baixe este repositório (Code → Download ZIP) e extraia em uma pasta, por exemplo `C:\PedroAgent`.
2. Recomendado: instale o **Node.js LTS** (gratuito, nodejs.org).
3. Dê dois cliques em **`Iniciar Pedro Agent.bat`**. O app abre em `http://localhost:8787`.
4. No Chrome ou no Edge, clique no ícone **Instalar** da barra de endereço para ter o app em janela própria, no menu Iniciar.
5. Para a ata por IA, instale o **Ollama** (ollama.com) e rode no terminal:
   ```
   ollama pull qwen3:8b
   ```
   Em PCs com 8 GB de RAM, use `qwen3:4b` e ajuste o modelo em Configurações → IA da ata.
6. Para o bot participante (opcional): dê dois cliques em **`Instalar bot.bat`** (exige o Node.js).

Sem Node.js, o iniciador usa um servidor mínimo do próprio Windows (PowerShell). Tudo funciona, exceto o bot.

## Celular

Os navegadores exigem HTTPS para o microfone. Publique a pasta `app/` gratuitamente pelo GitHub Pages (o fluxo `.github/workflows/pages.yml` já está pronto). Depois, abra o endereço no Chrome do Android (menu ⋮ → **Instalar app**) ou no Safari do iPhone (Compartilhar → **Adicionar à Tela de Início**).

No celular é possível gravar reuniões presenciais. Os navegadores móveis **não capturam o áudio de outros aplicativos** (Teams/Meet). A transcrição no celular funciona com o modelo "Rápido", porém é lenta. O melhor fluxo é gravar no celular e processar no PC, usando backup/restauração ou importação do áudio.

## PWA, atalho ou aplicativo nativo

| Opção | O que é | Situação |
|---|---|---|
| **PWA instalada** | O app instalado pelo navegador: janela própria, ícone, funciona offline | ✅ Entregue (forma principal) |
| Atalho | Link para a página; abre como aba comum | Não é instalação |
| Iniciador `.bat` | Script que sobe o servidor local e abre o app | ✅ Entregue; não é instalador nativo |
| Aplicativo nativo com instalador (.msi/.exe) | Empacotamento Tauri/Electron | ❌ Não entregue; ver [docs/ARQUITETURA.md](docs/ARQUITETURA.md) |

Atualizações trocam só os arquivos do app. Reuniões, áudios, transcrições, atas e capturas ficam no banco local do navegador (IndexedDB) e são preservados. **Desinstalar o PWA ou limpar os dados do site apaga esse banco**: faça backup em Configurações antes.

## Como gravar reuniões online

- **Teams ou Meet no navegador**: Nova reunião → Online → escolha a **aba** da reunião e marque **"Compartilhar áudio da aba"**.
- **Teams instalado (Windows)**: escolha **"Tela inteira"** e marque **"Compartilhar áudio do sistema"**.
- Use fone de ouvido. Seu microfone e o áudio da reunião são gravados em **trilhas separadas**. Com isso, o app sabe, por evidência medida, o que você falou e o que veio dos demais participantes.
- Firefox e Safari não capturam áudio de aba ou de sistema. Use Chrome ou Edge.

## Downloads, memória e internet

| Item | Download (1ª vez) | Memória aprox. | Internet depois? |
|---|---|---|---|
| Whisper Rápido (base) | ~135 MB | ~0,6 GB | Não |
| Whisper Equilibrado (small) — padrão | ~510 MB | ~1,5 GB | Não |
| Whisper Preciso (large-v3-turbo) | 1,1–1,6 GB | ~3,5 GB | Não |
| Ollama `qwen3:4b` / `qwen3:8b` | ~2,6 / ~5,2 GB | ~5 / 8–10 GB | Não |
| IA no navegador (WebLLM, exige GPU) | 2–5 GB | conforme o modelo | Não |
| Bot participante | ~170 MB (Chromium do Playwright) | ~0,5 GB | Sim (é reunião online) |

Velocidades medidas em CPU de 4 núcleos, sem GPU: Equilibrado ≈ 1× o tempo real (uma reunião de 46 min levou ~48 min); Preciso ≈ 1,9× o tempo real. Com GPU (WebGPU), o processamento é bem mais rápido. A estimativa exibida no app é calculada com a velocidade medida na sua máquina.

## Estrutura

```
app/                 PWA (abre direto no navegador)
  js/core/           lógica pura e testável: áudio, texto, ata, formatos
  js/ui/             telas
  js/workers/        Whisper, IA no navegador, captura PCM
  vendor/            docx, jsPDF, fflate (Transformers.js 4.3.2 vem do jsDelivr, versão fixa)
bot/                 servidor local + bot participante (Node + Playwright)
tests/               unitários, navegador (Playwright), modelo real, gerador de áudios
docs/                arquitetura, bot, testes
Iniciar Pedro Agent.bat · Instalar bot.bat · tools/servidor.ps1
```

## Testes

```
npm test                                   # unitários (simulados, sem modelo)
node bot/server.js                         # servidor para os testes de navegador
node tests/browser/e2e-gravacao.mjs <wav>  # gravação real no Chromium + Whisper
```

Resultados, critérios e limitações: [docs/TESTES.md](docs/TESTES.md).

## Referências funcionais

A organização das notas segue o que Fireflies e TeamsMaestro divulgam publicamente: visão geral, notas em tópicos com horário, itens de ação por pessoa, com responsável e prazo editáveis. A identidade visual e o código são próprios.

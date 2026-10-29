# Arquitetura do Pedro Agent

## Visão geral

```
┌──────────────────────── Navegador (PWA, offline) ─────────────────────────┐
│ UI (js/ui/*)                                                              │
│   │                                                                       │
│ Gravação (recorder.js) ── AudioWorklet 16 kHz ─┐   MediaRecorder Opus     │
│   microfone / aba / tela+sistema                │   (trilhas mic, sys, mix)│
│                                                 ▼                         │
│                    IndexedDB (db.js): reuniões, áudio, PCM, trechos,      │
│                    capturas, correções, logs — salvo a cada 4–10 s        │
│                                                 │                         │
│ Transcrição (transcriber.js) ── Worker Whisper (Transformers.js/ONNX)     │
│   plano de trechos nas pausas → preparo do sinal → checkpoint por trecho  │
│                                                 │                         │
│ Ata (ata.js + core/minutes.js) ── LLM: Ollama | WebLLM | Transformers.js  │
│   extração JSON por janelas → consolidação → conferência com a transcrição│
│                                                 │                         │
│ Formatos (core/formats.js) → Exportação (export.js): DOCX, PDF, MD, CSV   │
└───────────────────────────────────────────────────────────────────────────┘
          ▲ (opcional)
┌─────────┴──────── Servidor local (bot/server.js, Node) ──────────────────┐
│ serve o app em localhost · encaminha /ollama · bot Playwright (Meet/Teams)│
└───────────────────────────────────────────────────────────────────────────┘
```

## Decisões principais

| Decisão | Motivo | Custo aceito |
|---|---|---|
| Processamento local (Whisper e LLM no aparelho) | Gratuidade, privacidade, independência de serviços | Download inicial de modelos; velocidade depende do hardware |
| Gravar PCM 16 kHz em paralelo ao Opus | Transcrição lê trechos direto do banco, sem decodificar a reunião inteira (memória constante em reuniões longas); horários exatos para "ouvir trecho" | ~1,9 MB/min a mais no armazenamento |
| Trilhas separadas (microfone × reunião) | Evidência real de quem falou ("você" × "demais participantes") sem inventar identidade | Não distingue entre participantes remotos |
| Cortes nas pausas, sem sobreposição | Evita repetição e perda de frases nas transições | Fala contínua > 28 s é cortada no ponto de menor energia |
| Trechos silenciosos não vão ao modelo | Whisper inventa frases em silêncio ("Legendas pela comunidade Amara.org") | — |
| Ganho calculado só sobre quadros de fala, limiar relativo | Volume baixo é corrigido sem transformar ruído em fala | Medido: ver docs/TESTES.md |
| `jobId` por execução + gravação protegida (`guardedPut`) | Respostas atrasadas de execuções canceladas são descartadas; reunião excluída não é recriada | — |
| Motor descartado a cada falha | Não reaproveita um motor comprometido; GPU → CPU em instância nova | Recarregar o modelo (segundos) |
| Ata = JSON estruturado + conferência determinística | Formatos diferentes não mudam fatos; refs T# rastreáveis; responsável/prazo/número sem respaldo viram "A confirmar" | A conferência pode rebaixar algo correto; o usuário revisa |
| Edições por formato salvas à parte (`renditions["user:…"]`) | Trocar de formato não apaga edição | — |
| Versões anteriores da ata guardadas (até 5) | Regenerar não perde edições | — |

## Dados (IndexedDB `pedro-agent`, versão 1)

- `meetings` — metadados, participantes, plano de transcrição, ata (fatos + edições), formatos editados, histórico de atas.
- `blobs` — áudio original por trilha (`mic`, `sys`, `mix`, `original` importado), em pedaços.
- `pcm` — PCM 16 kHz Int16 em blocos de 10 s + energia por fonte a cada 100 ms.
- `segments` — trechos transcritos (texto bruto, texto corrigido, edição, locutor confirmado, métricas, flags).
- `shots` — capturas de tela (JPEG) com horário e legenda.
- `corrections` — memória de correções (de → para, tipo, ativa, histórico de edição).
- `logs` — erros técnicos com etapa, modelo e motor.

Migrações futuras só acrescentam (`if (oldVersion < N)`). O service worker troca apenas o cache de arquivos do app; não toca no IndexedDB nem no cache de modelos.

## Instalação: o que é cada coisa

- **PWA**: o próprio app instalado pelo navegador (Chrome/Edge/Android/iOS). É a forma principal.
- **Iniciador Windows** (`Iniciar Pedro Agent.bat`): roda o servidor local (Node) ou, sem Node, um servidor PowerShell mínimo. Não é instalador nativo.
- **Aplicativo nativo com instalador**: não entregue. Próximo passo sugerido: empacotar com **Tauri** (instalador MSI ~10 MB, usa o WebView2 do Windows) ou **Electron** (instalador ~100 MB). Ganho: captura de áudio do sistema sem o seletor do navegador (Electron `desktopCapturer` com loopback) e ícone/atalho nativos. Exige assinatura de código para não acionar o SmartScreen.

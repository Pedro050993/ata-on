# Testes — resultados e limites (29/10/2026)

Ambiente: contêiner Linux, CPU de 4 núcleos, 15 GB de RAM, **sem GPU e sem dispositivo de som**; Chromium 153 (Playwright); Node 22.
Áudio de teste: reunião roteirizada de 66 s com 3 vozes sintéticas pt-BR (Piper: faber, cadu, jeff), 11 falas com decisões, tarefas, valores e datas. Gerador: `tests/fixtures/make_fixtures.py`. Reuniões longas = o mesmo roteiro repetido com pausas variadas (20 min = 18 rodadas; 46 min = 42 rodadas).

Legenda: **[S]** simulado (sem modelo de IA ou com servidor/página falsa) · **[M]** modelo real fora do navegador · **[N]** navegador real com modelo real.

## Gravação, captura e áudio

| Teste | Tipo | Resultado |
|---|---|---|
| Gravar pelo microfone (fala conhecida injetada no microfone do Chromium), pausar, retomar, encerrar | N | ✅ 72,6 s gravados; relógio da tela = duração salva; trilhas `mic` + `mix`; 725 KB Opus |
| Reproduzir o áudio sincronizado com a transcrição | N | ✅ player com 72,6 s (mesma base de tempo dos trechos) |
| Gravação online com trilhas separadas (microfone + "reunião") e medidores por fonte | N (dispositivos falsos) | ✅ trilhas `mic`, `sys`, `mix`; medidores −21/−20/−23 dB |
| Captura real do **áudio de outra aba** | N | ❌ **não comprovado**: o contêiner não tem saída de som e o Chromium recusou ("Could not start audio source"). O app agora tenta só a imagem e avisa. **Validar no Windows.** |
| Áudio do sistema (Teams instalado, tela inteira) | — | ❌ **não comprovado** (precisa de Windows com Chrome/Edge) |
| Capturas de tela: tela parada não duplica; troca de cor/texto gera nova; marcação manual | N | ✅ após correção (o hash inicial ignorava troca de texto — defeito encontrado e corrigido) |
| Ponto importante marcado durante a gravação | N | ✅ captura manual + marca no horário |
| Recuperação após fechar o navegador no meio da gravação (sem "Encerrar") | N | ✅ aviso na reabertura; 24,2 s recuperados de 25 s (antes da correção: 20 s — blocos de 10 s; agora salva o bloco parcial a cada ~3 s) |

## Transcrição (Whisper, CPU/WASM, 4 núcleos)

WER = taxa de erro de palavras contra o roteiro (menor é melhor).

| Áudio | Modelo | Tipo | WER | Velocidade |
|---|---|---|---|---|
| Reunião 66 s, gravada pelo microfone | Equilibrado (small) | N | 20,1% | 0,86× tempo real |
| Mesma, importada | Equilibrado | N | 18,1% | 0,89× |
| Mesma, importada | **Preciso (large-v3-turbo)** | N | **6,7%** | 1,9× (mais lento que a reunião) |
| Volume baixo (−32 dB) — preparo antigo | Equilibrado | N | 32,2% | — |
| Volume baixo — preparo corrigido | Equilibrado | M | **16,1%** (áudio cru: 28,2%) | — |
| Ruído SNR 10 dB — preparo corrigido | Equilibrado | M | 22,8% (áudio cru: 25,5%) | — |
| Silêncio 60 s | Equilibrado | N | ✅ "sem fala"; nenhum texto inventado; modelo nem é chamado | — |
| Ruído sem fala 60 s | Equilibrado | N | ✅ "sem fala" | — |
| **Reunião de 20 min** | Equilibrado | N | 18,4%; 70 trechos; 0 lacunas; 0 repetições entre trechos; 18/18 rodadas | 1,05× (CPU dividida com outros testes) |
| **Reunião de 46 min** | Equilibrado | N | 18,7%; 157 trechos; 0 lacunas; 0 trechos vazios; 42/42 rodadas | 47,8 min para 46,5 min (CPU dividida) |

Leitura: a qualidade não cai com a duração (curta 18%, 20 min 18,4%, 46 min 18,7%). Os erros restantes do modelo Equilibrado vêm do modelo com essa voz sintética ("atasou", "Inda e Atuba"). O modelo Preciso corrige a maior parte deles. **Voz real em sala real não foi testada.**

## Robustez

| Teste | Tipo | Resultado |
|---|---|---|
| GPU indisponível → instância limpa na CPU | N (falha real do WebGPU) | ✅ erro técnico registrado; concluiu em WASM |
| Falha do motor no meio (trecho 2) → descarta e recria o motor | N (falha injetada) | ✅ 9/9 trechos concluídos |
| Fechar o navegador no meio → reabrir → "Retomar do trecho 3" | N | ✅ 2 trechos preservados da 1ª execução, 9/9 no fim, sem lacunas (defeito de status corrigido) |
| Excluir a reunião durante a transcrição | N | ✅ nenhum dado restante; nada recriado por respostas atrasadas |
| Falta de memória ao carregar IA | N | ✅ classificado como "Limite de memória", com mensagem técnica original e botão copiar |

## Ata por IA

| Teste | Tipo | Resultado |
|---|---|---|
| Transcrição vazia → ata recusada (modelo nem é chamado) | N + unitário | ✅ |
| Transcrição incompleta → exige confirmação e marca **ATA PARCIAL** | unitário | ✅ |
| Qwen3-4B, locutores confirmados | M | ✅ decisão "nova concretagem dia 6", tarefas de Ana (amanhã ao meio-dia) e Marcos (sexta) "assumidas", troca de fornecedor como **sugestão**, risco do elevador, todos com T#. ⚠️ "Não vamos aprovar o valor" virou sugestão, não decisão. ~6 min por ata em CPU |
| Qwen3-4B, sem locutores identificados | M | ⚠️ JSON malformado 2× → corrigido com reparo por seção; ata gerada com aviso; responsável só onde o nome aparece no trecho; tarefa da Ana (autor não identificado) não apareceu |
| Qwen2.5-1.5B | M | ❌ atribuiu tarefa à pessoa errada (motivo para recomendar ≥ 4B) |
| Qwen3-1.7B no navegador só com CPU | N | ❌ falta de memória do WebAssembly (2,1 GB e 1,4 GB) |
| Qwen3-0.6B no navegador só com CPU | N | ⚠️ funciona de ponta a ponta (16 min), mas **inverteu uma decisão** ("valor aprovado" quando foi "não vamos aprovar"). Retirado das sugestões |
| Conferência contra a transcrição | S + N | ✅ responsável inventado ("Fulano Inventado") e prazo "dia 30" rebaixados a "A confirmar"; refs inexistentes removidas; números por extenso reconhecidos |
| Ollama: esquema JSON, streaming, "modelo não instalado", "Ollama fechado" | S (servidor falso) | ✅ — **Ollama real não foi executado**: o ambiente bloqueou a execução do binário baixado |
| WebLLM (GPU) | — | ❌ não testado (sem GPU) |

## Tarefas, formatos, exportação, histórico

| Teste | Tipo | Resultado |
|---|---|---|
| Editar responsável, concluir e reabrir tarefa pela interface | N | ✅ |
| Editar texto de decisão → aparece em todos os formatos | N | ✅ |
| Edição de um formato não altera os outros nem a ata | N | ✅ |
| 9 formatos determinísticos + 2 por IA | N + unitário | ✅ (formatos de IA exigem modelo configurado) |
| DOCX com imagem, PDF com imagem, TXT, Markdown (zip com imagens), CSV (Excel pt-BR), áudio original | N | ✅ arquivos abertos e conferidos (texto, imagem embutida, BOM do CSV) |
| Backup sem áudio / com áudio → restaurar em outro perfil → reabrir → excluir | N | ✅ restauração não sobrescreve reunião existente; aviso de "sem áudio" |
| Busca, reabertura e exclusão no histórico | N | ✅ |
| PWA: service worker, offline, isolamento (WASM multithread), dados após atualização | N | ✅ |
| Memória de correções: lembrar, aplicar na nova transcrição, texto bruto preservado, desativar, recusar regra com número | N | ✅ |

## Bot participante

| Teste | Tipo | Resultado |
|---|---|---|
| Admitido → gravando → encerrado (página que imita o Meet) | S | ✅ após correção (falso "admitido" na sala de espera — defeito encontrado e corrigido) |
| Recusado pelo organizador | S | ✅ sem gravar |
| Retirado pelo usuário | S | ✅ |
| Áudio recebido por WebRTC é transcrevível | S + M | ✅ Whisper reconheceu a fala |
| Nomes dos participantes lidos da tela | S | ✅ |
| **Google Meet real / Microsoft Teams real** | — | ❌ **não comprovado** (sem reunião real nem conta no ambiente) |

## O que ainda não foi comprovado

1. Captura do áudio da aba e do sistema no **seu Windows** (Teams no navegador e Teams instalado).
2. Bot entrando em reunião **real** do Meet e do Teams (inclui política de anônimos do tenant da Iben).
3. **Ollama real** (protocolo testado com servidor falso) e **WebLLM/WebGPU** (sem GPU no ambiente).
4. Voz humana real, sala real, sotaques, termos da Iben; os 20 e 46 min problemáticos citados por você **não foram fornecidos**, então não foram reproduzidos.
5. Celular real (Android/iPhone): instalação do PWA, gravação, memória disponível.
6. Velocidade com GPU.

## Como reproduzir

```bash
pip install piper-tts numpy && python3 tests/fixtures/make_fixtures.py <vozes> <saida>
npm install && npm test
node bot/server.js &
node tests/browser/e2e-gravacao.mjs <saida>/reuniao_normal.wav equilibrado
node tests/browser/e2e-importar.mjs <saida>/reuniao_46min.wav equilibrado longa46
node tests/browser/e2e-robustez.mjs <curto.wav> <3min.wav>
node tests/browser/e2e-exportar.mjs <saida>/reuniao_normal.wav /tmp/export
node tests/browser/e2e-memoria.mjs <curto.wav>
node tests/browser/e2e-recuperacao.mjs <saida>/reuniao_normal.wav
node tests/browser/e2e-ata.mjs <saida>/reuniao_normal.wav <saida>/silencio_60s.wav <modeloLLM>
node tests/browser/e2e-pwa.mjs
node tests/browser/ollama-simulado.mjs <curto.wav>
node tests/browser/bot-simulado.mjs <saida>/reuniao_normal.wav
node tests/model/ata-real.mjs <transcricao.json> onnx-community/Qwen3-4B-ONNX q4f16 1
```

# Pedro Agent - instalação automática da IA local (Ollama + modelo) e abertura do app.
# Executado pelo "Instalar tudo.bat". Pode ser rodado de novo sem problema.
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$raiz = Split-Path -Parent $PSScriptRoot

function Passo($t) { Write-Host ""; Write-Host "==> $t" -ForegroundColor Cyan }
function Falha($t) { Write-Host ""; Write-Host "ERRO: $t" -ForegroundColor Red; Read-Host "Pressione Enter para sair"; exit 1 }

# 1) memória -> modelo
Passo "Verificando a memória do computador"
$ramGB = [math]::Round((Get-CimInstance Win32_ComputerSystem).TotalPhysicalMemory / 1GB)
if ($ramGB -ge 16) { $modelo = 'qwen3:8b' } else { $modelo = 'qwen3:4b' }
Write-Host "RAM: $ramGB GB  ->  modelo escolhido: $modelo"
if ($ramGB -lt 8) { Write-Host "Atenção: com menos de 8 GB a geração da ata pode ficar muito lenta ou falhar." -ForegroundColor Yellow }

# 2) Ollama
Passo "Verificando o Ollama"
$ollamaDir = Join-Path $env:LOCALAPPDATA 'Programs\Ollama'
$env:Path = "$env:Path;$ollamaDir"
if (-not (Get-Command ollama -ErrorAction SilentlyContinue)) {
  Write-Host "Ollama não encontrado. Instalando (gratuito)..."
  $instalado = $false
  if (Get-Command winget -ErrorAction SilentlyContinue) {
    try { winget install --id Ollama.Ollama -e --silent --accept-source-agreements --accept-package-agreements; $instalado = $true } catch { $instalado = $false }
  }
  if (-not $instalado -or -not (Test-Path (Join-Path $ollamaDir 'ollama.exe'))) {
    $setup = Join-Path $env:TEMP 'OllamaSetup.exe'
    Write-Host "Baixando o instalador de ollama.com (cerca de 1 GB)..."
    try { Invoke-WebRequest 'https://ollama.com/download/OllamaSetup.exe' -OutFile $setup } catch { Falha "Não consegui baixar o Ollama. Verifique a internet ou se a rede da empresa bloqueia ollama.com. Detalhe: $($_.Exception.Message)" }
    Start-Process $setup -ArgumentList '/SILENT', '/NORESTART' -Wait
  }
  if (-not (Get-Command ollama -ErrorAction SilentlyContinue)) { Falha "A instalação do Ollama não foi concluída. Se o computador é da empresa, a TI pode ter bloqueado instalações. Instale manualmente por ollama.com/download e rode este arquivo de novo." }
} else { Write-Host "Ollama já instalado." }

# 3) Ollama rodando
Passo "Iniciando o Ollama"
function OllamaOk { try { Invoke-RestMethod 'http://127.0.0.1:11434/api/tags' -TimeoutSec 3 | Out-Null; return $true } catch { return $false } }
if (-not (OllamaOk)) {
  $app = Join-Path $ollamaDir 'ollama app.exe'
  if (Test-Path $app) { Start-Process $app } else { Start-Process ollama -ArgumentList 'serve' -WindowStyle Hidden }
  for ($i = 0; $i -lt 30 -and -not (OllamaOk); $i++) { Start-Sleep 2 }
}
if (-not (OllamaOk)) { Falha "O Ollama foi instalado mas não respondeu em http://127.0.0.1:11434. Abra 'Ollama' pelo menu Iniciar e rode este arquivo de novo." }
Write-Host "Ollama respondendo."

# 4) modelo
Passo "Baixando o modelo $modelo (só na primeira vez; pode levar vários minutos)"
& ollama pull $modelo
if ($LASTEXITCODE -ne 0) { Falha "Falha ao baixar o modelo $modelo. Verifique a internet e o espaço em disco (precisa de ~3 a 6 GB livres)." }

# 5) teste rápido
Passo "Testando o modelo"
try {
  $corpo = @{ model = $modelo; prompt = 'Responda apenas com a palavra: funcionando /no_think'; stream = $false; think = $false } | ConvertTo-Json
  $r = Invoke-RestMethod 'http://127.0.0.1:11434/api/generate' -Method Post -Body $corpo -ContentType 'application/json' -TimeoutSec 600
  Write-Host ("Resposta do modelo: " + ($r.response.Trim())) -ForegroundColor Green
} catch { Write-Host "O teste não respondeu ($($_.Exception.Message)). O app ainda pode funcionar; use 'Testar conexão com a IA' em Configurações." -ForegroundColor Yellow }

# 6) configura o app
Passo "Configurando o Pedro Agent"
$cfg = @{ llm = @{ provider = 'ollama'; model = $modelo } } | ConvertTo-Json
[IO.File]::WriteAllText((Join-Path $raiz 'app\config.local.json'), $cfg, (New-Object Text.UTF8Encoding $false))
Write-Host "Motor: Ollama  |  Modelo: $modelo"

# 7) abre o app
Passo "Abrindo o Pedro Agent"
Start-Process (Join-Path $raiz 'Iniciar Pedro Agent.bat') -WorkingDirectory $raiz
Write-Host ""
Write-Host "Pronto. O app vai abrir no navegador. Mantenha a janela preta do servidor aberta enquanto usa." -ForegroundColor Green
Read-Host "Pressione Enter para fechar esta janela"

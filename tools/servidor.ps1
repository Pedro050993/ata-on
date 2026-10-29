# Servidor estático mínimo (sem dependências) para abrir o Pedro Agent em
# http://localhost:8787 quando o Node.js não está instalado. Não inclui o bot.
$ErrorActionPreference = 'Stop'
$root = Join-Path $PSScriptRoot '..\app' | Resolve-Path
$port = 8787
$listener = New-Object System.Net.HttpListener
$listener.Prefixes.Add("http://localhost:$port/")
try { $listener.Start() } catch { Write-Host "Porta $port em uso. O Pedro Agent ja esta aberto? Acesse http://localhost:$port"; Start-Process "http://localhost:$port/"; exit }
Write-Host "Pedro Agent em http://localhost:$port  (feche esta janela para encerrar)"
Start-Process "http://localhost:$port/"
$types = @{ '.html'='text/html; charset=utf-8'; '.js'='text/javascript; charset=utf-8'; '.css'='text/css; charset=utf-8'; '.json'='application/json'; '.webmanifest'='application/manifest+json'; '.svg'='image/svg+xml'; '.png'='image/png'; '.wasm'='application/wasm' }
while ($listener.IsListening) {
  $ctx = $listener.GetContext()
  $path = [Uri]::UnescapeDataString($ctx.Request.Url.AbsolutePath)
  if ($path -eq '/') { $path = '/index.html' }
  $file = Join-Path $root ($path.TrimStart('/'))
  $resp = $ctx.Response
  $resp.Headers.Add('Cross-Origin-Opener-Policy', 'same-origin')
  $resp.Headers.Add('Cross-Origin-Embedder-Policy', 'credentialless')
  $resp.Headers.Add('Cache-Control', 'no-cache')
  $full = [System.IO.Path]::GetFullPath($file)
  if ($full.StartsWith($root.Path) -and (Test-Path $full -PathType Leaf)) {
    $ext = [System.IO.Path]::GetExtension($full)
    $resp.ContentType = $(if ($types.ContainsKey($ext)) { $types[$ext] } else { 'application/octet-stream' })
    $bytes = [System.IO.File]::ReadAllBytes($full)
    $resp.ContentLength64 = $bytes.Length
    $resp.OutputStream.Write($bytes, 0, $bytes.Length)
  } else { $resp.StatusCode = 404 }
  $resp.OutputStream.Close()
}

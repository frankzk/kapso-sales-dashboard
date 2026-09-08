# Baja el «Ticket Shalom» de una guía, desde Windows.
#
# Existe porque en PowerShell `curl` NO es curl: es un alias de
# Invoke-WebRequest, que no entiende `-H` ni `-o`, y la barra `\` no continúa
# línea. Copiar un curl de Linux ahí falla siempre, y el error no dice por qué.
#
# Es solo lectura: no crea ni borra ninguna guía.
#
# Uso:
#   .\scripts\shalom-ticket.ps1 -Ose 584210
#
# Las credenciales se leen del entorno para no dejarlas en el historial de la
# consola —ni en una captura de pantalla—:
#   $env:SHALOM_API_KEY='sk_…'
#   $env:SHALOM_PRO_EMAIL='…'
#   $env:SHALOM_PRO_PASSWORD='…'

[CmdletBinding()]
param(
  # El `ose_id` de la guía. NO es el nº de orden que se ve en pro.shalom.pe:
  # es el id interno, el que Kapta guarda en `shalom_ose_id` al crear la guía.
  [Parameter(Mandatory = $true)][int]$Ose,
  [string]$Out = "ticket.pdf",
  [string]$Base = "https://api.shalom-api-peru.com"
)

$ErrorActionPreference = "Stop"

$key = $env:SHALOM_API_KEY
$email = $env:SHALOM_PRO_EMAIL
$pass = $env:SHALOM_PRO_PASSWORD

if (-not $key) { throw "Falta `$env:SHALOM_API_KEY" }
if (-not $email -or -not $pass) { throw "Faltan `$env:SHALOM_PRO_EMAIL / `$env:SHALOM_PRO_PASSWORD" }

# 1. El token de sesión. Esta llamada tarda ~90 s (hasta 2 min): el wrapper hace
#    un login real contra pro.shalom.pe. No es que se haya colgado.
Write-Host "Pidiendo el token de sesion (~90 s, es un login real)..." -ForegroundColor Yellow
$sess = Invoke-RestMethod -Uri "$Base/v1/shalom/sessions" -Method Post -TimeoutSec 200 `
  -Headers @{ "X-API-Key" = $key } -ContentType "application/json" `
  -Body (@{ email = $email; password = $pass } | ConvertTo-Json)

if (-not $sess.session_token) { throw "No se obtuvo token de sesion." }
Write-Host "Token obtenido." -ForegroundColor Green

# 2. El ticket. Ojo a la ruta: `/v1/orders/{ose}/voucher`, hermana del rotulo.
#    Bajo `/v1/tracking` no existe, y ese 404 nos tuvo meses creyendo que el
#    documento no se podia obtener.
Invoke-WebRequest -Uri "$Base/v1/orders/$Ose/voucher" -TimeoutSec 120 `
  -Headers @{ "X-API-Key" = $key; "X-Shalom-Session" = $sess.session_token } `
  -OutFile $Out

# Un PDF de verdad empieza por "%PDF-". Si llegó un JSON de error, el archivo se
# habría guardado igual y parecería que funcionó.
$head = [System.Text.Encoding]::ASCII.GetString([System.IO.File]::ReadAllBytes((Resolve-Path $Out))[0..4])
if ($head -eq "%PDF-") {
  Write-Host "OK: $Out ($((Get-Item $Out).Length) bytes)" -ForegroundColor Green
} else {
  Write-Host "Lo que llegó NO es un PDF:" -ForegroundColor Red
  Get-Content $Out -TotalCount 5
}

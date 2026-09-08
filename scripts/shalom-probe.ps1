# Corre la sonda de Shalom desde Windows.
#
# Existe porque PowerShell no entiende el `VAR=valor comando` de bash: ahí
# `SHALOM_GUIA=95040633 node ...` se interpreta como el NOMBRE de un programa a
# ejecutar, y el error que devuelve —«no se reconoce como cmdlet»— no da ninguna
# pista de que el problema sea la sintaxis y no el script.
#
# Es solo lectura: no crea ni borra ninguna guía.
#
# Uso, desde la raíz del repo:
#   $env:SHALOM_API_KEY='sk_…'
#   $env:SHALOM_PRO_EMAIL='…'
#   $env:SHALOM_PRO_PASSWORD='…'
#   .\scripts\shalom-probe.ps1 -Guia 95040633 -Codigo PMC3

[CmdletBinding()]
param(
  # El nº de orden y el código VAN JUNTOS: por separado la API responde un 422
  # que parece decir «esa guía no existe», y no lo dice.
  [string]$Guia,
  [string]$Codigo,
  # Si ya conoces el `ose_id` (el id interno, no el nº de orden), va solo.
  [int]$Ose,
  [string]$AgencyQ
)

$ErrorActionPreference = "Stop"

# La sonda vive junto a este archivo; el repo es su carpeta padre. Así funciona
# se llame desde donde se llame, que es la otra mitad del problema.
$repo = Split-Path -Parent $PSScriptRoot
$probe = Join-Path $PSScriptRoot "shalom-probe.mjs"
if (-not (Test-Path $probe)) { throw "No encuentro $probe. ¿Estás en el repo clonado?" }

if (-not $env:SHALOM_API_KEY) {
  throw "Falta `$env:SHALOM_API_KEY. Ponla con:  `$env:SHALOM_API_KEY='sk_…'"
}
if (-not $Guia -and -not $Ose) {
  Write-Host "Sin -Guia/-Codigo ni -Ose no se rastrea ninguna guía; solo se prueban las rutas." -ForegroundColor Yellow
}
if ($Guia -and -not $Codigo) {
  throw "Con -Guia hace falta -Codigo: por separado la API responde 422."
}

if ($Guia) { $env:SHALOM_GUIA = $Guia }
if ($Codigo) { $env:SHALOM_CODIGO = $Codigo }
if ($Ose) { $env:SHALOM_OSE = "$Ose" }
if ($AgencyQ) { $env:SHALOM_AGENCY_Q = $AgencyQ }

Write-Host "La primera llamada tarda ~90 s: es un login real contra pro.shalom.pe." -ForegroundColor Yellow

Push-Location $repo
try { node $probe } finally { Pop-Location }

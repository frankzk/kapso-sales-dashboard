# Corre la sonda de Flow.cl desde Windows.
#
# Existe por lo mismo que `shalom-probe.ps1`: PowerShell no entiende el
# `VAR=valor comando` de bash. Ahí `FLOWCL_API_KEY='...' node ...` se interpreta
# como el NOMBRE de un programa a ejecutar, y el error —«no se reconoce como
# cmdlet»— no da ninguna pista de que el problema sea la sintaxis.
#
# NO ES SOLO LECTURA: crea órdenes de pago. Están clavadas al SANDBOX, así que
# no mueven plata, pero no es una sonda inocua como la de Shalom.
#
# Uso, desde donde sea (resuelve el repo solo):
#   $env:FLOWCL_API_KEY='...'
#   $env:FLOWCL_SECRET_KEY='...'
#   .\scripts\flow-probe.ps1
#
# Opcionales:
#   .\scripts\flow-probe.ps1 -Amount 20 -Methods '9,170,152,169' -Email 'tu@correo.com'

[CmdletBinding()]
param(
  # Monto del cobro de prueba. El cobro de VERDAD no lleva el número escrito:
  # lo lee de `lib/adelanto-minimo.ts`, que es el único sitio donde vive.
  [double]$Amount = 20,
  # Medios a probar. `9` = todos: enseña la página de selección de Flow, que es
  # donde se leen los nombres reales de cada medio Yape.
  [string]$Methods = '9,170,152,169',
  [string]$Email,
  [string]$ReturnUrl
)

$ErrorActionPreference = "Stop"

# La sonda vive junto a este archivo; el repo es su carpeta padre. Así funciona
# se llame desde donde se llame, que es la otra mitad del problema.
$probe = Join-Path $PSScriptRoot "flow-probe.mjs"
if (-not (Test-Path $probe)) { throw "No encuentro $probe. ¿Estás en el repo clonado?" }

if (-not $env:FLOWCL_API_KEY -or -not $env:FLOWCL_SECRET_KEY) {
  throw @"
Faltan las credenciales. Ponlas así (son las de SANDBOX, no las de producción):
  `$env:FLOWCL_API_KEY='...'
  `$env:FLOWCL_SECRET_KEY='...'
Se obtienen en https://sandbox.flow.cl/app/web/misDatos.php
"@
}

# Los procesos hijo heredan `$env:`, así que basta con ponerlas antes de llamar
# a node. Solo se fijan las que el usuario pasó: lo demás lo decide el .mjs.
$env:FLOWCL_AMOUNT = $Amount
$env:FLOWCL_METHODS = $Methods
if ($Email) { $env:FLOWCL_EMAIL = $Email }
if ($ReturnUrl) { $env:FLOWCL_RETURN_URL = $ReturnUrl }

node $probe

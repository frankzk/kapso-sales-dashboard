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
  [string]$ReturnUrl,
  # Segundos hasta que la orden caduca. Importa en producción: una orden de
  # sonda sin caducidad queda pagable para siempre.
  [int]$Timeout = 900,
  # Corre contra PRODUCCIÓN. Hace falta porque los IDs de medio de pago del
  # panel son de producción y el sandbox no los tiene: cuál de los dos Yape es
  # «One Shot» no se puede responder en otro sitio. Crea órdenes PENDIENTES
  # —no mueven plata mientras nadie las pague— y pide confirmación.
  [switch]$Prod,
  # Solo diagnostica a qué ambiente pertenece la credencial. No crea nada: son
  # GETs. Es lo primero que hay que correr ante un «apiKey not found».
  [switch]$Check
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
$env:FLOWCL_TIMEOUT = $Timeout
if ($Email) { $env:FLOWCL_EMAIL = $Email }
if ($ReturnUrl) { $env:FLOWCL_RETURN_URL = $ReturnUrl }

if ($Check) {
  # Una llave cortada al pegar produce el MISMO «apiKey not found» que una de
  # otro ambiente. Se ven los largos —no los valores— para separar los dos
  # casos antes de culpar al ambiente.
  Write-Host ("apiKey: {0} chars, empieza en {1}" -f $env:FLOWCL_API_KEY.Length,
    $env:FLOWCL_API_KEY.Substring(0, [Math]::Min(8, $env:FLOWCL_API_KEY.Length))) -ForegroundColor Cyan
  Write-Host ("secret: {0} chars" -f $env:FLOWCL_SECRET_KEY.Length) -ForegroundColor Cyan
  $env:FLOWCL_CHECK = "1"
  Remove-Item Env:\FLOWCL_API_BASE -ErrorAction SilentlyContinue
  node $probe
  Remove-Item Env:\FLOWCL_CHECK -ErrorAction SilentlyContinue
  return
}
Remove-Item Env:\FLOWCL_CHECK -ErrorAction SilentlyContinue

if ($Prod) {
  Write-Host "PRODUCCIÓN: se van a crear $(($Methods -split ',').Count) órdenes reales de S/ $Amount." -ForegroundColor Yellow
  Write-Host "Quedan PENDIENTES y caducan en $Timeout s. No completes el pago al abrir los links." -ForegroundColor Yellow
  if ((Read-Host "Escribe PRODUCCION para continuar") -ne "PRODUCCION") { throw "Cancelado." }
  $env:FLOWCL_API_BASE = "https://www.flow.cl/api"
  $env:FLOWCL_ALLOW_PROD = "1"
} else {
  # `$env:` sobrevive a la llamada: sin esto, un `-Prod` de hace diez minutos
  # dejaría la siguiente corrida apuntando a producción SIN avisar, que es
  # exactamente el accidente que el freno de mano existe para evitar.
  Remove-Item Env:\FLOWCL_API_BASE -ErrorAction SilentlyContinue
  Remove-Item Env:\FLOWCL_ALLOW_PROD -ErrorAction SilentlyContinue
}

node $probe

// La extensión de Chrome «Kapta · Swayp», generada por organización.
//
// Qué hace: en una pestaña del panel de Swayp (ce.swayp.co) con la sesión
// abierta, lee la sesión que el propio panel guarda en el navegador
// (localStorage «userSWC»: token, RUC, correo, id de empresa) y se la envía a
// Kapta (`/api/swayp/session`). Kapta la reutiliza para el sync DIARIO del
// stock mientras está vigente. No inicia sesión, no toca el reCAPTCHA, no lee
// nada más del panel y sólo habla con Kapta.
//
// Se descarga desde Stock Swayp con la URL de Kapta y la llave de la
// organización ya dentro: no hay nada que configurar. Descargar otra vez
// genera una llave nueva y la anterior deja de servir.

import { zipSinCompresion } from "@/lib/zip";

export const VERSION_EXTENSION = "1.0.0";

/** Clave con la que el panel de Swayp guarda la sesión en el navegador. */
export const CLAVE_SESION_PANEL = "userSWC";

export function archivosExtensionSwayp(cfg: { kaptaUrl: string; llave: string }): Record<string, string> {
  const kaptaUrl = cfg.kaptaUrl.replace(/\/$/, "");
  const origen = new URL(kaptaUrl).origin;

  const manifest = {
    manifest_version: 3,
    name: "Kapta · Swayp",
    version: VERSION_EXTENSION,
    description:
      "Envía a Kapta tu sesión del panel de Swayp para sincronizar el stock una vez al día. Solo lectura de inventario.",
    permissions: ["storage"],
    host_permissions: ["https://ce.swayp.co/*", `${origen}/*`],
    background: { service_worker: "background.js" },
    content_scripts: [
      { matches: ["https://ce.swayp.co/*"], js: ["content.js"], run_at: "document_idle" },
    ],
    action: { default_title: "Kapta · Swayp", default_popup: "popup.html" },
  };

  const content = `// Lee la sesión que el panel de Swayp guarda en este navegador y se la pasa
// al service worker, que la envía a Kapta. No lee nada más.
(function () {
  function leer() {
    try {
      var raw = localStorage.getItem(${JSON.stringify(CLAVE_SESION_PANEL)});
      if (!raw) return null;
      var u = JSON.parse(raw);
      if (!u || !u.token) return null;
      return {
        token: String(u.token),
        email: String(u.email || ""),
        nit: String(u.nit || ""),
        idCompany: String(u.id || ""),
      };
    } catch (e) {
      return null;
    }
  }
  function enviar() {
    var s = leer();
    if (s) chrome.runtime.sendMessage({ tipo: "sesion-swayp", sesion: s });
  }
  enviar();
  // El panel es de una sola página: después de iniciar sesión no recarga.
  setInterval(enviar, 5 * 60 * 1000);
})();
`;

  const background = `// Envía la sesión de Swayp a Kapta. Generado para una organización.
var KAPTA_URL = ${JSON.stringify(kaptaUrl)};
var KAPTA_KEY = ${JSON.stringify(cfg.llave)};
// La misma sesión se reenvía cada 6 h (por si ya toca sincronizar); si falló,
// se reintenta a los 30 min, no en cada vuelta.
var REENVIAR_OK_MS = 6 * 60 * 60 * 1000;
var REINTENTAR_MS = 30 * 60 * 1000;

async function huella(texto) {
  var d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(texto));
  return Array.from(new Uint8Array(d)).map(function (b) { return b.toString(16).padStart(2, "0"); }).join("");
}

async function recibir(sesion) {
  var h = await huella(sesion.token);
  var guardado = await chrome.storage.local.get("ultimo");
  var u = guardado.ultimo;
  if (u && u.huella === h && Date.now() - u.at < (u.ok ? REENVIAR_OK_MS : REINTENTAR_MS)) return;
  var estado;
  try {
    var res = await fetch(KAPTA_URL + "/api/swayp/session", {
      method: "POST",
      headers: { "content-type": "application/json", "x-kapta-key": KAPTA_KEY },
      body: JSON.stringify(sesion),
    });
    var data = await res.json().catch(function () { return {}; });
    estado = { ok: res.ok && data.ok === true, mensaje: data.mensaje || "Kapta respondió " + res.status };
  } catch (e) {
    estado = { ok: false, mensaje: "No se pudo conectar con Kapta." };
  }
  await chrome.storage.local.set({ ultimo: { huella: h, at: Date.now(), ok: estado.ok, mensaje: estado.mensaje } });
  chrome.action.setBadgeBackgroundColor({ color: "#b91c1c" });
  chrome.action.setBadgeText({ text: estado.ok ? "" : "!" });
}

chrome.runtime.onMessage.addListener(function (msg) {
  if (msg && msg.tipo === "sesion-swayp" && msg.sesion) recibir(msg.sesion);
});
`;

  const popupHtml = `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<style>
  body { font: 13px/1.45 system-ui, sans-serif; width: 280px; margin: 0; padding: 14px; color: #0f172a; }
  h1 { font-size: 14px; margin: 0 0 6px; }
  p { margin: 6px 0 0; color: #475569; }
  .ok { color: #047857; }
  .error { color: #b91c1c; }
</style>
</head>
<body>
<h1>Kapta · Swayp</h1>
<p id="estado">Abre el panel de Swayp con tu sesión iniciada: la extensión le envía la sesión a Kapta y el stock se sincroniza una vez al día.</p>
<p id="cuando"></p>
<script src="popup.js"></script>
</body>
</html>
`;

  const popupJs = `chrome.storage.local.get("ultimo").then(function (g) {
  var u = g.ultimo;
  if (!u) return;
  var estado = document.getElementById("estado");
  estado.textContent = u.mensaje;
  estado.className = u.ok ? "ok" : "error";
  var min = Math.round((Date.now() - u.at) / 60000);
  document.getElementById("cuando").textContent =
    "Último envío: " + (min < 1 ? "hace un momento" : min < 60 ? "hace " + min + " min" : "hace " + Math.round(min / 60) + " h") + ".";
});
`;

  const leeme = `Kapta · Swayp — extensión de Chrome

Instalación (una vez, en la computadora que usa el panel de Swayp):
1. Descomprime este .zip en una carpeta que no vayas a borrar.
2. En Chrome abre chrome://extensions y activa «Modo de desarrollador».
3. «Cargar descomprimida» → elige la carpeta.

Uso: abre ce.swayp.co con tu sesión iniciada, como siempre. La extensión le
envía la sesión a Kapta y el stock se sincroniza solo, como mucho una vez al
día. El ícono muestra «!» si algo falló; haz clic para ver el detalle.

Si descargas la extensión otra vez desde Kapta, esta deja de funcionar:
reemplázala por la nueva.
`;

  return {
    "manifest.json": JSON.stringify(manifest, null, 2) + "\n",
    "content.js": content,
    "background.js": background,
    "popup.html": popupHtml,
    "popup.js": popupJs,
    "LEEME.txt": leeme,
  };
}

/** El .zip listo para descargar, con todo dentro de la carpeta `kapta-swayp/`. */
export function zipExtensionSwayp(cfg: { kaptaUrl: string; llave: string }): Uint8Array {
  const archivos = archivosExtensionSwayp(cfg);
  return zipSinCompresion(
    Object.fromEntries(Object.entries(archivos).map(([ruta, c]) => [`kapta-swayp/${ruta}`, c])),
  );
}

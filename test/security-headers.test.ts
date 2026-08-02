import { describe, expect, it } from "vitest";
import nextConfig from "../next.config";

// Guarda de los headers de seguridad.
//
// POR QUÉ EXISTE ESTE TEST. `Permissions-Policy: camera=()` (lista vacía) deniega
// la cámara también al propio origen, y el navegador no pregunta nada: rechaza
// getUserMedia en el acto. El síntoma en el almacén fue "no me salta la
// notificación de permiso" — se buscó el problema en los ajustes de Android, no
// en un header nuestro. El lector de QR del cotejo de oficina estuvo muerto sin
// que nada en el build fallara.
//
// El resto de las claves siguen cerradas: cerrar de más es tan caro como abrir
// de más, así que las dos direcciones quedan fijadas aquí.

/** Los headers que salen en toda ruta (`/:path*`), aplanados por clave. */
async function siteHeaders(): Promise<Map<string, string>> {
  const rules = await nextConfig.headers!();
  const map = new Map<string, string>();
  for (const rule of rules) {
    if (rule.source !== "/:path*") continue;
    for (const header of rule.headers) map.set(header.key, header.value);
  }
  return map;
}

describe("Permissions-Policy", () => {
  it("permite la cámara al propio origen — el lector de QR la necesita", async () => {
    const value = (await siteHeaders()).get("Permissions-Policy")!;
    expect(value).toContain("camera=(self)");
    // `camera=()` es justo lo que mató el lector: el navegador no llega a preguntar.
    expect(value).not.toMatch(/camera=\(\)/);
  });

  it("mantiene cerrado lo que la app no usa", async () => {
    const value = (await siteHeaders()).get("Permissions-Policy")!;
    expect(value).toContain("microphone=()");
    expect(value).toContain("geolocation=()");
    expect(value).toContain("browsing-topics=()");
  });
});

describe("resto de headers de seguridad", () => {
  it("siguen presentes en todas las rutas", async () => {
    const headers = await siteHeaders();
    expect(headers.get("X-Frame-Options")).toBe("DENY");
    expect(headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(headers.get("Referrer-Policy")).toBe("strict-origin-when-cross-origin");
    expect(headers.get("Strict-Transport-Security")).toContain("max-age=");
    expect(headers.get("Content-Security-Policy")).toContain("frame-ancestors 'none'");
  });

  it("no anuncia el framework", () => {
    expect(nextConfig.poweredByHeader).toBe(false);
  });
});

import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  debeSincronizar,
  HORAS_ENTRE_SYNCS,
  hashLlave,
  orgDeLlave,
  vencimientoDeToken,
} from "@/lib/swayp-inventory-session";
import { archivosExtensionSwayp, CLAVE_SESION_PANEL, zipExtensionSwayp } from "@/lib/swayp-extension";
import { crc32, zipSinCompresion } from "@/lib/zip";

// El sync diario reutiliza la sesión de Swayp que una persona abrió. Estas
// pruebas fijan hasta cuándo se usa, cada cuánto corre, y qué lleva la
// extensión que la envía. Ninguna toca la red ni la base.

function jwt(payload: Record<string, unknown>): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${b64({ alg: "HS256", typ: "JWT" })}.${b64(payload)}.firma`;
}

describe("vencimientoDeToken", () => {
  it("lee el exp del JWT (también con «Bearer » delante)", () => {
    const exp = 1_790_700_000;
    expect(vencimientoDeToken(jwt({ exp }))?.getTime()).toBe(exp * 1000);
    expect(vencimientoDeToken(`Bearer ${jwt({ exp })}`)?.getTime()).toBe(exp * 1000);
  });

  it("null si no es un JWT o no trae exp", () => {
    expect(vencimientoDeToken("no-es-un-jwt")).toBeNull();
    expect(vencimientoDeToken(jwt({ sub: "x" }))).toBeNull();
    expect(vencimientoDeToken("a.@@@.c")).toBeNull();
  });
});

describe("debeSincronizar", () => {
  const ahora = new Date("2026-09-29T15:00:00Z");
  it("sí si nunca se sincronizó", () => {
    expect(debeSincronizar(null, ahora)).toBe(true);
  });
  it("no si la última buena fue hace menos de 20 h; sí desde las 20 h", () => {
    expect(HORAS_ENTRE_SYNCS).toBe(20);
    expect(debeSincronizar(new Date("2026-09-28T20:00:00Z"), ahora)).toBe(false); // 19 h
    expect(debeSincronizar(new Date("2026-09-28T19:00:00Z"), ahora)).toBe(true); // 20 h
  });
});

describe("llave de la extensión", () => {
  it("el hash es sha256 hex y estable", () => {
    expect(hashLlave("kse_abc")).toMatch(/^[0-9a-f]{64}$/);
    expect(hashLlave(" kse_abc ")).toBe(hashLlave("kse_abc"));
  });

  it("una llave mal formada se rechaza sin consultar la base", async () => {
    const admin = new Proxy({}, {
      get() {
        throw new Error("no debía consultar la base");
      },
    }) as SupabaseClient;
    expect(await orgDeLlave(admin, "")).toBeNull();
    expect(await orgDeLlave(admin, "otra-cosa")).toBeNull();
  });
});

describe("zipSinCompresion", () => {
  it("crc32 de referencia", () => {
    expect(crc32(new TextEncoder().encode("123456789"))).toBe(0xcbf43926);
  });

  it("arma cabeceras locales, directorio central y fin con los conteos correctos", () => {
    const zip = zipSinCompresion({ "a.txt": "hola", "b/c.txt": "mundo" });
    const v = new DataView(zip.buffer);
    expect(v.getUint32(0, true)).toBe(0x04034b50);
    const fin = zip.length - 22;
    expect(v.getUint32(fin, true)).toBe(0x06054b50);
    expect(v.getUint16(fin + 10, true)).toBe(2); // entradas
    const inicioCentral = v.getUint32(fin + 16, true);
    expect(v.getUint32(inicioCentral, true)).toBe(0x02014b50);
    // El contenido va sin comprimir, legible tal cual.
    expect(new TextDecoder().decode(zip)).toContain("hola");
  });
});

describe("extensión Kapta · Swayp", () => {
  const cfg = { kaptaUrl: "https://kapta.example.com/", llave: "kse_" + "a".repeat(48) };

  it("sólo pide permiso para el panel de Swayp y para Kapta", () => {
    const m = JSON.parse(archivosExtensionSwayp(cfg)["manifest.json"]!);
    expect(m.manifest_version).toBe(3);
    expect(m.host_permissions).toEqual(["https://ce.swayp.co/*", "https://kapta.example.com/*"]);
    expect(m.permissions).toEqual(["storage"]);
    expect(m.content_scripts[0].matches).toEqual(["https://ce.swayp.co/*"]);
  });

  it("lee la sesión del panel y la envía a Kapta con la llave", () => {
    const f = archivosExtensionSwayp(cfg);
    expect(f["content.js"]).toContain(JSON.stringify(CLAVE_SESION_PANEL));
    expect(f["background.js"]).toContain('var KAPTA_URL = "https://kapta.example.com"');
    expect(f["background.js"]).toContain(JSON.stringify(cfg.llave));
    expect(f["background.js"]).toContain("/api/swayp/session");
  });

  it("el zip lleva todo dentro de kapta-swayp/", () => {
    const texto = new TextDecoder().decode(zipExtensionSwayp(cfg));
    for (const f of ["manifest.json", "content.js", "background.js", "popup.html", "popup.js", "LEEME.txt"]) {
      expect(texto).toContain(`kapta-swayp/${f}`);
    }
  });
});

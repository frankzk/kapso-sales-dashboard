// «Llamar con Anura», fase 2: la configuración SIP (lib/anura/sip.ts).
//   - el dominio se limpia de «sip:», usuario y puerto;
//   - la URL WebSocket solo puede ser wss:// a anura.pe y sin puerto (la CSP
//     no deja otra), y vacía es la de Perú; anura.dev (Argentina) no sirve;
//   - el usuario por defecto es `<anexo>-websocket`; la clave se recorta.

import { describe, expect, it } from "vitest";
import {
  ANURA_DEFAULT_SIP_PORT,
  ANURA_DEFAULT_WS_URL,
  defaultSipUser,
  isAnuraPeHost,
  looksLikeWebsocketUser,
  normalizeAnuraWsUrl,
  normalizeSipDomain,
  normalizeSipPassword,
  normalizeSipPort,
  normalizeSipUser,
} from "@/lib/anura/sip";

describe("el dominio SIP de la central", () => {
  it("se limpia de lo que se pega del panel", () => {
    expect(normalizeSipDomain("  Kenku.Anura.PE ")).toBe("kenku.anura.pe");
    expect(normalizeSipDomain("sip:101-websocket@kenku.anura.pe:55090")).toBe("kenku.anura.pe");
    expect(normalizeSipDomain("kenku.anura.pe;transport=wss")).toBe("kenku.anura.pe");
  });
  it("rechaza lo que no es un dominio", () => {
    for (const bad of ["", "kenku", "kenku .anura.pe", "-x.anura.pe", "x_y.anura.pe", 42, null]) expect(normalizeSipDomain(bad)).toBeNull();
  });
});

describe("la URL WebSocket", () => {
  it("vacía es la de Perú", () => {
    expect(normalizeAnuraWsUrl("")).toBe(ANURA_DEFAULT_WS_URL);
    expect(normalizeAnuraWsUrl(null)).toBe("wss://sipwss.anura.pe");
  });
  it("acepta solo wss:// a anura.pe, sin puerto", () => {
    expect(normalizeAnuraWsUrl("wss://SIPWSS.anura.pe/")).toBe("wss://sipwss.anura.pe");
    expect(normalizeAnuraWsUrl("wss://sipwss.anura.pe:443/ws")).toBe("wss://sipwss.anura.pe/ws");
    for (const bad of [
      "ws://sipwss.anura.pe",
      "wss://sip.anura.dev",
      "wss://sipwss.anura.pe:8089",
      "wss://sipwss.anura.pe.evil.com",
      "wss://evilanura.pe",
      // El dominio raíz: la CSP (wss://*.anura.pe) no lo cubre.
      "wss://anura.pe",
      "wss://u:p@sipwss.anura.pe",
      "wss://sipwss.anura.pe/?x=1",
      "https://sipwss.anura.pe",
      "no es url",
    ]) {
      expect(normalizeAnuraWsUrl(bad), bad).toBeNull();
    }
    expect(isAnuraPeHost("anura.pe")).toBe(false);
    expect(isAnuraPeHost(".anura.pe")).toBe(false);
    expect(isAnuraPeHost("x.anura.pe")).toBe(true);
    expect(isAnuraPeHost("xanura.pe")).toBe(false);
  });
  it("todo host que acepta lo deja pasar la CSP (connect-src)", async () => {
    const { default: config } = await import("../next.config");
    const rules = await (config as { headers: () => Promise<{ headers: { key: string; value: string }[] }[]> }).headers();
    const csp = rules.flatMap((r) => r.headers).find((h) => h.key.toLowerCase() === "content-security-policy")!.value;
    const connect = csp.split(";").map((d) => d.trim()).find((d) => d.startsWith("connect-src "))!.split(/\s+/).slice(1);
    const allows = (host: string) =>
      connect.some((src) => src === `wss://${host}` || (src.startsWith("wss://*.") && host.endsWith(src.slice("wss://*".length))));
    for (const url of ["wss://sipwss.anura.pe", "wss://x.anura.pe/ws", "wss://a.b.anura.pe"]) {
      const ok = normalizeAnuraWsUrl(url);
      expect(ok, url).not.toBeNull();
      expect(allows(new URL(ok!).hostname), url).toBe(true);
    }
    expect(allows("anura.pe")).toBe(false);
    expect(normalizeAnuraWsUrl("wss://anura.pe")).toBeNull();
  });
});

describe("puerto, usuario y clave", () => {
  it("el puerto por defecto es 55090", () => {
    expect(normalizeSipPort("")).toBe(ANURA_DEFAULT_SIP_PORT);
    expect(normalizeSipPort("5060")).toBe(5060);
    expect(normalizeSipPort(0)).toBeNull();
    expect(normalizeSipPort("70000")).toBeNull();
  });
  it("el usuario por defecto es el de la terminal web", () => {
    expect(defaultSipUser("101")).toBe("101-websocket");
    expect(normalizeSipUser("", "101")).toBe("101-websocket");
    expect(normalizeSipUser(" sip:101-websocket ", "101")).toBe("101-websocket");
    expect(normalizeSipUser("101 websocket", "101")).toBeNull();
    expect(normalizeSipUser("101@kenku", "101")).toBeNull();
    expect(looksLikeWebsocketUser("101-websocket")).toBe(true);
    expect(looksLikeWebsocketUser("101")).toBe(false);
  });
  it("la clave se recorta y no puede estar vacía", () => {
    expect(normalizeSipPassword("  s3cr3t  ")).toBe("s3cr3t");
    expect(normalizeSipPassword("   ")).toBeNull();
    expect(normalizeSipPassword("a\nb")).toBeNull();
    expect(normalizeSipPassword("x".repeat(129))).toBeNull();
    expect(normalizeSipPassword(undefined)).toBeNull();
  });
});

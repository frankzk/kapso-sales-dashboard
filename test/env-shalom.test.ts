import { describe, it, expect, afterEach } from "vitest";
import { env } from "@/lib/env";

// Pegar un secreto en el panel de Vercel arrastra un espacio o un salto de línea
// con muchísima facilidad, y Vercel no los limpia. Sin recortar, ese blanco
// viaja DENTRO de la cabecera `X-API-Key` y Shalom responde «api key inválida»:
// un 401 indistinguible del de una key caducada, que manda a pedirle una nueva
// al proveedor —lento, y la key vence— para arreglar un espacio en blanco.
//
// Pasó en producción, y lo que lo hizo difícil de ver es que la sonda del repo
// (`scripts/shalom-probe.mjs`) SÍ recortaba: la misma key funcionaba desde la
// terminal y fallaba en el despliegue. Estos tests fijan que las dos mitades se
// comporten igual.

const originalKey = process.env.SHALOM_API_KEY;
const originalBase = process.env.SHALOM_API_BASE;

const restore = (name: string, value: string | undefined) => {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
};

afterEach(() => {
  restore("SHALOM_API_KEY", originalKey);
  restore("SHALOM_API_BASE", originalBase);
});

describe("env.shalomApiKey", () => {
  it("recorta los blancos que deja un copiar/pegar", () => {
    process.env.SHALOM_API_KEY = "  sk_abc123\n";
    expect(env.shalomApiKey()).toBe("sk_abc123");
  });

  it("una key que es solo blancos cuenta como ausente", () => {
    // Si contara como presente, el panel diría «api key inválida» en vez de
    // «falta SHALOM_API_KEY», que son dos arreglos distintos.
    process.env.SHALOM_API_KEY = "   ";
    expect(env.shalomConfigured()).toBe(false);
  });

  it("una key de verdad sigue estando configurada", () => {
    process.env.SHALOM_API_KEY = "sk_abc123";
    expect(env.shalomConfigured()).toBe(true);
  });
});

describe("env.shalomApiBase", () => {
  it("recorta blancos y la barra final", () => {
    process.env.SHALOM_API_BASE = "  https://api.shalom-api-peru.com/  ";
    expect(env.shalomApiBase()).toBe("https://api.shalom-api-peru.com");
  });

  it("sin variable, el valor por defecto ya es el correcto", () => {
    delete process.env.SHALOM_API_BASE;
    expect(env.shalomApiBase()).toBe("https://api.shalom-api-peru.com");
  });
});


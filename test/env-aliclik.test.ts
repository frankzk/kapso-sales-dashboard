import { describe, it, expect, afterEach } from "vitest";
import { env } from "@/lib/env";

// La salida por defecto hacia Aliclik no es una preferencia de estilo: la
// directa NO llega. Cloudflare desafía las peticiones que salen de las
// funciones Node (IPs de datacenter de AWS) y responde 403 sin que la API las
// vea — comprobado desde Virginia y São Paulo. Por Edge, la misma petición con
// el mismo token responde 200.
//
// Este test existe para que nadie "limpie" ese default pensando que `direct`
// es lo natural y deje la integración muerta sin enterarse.

const original = process.env.ALICLIK_EGRESS;
afterEach(() => {
  if (original === undefined) delete process.env.ALICLIK_EGRESS;
  else process.env.ALICLIK_EGRESS = original;
});

describe("env.aliclikEgress", () => {
  it("por defecto sale por Edge, que es la única vía que llega", () => {
    delete process.env.ALICLIK_EGRESS;
    expect(env.aliclikEgress()).toBe("edge");
  });

  it("ALICLIK_EGRESS=direct es la vía de escape cuando Aliclik ajuste su WAF", () => {
    process.env.ALICLIK_EGRESS = "direct";
    expect(env.aliclikEgress()).toBe("direct");
  });

  it("un valor desconocido no rompe la integración: se queda en Edge", () => {
    process.env.ALICLIK_EGRESS = "cualquier-cosa";
    expect(env.aliclikEgress()).toBe("edge");
  });
});

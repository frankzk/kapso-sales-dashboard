// Simular GF Courier (MOM §29.17, owner 16-11-2026): qué impide crear la guía, sin crear ninguna. Se fija lo puro
// (external_id «-SIM», la fecha pasada, el valor enviado, el resumen y el ritmo), el cliente de /v1/orders/validate,
// que la simulación arma el MISMO cuerpo que la creación y que nada escribe.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { gfCourier, type GfOrderInput } from "@/lib/gf-courier";
import {
  createPacer,
  GF_SIM_CHUNK,
  GF_SIM_INTERVAL_MS,
  GF_SIM_KAPTA_CODE,
  gfSimulationText,
  sentValue,
  simExternalId,
  summarizeGfSimulation,
  withoutPastSchedule,
  type GfSimOutcome,
} from "@/lib/gf-courier-simulation";

const read = (p: string) => readFileSync(resolve(process.cwd(), p), "utf8");

const input = (over: Partial<GfOrderInput> = {}): GfOrderInput => ({
  external_id: "#KP1001",
  service: "COD_LIMA",
  recipient: { first_name: "Ana", phone: "999000111" },
  destination: { district: "Surco", address: "Av. Siempre Viva 123" },
  items: [{ sku: "SKU-1", quantity: 1, unit_price: 89.9 }],
  payment: { total: 89.9, advance_paid: 0, amount_to_collect: 89.9 },
  ...over,
});

describe("external_id y fecha", () => {
  it("con guía en GF lleva «-SIM»; sin guía, el mismo", () => {
    expect(simExternalId("#KP1001", false)).toBe("#KP1001");
    expect(simExternalId("#KP1001-S2", true)).toBe("#KP1001-S2-SIM");
    const long = simExternalId("x".repeat(100), true);
    expect(long).toHaveLength(100);
    expect(long.endsWith("-SIM")).toBe(true);
  });

  it("una fecha programada pasada no se manda; hoy o después, sí", () => {
    expect(withoutPastSchedule(input({ scheduled_date: "2026-11-10" }), "2026-11-16")).not.toHaveProperty("scheduled_date");
    expect(withoutPastSchedule(input({ scheduled_date: "2026-11-16" }), "2026-11-16").scheduled_date).toBe("2026-11-16");
    expect(withoutPastSchedule(input({ scheduled_date: "2026-11-18" }), "2026-11-16").scheduled_date).toBe("2026-11-18");
    expect(withoutPastSchedule(input(), "2026-11-16")).toEqual(input());
  });
});

describe("el valor enviado en el campo de GF", () => {
  it("sigue la ruta del campo, también con índices", () => {
    expect(sentValue(input(), "destination.district")).toBe("Surco");
    expect(sentValue(input(), "items[0].sku")).toBe("SKU-1");
    expect(sentValue(input(), "recipient.phone")).toBe("999000111");
    expect(sentValue(input(), "payment.total")).toBe("89.9");
  });

  it("sin campo o sin valor, null; un objeto, en JSON corto", () => {
    expect(sentValue(input(), null)).toBeNull();
    expect(sentValue(input(), "destination.ubigeo")).toBeNull();
    expect(sentValue(input(), "items[3].sku")).toBeNull();
    expect(sentValue(input(), "recipient")).toBe('{"first_name":"Ana","phone":"999000111"}');
    expect(sentValue(input({ observations: "a".repeat(300) }), "observations")!.length).toBeLessThanOrEqual(200);
  });
});

describe("el resumen", () => {
  const ok = (order: string, store: string, taken = false, hadGuide = false): GfSimOutcome => ({ kind: "valid", order, store, takenFromAddress: taken, hadGuide });
  const err = (order: string, store: string, code: string, field: string | null, sent: string | null = null): GfSimOutcome =>
    ({ kind: "error", order, store, code, field, message: `${code} en ${field ?? "-"}`, sent, hadGuide: false });
  const outcomes: GfSimOutcome[] = [
    ok("#1", "Kenku", true), ok("#2", "Kenku"), ok("#3", "Aurela", true, true),
    err("#4", "Kenku", "DISTRICT_NOT_COVERED", "destination.district", "Huaral"),
    err("#5", "Kenku", "DISTRICT_NOT_COVERED", "destination.district", "Cañete"),
    err("#6", "Aurela", "DISTRICT_NOT_COVERED", "destination.district", "Chancay"),
    err("#7", "Aurela", "DISTRICT_NOT_COVERED", "destination.district", "Barranca"),
    err("#8", "Kenku", "SKU_NOT_FOUND", "items[0].sku", "X-1"),
    err("#9", "Kenku", GF_SIM_KAPTA_CODE, null),
  ];
  const s = summarizeGfSimulation(outcomes);

  it("cuenta revisados, válidos, errores, distrito tomado de la dirección y guías previas", () => {
    expect(s).toMatchObject({ total: 9, valid: 3, errors: 6, takenFromAddress: 2, withGuide: 1 });
    expect(s.byStore).toEqual([
      { store: "Aurela", total: 3, valid: 1, errors: 2 },
      { store: "Kenku", total: 6, valid: 2, errors: 4 },
    ]);
  });

  it("agrupa por código y campo, el más frecuente primero, con 3 ejemplos", () => {
    expect(s.groups.map((g) => [g.code, g.field, g.count])).toEqual([
      ["DISTRICT_NOT_COVERED", "destination.district", 4],
      [GF_SIM_KAPTA_CODE, null, 1],
      ["SKU_NOT_FOUND", "items[0].sku", 1],
    ]);
    expect(s.groups[0]!.examples).toHaveLength(3);
    expect(s.groups[0]!.examples[0]).toEqual({ order: "#4", store: "Kenku", message: "DISTRICT_NOT_COVERED en destination.district", sent: "Huaral" });
  });

  it("el texto para copiar lleva los totales y los ejemplos", () => {
    const text = gfSimulationText(s);
    expect(text).toContain("9 pedidos revisados");
    expect(text).toContain("Válidos: 3 · Con error: 6");
    expect(text).toContain("Válidos con el distrito tomado de la dirección: 2");
    expect(text).toContain("DISTRICT_NOT_COVERED · destination.district · 4");
    expect(text).toContain("#8: SKU_NOT_FOUND en items[0].sku · enviado: X-1");
  });
});

describe("el ritmo: 4 por segundo", () => {
  it("cada llamada espera su turno de 250 ms, aunque lleguen juntas", async () => {
    let clock = 1_000;
    const waits: number[] = [];
    const pace = createPacer(GF_SIM_INTERVAL_MS, () => clock, async (ms) => { waits.push(ms); });
    await Promise.all([pace(), pace(), pace(), pace()]);
    expect(GF_SIM_INTERVAL_MS).toBe(250);
    expect(waits).toEqual([250, 500, 750]);
    clock = 10_000;
    await pace();
    expect(waits).toHaveLength(3);
  });
});

describe("POST /v1/orders/validate", () => {
  it("manda el cuerpo con la clave de la tienda y sin Idempotency-Key", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({ valid: true, would_create: { shipping_cost: 10 }, destination: { ubigeo: "150140", district: "SANTIAGO DE SURCO", taken_from_address: true } }), { status: 200 });
    }) as unknown as typeof fetch;
    const res = await gfCourier.validateOrder({ apiToken: "tok_kenku", baseUrl: "https://gf.test", fetchImpl }, input());
    expect(res.ok && res.data.destination?.taken_from_address).toBe(true);
    expect(calls[0]!.url).toBe("https://gf.test/v1/orders/validate");
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer tok_kenku");
    expect(headers["Idempotency-Key"]).toBeUndefined();
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual(input());
  });

  it("un error de GF llega con su código, mensaje y campo", async () => {
    const fetchImpl = (async () => new Response(JSON.stringify({ error: { code: "DISTRICT_NOT_COVERED", message: "Sin cobertura", field: "destination.district" } }), { status: 422 })) as unknown as typeof fetch;
    const res = await gfCourier.validateOrder({ apiToken: "t", baseUrl: "https://gf.test", fetchImpl }, input());
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toEqual({ code: "DISTRICT_NOT_COVERED", message: "Sin cobertura", field: "destination.district" });
  });
});

describe("el mismo cuerpo que la creación, y solo lectura", () => {
  const sim = read("lib/gf-courier-simulate-server.ts");
  const core = read("lib/gf-courier-guide.ts");
  const access = read("lib/gf-courier-simulate-access.ts");
  const actions = read("app/dashboard/pedidos/gf-simulacion/actions.ts");

  it("hace las MISMAS lecturas y arma el cuerpo igual que `createGfGuideFor`", () => {
    for (const piece of [
      '"store_id,order_id,order_name,customer_name,customer_phone,region,province,district,address,reference,latitude,longitude,order_total,dispatch_scheduled_on,shipping_mode"',
      '.select("id,delivery_status,returned_at").eq("order_id", orderId).eq("courier", GF_COURIER)',
      '.from("orders").select("name,line_items,raw").eq("id", orderId)',
      '.in("kind", [...CUSTOMER_PAYMENT_KINDS]).eq("validation_status", "validado")',
      "const sequence = (shipments.data ?? []).length + 1;",
      "sequence > 1 ? `-S${sequence}` : \"\"",
      "ubigeo: wooTerritorio(order.data.raw)?.code ?? null",
      "(row.dispatch_scheduled_on && row.dispatch_scheduled_on >= new Date().toISOString().slice(0, 10) ? row.dispatch_scheduled_on : null)",
      "await reproAgreedGfDay(admin, orderId)",
      "buildGfOrderInput({",
    ]) {
      expect(core, `creación: ${piece}`).toContain(piece);
      expect(sim, `simulación: ${piece}`).toContain(piece);
    }
  });

  it("solo cambia el external_id («-SIM») y la fecha pasada, y llama a validate a ritmo", () => {
    expect(sim).toContain("withoutPastSchedule({ ...built.input, external_id: simExternalId(built.input.external_id, hadGuide) }, ctx.today)");
    expect(sim.indexOf("await ctx.pace();")).toBeLessThan(sim.indexOf("gfCourier.validateOrder("));
    expect(sim).toContain("createPacer(GF_SIM_INTERVAL_MS)");
  });

  it("no crea guías ni escribe en Kapta", () => {
    const code = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    for (const src of [sim, access, actions].map(code)) {
      expect(src).not.toMatch(/createOrder|createGfGuideFor|cancelOrder|\.insert\(|\.update\(|\.upsert\(|\.delete\(|\.rpc\(/);
    }
  });

  it("solo el owner, solo sus tiendas con token, y pasadas acotadas", () => {
    expect(access).toContain('.eq("role", "owner")');
    expect(access).toContain('.not("gf_courier_api_token_enc", "is", null)');
    expect(sim).toContain("if (!store) return fail(label, \"?\", \"La tienda del pedido no está en la simulación.\");");
    expect(actions).toContain("orderIds.length > GF_SIM_CHUNK");
    expect(GF_SIM_CHUNK).toBe(120);
  });

  it("los pedidos: Lima y Callao, 90 días, sin anular, contraentrega o manuales", () => {
    expect(sim).toContain('.or("region.ilike.*lima*,region.ilike.*callao*")');
    expect(sim).toContain("if (o.cancelled_at) continue;");
    expect(sim).toContain('mode.get(o.id) === "cod" || (o.payment_gateway && gateways.has(o.payment_gateway))');
    expect(read("lib/gf-courier-simulation.ts")).toContain('export const GF_SIM_GATEWAYS = ["cod", "manual"] as const;');
  });

  it("el MOM lo registra", () => {
    const mom = read("docs/mom/master-pedidos-v1.md").replace(/\s+/g, " ");
    expect(mom).toContain("#### Simular GF Courier: qué impide crear la guía (owner, 16-11-2026)");
    expect(mom).toContain("el `external_id` lleva **«-SIM»**");
    expect(mom).toContain("**Nada se guarda.**");
  });
});

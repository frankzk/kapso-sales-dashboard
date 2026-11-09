// «Pago solo online (lista automática)» (MOM §41.11): la corrida, el envío a
// las tiendas, los reintentos y el freno de la lista de pago adelantado, con
// una base falsa y una tienda falsa. Lo que se fija:
//   - Apagado no hace nada; Simulación cuenta y no manda ni frena;
//   - Activo guarda la corrida, la deja vigente y la manda a CADA tienda por
//     separado, con Basic auth a /wp-json/cod-core/v1/pago-solo-online, y
//     verifica con un GET;
//   - el cron calcula una sola vez al día (el candado);
//   - 5xx reintenta a los 1 minuto; 401 no; 404 se registra sin reintento;
//   - el freno de cambio brusco no manda, no cambia la lista vigente y avisa;
//   - el registro y la respuesta nunca llevan los celulares;
//   - `prepayOrderCheck` frena por la lista automática con el adelanto por
//     defecto, y la lista de pago adelantado sigue mandando (pide el total).

import { beforeEach, describe, expect, it, vi } from "vitest";
import { FakeDb, type Row } from "./woocommerce-fake-db";

vi.mock("server-only", () => ({}));
const telegram: string[] = [];
vi.mock("@/lib/aliclik-scheduled-server", () => ({
  telegramTarget: async () => ({ token: "t", chats: "1", storeName: "x" }),
}));
vi.mock("@/lib/telegram", () => ({
  escapeHtml: (s: string) => s,
  sendTelegramToAll: async (_t: string, _c: string, text: string) => {
    telegram.push(text);
    return { sent: 1, total: 1, results: [] };
  },
}));
vi.mock("@/lib/woocommerce-intake", () => ({
  loadWooStoreCreds: async (_admin: unknown, storeId: string) => ({
    creds:
      storeId === "s-sin-claves"
        ? { siteUrl: "https://sinclaves.pe", consumerKey: null, consumerSecret: null }
        : { siteUrl: storeId === "s-aur" ? "https://aurela.pe" : "https://kenku.pe", consumerKey: "ck_x", consumerSecret: "cs_y" },
    error: null,
  }),
}));

const { runPagoOnlineForOrg, runPagoOnlineDaily, processPagoOnlineRetries, sendPagoOnlineTest, emptyPagoOnlineStore } = await import("@/lib/pago-online-server");
const { pagoOnlineListedAmong } = await import("@/lib/pago-online-lookup");
const { withPagoOnlineListed } = await import("@/lib/pago-online");
const { prepayOrderCheck } = await import("@/lib/prepay-list-server");

const ORG = "22222222-2222-4222-8222-222222222222";
const LIST = [
  { p: "987654321", f: 2, r: "devuelto", o: 3, e: ["a@x.pe"] },
  { p: "912345678", f: 4, r: "anulador", o: 5, e: [] as string[] },
];

class PagoDb extends FakeDb {
  list = LIST;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async rpc(name: string, args: any): Promise<any> {
    this.rpcCalls.push({ name, args });
    if (name === "pago_online_build") {
      if (args.p_run) for (const r of this.list) this.rows("pago_online_phones").push({ run_id: args.p_run, org_id: args.p_org, phone: r.p, failed: r.f, reason: r.r, orders: r.o, emails: r.e });
      return {
        data: {
          phones: this.list.length,
          emails: this.list.reduce((n, r) => n + r.e.length, 0),
          two_or_more: this.list.filter((r) => r.r === "devuelto" && r.f >= 2).length,
          anuladores: this.list.filter((r) => r.r === "anulador").length,
          excepted: 0,
          por_confirmar_listed: 3,
          por_confirmar_braked: 2,
        },
        error: null,
      };
    }
    if (name === "pago_online_lookup") {
      const s = this.rows("pago_online_settings").find((r) => r.org_id === args.p_org && r.mode === "activo");
      if (!s) return { data: [], error: null };
      const hit = this.rows("pago_online_phones").find((r) => r.run_id === s.current_run_id && r.phone === args.p_phone);
      return {
        data: [{ listed: !!hit, failed: hit?.failed ?? null, reason: hit?.reason ?? null, orders: hit?.orders ?? null, requirement: s.requirement ?? "adelanto" }],
        error: null,
      };
    }
    return { data: null, error: null };
  }
}

const seed = (mode: string, extra: Record<string, Row[]> = {}) =>
  new PagoDb({
    pago_online_settings: [{ org_id: ORG, mode, requirement: "adelanto", current_run_id: null }],
    stores: [
      { id: "s-ken", org_id: ORG, name: "Kenku Peru", status: "active", platform: "woocommerce" },
      { id: "s-aur", org_id: ORG, name: "Aurela", status: "active", platform: "woocommerce" },
      { id: "s-shop", org_id: ORG, name: "Vieja", status: "active", platform: "shopify" },
    ],
    ...extra,
  });

type Call = { url: string; method: string; auth: string | null; body: any };
function fakeStore(answer: (call: Call) => { status: number; body?: unknown }) {
  const calls: Call[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    const headers = (init.headers ?? {}) as Record<string, string>;
    const call = { url, method: init.method ?? "GET", auth: headers.Authorization ?? null, body: init.body ? JSON.parse(String(init.body)) : null };
    calls.push(call);
    const a = answer(call);
    return new Response(a.body === undefined ? "" : JSON.stringify(a.body), { status: a.status, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}
const ok = (call: Call) =>
  call.method === "POST"
    ? { status: 200, body: { descartados: 0, celulares: call.body.celulares.length, correos: call.body.correos.length, actualizado: "2026-11-10T10:00:02+00:00", regla: call.body.regla } }
    : { status: 200, body: { celulares: 2, correos: 1, actualizado: "2026-11-10T10:00:02+00:00", regla: "r" } };

const NOW = new Date("2026-11-10T10:00:00Z");

beforeEach(() => {
  telegram.length = 0;
});

describe("la corrida", () => {
  it("Apagado no hace nada", async () => {
    const db = seed("apagado");
    const store = fakeStore(ok);
    const r = await runPagoOnlineForOrg(db.client(), { orgId: ORG, trigger: "cron", now: NOW, fetchImpl: store.fetchImpl });
    expect(r.skipped).toBe("apagado");
    expect(db.rows("pago_online_runs")).toHaveLength(0);
    expect(store.calls).toHaveLength(0);
  });

  it("Simulación cuenta y no manda, no guarda celulares ni deja una lista vigente", async () => {
    const db = seed("simulacion");
    const store = fakeStore(ok);
    const r = await runPagoOnlineForOrg(db.client(), { orgId: ORG, trigger: "cron", now: NOW, fetchImpl: store.fetchImpl });
    expect(r.error).toBeNull();
    expect(r.counts).toMatchObject({ phones: 2, emails: 1, por_confirmar_braked: 2 });
    expect(db.rpcCalls.find((c) => c.name === "pago_online_build")?.args).toEqual({ p_org: ORG, p_run: null, p_requirement: "adelanto" });
    expect(store.calls).toHaveLength(0);
    expect(db.rows("pago_online_phones")).toHaveLength(0);
    expect(db.rows("pago_online_settings")[0]!.current_run_id).toBeNull();
    expect(db.rows("pago_online_runs")[0]).toMatchObject({ mode: "simulacion", status: "listo", phones: 2, guard: "primera" });
  });

  it("Activo: la lista vigente, a cada tienda WooCommerce por separado, con Basic auth, y el GET de verificación", async () => {
    const db = seed("activo");
    const store = fakeStore(ok);
    const r = await runPagoOnlineForOrg(db.client(), { orgId: ORG, trigger: "cron", now: NOW, fetchImpl: store.fetchImpl });
    expect(r.error).toBeNull();
    expect(db.rows("pago_online_settings")[0]!.current_run_id).toBe(r.runId);
    const posts = store.calls.filter((c) => c.method === "POST");
    expect(posts.map((c) => c.url)).toEqual([
      "https://kenku.pe/wp-json/cod-core/v1/pago-solo-online",
      "https://aurela.pe/wp-json/cod-core/v1/pago-solo-online",
    ]);
    expect(posts[0]!.auth).toBe(`Basic ${Buffer.from("ck_x:cs_y").toString("base64")}`);
    expect(posts[0]!.body).toEqual({
      celulares: ["912345678", "987654321"],
      correos: ["a@x.pe"],
      regla: "1+ devuelto, o 5+ pedidos con 75 % anulados, y 0 recibidas, Kenku Peru y Aurela, calculada 2026-11-10 05:00",
    });
    expect(store.calls.filter((c) => c.method === "GET")).toHaveLength(2);
    const sends = db.rows("pago_online_sends");
    expect(sends.map((s) => s.status)).toEqual(["enviado", "enviado"]);
    expect(sends[0]).toMatchObject({ kind: "diaria", attempt: 1, phones_sent: 2, emails_sent: 1, http_status: 200 });
    expect(sends[0]!.verify).toMatchObject({ celulares: 2 });
    // Nada del registro lleva un celular.
    expect(JSON.stringify(sends)).not.toMatch(/9\d{8}/);
    expect(JSON.stringify(r)).not.toMatch(/9\d{8}/);
  });

  it("el cron calcula una sola vez al día", async () => {
    const db = seed("activo");
    const store = fakeStore(ok);
    await runPagoOnlineDaily(db.client(), { now: NOW });
    const again = await runPagoOnlineForOrg(db.client(), { orgId: ORG, trigger: "cron", now: new Date("2026-11-10T10:01:00Z"), fetchImpl: store.fetchImpl });
    expect(again.skipped).toBe("ya_calculada");
    expect(db.rpcCalls.filter((c) => c.name === "pago_online_build")).toHaveLength(1);
  });

  it("si el cálculo falla, suelta el candado para el minuto siguiente", async () => {
    const db = seed("activo");
    db.rpc = async () => ({ data: null, error: { message: "timeout" } }) as any;
    const r = await runPagoOnlineForOrg(db.client(), { orgId: ORG, trigger: "cron", now: NOW });
    expect(r.error).toMatch(/calcular la lista/);
    expect(db.rows("pago_online_runs")[0]).toMatchObject({ status: "error", daily_key: null });
  });
});

describe("los envíos que fallan", () => {
  it("5xx: se reintenta al minuto, y el reintento manda la misma lista", async () => {
    const db = seed("activo");
    let fail = true;
    const store = fakeStore((c) => (fail && c.method === "POST" ? { status: 503, body: { code: "x", message: "caído" } } : ok(c)));
    await runPagoOnlineForOrg(db.client(), { orgId: ORG, trigger: "cron", now: NOW, fetchImpl: store.fetchImpl });
    const first = db.rows("pago_online_sends");
    expect(first.map((s) => s.status)).toEqual(["reintento", "reintento"]);
    expect(first[0]!.http_status).toBe(503);
    expect(first[0]!.next_attempt_at).toBe("2026-11-10T10:01:00.000Z");
    // Todavía no toca.
    expect(await processPagoOnlineRetries(db.client(), { now: new Date("2026-11-10T10:00:30Z"), fetchImpl: store.fetchImpl })).toEqual([]);
    fail = false;
    const retried = await processPagoOnlineRetries(db.client(), { now: new Date("2026-11-10T10:01:00Z"), fetchImpl: store.fetchImpl });
    expect(retried.map((r) => r.status)).toEqual(["enviado", "enviado"]);
    expect(db.rows("pago_online_sends").filter((s) => s.attempt === 2).map((s) => s.status)).toEqual(["enviado", "enviado"]);
    const bodies = store.calls.filter((c) => c.method === "POST").map((c) => c.body.celulares.length);
    expect(new Set(bodies)).toEqual(new Set([2]));
  });

  it("401: no se reintenta", async () => {
    const db = seed("activo");
    const store = fakeStore((c) => (c.method === "POST" ? { status: 401, body: { code: "woocommerce_rest_authentication_error", message: "no" } } : ok(c)));
    await runPagoOnlineForOrg(db.client(), { orgId: ORG, trigger: "cron", now: NOW, fetchImpl: store.fetchImpl });
    const sends = db.rows("pago_online_sends");
    expect(sends.map((s) => s.status)).toEqual(["credenciales", "credenciales"]);
    expect(sends.every((s) => s.next_attempt_at == null)).toBe(true);
    // Sin GET de verificación, y las claves nunca en el error.
    expect(store.calls.filter((c) => c.method === "GET")).toHaveLength(0);
    expect(JSON.stringify(sends)).not.toContain("cs_y");
  });

  it("404: la tienda todavía no tiene el endpoint; se registra, sin reintentos ni alerta", async () => {
    const db = seed("activo");
    const store = fakeStore((c) => (c.method === "POST" ? { status: 404, body: { code: "rest_no_route", message: "No route" } } : ok(c)));
    await runPagoOnlineForOrg(db.client(), { orgId: ORG, trigger: "cron", now: NOW, fetchImpl: store.fetchImpl });
    const sends = db.rows("pago_online_sends");
    expect(sends.map((s) => s.status)).toEqual(["sin_endpoint", "sin_endpoint"]);
    expect(sends.every((s) => s.next_attempt_at == null)).toBe(true);
    expect(telegram).toHaveLength(0);
  });

  it("413: avisa por Telegram, sin celulares", async () => {
    const db = seed("activo");
    const store = fakeStore((c) => (c.method === "POST" ? { status: 413, body: { code: "too_big", message: "max" } } : ok(c)));
    await runPagoOnlineForOrg(db.client(), { orgId: ORG, trigger: "cron", now: NOW, fetchImpl: store.fetchImpl });
    expect(db.rows("pago_online_sends").map((s) => s.status)).toEqual(["demasiado_grande", "demasiado_grande"]);
    expect(telegram).toHaveLength(2);
    expect(telegram.join(" ")).not.toMatch(/9\d{8}/);
  });

  it("dos días seguidos fallidos: avisa una vez por tienda", async () => {
    const db = seed("activo", {
      pago_online_sends: [
        { id: "ayer-k", org_id: ORG, store_id: "s-ken", run_id: "r0", kind: "diaria", attempt: 4, status: "fallido", started_at: "2026-11-09T10:21:00Z" },
      ],
    });
    const store = fakeStore((c) => (c.method === "POST" ? { status: 400, body: { code: "bad", message: "no" } } : ok(c)));
    await runPagoOnlineForOrg(db.client(), { orgId: ORG, trigger: "cron", now: NOW, fetchImpl: store.fetchImpl });
    const alerts = telegram.filter((t) => t.includes("dos días seguidos"));
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toContain("Kenku Peru");
  });
});

describe("el freno de cambio brusco", () => {
  it("no manda, no cambia la lista vigente y avisa", async () => {
    const db = seed("activo", { pago_online_runs: [{ id: "r-old", org_id: ORG, mode: "activo", status: "listo", phones: 10, started_at: "2026-11-09T10:00:00Z" }] });
    db.rows("pago_online_settings")[0]!.current_run_id = "r-old";
    const store = fakeStore(ok);
    const r = await runPagoOnlineForOrg(db.client(), { orgId: ORG, trigger: "cron", now: NOW, fetchImpl: store.fetchImpl });
    expect(r.guard).toBe("bloqueado");
    expect(store.calls).toHaveLength(0);
    expect(db.rows("pago_online_settings")[0]!.current_run_id).toBe("r-old");
    expect(db.rows("pago_online_sends").map((s) => s.status)).toEqual(["freno_cambio", "freno_cambio"]);
    expect(telegram.filter((t) => t.includes("cambio brusco"))).toHaveLength(2);
  });

  it("por tienda: contra su último envío bueno (una prueba no cuenta)", async () => {
    const db = seed("activo", {
      pago_online_sends: [
        { id: "x1", org_id: ORG, store_id: "s-ken", run_id: "r0", kind: "diaria", attempt: 1, status: "enviado", phones_sent: 50, started_at: "2026-11-09T10:00:00Z" },
        { id: "x2", org_id: ORG, store_id: "s-aur", run_id: null, kind: "prueba", attempt: 1, status: "enviado", phones_sent: 1, started_at: "2026-11-09T12:00:00Z" },
      ],
    });
    const store = fakeStore(ok);
    await runPagoOnlineForOrg(db.client(), { orgId: ORG, trigger: "cron", now: NOW, fetchImpl: store.fetchImpl });
    const today = db.rows("pago_online_sends").filter((s) => s.run_id && s.run_id !== "r0");
    expect(today.find((s) => s.store_id === "s-ken")?.status).toBe("freno_cambio");
    expect(today.find((s) => s.store_id === "s-aur")?.status).toBe("enviado");
  });
});

describe("«Enviar prueba»", () => {
  it("un solo celular, regla «prueba», a una tienda, sin guardar el celular", async () => {
    const db = seed("apagado");
    const store = fakeStore(ok);
    // La prueba usa `fetch` global: se cambia solo aquí.
    const prev = globalThis.fetch;
    globalThis.fetch = store.fetchImpl;
    try {
      const r = await sendPagoOnlineTest(db.client(), { orgId: ORG, storeId: "s-ken", phone: "+51 987 000 111", actor: null });
      expect("status" in r && r.status).toBe("enviado");
    } finally {
      globalThis.fetch = prev;
    }
    expect(store.calls[0]!.body).toEqual({ celulares: ["987000111"], correos: [], regla: "prueba" });
    expect(db.rows("pago_online_sends")[0]).toMatchObject({ kind: "prueba", run_id: null, phones_sent: 1 });
    expect(JSON.stringify(db.rows("pago_online_sends"))).not.toContain("987000111");
    expect(await sendPagoOnlineTest(db.client(), { orgId: ORG, storeId: "s-shop", phone: "987000111", actor: null })).toEqual({
      error: "Esa tienda no es una tienda WooCommerce activa de la organización.",
    });
  });
});

describe("«Vaciar la lista de la tienda»", () => {
  it("manda {celulares: [], correos: []} a UNA tienda, lo registra como manual con 0, en cualquier posición", async () => {
    const db = seed("apagado");
    const store = fakeStore((c) => (c.method === "POST" ? { status: 200, body: { descartados: 0, celulares: 0, correos: 0, actualizado: "x" } } : { status: 200, body: { celulares: 0, correos: 0 } }));
    const prev = globalThis.fetch;
    globalThis.fetch = store.fetchImpl;
    try {
      const r = await emptyPagoOnlineStore(db.client(), { orgId: ORG, storeId: "s-aur", actor: null });
      expect("status" in r && r.status).toBe("enviado");
    } finally {
      globalThis.fetch = prev;
    }
    const posts = store.calls.filter((c) => c.method === "POST");
    expect(posts).toHaveLength(1);
    expect(posts[0]!.url).toBe("https://aurela.pe/wp-json/cod-core/v1/pago-solo-online");
    expect(posts[0]!.body).toEqual({ celulares: [], correos: [] });
    expect(db.rows("pago_online_sends")[0]).toMatchObject({ kind: "manual", run_id: null, phones_sent: 0, emails_sent: 0, status: "enviado" });
    expect(await emptyPagoOnlineStore(db.client(), { orgId: ORG, storeId: "s-shop", actor: null })).toEqual({
      error: "Esa tienda no es una tienda WooCommerce activa de la organización.",
    });
  });

  it("después de vaciar, el envío diario no lo toma como cambio brusco", async () => {
    const db = seed("activo", {
      pago_online_sends: [
        { id: "v1", org_id: ORG, store_id: "s-ken", run_id: null, kind: "manual", attempt: 1, status: "enviado", phones_sent: 0, started_at: "2026-11-09T20:00:00Z" },
      ],
    });
    const store = fakeStore(ok);
    await runPagoOnlineForOrg(db.client(), { orgId: ORG, trigger: "cron", now: NOW, fetchImpl: store.fetchImpl });
    expect(db.rows("pago_online_sends").filter((s) => s.run_id).map((s) => s.status)).toEqual(["enviado", "enviado"]);
  });
});

describe("la chapa del Master", () => {
  it("marca solo los celulares de la lista vigente, por organización y sin las excepciones", async () => {
    const db = seed("activo");
    await runPagoOnlineForOrg(db.client(), { orgId: ORG, trigger: "cron", now: NOW, fetchImpl: fakeStore(ok).fetchImpl });
    db.rows("pago_online_exceptions").push({ id: "x", org_id: ORG, phone: "912345678", reason: "Conocida", removed_at: null });
    const set = await pagoOnlineListedAmong(db.client(), [ORG], ["+51 987 654 321", "912345678", "999888777", null]);
    expect([...set]).toEqual([`${ORG}|987654321`]);
    const rows = withPagoOnlineListed(
      [
        { customer_phone: "51987654321", store_id: "s-ken" },
        { customer_phone: "51987654321", store_id: "otra" },
        { customer_phone: "912345678", store_id: "s-ken" },
      ],
      set,
      new Map([["s-ken", ORG]]),
    );
    expect(rows.map((r) => r.pago_online_listed)).toEqual([true, false, false]);
    expect(withPagoOnlineListed([{ customer_phone: "1", store_id: "s-ken" }], null, new Map())).toEqual([{ customer_phone: "1", store_id: "s-ken" }]);
    // En Simulación, nada.
    db.rows("pago_online_settings")[0]!.mode = "simulacion";
    expect((await pagoOnlineListedAmong(db.client(), [ORG], ["987654321"])).size).toBe(0);
  });
});

describe("el freno de Kapta: la lista automática como otra fuente de `prepayOrderCheck`", () => {
  const order = (over: Row = {}): Row => ({
    order_id: "o1",
    store_id: "s-ken",
    customer_phone: "+51 987 654 321",
    financial_status: "pending",
    total_refunded: 0,
    payment_state: "sin_pago",
    payment_gateway: "cod",
    ...over,
  });
  const listedDb = async (requirement = "adelanto", prepay: Row[] = []) => {
    const db = seed("activo", { prepay_list_entries: prepay });
    await runPagoOnlineForOrg(db.client(), { orgId: ORG, trigger: "cron", now: NOW, fetchImpl: fakeStore(ok).fetchImpl });
    db.rows("pago_online_settings")[0]!.requirement = requirement;
    return db;
  };

  it("sin el adelanto validado frena confirmar y la guía, con el motivo y sus cuentas", async () => {
    const db = await listedDb();
    const c = await prepayOrderCheck(db.client(), order() as any, "confirmar");
    expect(c.state).toBe("blocked");
    expect(c.state === "blocked" && c.source).toBe("pago_online");
    expect(c.state === "blocked" && c.message).toContain("Cliente con entrega devuelta y ninguna recibida: solo pago online o adelanto");
    expect(c.state === "blocked" && c.message).toContain("(2 devueltos, 0 recibidas)");
    // El anulador dice cuántos anuló de cuántos.
    const anul = await prepayOrderCheck(db.client(), order({ customer_phone: "912345678" }) as any, "guia");
    expect(anul.state === "blocked" && anul.message).toContain("Cliente que anuló 4 de 5 pedidos y nunca recibió");
    expect((await prepayOrderCheck(db.client(), order({ payment_state: "adelanto_cargado" }) as any, "guia")).state).toBe("blocked");
  });

  it("con el adelanto validado sigue (Adelanto, regla §8); con «Pago completo» no", async () => {
    const db = await listedDb();
    expect(await prepayOrderCheck(db.client(), order({ payment_state: "adelanto_validado" }) as any, "guia")).toEqual({ state: "ok", listed: true, fullyPaid: false });
    const full = await listedDb("pago_completo");
    expect((await prepayOrderCheck(full.client(), order({ payment_state: "adelanto_validado" }) as any, "guia")).state).toBe("blocked");
    expect(await prepayOrderCheck(full.client(), order({ payment_state: "pago_completo" }) as any, "guia")).toEqual({ state: "ok", listed: true, fullyPaid: true });
  });

  it("fuera de la lista, en Simulación o Apagado: pasa", async () => {
    const db = await listedDb();
    expect(await prepayOrderCheck(db.client(), order({ customer_phone: "999888777" }) as any, "guia")).toEqual({ state: "ok", listed: false, fullyPaid: false });
    db.rows("pago_online_settings")[0]!.mode = "simulacion";
    expect((await prepayOrderCheck(db.client(), order() as any, "guia")).state).toBe("ok");
  });

  it("la lista de pago adelantado manda: pide el total", async () => {
    const db = await listedDb("adelanto", [
      { id: "e1", org_id: ORG, phone: "51987654321", source: "manual", reason: "Rechazó en la puerta", evidence: { kind: "manual" }, added_at: "2026-11-01T00:00:00Z", removed_at: null },
    ]);
    const c = await prepayOrderCheck(db.client(), order({ payment_state: "adelanto_validado" }) as any, "guia");
    expect(c.state === "blocked" && c.source).toBe("lista");
  });

  it("«no se pudo leer» la lista automática no autoriza una guía", async () => {
    const db = await listedDb();
    db.rpc = async () => ({ data: null, error: { message: "timeout" } }) as any;
    expect((await prepayOrderCheck(db.client(), order() as any, "guia")).state).toBe("unread");
    // Sin la 0326, nada se frena.
    db.rpc = async () => ({ data: null, error: { code: "PGRST202", message: "Could not find the function" } }) as any;
    expect((await prepayOrderCheck(db.client(), order() as any, "guia")).state).toBe("ok");
  });
});

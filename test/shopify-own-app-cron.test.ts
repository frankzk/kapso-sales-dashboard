// Tiendas con su app propia de Shopify — el cron que renueva el acceso
// (app/api/cron/shopify-own-app-tokens/route.ts, MOM §36.3).
//
// Lo que se fija aquí: que solo lo llame quien tiene CRON_SECRET; que la
// consulta tome SOLO tiendas 'propia' y activas (Kenku, Aurela y las de la app
// de clientes ni se leen) y, de esas, las que vencen en menos de 12 horas o no
// tienen token; que una tienda deshabilitada no se resucite; que sin la 0271
// responda 200 con `sin_migracion`; que un fallo ponga el cron rojo; que la
// línea de log no lleve el token ni el secreto; y que vercel.json lo corra cada
// hora en un minuto que no comparte con otro barrido. Sin red: `fetch` es falso.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Filter = [method: string, ...args: unknown[]];
interface Call {
  table: string;
  op: "select" | "update";
  cols?: string;
  payload?: Record<string, unknown>;
  filters: Filter[];
}

const st = vi.hoisted(() => ({
  calls: [] as Call[],
  /** Lo que devuelve la consulta del cron (las tiendas que tocan). */
  due: [] as Record<string, unknown>[],
  dueError: null as unknown,
  /** Cada tienda por id, como la lee la renovación. */
  rows: {} as Record<string, Record<string, unknown>>,
}));

vi.mock("@/lib/db", () => {
  const reply = (c: Call) => {
    if (c.op === "update") return { data: [{ id: "x" }], error: null };
    if (c.cols === "id,shopify_token_expires_at") return { data: st.dueError ? null : st.due, error: st.dueError };
    const id = c.filters.find((f) => f[0] === "eq" && f[1] === "id")?.[2] as string;
    return { data: st.rows[id] ?? null, error: null };
  };
  const from = (table: string) => {
    const call: Call = { table, op: "select", filters: [] };
    st.calls.push(call);
    const q: any = {};
    q.select = (cols?: string) => {
      if (call.op === "select") call.cols = cols;
      return q;
    };
    q.update = (payload: Record<string, unknown>) => {
      call.op = "update";
      call.payload = payload;
      return q;
    };
    for (const m of ["eq", "neq", "in", "is", "not", "or", "lt", "lte", "order", "limit"]) {
      q[m] = (...args: unknown[]) => {
        call.filters.push([m, ...args]);
        return q;
      };
    }
    q.maybeSingle = q.single = async () => reply(call);
    q.then = (res: any, rej: any) => Promise.resolve().then(() => reply(call)).then(res, rej);
    return q;
  };
  return { createAdminSupabase: () => ({ from }) };
});

import { decrypt, encrypt, generateEncryptionKey } from "@/lib/crypto";
import { GET, POST, dynamic, maxDuration, runtime } from "@/app/api/cron/shopify-own-app-tokens/route";

process.env.ENCRYPTION_KEY = generateEncryptionKey();

const SECRET = "shpss_secreto-de-prueba-0123456789";
const NEW_TOKEN = "shpat_token-nuevo-1111111111";
const OLD_TOKEN = "shpat_token-viejo-0000000000";
const SCOPES = "read_orders,read_draft_orders,write_draft_orders,read_products,read_customers,write_orders";

function propia(id: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    shopify_domain: `${id}.myshopify.com`,
    shopify_app: "propia",
    status: "active",
    shopify_client_id: "client-id-0123456789",
    shopify_client_secret_enc: encrypt(SECRET),
    shopify_token_enc: encrypt(OLD_TOKEN),
    shopify_token_expires_at: new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString(),
    ...over,
  };
}

const req = (auth: string | null = "Bearer cron", headers: Record<string, string> = {}) =>
  new NextRequest("https://kapta.test/api/cron/shopify-own-app-tokens", {
    headers: { ...(auth ? { authorization: auth } : {}), ...headers },
  });

let fetchSpy: ReturnType<typeof vi.fn>;
const logs: string[] = [];

beforeEach(() => {
  vi.stubEnv("CRON_SECRET", "cron");
  st.calls = [];
  st.due = [];
  st.dueError = null;
  st.rows = {};
  logs.length = 0;
  vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => void logs.push(a.map(String).join(" ")));
  vi.spyOn(console, "warn").mockImplementation((...a: unknown[]) => void logs.push(a.map(String).join(" ")));
  fetchSpy = vi.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => ({ access_token: NEW_TOKEN, scope: SCOPES, expires_in: 86399 }),
    text: async () => "",
  }));
  vi.stubGlobal("fetch", fetchSpy);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("/api/cron/shopify-own-app-tokens", () => {
  it("corre en Node, sin caché y con 60 s, por GET y por POST", () => {
    expect(runtime).toBe("nodejs");
    expect(dynamic).toBe("force-dynamic");
    expect(maxDuration).toBe(60);
    expect(POST).toBe(GET);
  });

  it("sin el secreto del cron: 401, sin leer la base ni salir a la red", async () => {
    expect((await GET(req(null))).status).toBe(401);
    expect((await GET(req("Bearer otro"))).status).toBe(401);
    expect(st.calls).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("acepta el secreto interno por cabecera", async () => {
    expect((await GET(req(null, { "x-internal-secret": "cron" }))).status).toBe(200);
  });

  it("solo pide tiendas 'propia' activas que vencen en 12 horas o no tienen token", async () => {
    const before = Date.now();
    await GET(req());
    const query = st.calls[0]!;
    expect(query).toMatchObject({ table: "stores", op: "select", cols: "id,shopify_token_expires_at" });
    expect(query.filters.slice(0, 2)).toEqual([
      ["eq", "shopify_app", "propia"],
      ["eq", "status", "active"],
    ]);
    const or = query.filters[2]!;
    expect(or[0]).toBe("or");
    const m = /^shopify_token_enc\.is\.null,shopify_token_expires_at\.is\.null,shopify_token_expires_at\.lte\.(.+)$/.exec(String(or[1]));
    expect(m).not.toBeNull();
    const cutoff = Date.parse(m![1]!);
    expect(cutoff - before).toBeGreaterThanOrEqual(12 * 60 * 60 * 1000 - 1000);
    expect(cutoff - before).toBeLessThanOrEqual(12 * 60 * 60 * 1000 + 5000);
    // El token cifrado no se lee en la consulta del cron.
    expect(query.cols).not.toContain("token_enc");
  });

  it("renueva cada tienda que toca, guarda cifrado y deja una línea de log sin secretos", async () => {
    st.due = [{ id: "sh-1", shopify_token_expires_at: null }, { id: "sh-2", shopify_token_expires_at: null }];
    st.rows = { "sh-1": propia("sh-1"), "sh-2": propia("sh-2", { shopify_token_enc: null, shopify_token_expires_at: null }) };
    const res = await GET(req());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ ok: true, due: 2, renewed: 2, vigentes: 0, failed: [], sinPermisos: [] });
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(fetchSpy.mock.calls.map((c) => String(c[0]))).toEqual([
      "https://sh-1.myshopify.com/admin/oauth/access_token",
      "https://sh-2.myshopify.com/admin/oauth/access_token",
    ]);
    const saves = st.calls.filter((c) => c.op === "update");
    expect(saves).toHaveLength(2);
    for (const s of saves) {
      expect(decrypt(String(s.payload!.shopify_token_enc))).toBe(NEW_TOKEN);
      expect(s.filters).toContainEqual(["eq", "shopify_app", "propia"]);
      expect(s.filters).toContainEqual(["eq", "status", "active"]);
    }
    const line = logs.find((l) => l.startsWith("[shopify-own-app]"));
    expect(line).toBeDefined();
    for (const text of [JSON.stringify(body), logs.join("\n")]) {
      expect(text).not.toContain(SECRET);
      expect(text).not.toContain(NEW_TOKEN);
      expect(text).not.toContain(OLD_TOKEN);
      expect(text).not.toContain("myshopify.com");
    }
  });

  it("una tienda que ya renovó otro proceso cuenta como vigente, sin pedir token", async () => {
    st.due = [{ id: "sh-1", shopify_token_expires_at: null }];
    st.rows = { "sh-1": propia("sh-1", { shopify_token_expires_at: new Date(Date.now() + 20 * 60 * 60 * 1000).toISOString() }) };
    const body = await (await GET(req())).json();
    expect(body).toMatchObject({ ok: true, due: 1, renewed: 0, vigentes: 1 });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("no resucita: si entre la consulta y la renovación la tienda se deshabilitó o no es propia, no la toca", async () => {
    st.due = [
      { id: "sh-off", shopify_token_expires_at: null },
      { id: "kenku", shopify_token_expires_at: null },
    ];
    st.rows = {
      "sh-off": propia("sh-off", { status: "disabled", shopify_token_enc: null }),
      kenku: { ...propia("kenku"), shopify_app: "interna", shopify_client_id: null, shopify_client_secret_enc: null },
    };
    const res = await GET(req());
    expect(res.status).toBe(502);
    expect((await res.json()).failed).toEqual([
      { storeId: "sh-off", reason: "inactiva" },
      { storeId: "kenku", reason: "no_propia" },
    ]);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(st.calls.filter((c) => c.op === "update")).toEqual([]);
  });

  it("si Shopify niega una, el cron se ve rojo, anota el motivo y sigue con las demás", async () => {
    st.due = [{ id: "sh-1", shopify_token_expires_at: null }, { id: "sh-2", shopify_token_expires_at: null }];
    st.rows = { "sh-1": propia("sh-1"), "sh-2": propia("sh-2") };
    fetchSpy.mockImplementationOnce(async () => ({
      ok: false,
      status: 401,
      json: async () => ({ error: "invalid_client" }),
      text: async () => JSON.stringify({ error: "invalid_client", error_description: SECRET }),
    }));
    const res = await GET(req());
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body).toMatchObject({ ok: false, renewed: 1, failed: [{ storeId: "sh-1", reason: "credenciales" }] });
    const errorWrite = st.calls.find((c) => c.op === "update" && Object.keys(c.payload!).join() === "shopify_token_error");
    expect(errorWrite?.filters).toContainEqual(["eq", "id", "sh-1"]);
    expect(JSON.stringify(body) + logs.join("\n")).not.toContain(SECRET);
  });

  it("sin la 0271: 200 con sin_migracion, sin red", async () => {
    st.dueError = { code: "42703", message: "column stores.shopify_token_expires_at does not exist" };
    const res = await GET(req());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, skipped: "sin_migracion" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("otro error de la base: rojo", async () => {
    st.dueError = { code: "57014", message: "canceling statement due to statement timeout" };
    expect((await GET(req())).status).toBe(500);
  });
});

describe("vercel.json: la renovación de las apps propias", () => {
  const crons = (
    JSON.parse(readFileSync(resolve(__dirname, "../vercel.json"), "utf8")) as { crons: { path: string; schedule: string }[] }
  ).crons;

  it("corre cada hora, en el minuto 23", () => {
    expect(crons.filter((c) => c.path === "/api/cron/shopify-own-app-tokens")).toEqual([
      { path: "/api/cron/shopify-own-app-tokens", schedule: "23 * * * *" },
    ]);
  });

  it("no cae en el minuto de ningún barrido que corre cada hora o más seguido", () => {
    const minutesOf = (schedule: string): number[] => {
      const [minute, hour] = schedule.split(" ");
      if (hour !== "*" && !hour!.startsWith("*/")) return [];
      if (minute === "*") return Array.from({ length: 60 }, (_, i) => i);
      if (minute!.startsWith("*/")) {
        const step = Number(minute!.slice(2));
        return Array.from({ length: 60 / step }, (_, i) => i * step);
      }
      return minute!.split(",").map(Number);
    };
    for (const c of crons.filter((x) => x.path !== "/api/cron/shopify-own-app-tokens")) {
      expect(minutesOf(c.schedule), c.path).not.toContain(23);
    }
  });
});

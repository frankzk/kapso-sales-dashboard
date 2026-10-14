// Ajustes → «Boletas y facturas» (MOM §35.2, §35.4, §35.7, §35.8).
//
// Lo que se fija aquí: que las tres acciones pidan los DOS permisos («Administrar
// tiendas» y «Boletas y facturas») en la organización de la tienda; que un RUC
// no se guarde con datos que la base rechazaría; que el token se cifre y nunca
// vuelva; que «Emitir desde» no quede atrás; que Real se gane con una prueba de
// conexión que leyó el RUC declarado; y que la sección del navegador no arrastre
// `node:crypto` ni reciba el token. La base, la sesión, el cifrado y SimpleFact
// van simulados: aquí no sale nada a la red.

import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Filter = [method: string, ...args: unknown[]];
interface Call {
  table: string;
  op: "select" | "insert" | "update" | "upsert" | "delete";
  cols?: string;
  opts?: unknown;
  payload?: Record<string, unknown>;
  filters: Filter[];
}
type Reply = { data: unknown; error: { code?: string; message: string } | null; count?: number | null };

const SECRET = "tok-secreto-123|abcdefXYZ";

const st = vi.hoisted(() => ({
  calls: [] as Call[],
  user: { id: "owner" } as { id: string } | null,
  perms: [] as string[],
  permArgs: [] as unknown[][],
  store: { id: "store", org_id: "org" } as unknown,
  issuer: null as Record<string, unknown> | null,
  issuerError: null as { message: string } | null,
  hasToken: false,
  /** Lo que devuelve la escritura de `invoice_issuers` (null = como vino). */
  written: undefined as unknown,
  writeError: null as { code?: string; message: string } | null,
  issuerLookup: { id: "iss-1", ruc: "20556792829", legal_name: "GRUPO GF S.A.C." } as unknown,
  account: { id: "acc-1", label: "Grupo GF S.A.C." } as unknown,
  accountError: null as { message: string } | null,
  probe: { ok: true, ruc: "20556792829", sales: 7 } as unknown,
  probeArgs: [] as unknown[][],
  decryptThrows: false,
  revalidated: [] as unknown[],
}));

const spies = vi.hoisted(() => ({
  encrypt: (plain: string) => `v1:cifrado(${plain.length})`,
  decrypt: (payload: string) => payload,
}));

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: (p: unknown) => st.revalidated.push(p) }));
vi.mock("next/navigation", () => ({
  redirect: () => {
    throw new Error("login");
  },
  usePathname: () => "/dashboard/store/settings",
  useSearchParams: () => new URLSearchParams(""),
  useRouter: () => ({ refresh: () => {} }),
}));
vi.mock("@/lib/permissions-access", () => ({
  hasOrgPermission: async (orgId: string, permission: string) => {
    st.permArgs.push([orgId, permission]);
    return st.perms.includes(permission);
  },
}));
vi.mock("@/lib/crypto", () => ({
  encrypt: vi.fn((plain: string) => spies.encrypt(plain)),
  decrypt: vi.fn((payload: string) => {
    if (st.decryptThrows) throw new Error("Unsupported state or unable to authenticate data");
    return spies.decrypt(payload);
  }),
}));
vi.mock("@/lib/invoicing/simplefact", () => ({
  testSimplefactConnection: vi.fn(async (...args: unknown[]) => {
    st.probeArgs.push(args);
    return st.probe;
  }),
}));

function reply(c: Call): Reply {
  if (c.table === "stores") return { data: st.store, error: null };
  if (c.table === "invoice_issuers") {
    if (c.op === "select") {
      // «¿Hay token?» se pregunta con un filtro y devuelve solo el id.
      if (c.filters.some((f) => f[0] === "not")) return { data: st.hasToken ? { id: "iss-1" } : null, error: null };
      if (c.cols === "id,ruc,legal_name") return { data: st.issuerLookup, error: null };
      return { data: st.issuer, error: st.issuerError };
    }
    if (st.writeError) return { data: null, error: st.writeError };
    if (st.written !== undefined) return { data: st.written, error: null };
    return { data: { id: "iss-1", mode: c.payload?.mode ?? st.issuer?.mode ?? "apagado" }, error: null };
  }
  if (c.table === "store_collection_accounts") return { data: st.accountError ? null : st.account, error: st.accountError };
  return { data: null, error: null };
}

vi.mock("@/lib/db", () => {
  const from = (table: string) => {
    const call: Call = { table, op: "select", filters: [] };
    st.calls.push(call);
    const q: any = {};
    q.select = (cols?: string, opts?: unknown) => {
      if (call.op === "select") {
        call.cols = cols;
        call.opts = opts;
      }
      return q;
    };
    for (const op of ["insert", "update", "upsert"] as const) {
      q[op] = (payload: Record<string, unknown>) => {
        call.op = op;
        call.payload = payload;
        return q;
      };
    }
    q.delete = () => {
      call.op = "delete";
      return q;
    };
    for (const m of ["eq", "neq", "in", "is", "not", "gte", "lte", "lt", "order", "limit"]) {
      q[m] = (...args: unknown[]) => {
        call.filters.push([m, ...args]);
        return q;
      };
    }
    q.maybeSingle = q.single = async () => reply(call);
    q.then = (res: any, rej: any) => Promise.resolve().then(() => reply(call)).then(res, rej);
    return q;
  };
  return {
    createAdminSupabase: () => ({ from }),
    createServerSupabase: async () => ({
      from,
      auth: { getUser: async () => ({ data: { user: st.user } }) },
    }),
  };
});

import { encrypt, decrypt } from "@/lib/crypto";
import { isValidRuc, INVOICE_DAILY_LIMIT_MAX, INVOICE_DAILY_LIMIT_MIN } from "@/lib/invoicing/rules";
import {
  saveInvoiceIssuer,
  setAccountInvoiceIssuer,
  testInvoiceIssuer,
} from "@/app/dashboard/[storeId]/settings/invoice-actions";
import {
  InvoiceSettingsSection,
  type InvoiceIssuerView,
  type InvoiceSettingsData,
} from "@/components/invoice-settings-section";

const read = (p: string) => readFileSync(resolve(process.cwd(), p), "utf8");
const ACTIONS = read("app/dashboard/[storeId]/settings/invoice-actions.ts");
const SECTION = read("components/invoice-settings-section.tsx");
const PAGE = read("app/dashboard/[storeId]/settings/page.tsx");
const FORM = read("components/store-settings.tsx");

const GF = "20556792829";
const OTRO = "20100000009";
const NOW = "2026-10-14T15:00:00.000Z"; // 10:00 en Lima
const BOTH = ["stores.manage", "invoices.manage"];

const SIN_PERMISO = "Sin permiso: «Boletas y facturas» lo configura quien tiene ese permiso (solo lo da el owner).";

function issuerRow(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "iss-1",
    ruc: GF,
    simplefact_subdomain: "grupogf",
    mode: "simulacion",
    emit_from: "2026-10-10T15:00:00.000Z", // 10:00 en Lima del 10
    checked_ruc: null,
    token_enc: "v1:guardado",
    updated_at: "2026-10-14T14:00:00.123456+00:00",
    ...over,
  };
}

function form(fields: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.append(k, v);
  return fd;
}

/** El formulario de una tarjeta de RUC tal como lo manda el navegador. */
function issuerForm(over: Record<string, string> = {}): FormData {
  return form({
    issuer_id: "iss-1",
    ruc: GF,
    legal_name: "GRUPO GF S.A.C.",
    subdomain: "grupogf",
    token: "",
    mode: "simulacion",
    emit_from: "2026-10-10T10:00",
    daily_limit: "40",
    ...over,
  });
}

const writes = (table = "invoice_issuers") =>
  st.calls.filter((c) => c.table === table && (c.op === "update" || c.op === "insert"));
const lastWrite = (table = "invoice_issuers") => writes(table).at(-1);

beforeEach(() => {
  st.calls = [];
  st.user = { id: "owner" };
  st.perms = [...BOTH];
  st.permArgs = [];
  st.store = { id: "store", org_id: "org" };
  st.issuer = issuerRow();
  st.issuerError = null;
  st.hasToken = true;
  st.written = undefined;
  st.writeError = null;
  st.issuerLookup = { id: "iss-1", ruc: GF, legal_name: "GRUPO GF S.A.C." };
  st.account = { id: "acc-1", label: "Grupo GF S.A.C." };
  st.accountError = null;
  st.probe = { ok: true, ruc: GF, sales: 7 };
  st.probeArgs = [];
  st.decryptThrows = false;
  st.revalidated = [];
  vi.mocked(encrypt).mockClear();
  vi.mocked(decrypt).mockClear();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(NOW));
});

afterEach(() => {
  vi.useRealTimers();
});

it("los RUC de las pruebas son RUC bien formados", () => {
  expect(isValidRuc(GF)).toBe(true);
  expect(isValidRuc(OTRO)).toBe(true);
});

// ── Permisos (MOM §35.7) ─────────────────────────────────────────────────────

describe("cada acción pide «Administrar tiendas» y «Boletas y facturas» en la org de la tienda", () => {
  const acciones: Array<[string, () => Promise<unknown>]> = [
    ["saveInvoiceIssuer", () => saveInvoiceIssuer("store", {}, issuerForm())],
    ["testInvoiceIssuer", () => testInvoiceIssuer("store", "iss-1")],
    ["setAccountInvoiceIssuer", () => setAccountInvoiceIssuer("store", "acc-1", "iss-1")],
  ];

  for (const [name, run] of acciones) {
    for (const perms of [[], ["stores.manage"], ["invoices.manage"]]) {
      it(`${name}: con [${perms.join(", ")}] no hace nada`, async () => {
        st.perms = perms;
        expect(await run()).toEqual({ error: SIN_PERMISO });
        // Solo se leyó la tienda: ni el RUC, ni la cuenta, ni SimpleFact.
        expect(st.calls.map((c) => c.table)).toEqual(["stores"]);
        expect(st.probeArgs).toEqual([]);
        expect(decrypt).not.toHaveBeenCalled();
        expect(st.revalidated).toEqual([]);
      });
    }

    it(`${name}: sin sesión manda al login`, async () => {
      st.user = null;
      await expect(run()).rejects.toThrow("login");
      expect(writes()).toEqual([]);
    });

    it(`${name}: una tienda que no existe no pasa`, async () => {
      st.store = null;
      expect(await run()).toEqual({ error: SIN_PERMISO });
      expect(st.permArgs).toEqual([]);
    });

    it(`${name}: pregunta los permisos en la organización de la tienda`, async () => {
      await run();
      expect(st.permArgs).toEqual(
        expect.arrayContaining([
          ["org", "stores.manage"],
          ["org", "invoices.manage"],
        ]),
      );
      expect(st.permArgs.every(([org]) => org === "org")).toBe(true);
    });
  }

  it("toda acción exportada pasa por la puerta antes de leer o escribir", () => {
    const bodies = [...ACTIONS.matchAll(/\nexport async function (\w+)\(/g)].map((m) => {
      const end = ACTIONS.indexOf("\n}\n", m.index!);
      return [m[1]!, ACTIONS.slice(m.index!, end)] as const;
    });
    expect(bodies.map(([n]) => n).sort()).toEqual(["saveInvoiceIssuer", "setAccountInvoiceIssuer", "testInvoiceIssuer"]);
    for (const [name, body] of bodies) {
      const gate = body.indexOf("const ctx = await requireInvoiceAdmin(storeId);\n  if (!ctx) return { error: SIN_PERMISO };");
      expect(gate, name).toBeGreaterThan(0);
      expect(gate, name).toBeLessThan(body.indexOf("ctx.admin"));
    }
    const puerta = ACTIONS.slice(ACTIONS.indexOf("async function requireInvoiceAdmin("));
    expect(puerta).toContain('hasOrgPermission(store.org_id, "stores.manage")');
    expect(puerta).toContain('hasOrgPermission(store.org_id, "invoices.manage")');
    expect(puerta).toContain("if (!storesManage || !invoicesManage) return null;");
  });
});

// ── Guardar un RUC: validación ───────────────────────────────────────────────

describe("saveInvoiceIssuer: lo que la base rechazaría no se manda", () => {
  const casos: Array<[string, Record<string, string>, RegExp]> = [
    ["RUC con dígito verificador malo", { ruc: "20556792828" }, /El RUC no es válido/],
    ["RUC con prefijo que no existe", { ruc: "12345678901" }, /El RUC no es válido/],
    ["RUC corto", { ruc: "2055679282" }, /El RUC no es válido/],
    ["sin razón social", { legal_name: "   " }, /Falta la razón social/],
    ["razón social de 201", { legal_name: "x".repeat(201) }, /Falta la razón social/],
    ["subdominio con guion bajo", { subdomain: "grupo_gf" }, /subdominio de SimpleFact no es válido/],
    ["subdominio de otro dominio", { subdomain: "https://grupogf.evil.pe/api" }, /subdominio de SimpleFact no es válido/],
    ["tope 0", { daily_limit: String(INVOICE_DAILY_LIMIT_MIN - 1) }, /tope diario/],
    ["tope 301", { daily_limit: String(INVOICE_DAILY_LIMIT_MAX + 1) }, /tope diario/],
    ["tope con decimales", { daily_limit: "1.5" }, /tope diario/],
    ["tope vacío", { daily_limit: "" }, /tope diario/],
    ["modo inventado", { mode: "encendido" }, /Elige un modo/],
    ["token con espacios", { token: "abc def" }, /una sola línea/],
    ["fecha que no es fecha", { emit_from: "mañana" }, /no es una fecha válida/],
  ];

  for (const [nombre, campos, error] of casos) {
    it(nombre, async () => {
      const r = await saveInvoiceIssuer("store", {}, issuerForm(campos));
      expect(r.error).toMatch(error);
      expect(writes()).toEqual([]);
      expect(encrypt).not.toHaveBeenCalled();
    });
  }

  it("los bordes del tope sí se guardan", async () => {
    for (const limit of [INVOICE_DAILY_LIMIT_MIN, INVOICE_DAILY_LIMIT_MAX]) {
      const r = await saveInvoiceIssuer("store", {}, issuerForm({ daily_limit: String(limit) }));
      expect(r.error).toBeUndefined();
      expect(lastWrite()!.payload!.daily_limit).toBe(limit);
    }
  });

  it("el subdominio se puede pegar con la dirección entera", async () => {
    await saveInvoiceIssuer("store", {}, issuerForm({ subdomain: "https://GrupoGF.simplefact.pe/api/v1" }));
    expect(lastWrite()!.payload!.simplefact_subdomain).toBe("grupogf");
  });

  it("el alta va con la organización de la tienda y nace donde se pidió", async () => {
    st.issuer = null;
    const r = await saveInvoiceIssuer(
      "store",
      {},
      issuerForm({ issuer_id: "", ruc: OTRO, legal_name: "  OTRA   EMPRESA S.A.C. ", mode: "apagado", emit_from: "" }),
    );
    expect(r).toEqual({ notice: `RUC ${OTRO} dado de alta ✓ · Apagado` });
    const w = lastWrite()!;
    expect(w.op).toBe("insert");
    expect(w.payload).toEqual({
      org_id: "org",
      ruc: OTRO,
      legal_name: "OTRA EMPRESA S.A.C.",
      simplefact_subdomain: "grupogf",
      mode: "apagado",
      daily_limit: 40,
      emit_from: null,
    });
    expect(st.revalidated).toEqual(["/dashboard/store/settings"]);
  });

  it("un cambio solo toca un RUC de la organización: filtra por id y org", async () => {
    await saveInvoiceIssuer("store", {}, issuerForm({ daily_limit: "60" }));
    const leidos = st.calls.filter((c) => c.table === "invoice_issuers" && c.op === "select");
    for (const c of leidos) {
      expect(c.filters).toEqual(expect.arrayContaining([["eq", "id", "iss-1"], ["eq", "org_id", "org"]]));
    }
    // El texto cifrado no se trae: si hay token se sabe con un filtro.
    expect(leidos.every((c) => !String(c.cols).includes("token_enc"))).toBe(true);
    const w = lastWrite()!;
    expect(w.op).toBe("update");
    expect(w.filters).toEqual([
      ["eq", "id", "iss-1"],
      ["eq", "org_id", "org"],
    ]);
  });

  it("un RUC de otra organización no se encuentra", async () => {
    st.issuer = null;
    const r = await saveInvoiceIssuer("store", {}, issuerForm());
    expect(r).toEqual({ error: "Ese RUC no es de la organización de esta tienda." });
    expect(writes()).toEqual([]);
  });

  it("falla cerrada: si no se pudo leer el RUC guardado, no se escribe", async () => {
    st.issuerError = { message: "timeout" };
    const r = await saveInvoiceIssuer("store", {}, issuerForm({ mode: "real" }));
    expect(r).toEqual({ error: "No se pudo leer el RUC: intenta de nuevo." });
    expect(writes()).toEqual([]);
  });

  it("lo que la base rechaza vuelve en palabras", async () => {
    st.writeError = { code: "23505", message: "duplicate key value violates unique constraint" };
    expect(await saveInvoiceIssuer("store", {}, issuerForm())).toEqual({ error: "Ese RUC ya está dado de alta." });
    st.writeError = {
      code: "23514",
      message: 'new row for relation "invoice_issuers" violates check constraint "invoice_issuers_real_ready"',
    };
    expect((await saveInvoiceIssuer("store", {}, issuerForm())).error).toMatch(/Para pasar a Real hacen falta el token/);
    st.writeError = {
      code: "23514",
      message: 'new row for relation "invoice_issuers" violates check constraint "invoice_issuers_daily_limit_check"',
    };
    expect((await saveInvoiceIssuer("store", {}, issuerForm())).error).toBe("El tope diario va de 1 a 300.");
  });
});

// ── El token (MOM §35.6) ─────────────────────────────────────────────────────

describe("saveInvoiceIssuer: el token", () => {
  it("con valor se cifra y se guarda cifrado, nunca en claro", async () => {
    const r = await saveInvoiceIssuer("store", {}, issuerForm({ token: `  ${SECRET} ` }));
    expect(encrypt).toHaveBeenCalledTimes(1);
    expect(encrypt).toHaveBeenCalledWith(SECRET);
    const payload = lastWrite()!.payload!;
    expect(payload.token_enc).toBe(`v1:cifrado(${SECRET.length})`);
    expect(JSON.stringify(payload)).not.toContain(SECRET);
    expect(JSON.stringify(r)).not.toContain(SECRET);
    expect(r.notice).toContain("vuelve a pulsar «Probar conexión»");
  });

  it("vacío conserva el guardado: ni se cifra ni se toca la columna", async () => {
    await saveInvoiceIssuer("store", {}, issuerForm({ token: "" }));
    expect(encrypt).not.toHaveBeenCalled();
    expect(lastWrite()!.payload).not.toHaveProperty("token_enc");
  });

  it("cambiar el token de un RUC en Real: la base lo baja a Simulación y se dice", async () => {
    st.issuer = issuerRow({ mode: "real", checked_ruc: GF });
    st.written = { id: "iss-1", mode: "simulacion" }; // el trigger de 0257
    const r = await saveInvoiceIssuer("store", {}, issuerForm({ mode: "real", token: SECRET }));
    expect(r.notice).toContain(
      "El token cambió: el RUC bajó a Simulación hasta que vuelvas a probar la conexión.",
    );
    expect(r.notice!.split("\n")[0]).toBe(`RUC ${GF} guardado ✓ · Simulación`);
  });

  it("sin la clave de cifrado del servidor no se guarda nada", async () => {
    vi.mocked(encrypt).mockImplementationOnce(() => {
      throw new Error("ENCRYPTION_KEY is not set");
    });
    const r = await saveInvoiceIssuer("store", {}, issuerForm({ token: SECRET }));
    expect(r).toEqual({ error: "No se pudo cifrar el token: falta la clave de cifrado del servidor." });
    expect(writes()).toEqual([]);
  });
});

// ── «Emitir desde» (MOM §35.4) ───────────────────────────────────────────────

describe("saveInvoiceIssuer: «Emitir desde» nunca queda atrás", () => {
  it("una fecha nueva en el pasado se guarda como ahora, y se dice", async () => {
    const r = await saveInvoiceIssuer("store", {}, issuerForm({ emit_from: "2026-10-12T08:00" }));
    expect(lastWrite()!.payload!.emit_from).toBe(NOW);
    expect(r.notice).toContain("«Emitir desde» no puede quedar en el pasado: se guardó con la hora de ahora.");
  });

  it("una fecha futura se guarda tal cual, leída en hora de Lima", async () => {
    const r = await saveInvoiceIssuer("store", {}, issuerForm({ emit_from: "2026-10-20T09:30" }));
    expect(lastWrite()!.payload!.emit_from).toBe("2026-10-20T14:30:00.000Z");
    expect(r.notice).toBe(`RUC ${GF} guardado ✓ · Simulación`);
  });

  it("la fecha guardada que el formulario reenvía sin tocar no se mueve (guardar el tope no corre la fecha)", async () => {
    const r = await saveInvoiceIssuer("store", {}, issuerForm({ emit_from: "2026-10-10T10:00", daily_limit: "60" }));
    expect(lastWrite()!.payload).not.toHaveProperty("emit_from");
    expect(r.notice).toBe(`RUC ${GF} guardado ✓ · Simulación`);
  });

  it("lo guardado con segundos (el `now()` de la base) también cuenta como sin tocar", async () => {
    st.issuer = issuerRow({ emit_from: "2026-10-10T15:00:42.517+00:00" });
    await saveInvoiceIssuer("store", {}, issuerForm({ emit_from: "2026-10-10T10:00" }));
    expect(lastWrite()!.payload).not.toHaveProperty("emit_from");
    // Un minuto después ya es una fecha nueva, y en el pasado: queda en ahora.
    await saveInvoiceIssuer("store", {}, issuerForm({ emit_from: "2026-10-10T10:01" }));
    expect(lastWrite()!.payload!.emit_from).toBe(NOW);
  });

  it("al cambiar de modo, si quedó atrás, se mueve a ahora", async () => {
    st.issuer = issuerRow({ mode: "apagado" });
    const r = await saveInvoiceIssuer("store", {}, issuerForm({ mode: "simulacion", emit_from: "2026-10-10T10:00" }));
    expect(lastWrite()!.payload!.emit_from).toBe(NOW);
    expect(r.notice).toContain("Al cambiar de modo, «Emitir desde» quedó en ahora");
  });

  it("al cambiar de modo sin fecha, también queda en ahora", async () => {
    st.issuer = issuerRow({ mode: "apagado", emit_from: null });
    await saveInvoiceIssuer("store", {}, issuerForm({ mode: "simulacion", emit_from: "" }));
    expect(lastWrite()!.payload!.emit_from).toBe(NOW);
  });

  it("al cambiar de modo con una fecha futura, se respeta", async () => {
    st.issuer = issuerRow({ mode: "apagado" });
    await saveInvoiceIssuer("store", {}, issuerForm({ mode: "simulacion", emit_from: "2026-10-15T00:00" }));
    expect(lastWrite()!.payload!.emit_from).toBe("2026-10-15T05:00:00.000Z");
  });

  it("al apagar no se mueve: Apagado no emite", async () => {
    await saveInvoiceIssuer("store", {}, issuerForm({ mode: "apagado", emit_from: "2026-10-10T10:00" }));
    expect(lastWrite()!.payload).not.toHaveProperty("emit_from");
  });

  it("sin fecha solo se puede estar Apagado", async () => {
    st.issuer = issuerRow({ mode: "simulacion", emit_from: null });
    const r = await saveInvoiceIssuer("store", {}, issuerForm({ mode: "simulacion", emit_from: "" }));
    expect(r).toEqual({ error: "Pon «Emitir desde»: sin fecha de inicio el RUC no emite." });
    expect(writes()).toEqual([]);

    await saveInvoiceIssuer("store", {}, issuerForm({ mode: "apagado", emit_from: "" }));
    expect(lastWrite()!.payload!.emit_from).toBeNull();
  });
});

// ── Pasar a Real (MOM §35.8) ─────────────────────────────────────────────────

describe("saveInvoiceIssuer: Real se gana con una prueba de conexión", () => {
  it("sin una prueba que leyó el RUC no pasa, y no se escribe nada", async () => {
    st.issuer = issuerRow({ mode: "simulacion", checked_ruc: null });
    const r = await saveInvoiceIssuer("store", {}, issuerForm({ mode: "real" }));
    expect(r.error).toMatch(/^Prueba la conexión antes de pasar a Real/);
    expect(writes()).toEqual([]);
  });

  it("si la prueba leyó otro RUC, lo dice", async () => {
    st.issuer = issuerRow({ mode: "simulacion", checked_ruc: OTRO });
    const r = await saveInvoiceIssuer("store", {}, issuerForm({ mode: "real" }));
    expect(r.error).toBe(`Prueba la conexión antes de pasar a Real: la última prueba leyó el RUC ${OTRO}, no el ${GF}.`);
  });

  it("sin token no pasa", async () => {
    st.issuer = issuerRow({ mode: "simulacion", checked_ruc: GF });
    st.hasToken = false;
    const r = await saveInvoiceIssuer("store", {}, issuerForm({ mode: "real" }));
    expect(r.error).toMatch(/Falta el token de SimpleFact/);
  });

  it("no en el mismo guardado que cambia el token, el RUC o el subdominio", async () => {
    st.issuer = issuerRow({ mode: "simulacion", checked_ruc: GF });
    expect((await saveInvoiceIssuer("store", {}, issuerForm({ mode: "real", token: SECRET }))).error).toMatch(
      /token nuevo y prueba la conexión/,
    );
    expect((await saveInvoiceIssuer("store", {}, issuerForm({ mode: "real", subdomain: "otra" }))).error).toMatch(
      /Cambiaste el RUC o el subdominio/,
    );
    expect(writes()).toEqual([]);
    expect(encrypt).not.toHaveBeenCalled();
  });

  it("un RUC nuevo no nace en Real", async () => {
    st.issuer = null;
    const r = await saveInvoiceIssuer("store", {}, issuerForm({ issuer_id: "", mode: "real" }));
    expect(r.error).toMatch(/Un RUC nuevo empieza en Apagado o Simulación/);
    expect(writes()).toEqual([]);
  });

  it("con token y la prueba del mismo RUC, pasa, y «Emitir desde» se mueve a ahora", async () => {
    st.issuer = issuerRow({ mode: "simulacion", checked_ruc: GF });
    const r = await saveInvoiceIssuer("store", {}, issuerForm({ mode: "real" }));
    expect(r.error).toBeUndefined();
    expect(lastWrite()!.payload).toMatchObject({ mode: "real", emit_from: NOW });
    expect(r.notice).toContain(`RUC ${GF} guardado ✓ · Real`);
    expect(r.notice).toContain("«Emitir desde» quedó en ahora");
  });

  it("un RUC que ya está en Real se puede seguir editando (el tope) sin volver a probar", async () => {
    st.issuer = issuerRow({ mode: "real", checked_ruc: GF });
    const r = await saveInvoiceIssuer("store", {}, issuerForm({ mode: "real", daily_limit: "80" }));
    expect(r).toEqual({ notice: `RUC ${GF} guardado ✓ · Real` });
    expect(lastWrite()!.payload).toMatchObject({ mode: "real", daily_limit: 80 });
    expect(lastWrite()!.payload).not.toHaveProperty("emit_from");
  });
});

// ── Probar conexión (MOM §35.4) ──────────────────────────────────────────────

describe("testInvoiceIssuer", () => {
  it("descifra en el servidor, prueba contra el RUC declarado y guarda qué leyó", async () => {
    st.issuer = issuerRow({ token_enc: SECRET });
    const r = await testInvoiceIssuer("store", "iss-1");
    expect(r).toEqual({ notice: `Conexión correcta: RUC ${GF}, 7 ventas leídas.` });
    expect(decrypt).toHaveBeenCalledWith(SECRET);
    expect(st.probeArgs).toEqual([[{ subdomain: "grupogf", token: SECRET }, GF]]);
    const w = lastWrite()!;
    expect(w.payload).toEqual({ checked_at: NOW, checked_ruc: GF, check_error: null });
    // Solo si el RUC no cambió mientras se probaba.
    expect(w.filters).toEqual([
      ["eq", "id", "iss-1"],
      ["eq", "org_id", "org"],
      ["eq", "updated_at", "2026-10-14T14:00:00.123456+00:00"],
    ]);
    expect(JSON.stringify(r)).not.toContain(SECRET);
    expect(st.revalidated).toEqual(["/dashboard/store/settings"]);
  });

  it("un token de otro RUC: guarda el RUC leído y el error, y no devuelve el token", async () => {
    st.issuer = issuerRow({ token_enc: SECRET });
    st.probe = { ok: false, error: `El token es del RUC ${OTRO}, no del ${GF}`, ruc: OTRO };
    const r = await testInvoiceIssuer("store", "iss-1");
    expect(r).toEqual({ error: `El token es del RUC ${OTRO}, no del ${GF}.` });
    expect(lastWrite()!.payload).toEqual({
      checked_at: NOW,
      checked_ruc: OTRO,
      check_error: `El token es del RUC ${OTRO}, no del ${GF}`,
    });
    expect(JSON.stringify(r)).not.toContain(SECRET);
  });

  it("un RUC en Real cuya prueba falla baja a Simulación, y se dice", async () => {
    st.issuer = issuerRow({ mode: "real", checked_ruc: GF });
    st.probe = { ok: false, error: "Token rechazado", ruc: null };
    st.written = { mode: "simulacion" };
    const r = await testInvoiceIssuer("store", "iss-1");
    expect(r.error).toBe("Token rechazado.\nEl RUC bajó a Simulación hasta que una prueba confirme el RUC.");
    expect(lastWrite()!.payload).toMatchObject({ checked_ruc: null, check_error: "Token rechazado" });
  });

  it("sin token no llama a nadie", async () => {
    st.issuer = issuerRow({ token_enc: null });
    const r = await testInvoiceIssuer("store", "iss-1");
    expect(r).toEqual({ error: "Primero guarda el token de SimpleFact de este RUC." });
    expect(st.probeArgs).toEqual([]);
    expect(writes()).toEqual([]);
  });

  it("un token que no se puede descifrar queda como error de la prueba, sin llamar", async () => {
    st.decryptThrows = true;
    const r = await testInvoiceIssuer("store", "iss-1");
    expect(r).toEqual({ error: "No se pudo descifrar el token guardado: vuelve a pegarlo." });
    expect(st.probeArgs).toEqual([]);
    expect(lastWrite()!.payload).toMatchObject({ checked_ruc: null });
  });

  it("si el RUC cambió mientras se probaba, el resultado no se da por bueno", async () => {
    st.written = null;
    const r = await testInvoiceIssuer("store", "iss-1");
    expect(r).toEqual({ error: "El RUC cambió mientras se probaba: vuelve a probar la conexión." });
  });

  it("un RUC de otra organización no se prueba", async () => {
    st.issuer = null;
    expect(await testInvoiceIssuer("store", "iss-x")).toEqual({
      error: "Ese RUC no es de la organización de esta tienda.",
    });
    expect(decrypt).not.toHaveBeenCalled();
    expect(st.probeArgs).toEqual([]);
  });
});

// ── Cuenta → RUC (MOM §35.2) ─────────────────────────────────────────────────

describe("setAccountInvoiceIssuer", () => {
  it("asigna el RUC a la cuenta de ESTA tienda: filtra por id y store_id", async () => {
    const r = await setAccountInvoiceIssuer("store", "acc-1", "iss-1");
    expect(r).toEqual({ notice: `«Grupo GF S.A.C.» emite con GRUPO GF S.A.C. (RUC ${GF}) ✓` });
    const lookup = st.calls.find((c) => c.table === "invoice_issuers")!;
    expect(lookup.filters).toEqual([
      ["eq", "id", "iss-1"],
      ["eq", "org_id", "org"],
    ]);
    const w = lastWrite("store_collection_accounts")!;
    expect(w.op).toBe("update");
    expect(w.payload).toMatchObject({ invoice_issuer_id: "iss-1" });
    expect(w.filters).toEqual([
      ["eq", "id", "acc-1"],
      ["eq", "store_id", "store"],
    ]);
  });

  it("'' es «Sin comprobante»: deja la cuenta sin RUC", async () => {
    const r = await setAccountInvoiceIssuer("store", "acc-1", "");
    expect(r).toEqual({ notice: "«Grupo GF S.A.C.» queda sin comprobante ✓" });
    expect(st.calls.some((c) => c.table === "invoice_issuers")).toBe(false);
    expect(lastWrite("store_collection_accounts")!.payload).toMatchObject({ invoice_issuer_id: null });
  });

  it("un RUC de otra organización no se asigna", async () => {
    st.issuerLookup = null;
    const r = await setAccountInvoiceIssuer("store", "acc-1", "iss-ajeno");
    expect(r).toEqual({ error: "Ese RUC no es de la organización de esta tienda." });
    expect(writes("store_collection_accounts")).toEqual([]);
  });

  it("la cuenta de otra tienda no aparece", async () => {
    st.account = null;
    const r = await setAccountInvoiceIssuer("store", "acc-de-otra", "iss-1");
    expect(r).toEqual({ error: "No se encontró esa cuenta en esta tienda." });
  });

  it("si el trigger de la base dice que el RUC es ajeno, se dice igual", async () => {
    st.accountError = { message: "El RUC no es de la organización de la tienda" };
    const r = await setAccountInvoiceIssuer("store", "acc-1", "iss-1");
    expect(r).toEqual({ error: "Ese RUC no es de la organización de esta tienda." });
  });
});

// ── La sección en el navegador ───────────────────────────────────────────────

/** Los módulos que el navegador carga con la sección (sin cruzar «use server»). */
function clientGraph(entry: string): Map<string, string> {
  const seen = new Map<string, string>();
  const visit = (file: string) => {
    if (seen.has(file)) return;
    const src = readFileSync(file, "utf8");
    seen.set(file, src);
    // Un módulo «use server» llega al navegador como referencia, no como código.
    if (/^\s*["']use server["']/.test(src)) return;
    for (const m of src.matchAll(/^\s*(?:import|export)\s+(type\s+)?[^;]*?from\s+["']([^"']+)["']/gm)) {
      if (m[1]) continue;
      const spec = m[2]!;
      const base = spec.startsWith("@/")
        ? resolve(process.cwd(), spec.slice(2))
        : spec.startsWith(".")
          ? resolve(dirname(file), spec)
          : null;
      if (!base) continue;
      const hit = ["", ".ts", ".tsx", "/index.ts", "/index.tsx"]
        .map((ext) => base + ext)
        .find((p) => existsSync(p) && statSync(p).isFile());
      if (hit) visit(hit);
    }
  };
  visit(resolve(process.cwd(), entry));
  return seen;
}

describe("la sección no arrastra node:crypto ni recibe el token", () => {
  it("no importa lib/crypto ni el lado servidor de comprobantes", () => {
    expect(SECTION.startsWith('"use client";')).toBe(true);
    expect(SECTION).not.toMatch(/from "@\/lib\/crypto"/);
    expect(SECTION).not.toMatch(/from "@\/lib\/invoicing\/server"/);
    expect(SECTION).not.toMatch(/from "@\/lib\/invoicing\/simplefact"/);
    expect(SECTION).not.toMatch(/from "node:crypto"/);
  });

  it("ningún módulo que carga el navegador con ella importa node:crypto", () => {
    const graph = clientGraph("components/invoice-settings-section.tsx");
    expect(graph.size).toBeGreaterThan(5);
    const culpables = [...graph]
      .filter(([, src]) => !/^\s*["']use server["']/.test(src))
      .filter(([, src]) => /from\s+["'](node:crypto|crypto|server-only|@\/lib\/crypto)["']/.test(src))
      .map(([file]) => file);
    expect(culpables).toEqual([]);
  });

  it("la página no selecciona token_enc: sabe si hay token con un filtro", () => {
    expect(PAGE).not.toMatch(/\.select\([^)]*token_enc/);
    expect(PAGE).toContain('.not("token_enc", "is", null)');
    expect(PAGE).toContain("hasToken: withToken.has(r.id),");
  });

  it("la página pide el permiso y lee dentro del Promise.all sin tumbar Ajustes", () => {
    expect(PAGE).toContain('const canManageInvoices = await hasOrgPermission(store.org_id, "invoices.manage");');
    expect(PAGE).toContain("loadInvoiceSettings(admin, store.org_id, storeId).catch(() => NO_INVOICES)");
    expect(PAGE).toContain("invoices: { canManage: canManageInvoices, ...invoices },");
    const all = PAGE.slice(PAGE.indexOf("] = await Promise.all(["), PAGE.indexOf("const leadVoice = "));
    expect(all).toContain("loadInvoiceSettings(");
  });

  it("va en el índice, en Cobranza junto a las cuentas, y se monta ahí", () => {
    expect(FORM).toContain(
      '      { id: "cuentas", label: "Cuentas de cobro" },\n      { id: "boletas", label: "Boletas y facturas" },',
    );
    const cuentas = FORM.indexOf("<PaymentMethodsSection storeId={s.id}");
    const boletas = FORM.indexOf("<InvoiceSettingsSection storeId={s.id} data={data.invoices}");
    const escalera = FORM.indexOf("<EscalationSection storeId={s.id}");
    expect(cuentas).toBeGreaterThan(-1);
    expect(boletas).toBeGreaterThan(cuentas);
    expect(escalera).toBeGreaterThan(boletas);
    expect(SECTION).toContain('<SettingsSection id="boletas" title={TITLE}>');
    expect(SECTION).toContain('const TITLE = "Boletas y facturas (SimpleFact)";');
  });
});

function issuerView(over: Partial<InvoiceIssuerView> = {}): InvoiceIssuerView {
  return {
    id: "iss-1",
    ruc: GF,
    legalName: "GRUPO GF S.A.C.",
    subdomain: "grupogf",
    mode: "simulacion",
    emitFromInput: "2026-10-14T10:00",
    dailyLimit: 40,
    hasToken: true,
    checkedAt: "2026-10-14T14:30:00.000Z",
    checkedRuc: GF,
    checkError: null,
    today: { emitidas: 0, simuladas: 5, enDuda: 1, errores: 2 },
    ...over,
  };
}

function render(data: Partial<InvoiceSettingsData>, paymentMethods = METHODS): string {
  return renderToStaticMarkup(
    createElement(InvoiceSettingsSection, {
      storeId: "store",
      data: { canManage: true, issuers: [issuerView()], accounts: ACCOUNTS, recent: RECENT, ...data },
      paymentMethods,
    }),
  );
}

const ACCOUNTS: InvoiceSettingsData["accounts"] = [
  { id: "acc-gf", label: "Grupo GF S.A.C.", aliases: [], phoneLastDigits: "309", issuerId: "iss-1" },
  { id: "acc-flow", label: "Aurela Kenku", aliases: [], phoneLastDigits: null, issuerId: "iss-1" },
  { id: "acc-frank", label: "Frank Zapata", aliases: ["Frank Z"], phoneLastDigits: "123", issuerId: null },
];

const METHODS = [
  { kind: "banco", label: "BCP", holder: "Grupo GF SAC", account: "191-2434540-0-12", active: true },
  { kind: "yape", label: "YAPE 1", holder: "GRUPO GF S.A.C.", account: "930 555 309", active: true },
  { kind: "yape", label: "YAPE VIEJO", holder: "Grupo GF S.A.C.", account: "999888777", active: false },
  { kind: "plin", label: "PLIN", holder: "Otra Persona", account: "911222333", active: true },
];

const RECENT: InvoiceSettingsData["recent"] = [
  {
    id: "inv-1",
    orderId: "ord-1",
    orderName: "#KP136181",
    ruc: GF,
    mode: "real",
    status: "emitida",
    serie: "B001",
    correlative: "97",
    total: 89.9,
    error: null,
    createdAt: "2026-10-14T14:00:00.000Z",
    rucMismatch: false,
  },
  {
    id: "inv-2",
    orderId: "ord-2",
    orderName: "#KP136182",
    ruc: GF,
    mode: "real",
    status: "en_duda",
    serie: null,
    correlative: null,
    total: 120,
    error: "SimpleFact no respondió.",
    createdAt: "2026-10-14T14:10:00.000Z",
    rucMismatch: false,
  },
];

describe("la sección, pintada", () => {
  it("sin el permiso solo dice quién la configura", () => {
    const html = render({ canManage: false, issuers: null, accounts: null, recent: null });
    expect(html).toContain("Boletas y facturas (SimpleFact)");
    expect(html).toContain("Lo configura quien tiene el permiso “Boletas y facturas” (solo lo da el owner).");
    expect(html).not.toContain("Probar conexión");
    expect(html).not.toContain("Sin comprobante");
    expect(html).not.toContain("Últimos comprobantes");
  });

  it("el token solo como «Configurado» / «Sin configurar»", () => {
    expect(render({})).toContain("Configurado");
    const sin = render({ issuers: [issuerView({ hasToken: false, checkedAt: null, checkedRuc: null })] });
    expect(sin).toContain("Sin configurar");
    // Sin token no se puede probar.
    expect(sin).toMatch(/<button[^>]*disabled=""[^>]*>Probar conexión<\/button>/);
  });

  it("cada RUC con su modo, «Emitir desde», tope, la última prueba y lo de hoy", () => {
    const html = render({});
    expect(html).toContain("GRUPO GF S.A.C.");
    expect(html).toContain("grupogf.simplefact.pe");
    expect(html).toContain('value="2026-10-14T10:00"');
    expect(html).toContain('type="datetime-local"');
    expect(html).toMatch(/<option value="simulacion" selected="">Simulación<\/option>/);
    expect(html).toContain('name="daily_limit"');
    expect(html).toContain(`leyó el RUC <span class="tabular-nums">${GF}</span> ✓`);
    for (const label of ["Emitidas", "Simuladas", "En duda", "Con error", "Tope"]) expect(html).toContain(`>${label}</dt>`);
    expect(html).toContain("Los RUC son de la organización: valen para <strong>todas sus tiendas</strong>.");
    expect(html).toContain("Agregar RUC");
  });

  // FIX: cuando el barrido apaga un RUC borra `checked_at`/`checked_ruc` y deja
  // el motivo en `check_error`. Sin fecha, esto decía «Sin probar…» y escondía
  // el motivo: el owner no sabía por qué se apagó ni qué arreglar.
  it("un RUC que Kapta apagó dice por qué y que hay que probar antes de volver a Real", () => {
    const why = `SimpleFact emitió con archivos del RUC ${OTRO}: el token no es de este RUC.`;
    const html = render({
      issuers: [issuerView({ mode: "apagado", checkedAt: null, checkedRuc: null, checkError: why })],
    });
    expect(html).toContain(
      `Apagado por Kapta: SimpleFact emitió con archivos del RUC ${OTRO}: el token no es de este RUC. Prueba la conexión antes de volver a Real.`,
    );
    expect(html).toMatch(/<span class="text-crit-fg">Apagado por Kapta: /);
    expect(html).not.toContain("Sin probar");
  });

  it("sin fecha y encendido, el motivo se enseña igual: no está probado", () => {
    const html = render({
      issuers: [issuerView({ mode: "simulacion", checkedAt: null, checkedRuc: null, checkError: "Token rechazado (401)." })],
    });
    expect(html).toContain("Sin probar. Lo último que falló: Token rechazado (401). Prueba la conexión antes de pasar a Real.");
    expect(html).not.toContain("Apagado por Kapta");
  });

  it("sin fecha ni motivo, «Sin probar»; con una prueba fechada, la de siempre", () => {
    const nunca = render({ issuers: [issuerView({ checkedAt: null, checkedRuc: null, checkError: null })] });
    expect(nunca).toContain("Sin probar. «Probar conexión» lee las ventas de la cuenta");
    expect(nunca).not.toContain("Apagado por Kapta");
    const fallida = render({
      issuers: [issuerView({ mode: "apagado", checkedRuc: null, checkError: "Token rechazado (401)." })],
    });
    // 09:30 en Lima del 14.
    expect(fallida).toMatch(/Última prueba \([^)]*9:30[^)]*\): Token rechazado \(401\)\./);
    expect(fallida).not.toContain("Apagado por Kapta");
  });

  it("el alta no ofrece Real", () => {
    const html = render({ issuers: [] });
    expect(html).toContain("Aún no hay RUC");
    // El formulario de alta es el único: Real no aparece entre sus opciones.
    expect(html).not.toContain('<option value="real">');
  });

  it("cada cuenta con su titular, lo que cubre y su RUC", () => {
    const html = render({});
    expect(html).toContain("Grupo GF S.A.C. <span");
    expect(html).toContain("· ···309");
    expect(html).toContain("· Flow (sin celular)");
    // Por titular, no por banco: el BCP y el Yape del mismo titular van juntos;
    // lo retirado y lo de otro titular no.
    expect(html).toContain("Cubre: BCP ···0-12, YAPE 1 ···309");
    expect(html).not.toContain("YAPE VIEJO");
    expect(html).not.toContain("PLIN ···");
    expect(html).toContain("Ninguna cuenta que ve el cliente tiene este titular.");
    expect(html).toContain("Cubre: los pagos por link de Flow y el prepago web de la tienda.");
    expect(html).toMatch(/<option value="" selected="">Sin comprobante<\/option>/);
    expect(html).toContain(`GRUPO GF S.A.C. · ${GF}</option>`);
  });

  it("los últimos comprobantes, con su estado, su número y, si quedó en duda, por qué", () => {
    const html = render({});
    expect(html).toContain("#KP136181");
    expect(html).toContain("?ficha=ord-1");
    expect(html).toContain(">Emitida</span>");
    expect(html).toContain("B001-97");
    expect(html).toContain("S/ 89.90");
    expect(html).toContain(">En duda</span>");
    expect(html).toContain("SimpleFact no respondió.");
  });

  // FIX F: una emitida con archivos de otro RUC se pintaba como una emitida más,
  // verde y sin su error. Es una boleta de una empresa que no cobró.
  it("una emitida con otro RUC va marcada, en rojo y con su error", () => {
    const error = `SimpleFact contestó con archivos del RUC ${OTRO}, no del ${GF}.`;
    const html = render({
      recent: [{ ...RECENT![0]!, id: "inv-3", orderName: "#KP136190", rucMismatch: true, error }],
    });
    expect(html).toMatch(/<span[^>]*bg-crit-bg[^>]*>Emitida<\/span>/);
    expect(html).toMatch(/<span[^>]*bg-crit-bg[^>]*>Otro RUC<\/span>/);
    expect(html).toContain(error);
    expect(html).toContain("Revísala en SimpleFact: puede necesitar anularse o una nota de crédito.");
    // La de su RUC sigue verde y sin marca.
    const bien = render({});
    expect(bien).toMatch(/<span[^>]*bg-ok-bg[^>]*>Emitida<\/span>/);
    expect(bien).not.toContain("Otro RUC");
  });

  it("la página lee la marca de los últimos comprobantes", () => {
    // La primera lectura de `order_invoices` es la de los últimos 20.
    const recent = PAGE.slice(PAGE.indexOf('.from("order_invoices")'), PAGE.indexOf(".limit(20)"));
    expect(recent).toMatch(/\.select\("[^"]*\bruc_mismatch\b[^"]*"\)/);
    expect(PAGE).toContain("rucMismatch: r.ruc_mismatch === true,");
  });

  it("lo que no se pudo leer se dice, no se pinta como vacío", () => {
    const html = render({ issuers: null, accounts: null, recent: null });
    expect(html).toContain("No se pudieron leer los RUC de la organización.");
    expect(html).toContain("No se pudieron leer los comprobantes.");
    expect(html).not.toContain("Todavía no hay comprobantes");
    const sinCuentas = render({ accounts: null });
    expect(sinCuentas).toContain("No se pudieron leer las cuentas de esta tienda");
  });
});

// ── El MOM ───────────────────────────────────────────────────────────────────

describe("MOM §35", () => {
  it("nombra estos archivos y lo que Ajustes muestra", () => {
    const mom = read("docs/mom/master-pedidos-v1.md").replace(/\s+/g, " ");
    expect(mom).toContain(
      "Ajustes, en `app/dashboard/[storeId]/settings/invoice-actions.ts` y `components/invoice-settings-section.tsx`",
    );
    expect(mom).toContain("Ajustes solo dice «Configurado» o «Sin configurar».");
    expect(mom).toContain("En Ajustes de la tienda se pide además `stores.manage`.");
  });
});

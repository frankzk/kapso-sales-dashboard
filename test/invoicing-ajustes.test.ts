// Ajustes → «Boletas y facturas» (MOM §35.2, §35.4, §35.7, §35.8).
//
// Lo que se fija aquí: que las tres acciones pidan los DOS permisos («Administrar
// tiendas» y «Boletas y facturas») en la organización de la tienda; que un RUC
// no se guarde con datos que la base rechazaría; que el token se cifre y nunca
// vuelva; que «Emitir desde» no quede atrás; que Manual y Real se ganen con una
// prueba de conexión que leyó el RUC declarado; que «Emitir» de los últimos
// comprobantes salga solo en la simulada de un RUC en Manual; y que la sección
// del navegador no arrastre `node:crypto` ni reciba el token. La base, la
// sesión, el cifrado, SimpleFact y la acción de emitir van simulados: aquí no
// sale nada a la red.

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
// La acción de emitir es la del drawer (test/invoicing-drawer.test.ts la
// prueba): aquí solo se mira que Ajustes la use, y no se carga su servidor.
vi.mock("@/app/dashboard/pedidos/invoice-actions", () => ({
  emitInvoiceAction: vi.fn(async () => ({ notice: "Emitida B001-1" })),
  loadInvoicePanel: vi.fn(),
  registerExternalInvoice: vi.fn(),
  requestInvoiceRetry: vi.fn(),
  releaseDoubtfulInvoice: vi.fn(),
  confirmDoubtfulInvoice: vi.fn(),
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
import {
  isValidRuc,
  INVOICE_BACKFILL_FROM,
  INVOICE_DAILY_LIMIT_MAX,
  INVOICE_DAILY_LIMIT_MIN,
  INVOICE_REASON_LABEL,
} from "@/lib/invoicing/rules";
import {
  saveInvoiceIssuer,
  setAccountInvoiceIssuer,
  testInvoiceIssuer,
} from "@/app/dashboard/[storeId]/settings/invoice-actions";
import {
  InvoiceSettingsSection,
  MODE_HELP,
  RecentListView,
  type InvoiceIssuerView,
  type InvoiceRecentView,
  type InvoiceSettingsData,
  type RecentEmitOutcomes,
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
/**
 * Lo que dice Ajustes cuando un cambio de modo mueve «Emitir desde» (MOM
 * §35.4): el barrido no va hacia atrás; lo de antes, desde el 01/10/2026, solo
 * con el botón (owner, 15-10-2026). Ya no «ningún RUC emite hacia atrás».
 */
const MODO_MOVIO_FECHA =
  "Al cambiar de modo, «Emitir desde» quedó en ahora: el barrido no emite nada pagado antes. En Manual, lo pagado desde el 01/10/2026 solo sale con «Emitir esta boleta», después de revisar SimpleFact.";

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
    // El aviso entero: que el barrido no va hacia atrás, y que lo de antes solo
    // sale con el botón. «Ningún RUC emite hacia atrás» ya no es cierto.
    expect(r.notice!.split("\n")).toContain(MODO_MOVIO_FECHA);
    expect(r.notice).not.toContain("ningún RUC emite hacia atrás");
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
      data: { canManage: true, emitHere: true, issuers: [issuerView()], accounts: ACCOUNTS, recent: RECENT, ...data },
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
    issuerId: "iss-1",
    emitNow: null,
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
    issuerId: "iss-1",
    emitNow: null,
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
  // Y dice «o a Manual»: Manual también manda boletas a SUNAT y la base le
  // exige la misma prueba (0261). Decir solo Real dejaba creer que a Manual se
  // podía volver sin probar.
  it("un RUC que Kapta apagó dice por qué y que hay que probar antes de volver a Real o a Manual", () => {
    const why = `SimpleFact emitió con archivos del RUC ${OTRO}: el token no es de este RUC.`;
    const html = render({
      issuers: [issuerView({ mode: "apagado", checkedAt: null, checkedRuc: null, checkError: why })],
    });
    expect(html).toContain(
      `Apagado por Kapta: SimpleFact emitió con archivos del RUC ${OTRO}: el token no es de este RUC. Prueba la conexión antes de volver a Real o a Manual.`,
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

// ── «Manual» (owner, 15-10-2026) ─────────────────────────────────────────────

describe("saveInvoiceIssuer: Manual pide lo mismo que Real", () => {
  it("sin una prueba que leyó el RUC no pasa, con la misma frase que Real, y no se escribe nada", async () => {
    st.issuer = issuerRow({ mode: "simulacion", checked_ruc: null });
    const r = await saveInvoiceIssuer("store", {}, issuerForm({ mode: "manual" }));
    expect(r).toEqual({
      error: "Prueba la conexión antes de pasar a Manual: todavía no hay una prueba que haya leído este RUC.",
    });
    st.issuer = issuerRow({ mode: "simulacion", checked_ruc: OTRO });
    expect((await saveInvoiceIssuer("store", {}, issuerForm({ mode: "manual" }))).error).toBe(
      `Prueba la conexión antes de pasar a Manual: la última prueba leyó el RUC ${OTRO}, no el ${GF}.`,
    );
    expect(writes()).toEqual([]);
  });

  it("sin token no pasa", async () => {
    st.issuer = issuerRow({ mode: "simulacion", checked_ruc: GF });
    st.hasToken = false;
    expect(await saveInvoiceIssuer("store", {}, issuerForm({ mode: "manual" }))).toEqual({
      error: "Falta el token de SimpleFact: ponlo y prueba la conexión antes de pasar a Manual.",
    });
    expect(writes()).toEqual([]);
  });

  it("no en el mismo guardado que cambia el token, el RUC o el subdominio", async () => {
    st.issuer = issuerRow({ mode: "simulacion", checked_ruc: GF });
    expect((await saveInvoiceIssuer("store", {}, issuerForm({ mode: "manual", token: SECRET }))).error).toBe(
      "Guarda primero el token nuevo y prueba la conexión antes de pasar a Manual.",
    );
    expect((await saveInvoiceIssuer("store", {}, issuerForm({ mode: "manual", subdomain: "otra" }))).error).toBe(
      "Cambiaste el RUC o el subdominio: guarda y prueba la conexión antes de pasar a Manual.",
    );
    expect((await saveInvoiceIssuer("store", {}, issuerForm({ mode: "manual", ruc: OTRO }))).error).toBe(
      "Cambiaste el RUC o el subdominio: guarda y prueba la conexión antes de pasar a Manual.",
    );
    expect(writes()).toEqual([]);
    expect(encrypt).not.toHaveBeenCalled();
  });

  it("un RUC nuevo no nace en Manual", async () => {
    st.issuer = null;
    const r = await saveInvoiceIssuer("store", {}, issuerForm({ issuer_id: "", mode: "manual" }));
    expect(r.error).toBe(
      "Un RUC nuevo empieza en Apagado o Simulación: guarda su token y prueba la conexión antes de pasar a Manual.",
    );
    expect(writes()).toEqual([]);
  });

  it("con token y la prueba del mismo RUC, pasa: «Emitir desde» a ahora y dice qué cambia", async () => {
    st.issuer = issuerRow({ mode: "simulacion", checked_ruc: GF });
    const r = await saveInvoiceIssuer("store", {}, issuerForm({ mode: "manual" }));
    expect(r.error).toBeUndefined();
    expect(lastWrite()!.payload).toMatchObject({ mode: "manual", emit_from: NOW });
    expect(r.notice).toContain(`RUC ${GF} guardado ✓ · Manual`);
    expect(r.notice).toContain("«Emitir desde» quedó en ahora");
    expect(r.notice).toContain(
      "En Manual el barrido solo simula: cada boleta real se emite con «Emitir esta boleta» en el pedido.",
    );
  });

  it("de Manual a Real y de Real a Manual, con la prueba hecha, pasa", async () => {
    st.issuer = issuerRow({ mode: "manual", checked_ruc: GF });
    expect((await saveInvoiceIssuer("store", {}, issuerForm({ mode: "real" }))).notice).toContain("· Real");
    st.issuer = issuerRow({ mode: "real", checked_ruc: GF });
    expect((await saveInvoiceIssuer("store", {}, issuerForm({ mode: "manual" }))).notice).toContain("· Manual");
    // Y sin la prueba, tampoco entre ellos: lo dice la base, y aquí antes.
    st.issuer = issuerRow({ mode: "manual", checked_ruc: null });
    expect((await saveInvoiceIssuer("store", {}, issuerForm({ mode: "real" }))).error).toMatch(
      /^Prueba la conexión antes de pasar a Real/,
    );
  });

  it("un RUC que ya está en Manual se edita (el tope) sin volver a probar, y sin repetir el aviso", async () => {
    st.issuer = issuerRow({ mode: "manual", checked_ruc: GF });
    const r = await saveInvoiceIssuer("store", {}, issuerForm({ mode: "manual", daily_limit: "10" }));
    expect(r).toEqual({ notice: `RUC ${GF} guardado ✓ · Manual` });
    expect(lastWrite()!.payload).toMatchObject({ mode: "manual", daily_limit: 10 });
  });

  it("cambiar el token de un RUC en Manual: la base lo baja a Simulación y se dice", async () => {
    st.issuer = issuerRow({ mode: "manual", checked_ruc: GF });
    st.written = { id: "iss-1", mode: "simulacion" };
    const r = await saveInvoiceIssuer("store", {}, issuerForm({ mode: "manual", token: SECRET }));
    expect(r.notice).toContain("El token cambió: el RUC bajó a Simulación hasta que vuelvas a probar la conexión.");
    expect(r.notice).not.toContain("En Manual el barrido solo simula");
  });

  it("lo que la base rechaza de Manual vuelve en palabras; sin la 0261, lo dice", async () => {
    st.issuer = issuerRow({ mode: "simulacion", checked_ruc: GF });
    st.writeError = {
      code: "23514",
      message: 'new row for relation "invoice_issuers" violates check constraint "invoice_issuers_real_ready"',
    };
    expect((await saveInvoiceIssuer("store", {}, issuerForm({ mode: "manual" }))).error).toBe(
      "Para pasar a Manual hacen falta el token, «Emitir desde» y una prueba de conexión que leyó este mismo RUC.",
    );
    st.writeError = {
      code: "23514",
      message: 'new row for relation "invoice_issuers" violates check constraint "invoice_issuers_mode_check"',
    };
    expect((await saveInvoiceIssuer("store", {}, issuerForm({ mode: "manual" }))).error).toBe(
      "La base todavía no admite el modo Manual: falta aplicar la migración 0261.",
    );
    // Otro modo que choca con esa regla sigue siendo «ese modo no existe».
    expect((await saveInvoiceIssuer("store", {}, issuerForm({ mode: "simulacion" }))).error).toBe("Ese modo no existe.");
  });

  it("el modo se elige entre los cuatro", async () => {
    expect((await saveInvoiceIssuer("store", {}, issuerForm({ mode: "automatico" }))).error).toBe(
      "Elige un modo: Apagado, Simulación, Manual o Real.",
    );
  });
});

describe("testInvoiceIssuer: un RUC en Manual cuya prueba falla", () => {
  it("baja a Simulación, como Real, y se dice", async () => {
    st.issuer = issuerRow({ mode: "manual", checked_ruc: GF });
    st.probe = { ok: false, error: "Token rechazado", ruc: null };
    st.written = { mode: "simulacion" };
    const r = await testInvoiceIssuer("store", "iss-1");
    expect(r.error).toBe("Token rechazado.\nEl RUC bajó a Simulación hasta que una prueba confirme el RUC.");
    // Si la base no lo bajó, no se dice que bajó.
    st.written = { mode: "manual" };
    expect((await testInvoiceIssuer("store", "iss-1")).error).toBe("Token rechazado.");
  });
});

describe("la sección, pintada: Manual", () => {
  /** Lo que saldría si se pulsa: lo decide la página con la función del drawer. */
  const OFERTA = { issuerId: "iss-1", ruc: GF, legalName: "GRUPO GF S.A.C.", total: 85 };
  const simulada = (over: Partial<InvoiceRecentView> = {}): InvoiceRecentView => ({
    id: "inv-sim",
    orderId: "ord-9",
    orderName: "#KP136199",
    issuerId: "iss-1",
    ruc: GF,
    mode: "simulacion",
    status: "simulada",
    serie: null,
    correlative: null,
    total: 85,
    error: null,
    createdAt: "2026-10-14T14:20:00.000Z",
    rucMismatch: false,
    emitNow: OFERTA,
    ...over,
  });
  const BOTON = /<button[^>]*>Emitir<\/button>/g;

  it("un RUC ya dado de alta ofrece los cuatro modos; el alta, solo Apagado y Simulación", () => {
    const html = render({ issuers: [issuerView({ mode: "manual" })] });
    expect(html).toMatch(/<option value="manual" selected="">Manual<\/option>/);
    expect(html).toContain('<option value="real">Real</option>');
    // El formulario del alta no ofrece ni Manual ni Real.
    const alta = render({ issuers: [] });
    expect(alta).not.toContain('<option value="manual">');
    expect(alta).not.toContain('<option value="real">');
    expect(alta).toContain("Un RUC nuevo pasa a Manual o a Real después de probar su conexión.");
  });

  it("cada modo explicado en una línea: Manual, y Real como lo automático", () => {
    expect(MODE_HELP.manual).toMatch(
      /^Revisa y simula como Simulación; tú emites cada boleta con «Emitir esta boleta» en el pedido\./,
    );
    expect(MODE_HELP.real).toMatch(/^Automático: el barrido emite cada boleta en SimpleFact/);
    const t = render({}).replace(/<[^>]+>/g, "");
    expect(t).toContain(`Manual: ${MODE_HELP.manual}`);
    expect(t).toContain(`Real: ${MODE_HELP.real}`);
  });

  it("la chapa de la sección dice «En manual», y Real manda sobre Manual", () => {
    expect(render({ issuers: [issuerView({ mode: "manual" })] })).toMatch(/>En manual<\/span>/);
    expect(render({ issuers: [issuerView({ mode: "manual" }), issuerView({ id: "iss-2", mode: "real" })] })).toMatch(
      />En real<\/span>/,
    );
  });

  it("«Hoy» enseña las emitidas también en Manual: las que salieron con el botón", () => {
    const html = render({
      issuers: [issuerView({ mode: "manual", today: { emitidas: 3, simuladas: 12, enDuda: 0, errores: 0 } })],
    });
    expect(html).toMatch(/>Emitidas<\/dt><dd[^>]*>3<\/dd>/);
    expect(html).toMatch(/>Simuladas<\/dt><dd[^>]*>12<\/dd>/);
  });

  it("«Emitir» solo en la simulada que la página marcó, de un RUC que está en Manual", () => {
    const manual = [issuerView({ mode: "manual" })];
    expect(render({ issuers: manual, recent: [simulada()] }).match(BOTON)).toHaveLength(1);
    // La página no la marcó (el drawer no lo ofrecería, no es la más nueva, o no se pudo leer).
    expect(render({ issuers: manual, recent: [simulada({ emitNow: null })] })).not.toMatch(BOTON);
    // El RUC no está en Manual en lo que se ve.
    for (const mode of ["real", "simulacion", "apagado"] as const) {
      expect(render({ issuers: [issuerView({ mode })], recent: [simulada()] }), mode).not.toMatch(BOTON);
    }
    // Una real nunca lleva «Emitir», aunque viniera marcada.
    expect(render({ issuers: manual, recent: [simulada({ mode: "real", status: "error" })] })).not.toMatch(BOTON);
    // Un RUC que ya no está, tampoco: el de lo que saldría, no el de la simulada.
    expect(render({ issuers: manual, recent: [simulada({ emitNow: { ...OFERTA, issuerId: "iss-borrado" } })] })).not.toMatch(
      BOTON,
    );
    // Si el pedido pasó a otro RUC también en Manual, sale con ese: es el que se enviaría.
    const dos = [issuerView({ mode: "manual" }), issuerView({ id: "iss-2", ruc: OTRO, mode: "manual" })];
    const otro = { issuerId: "iss-2", ruc: OTRO, legalName: "OTRA EMPRESA S.A.C.", total: 85 };
    expect(render({ issuers: dos, recent: [simulada({ emitNow: otro })] }).match(BOTON)).toHaveLength(1);
    // Y si ese RUC no está en Manual en lo que se ve, no.
    const otroEnReal = [issuerView({ mode: "manual" }), issuerView({ id: "iss-2", ruc: OTRO, mode: "real" })];
    expect(render({ issuers: otroEnReal, recent: [simulada({ emitNow: otro })] })).not.toMatch(BOTON);
    // Ni si no se pudieron leer los RUC.
    expect(render({ issuers: null, recent: [simulada()] })).not.toMatch(BOTON);
  });

  it("solo a quien tiene «Boletas y facturas»", () => {
    const html = render({ canManage: false, issuers: [issuerView({ mode: "manual" })], recent: [simulada()] });
    expect(html).not.toMatch(BOTON);
    expect(SECTION).toContain("const issuer = offer ? issuers.find((i) => i.id === offer.issuerId) : undefined;");
    expect(SECTION).toMatch(
      /const show =\s*canEmit &&\s*emitHere &&\s*!!offer &&\s*r\.status === "simulada" &&\s*issuer\?\.mode === "manual" &&\s*!outcomes\[r\.orderId\];/,
    );
    expect(SECTION).toContain(
      "<RecentList rows={data.recent} issuers={issuers ?? []} canEmit={data.canManage} emitHere={data.emitHere} />",
    );
  });

  it("es la acción del drawer, con su confirmación, lo que vio la persona y la respuesta en la fila", () => {
    const emit = SECTION.slice(SECTION.indexOf("function RecentList("), SECTION.indexOf("function placeOutcomes("));
    const view = SECTION.slice(SECTION.indexOf("export function RecentListView("), SECTION.indexOf("// ── La sección"));
    expect(SECTION).toContain('import { EmitInvoiceControl, EmitOutcome } from "@/components/order-invoice-panel";');
    expect(SECTION).toMatch(
      /import \{\s*emitInvoiceAction,\s*type EmitInvoiceState,\s*type InvoicePanelEmitNow,\s*\} from "@\/app\/dashboard\/pedidos\/invoice-actions";/,
    );
    expect(view).toContain("<EmitInvoiceControl");
    // Confirma y envía lo que confirmaría el drawer (el RUC y el total de ahora),
    // no lo de la simulada: si el pedido cambió, la confirmación lo dice.
    expect(view).toContain("emit={offer}");
    // Con la casilla «Revisé en SimpleFact…» de un pedido pagado antes de
    // «Emitir desde», como el drawer, y con la oferta que se vio al abrir la
    // confirmación (`shown`).
    expect(view).toContain("onEmit={(shown, simplefactChecked) => onEmit(r, shown, simplefactChecked)}");
    expect(emit).toContain(
      "res = await emitInvoiceAction(orderId, { issuerId: offer.issuerId, total: offer.total, simplefactChecked });",
    );
    expect(emit).not.toContain("row.total");
    expect(emit).not.toContain("row.ruc");
    // La respuesta se guarda en la lista, por pedido, y después se refresca.
    expect(emit).toContain("const [outcomes, setOutcomes] = useState<RecentEmitOutcomes>({});");
    expect(emit).toContain(
      "setOutcomes((prev) => ({ ...prev, [orderId]: { rowId: row.id, orderId, orderName: row.orderName, state: res } }));",
    );
    expect(emit).toContain("startRefresh(() => router.refresh());");
    expect(emit.indexOf("setOutcomes(")).toBeLessThan(emit.indexOf("startRefresh(() => router.refresh());"));
  });

  // Owner, 15-10-2026: lo pagado antes de «Emitir desde» (desde el 01/10/2026)
  // se emite con el botón y la casilla «Revisé en SimpleFact…». Ajustes no lo
  // esconde: es la misma oferta y el mismo control que el drawer.
  it("un pedido pagado antes de «Emitir desde» lleva «Emitir» igual, y la casilla viaja a la acción", () => {
    const antes = { ...OFERTA, beforeStart: true, paidAt: "2026-10-10T15:00:00.000Z", emitFrom: "2026-10-14T05:00:00.000Z" };
    const manual = [issuerView({ mode: "manual" })];
    expect(render({ issuers: manual, recent: [simulada({ emitNow: antes })] }).match(BOTON)).toHaveLength(1);
    // La página no filtra las ofertas de antes: pasan tal cual las da el servidor.
    const marca = PAGE.slice(PAGE.indexOf("const newestSimulated"), PAGE.indexOf("  return {", PAGE.indexOf("const newestSimulated")));
    expect(marca).not.toContain("beforeStart");
    expect(SECTION.slice(SECTION.indexOf("export function RecentListView("))).not.toContain("beforeStart");
    // Lo que se marcó en la confirmación llega a `emitInvoiceAction`.
    const list = SECTION.slice(SECTION.indexOf("function RecentList("), SECTION.indexOf("function placeOutcomes("));
    expect(list).toContain("async function emit(row: InvoiceRecentView, offer: InvoicePanelEmitNow, simplefactChecked: boolean) {");
    expect(list).toContain("total: offer.total, simplefactChecked });");
    // Y lo que viaja es la oferta que se vio en la confirmación (`shown`), no la
    // de la fila al pulsar: si la fila cambió, el servidor dice `pedido_cambio`.
    expect(SECTION).toContain("onEmit={(shown, simplefactChecked) => onEmit(r, shown, simplefactChecked)}");
    expect(SECTION).not.toContain("onEmit(r, offer, simplefactChecked)");
  });

  // Owner, 15-10-2026: con la excepción del botón, «nada pagado antes sale» ya
  // no es cierto. Ajustes dice lo que de verdad pasa, con las mismas palabras
  // que el MOM (§35.4): el barrido no va hacia atrás; una persona, sí.
  it("Ajustes no promete de más: el barrido no va hacia atrás, y lo de antes solo sale con el botón", () => {
    const mom = readFileSync(resolve(process.cwd(), "docs/mom/master-pedidos-v1.md"), "utf8");
    const s4 = mom.slice(mom.indexOf("### 35.4 Topes y candados"), mom.indexOf("### 35.5 ")).replace(/\s+/g, " ");
    const plano = (t: string) => t.replace(/\s+/g, " ");
    // El aviso del cambio de modo.
    expect(ACTIONS).toContain(`const EMIT_FROM_MOVED_NOTICE =\n  "${MODO_MOVIO_FECHA}";`);
    expect(ACTIONS).toContain("if (!notes.length) notes.push(EMIT_FROM_MOVED_NOTICE);");
    expect(s4).toContain(`al mover la fecha por un cambio de modo, «${MODO_MOVIO_FECHA}»`);
    // La ayuda de «Emitir desde». Ajustes acepta una fecha en el futuro, y con
    // ella nada pagado antes sale, ni con el botón (revisión 15-10-2026): la
    // ayuda no promete el botón antes de que la fecha llegue.
    const ayuda =
      "El barrido solo toma pedidos que quedaron pagados desde aquí (en Manual y con esta fecha ya llegada, «Emitir esta boleta» también puede emitir lo pagado desde el 01/10/2026, después de revisar SimpleFact)";
    expect(plano(SECTION)).toContain(`Hora de Lima. ${ayuda}: una fecha en el pasado se guarda como ahora`);
    expect(s4).toContain(`junto a «Emitir desde», «${ayuda}»`);
    expect(s4).toContain("Con «Emitir desde» en el futuro, nada pagado antes de él sale, ni con el botón (35.3).");
    // Las cuentas de cobro.
    const cuentas = "Asignar un RUC no hace que el barrido emita nada pagado antes de su «Emitir desde».";
    expect(plano(SECTION)).toContain(cuentas);
    expect(s4).toContain(`en las cuentas de cobro, «${cuentas}»`);
    expect(ACTIONS).toContain(" * emite. Asignar no hace que el barrido emita nada pagado antes de «Emitir\n * desde» del RUC");
    // Lo de antes no vuelve.
    for (const viejo of [
      "ningún RUC emite hacia atrás",
      "Solo entran pedidos que quedaron pagados desde aquí",
      "Asignar un RUC no emite nada pagado antes",
      "Asignar no emite nada pagado antes",
      "(en Manual, «Emitir esta boleta» también puede emitir",
    ]) {
      expect(plano(ACTIONS), viejo).not.toContain(viejo);
      expect(plano(SECTION), viejo).not.toContain(viejo);
    }
    // El piso del texto es el de las reglas.
    expect(INVOICE_BACKFILL_FROM).toBe("2026-10-01T05:00:00.000Z");
  });

  // FIX: la página marcaba «Emitir» con solo dos cosas —el RUC de la simulada en
  // Manual y el pedido sin real viva— y nunca miraba lo que mira el drawer: las
  // reglas como emisión real, la última pasada de Shopify, la tienda activa ni
  // el RUC ACTUAL del pedido. Ahora pregunta a la misma función que el drawer
  // (`invoiceEmitNowReadiness`, por `loadInvoiceEmitNowOffers`); lo que esa
  // función decide se prueba en test/invoicing-server.test.ts, con la base.
  it("la página marca «Emitir» con la función del drawer, de una vez para la lista, y si no pudo leer, en ninguna", () => {
    const recent = PAGE.slice(PAGE.indexOf('.from("order_invoices")'), PAGE.indexOf(".limit(20)"));
    expect(recent).toMatch(/\.select\("[^"]*\bissuer_id\b[^"]*"\)/);
    expect(PAGE).toMatch(
      /import \{\s*invoiceEmitAllowedHere,\s*loadInvoiceEmitNowOffers,\s*type InvoiceEmitNowOffer,\s*\} from "@\/lib\/invoicing\/server";/,
    );
    const marca = PAGE.slice(PAGE.indexOf("const newestSimulated"), PAGE.indexOf("  return {", PAGE.indexOf("const newestSimulated")));
    // La simulada más nueva de cada pedido.
    expect(marca).toContain('if (r.status === "simulada" && r.mode === "simulacion" && !newestSimulated.has(r.order_id)) {');
    // Una sola pregunta para todos los pedidos de la lista, a la función del drawer.
    expect(marca.match(/loadInvoiceEmitNowOffers\(/g)).toHaveLength(1);
    expect(marca).toContain("offers = await loadInvoiceEmitNowOffers(admin, [...newestSimulated.keys()]);");
    // Falla cerrada: si no pudo leer, ninguna lleva «Emitir», sin tumbar la sección.
    expect(marca).toMatch(/\} catch \(cause\) \{[\s\S]*?offers = new Map\(\);\s*\}/);
    // Ya no decide por su cuenta con el RUC de la simulada ni con su propia lectura.
    expect(PAGE).not.toContain("manualIssuers");
    expect(PAGE).not.toContain("LIVE_REAL_STATUSES");
    expect(PAGE).not.toContain("invoiceEligibility");
    expect(marca).toContain(
      "const emitNowOf = (r: RecentRow) => (newestSimulated.get(r.order_id) === r.id ? offers.get(r.order_id) ?? null : null);",
    );
    expect(PAGE).toContain("emitNow: emitNowOf(r),");
    expect(PAGE).toContain("issuerId: r.issuer_id,");
    // Y la función es la misma que usa el drawer para su botón.
    const SERVER = read("lib/invoicing/server.ts");
    const loader = SERVER.slice(SERVER.indexOf("export async function loadInvoiceEmitNowOffers("));
    expect(loader.match(/loadInvoiceOrderFacts\(admin, ids\)/g)).toHaveLength(1);
    expect(loader).toContain("const ready = invoiceEmitNowReadiness({");
    const ACTIONS_DRAWER = read("app/dashboard/pedidos/invoice-actions.ts");
    const drawer = ACTIONS_DRAWER.slice(ACTIONS_DRAWER.indexOf("function emitNowOf("));
    expect(drawer.slice(0, drawer.indexOf("\n}\n"))).toContain(
      "const ready = invoiceEmitNowReadiness({ facts, invoices, checks, storeActive });",
    );
  });
});

// ── «Emitir»: lo que contesta no se pierde con el refresco (§35.7) ───────────

describe("«Emitir» en los últimos comprobantes: la respuesta se queda", () => {
  const OFERTA = { issuerId: "iss-1", ruc: GF, legalName: "GRUPO GF S.A.C.", total: 85 };
  const MANUAL = [issuerView({ mode: "manual" })];
  const PDF = "https://grupogf.simplefact.pe/files/20556792829-03-B001-97.pdf";
  const EN_DUDA = "SimpleFact no respondió: queda En duda; búscala por su nota «Kapta inv-real» antes de nada.";
  const BOTON = /<button[^>]*>Emitir<\/button>/;
  const ENCABEZADO = "<span>Fecha</span>";

  /** La simulada donde se pulsa «Emitir». */
  const simulada = (over: Partial<InvoiceRecentView> = {}): InvoiceRecentView => ({
    id: "inv-sim",
    orderId: "ord-9",
    orderName: "#KP136199",
    issuerId: "iss-1",
    ruc: GF,
    mode: "simulacion",
    status: "simulada",
    serie: null,
    correlative: null,
    total: 85,
    error: null,
    createdAt: "2026-10-14T14:20:00.000Z",
    rucMismatch: false,
    emitNow: OFERTA,
    ...over,
  });
  /** La real que nació al pulsar: la más nueva de la lista, ya sin oferta. */
  const real = (over: Partial<InvoiceRecentView> = {}): InvoiceRecentView =>
    simulada({ id: "inv-real", mode: "real", status: "en_duda", createdAt: NOW, emitNow: null, ...over });
  /** Lo que contestó «Emitir» del pedido ord-9, pulsado en la simulada. */
  const outcome = (state: { error?: string; notice?: string; pdfUrl?: string }, rowId = "inv-sim"): RecentEmitOutcomes => ({
    "ord-9": { rowId, orderId: "ord-9", orderName: "#KP136199", state },
  });

  function lista(props: Partial<Parameters<typeof RecentListView>[0]> = {}): string {
    return renderToStaticMarkup(
      createElement(RecentListView, {
        rows: [simulada()],
        issuers: MANUAL,
        canEmit: true,
        emitHere: true,
        outcomes: {},
        sending: new Set<string>(),
        pending: false,
        onEmit: async () => {},
        ...props,
      }),
    );
  }

  // FIX: la respuesta vivía dentro del botón, que solo se pintaba con oferta
  // (`r.emitNow`). Después de emitir la página se refresca y el pedido ya no
  // tiene oferta: el botón se desmontaba y con él las instrucciones de un «En
  // duda», el «Ver PDF» o el error, en cuanto llegaba el refresco.
  it("re-pintada sin oferta después de la respuesta: las instrucciones del En duda siguen a la vista", () => {
    // Antes de pulsar: el botón.
    expect(lista()).toMatch(BOTON);
    // Llega el refresco: la real nueva arriba y la simulada ya sin oferta.
    const html = lista({ rows: [real(), simulada({ emitNow: null })], outcomes: outcome({ error: EN_DUDA }) });
    expect(html).toContain(EN_DUDA);
    expect(html).toMatch(/<p role="alert"[^>]*>SimpleFact no respondió: queda En duda/);
    expect(html).not.toMatch(BOTON);
  });

  it("y el «Ver PDF» de la que salió", () => {
    const html = lista({
      rows: [real({ status: "emitida", serie: "B001", correlative: "97" }), simulada({ emitNow: null })],
      outcomes: outcome({ notice: "Emitida B001-97", pdfUrl: PDF }),
    });
    expect(html).toContain("Emitida B001-97");
    expect(html).toContain(`href="${PDF}"`);
    expect(html).toMatch(/>Ver PDF<svg/);
    expect(html).not.toMatch(BOTON);
  });

  it("y el error, también cuando la emisión apagó el RUC", () => {
    const apagado = "Token rechazado por SimpleFact (401): Kapta apagó el RUC.";
    const html = lista({
      rows: [simulada({ emitNow: null })],
      issuers: [issuerView({ mode: "apagado" })],
      outcomes: outcome({ error: apagado }),
    });
    expect(html).toContain(apagado);
    expect(html).not.toMatch(BOTON);
  });

  it("con una respuesta a la vista el botón de ese pedido no vuelve, aunque vuelva la oferta", () => {
    const cambio = INVOICE_REASON_LABEL.pedido_cambio;
    const html = lista({ outcomes: outcome({ error: cambio }) });
    expect(html).toContain(cambio);
    expect(html).not.toMatch(BOTON);
    // Tampoco si la respuesta quedó en otra fila del mismo pedido.
    const enOtraFila = lista({ rows: [real(), simulada()], outcomes: outcome({ error: EN_DUDA }, "inv-real") });
    expect(enOtraFila).toContain(EN_DUDA);
    expect(enOtraFila).not.toMatch(BOTON);
    // La de otro pedido no lo esconde.
    const otro: RecentEmitOutcomes = {
      "ord-otro": { rowId: "inv-x", orderId: "ord-otro", orderName: "#KP1", state: { notice: "Emitida B001-1" } },
    };
    expect(lista({ outcomes: otro })).toMatch(BOTON);
  });

  it("si la fila donde se pulsó ya no está, va en la más nueva de su pedido; si ninguna está, arriba con el pedido", () => {
    // La real nueva empujó a la simulada fuera de las 20: va en la real, dentro de la lista.
    const enLaReal = lista({ rows: [real()], outcomes: outcome({ error: EN_DUDA }) });
    expect(enLaReal.split(EN_DUDA)).toHaveLength(2);
    expect(enLaReal.indexOf(EN_DUDA)).toBeGreaterThan(enLaReal.indexOf(ENCABEZADO));
    // Ninguna de su pedido está: arriba, antes de la lista, con el enlace al pedido.
    const ajena = simulada({ id: "inv-x", orderId: "ord-x", orderName: "#KP1", emitNow: null });
    const arriba = lista({ rows: [ajena], outcomes: outcome({ error: EN_DUDA }) });
    expect(arriba.indexOf(EN_DUDA)).toBeGreaterThan(-1);
    expect(arriba.indexOf(EN_DUDA)).toBeLessThan(arriba.indexOf(ENCABEZADO));
    expect(arriba).toContain("?ficha=ord-9");
    expect(arriba).toContain("#KP136199");
    // El refresco no pudo leer la lista: se dice, y la respuesta sigue.
    const sinLista = lista({ rows: null, outcomes: outcome({ error: EN_DUDA }) });
    expect(sinLista).toContain("No se pudieron leer los comprobantes.");
    expect(sinLista).toContain(EN_DUDA);
    expect(sinLista).toContain("?ficha=ord-9");
    const vacia = lista({ rows: [], outcomes: outcome({ notice: "Emitida B001-97", pdfUrl: PDF }) });
    expect(vacia).toContain("Todavía no hay comprobantes");
    expect(vacia).toContain(`href="${PDF}"`);
  });

  it("mientras sale, el botón de ese pedido queda deshabilitado aunque se vuelva a montar", () => {
    expect(lista({ sending: new Set(["ord-9"]) })).toMatch(/<button[^>]*disabled=""[^>]*>Emitir<\/button>/);
    expect(lista()).not.toMatch(/<button[^>]*disabled=""[^>]*>Emitir<\/button>/);
  });

  it("la lista guarda la respuesta por pedido, con candado por pedido, y la sección la monta siempre", () => {
    const list = SECTION.slice(SECTION.indexOf("function RecentList("), SECTION.indexOf("function placeOutcomes("));
    // Un segundo envío del mismo pedido no sale mientras el primero no vuelve.
    expect(list).toContain("if (inFlight.current.has(orderId)) return;");
    expect(list.indexOf("inFlight.current.add(orderId);")).toBeLessThan(list.indexOf("await emitInvoiceAction("));
    expect(list.indexOf("inFlight.current.delete(orderId);")).toBeGreaterThan(list.indexOf("setOutcomes("));
    // Lo que no llegó, lanzó o volvió sin decir nada: «no se sabe», nunca en blanco.
    expect(list).toContain("res = { error: EMIT_LOST };");
    expect(list).toContain("if (!res?.error && !res?.notice) res = { error: EMIT_LOST };");
    // Montada siempre, también sin lista: si no, el refresco que no pudo leer la borraba.
    expect(SECTION).not.toContain("data.recent === null ? (");
    expect(SECTION).not.toContain("function RecentEmit(");
    // Y la sección entera la pinta con lo que no se pudo leer.
    expect(render({ recent: null })).toContain("No se pudieron leer los comprobantes.");
    expect(render({ recent: [] })).toContain("Todavía no hay comprobantes");
  });
});

// ── «Emitir» solo en producción (§35.7) ──────────────────────────────────────

describe("fuera de producción, Ajustes no ofrece «Emitir»", () => {
  const OFERTA = { issuerId: "iss-1", ruc: GF, legalName: "GRUPO GF S.A.C.", total: 85 };
  const marcada: InvoiceRecentView = {
    id: "inv-sim",
    orderId: "ord-9",
    orderName: "#KP136199",
    issuerId: "iss-1",
    ruc: GF,
    mode: "simulacion",
    status: "simulada",
    serie: null,
    correlative: null,
    total: 85,
    error: null,
    createdAt: "2026-10-14T14:20:00.000Z",
    rucMismatch: false,
    emitNow: OFERTA,
  };
  const BOTON = /<button[^>]*>Emitir<\/button>/;
  const POR_QUE = `«Emitir» no está disponible: ${INVOICE_REASON_LABEL.no_produccion}`;
  const t = (html: string) => html.replace(/<[^>]+>/g, "");

  // FIX: una vista previa comparte la base y la llave de cifrado con
  // producción: desde ella «Emitir» mandaba una boleta real a SUNAT. La página
  // ya no pregunta qué simuladas lo llevan y la sección no pinta el botón ni
  // aunque llegara una oferta.
  it("sin botón aunque llegue una simulada marcada, y con un RUC en Manual dice por qué", () => {
    const manual = [issuerView({ mode: "manual" })];
    const preview = render({ emitHere: false, issuers: manual, recent: [marcada] });
    expect(preview).not.toMatch(BOTON);
    expect(t(preview)).toContain(POR_QUE);
    // En producción, el botón y nada que explicar.
    const prod = render({ emitHere: true, issuers: manual, recent: [marcada] });
    expect(prod).toMatch(BOTON);
    expect(t(prod)).not.toContain(POR_QUE);
    // Sin un RUC en Manual no hay botón que echar de menos: no se dice nada.
    expect(t(render({ emitHere: false, recent: [marcada] }))).not.toContain(POR_QUE);
  });

  it("la página pregunta a `invoiceEmitAllowedHere` antes que a nadie, y sin datos no emite", () => {
    const marca = PAGE.slice(PAGE.indexOf("let offers = new Map"), PAGE.indexOf("const emitNowOf = "));
    expect(marca).toContain("const emitHere = invoiceEmitAllowedHere();");
    expect(marca).toContain(
      'if (emitHere && newestSimulated.size && (rows ?? []).some((r) => r.mode === "manual")) {',
    );
    expect(marca.indexOf("const emitHere = invoiceEmitAllowedHere();")).toBeLessThan(
      marca.indexOf("offers = await loadInvoiceEmitNowOffers("),
    );
    // Lo que la sección sabe de dónde corre es lo mismo que decidió las ofertas.
    expect(PAGE).toMatch(/return \{\s*emitHere,\s*issuers:/);
    // Sin permiso o con la lectura caída, tampoco (falla cerrada).
    expect(PAGE).toMatch(/const NO_INVOICES: Omit<InvoiceSettingsData, "canManage"> = \{\s*emitHere: false,/);
  });
});

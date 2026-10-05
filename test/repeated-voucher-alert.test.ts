// Alerta urgente de comprobante repetido (0226).
//
// EL CASO. Un solo Lemon de S/ 89 era el comprobante de cuatro pedidos Tanders
// (#KP124940, #KP126075, #KP126468, #KP126871): el mismo archivo, byte a byte.
// El nº de operación salía cortado y la huella del archivo bloqueaba el cobro EN
// SILENCIO. Regla del owner: un mismo comprobante no puede estar en más de un
// pedido, y cuando pase lo tienen que ver Frank, Yohalis, Akemi y Daysi.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  telegrams: [] as { chat: string; text: string }[],
  creds: { name: "Kenku Peru", telegram_bot_token: "bot", telegram_chat_id: "resumen-diario" } as Record<string, unknown> | null,
}));

vi.mock("@/lib/ingest", () => ({ getStoreCreds: vi.fn(async () => h.creds) }));
vi.mock("@/lib/telegram", () => ({
  sendTelegramToAll: vi.fn(async (_token: string, chat: string, text: string) => {
    h.telegrams.push({ chat, text });
    return { sent: 1, total: 1, results: [] };
  }),
}));

import {
  raiseRepeatedVoucherAlert,
  repeatedVoucherDetail,
  repeatedVoucherKey,
  repeatedVoucherTelegram,
  type RepeatedVoucher,
} from "@/lib/repeated-voucher-alert";
import { registerCourierCollection } from "@/lib/tanders/collection-payment";
import { GRANTED_ONE_BY_ONE, permissionsFor } from "@/lib/permissions";

type Row = Record<string, unknown>;

/** Un Supabase mínimo: lo justo para los `eq`/`neq`/`in`/`limit` de estas rutas. */
function fakeAdmin(tables: Record<string, Row[]>, opts: { uniqueOn?: Record<string, string[]> } = {}) {
  const inserted: { table: string; row: Row }[] = [];
  function query(table: string) {
    const filters: ((r: Row) => boolean)[] = [];
    let max = Infinity;
    const rows = () => (tables[table] ?? []).filter((r) => filters.every((f) => f(r))).slice(0, max);
    const q = {
      select: () => q,
      eq: (c: string, v: unknown) => (filters.push((r) => r[c] === v), q),
      neq: (c: string, v: unknown) => (filters.push((r) => r[c] !== v), q),
      in: (c: string, vs: unknown[]) => (filters.push((r) => vs.includes(r[c])), q),
      limit: (n: number) => ((max = n), q),
      maybeSingle: async () => ({ data: rows()[0] ?? null, error: null }),
      then: (ok: (v: { data: Row[]; error: null }) => unknown) => Promise.resolve({ data: rows(), error: null }).then(ok),
      insert: (row: Row) => {
        const clash = (opts.uniqueOn?.[table] ?? []).some((col) =>
          (tables[table] ?? []).some((r) => row[col] != null && r[col] === row[col] && (r.status ?? "abierta") === "abierta"),
        );
        const result = clash
          ? { data: null, error: { code: "23505", message: "duplicate" } }
          : (inserted.push({ table, row }), (tables[table] ??= []).push({ id: `id-${inserted.length}`, ...row }), { data: { id: `id-${inserted.length}` }, error: null });
        const done = Promise.resolve(result);
        return Object.assign(done, { select: () => ({ single: () => done }) });
      },
    };
    return q;
  }
  return {
    inserted,
    from: (t: string) => query(t),
    storage: { from: () => ({ upload: async () => ({ error: null }) }) },
  } as never as { inserted: { table: string; row: Row }[] } & Parameters<typeof raiseRepeatedVoucherAlert>[0];
}

const LEMON: RepeatedVoucher = {
  storeId: "kenku",
  orderId: "o-126075",
  orderName: "#KP126075",
  alsoIn: ["#KP124940"],
  fileSha256: "ad7a6a7c936e",
  amount: 89,
  source: "cobro_courier",
  actions: ["El cobro no entró a «Validar pagos»: quedó bloqueado."],
};

beforeEach(() => {
  h.telegrams = [];
  h.creds = { name: "Kenku Peru", telegram_bot_token: "bot", telegram_chat_id: "resumen-diario" };
});

describe("qué dice la alerta", () => {
  it("nombra todos los pedidos, el monto y que es el mismo archivo", () => {
    const text = repeatedVoucherTelegram("Kenku Peru", LEMON);
    expect(text).toContain("COMPROBANTE REPETIDO");
    expect(text).toContain("#KP126075");
    expect(text).toContain("#KP124940");
    expect(text).toContain("S/ 89.00");
    expect(text).toContain("mismo archivo de imagen");
    expect(text).toContain("al menos uno NO está pagado");
    expect(repeatedVoucherDetail(LEMON)).toContain("aparece en 2 pedidos: #KP126075, #KP124940");
  });

  it("con nº de operación lo dice; y escapa el HTML (Telegram en modo HTML)", () => {
    const text = repeatedVoucherTelegram("A <b>&", { ...LEMON, fileSha256: null, operation: "86480816" });
    expect(text).toContain("<code>86480816</code>");
    expect(text).toContain("A &lt;b&gt;&amp;");
  });

  it("la huella prefiere el archivo, luego la operación: una alerta por comprobante", () => {
    expect(repeatedVoucherKey(LEMON)).toBe("sha:ad7a6a7c936e");
    expect(repeatedVoucherKey({ ...LEMON, fileSha256: null, operation: "123456" })).toBe("op:123456");
  });
});

describe("raiseRepeatedVoucherAlert", () => {
  it("levanta la alerta en Kapta, sin dueño ni escalera, y avisa al grupo urgente", async () => {
    const admin = fakeAdmin({ stores: [{ id: "kenku", urgent_telegram_chat_id: "-100urgente" }], collection_alerts: [] });
    const res = await raiseRepeatedVoucherAlert(admin, LEMON);
    expect(res.alertId).toBeTruthy();
    expect(res.telegram).toBe(true);
    const alert = admin.inserted.find((i) => i.table === "collection_alerts")!.row;
    expect(alert).toMatchObject({ kind: "comprobante_repetido", dedupe_key: "sha:ad7a6a7c936e", offered_to: null, amount: 89 });
    expect(h.telegrams).toHaveLength(1);
    expect(h.telegrams[0]!.chat).toBe("-100urgente");
  });

  it("sin grupo urgente configurado, avisa al chat de siempre: mejor que callar", async () => {
    const admin = fakeAdmin({ stores: [{ id: "kenku", urgent_telegram_chat_id: null }], collection_alerts: [] });
    await raiseRepeatedVoucherAlert(admin, LEMON);
    expect(h.telegrams[0]!.chat).toBe("resumen-diario");
  });

  it("una vez por comprobante: si ya hay una abierta, ni otra alerta ni otro Telegram", async () => {
    const admin = fakeAdmin(
      {
        stores: [{ id: "kenku", urgent_telegram_chat_id: "-100urgente" }],
        collection_alerts: [{ id: "a1", dedupe_key: "sha:ad7a6a7c936e", status: "abierta" }],
      },
      { uniqueOn: { collection_alerts: ["dedupe_key"] } },
    );
    const res = await raiseRepeatedVoucherAlert(admin, LEMON);
    expect(res.alertId).toBeNull();
    expect(h.telegrams).toHaveLength(0);
  });

  it("sin otro pedido no hay nada que alertar", async () => {
    const admin = fakeAdmin({ stores: [], collection_alerts: [] });
    expect((await raiseRepeatedVoucherAlert(admin, { ...LEMON, alsoIn: [] })).alertId).toBeNull();
  });
});

describe("el caso de los cuatro pedidos: el mismo archivo ya no se bloquea en silencio", () => {
  it("registerCourierCollection dice EN QUÉ PEDIDO estaba el mismo archivo", async () => {
    const bytes = new TextEncoder().encode("89yape.png");
    const sha = createHash("sha256").update(Buffer.from(bytes)).digest("hex");
    const admin = fakeAdmin({
      order_payments: [
        { id: "p1", order_id: "o-124940", kind: "cobro_courier", amount: 89, operation_number: null, file_sha256: sha, validation_status: "pendiente_revision" },
      ],
      orders: [{ id: "o-124940", name: "#KP124940" }],
    });
    const out = await registerCourierCollection(admin, {
      storeId: "kenku",
      orderId: "o-126075",
      guideCode: "TANDER17857937764169963",
      imageUrl: "https://x/89yape.png",
      imageBytes: bytes.buffer as ArrayBuffer,
      mediaType: "image/png",
      // El nº de operación sale cortado («2026…843»): no se puede leer.
      reading: { ok: true, isPaymentProof: true, method: "yape", amount: 89, operationNumber: "2026…843" } as never,
      verdict: { state: "validado", reasons: [], summary: "ok" } as never,
      expectedAmount: 89,
    });
    expect(out.registered).toBe(false);
    if (out.registered || out.reason !== "duplicado") throw new Error("debía ser duplicado");
    expect(out.repeated).toMatchObject({ orderName: "#KP124940", orderId: "o-124940", sha256: sha, operation: null, sameOrder: false });
  });
});

describe("las piezas", () => {
  const read = (p: string) => readFileSync(p, "utf8");

  it("todos los caminos que detectan un repetido pasan por la misma puerta", () => {
    expect(read("lib/tanders/duplicate-alert.ts")).toContain("raiseRepeatedVoucherAlert(");
    expect(read("lib/tanders/payment-sweep.ts")).toContain('source: "cobro_courier"');
    expect(read("app/dashboard/pedidos/payment-actions.ts").match(/raiseRepeatedVoucherAlert\(/g)?.length).toBe(2);
    expect(read("lib/shalom/voucher-intake.ts")).toContain('source: "whatsapp"');
    expect(read("lib/voucher-reprocess.ts")).toContain("raiseRepeatedVoucherAlert(");
  });

  it("no escala: la ven a la vez los que tienen el permiso", () => {
    expect(read("lib/collection-alerts-access.ts")).toContain('.neq("kind", "comprobante_repetido")');
    const actions = read("app/dashboard/cobranza/actions.ts");
    expect(actions).toContain('can("alerts.repeated_voucher")');
    expect(actions).toContain('r.kind === "comprobante_repetido"\n      ? seesRepeated');
  });

  it("se cierra diciendo qué se hizo, no se descarta", () => {
    const ui = read("components/collection-alerts.tsx");
    expect(ui).toContain("attendRepeatedVoucherAlert(a.id, que)");
    expect(ui).toContain('a.kind !== "comprobante_repetido" && (');
  });

  it("el permiso se concede persona por persona: no viene con el rol admin", () => {
    expect(GRANTED_ONE_BY_ONE.some((g) => g.permission === "alerts.repeated_voucher")).toBe(true);
    expect(permissionsFor(["admin"]).has("alerts.repeated_voucher")).toBe(false);
    expect(permissionsFor(["admin"], [{ permission: "alerts.repeated_voucher" }]).has("alerts.repeated_voucher")).toBe(true);
  });

  it("la migración amplía el tipo y deduplica las abiertas", () => {
    const sql = read("db/migrations/0226_repeated_voucher_alert.sql");
    expect(sql).toContain("'comprobante_repetido'");
    expect(sql).toContain("where dedupe_key is not null and status = 'abierta'");
    expect(sql).toContain("urgent_telegram_chat_id");
  });
});

// La consulta de la tienda «¿este celular paga por adelantado?» (MOM §41.7):
// `POST /api/webhooks/woocommerce/<id>/prepago` y `handlePrepayQuery`. Lo que
// se fija:
//   - la firma es la de los formularios abandonados de COD Core (HMAC-SHA256
//     del cuerpo crudo con el secreto de los webhooks, en base64), la misma
//     fórmula que escribe el mu-plugin en PHP;
//   - el sello va firmado (dentro del cuerpo) y se repite en la cabecera; a
//     más de 5 minutos, o distinto, se rechaza;
//   - la tienda tiene que ser WooCommerce y estar activa;
//   - contesta solo `{ prepay_required }`: nunca el motivo ni la evidencia;
//   - un celular que no se puede normalizar es «no»; la lista que no se pudo
//     leer es 503 (y la tienda, del otro lado, falla abierto).

import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  process.env.ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");
});

import { encrypt } from "@/lib/crypto";
import { verifyWooSignature } from "@/lib/woocommerce";
import { PREPAY_MAX_SKEW_S, handlePrepayQuery, prepayTimestampProblem } from "@/lib/prepay-woo";
import { FakeDb, type Row } from "./woocommerce-fake-db";

const STORE = "11111111-1111-4111-8111-111111111111";
const ORG = "22222222-2222-4222-8222-222222222222";
const SECRET = "secreto-de-los-webhooks";
const NOW = Date.parse("2026-11-05T15:00:00Z");
const TS = Math.floor(NOW / 1000);

const sign = (body: string, secret = SECRET) => createHmac("sha256", secret).update(body).digest("base64");

function store(over: Row = {}): Row {
  return {
    id: STORE,
    org_id: ORG,
    status: "active",
    timezone: "America/Lima",
    platform: "woocommerce",
    woo_site_url: "https://aurela.pe",
    woo_site_key: "aur",
    woo_webhook_secret_enc: encrypt(SECRET),
    ...over,
  };
}

const ENTRY: Row = {
  id: "e1",
  org_id: ORG,
  phone: "51987654321",
  source: "auto",
  reason: "Rechazó en la puerta 1 pedido (#AUR1).",
  evidence: { kind: "auto", orders: [{ order_id: "o1", order_name: "#AUR1" }] },
  added_at: "2026-11-01T00:00:00Z",
  removed_at: null,
};

function ask(db: FakeDb, opts: { phone?: unknown; ts?: number; headerTs?: string | null; secret?: string; raw?: string; storeId?: string; nowMs?: number } = {}) {
  const raw = opts.raw ?? JSON.stringify({ phone: opts.phone ?? "987 654 321", timestamp: opts.ts ?? TS });
  return handlePrepayQuery(db.client() as never, {
    storeId: opts.storeId ?? STORE,
    rawBody: raw,
    signature: sign(raw, opts.secret),
    timestamp: opts.headerTs === undefined ? String(opts.ts ?? TS) : opts.headerTs,
    nowMs: opts.nowMs ?? NOW,
  });
}

describe("la firma: la misma de COD Core y la misma fórmula que el mu-plugin", () => {
  it("HMAC-SHA256 del cuerpo crudo, base64, verificado con `verifyWooSignature`", () => {
    // El vector lo calculó PHP: base64_encode(hash_hmac('sha256', $b, 'secreto', true)).
    const body = '{"phone":"51987654321","timestamp":1700000000}';
    expect(sign(body, "secreto")).toBe("PUUssH9ypfdllM0TwvirAzoNNFcQ/zQk5Rjlez7UpB4=");
    expect(verifyWooSignature(body, "PUUssH9ypfdllM0TwvirAzoNNFcQ/zQk5Rjlez7UpB4=", "secreto")).toBe(true);
    expect(verifyWooSignature(body.replace("1700000000", "1700000001"), "PUUssH9ypfdllM0TwvirAzoNNFcQ/zQk5Rjlez7UpB4=", "secreto")).toBe(false);
  });

  it("el mu-plugin firma así, manda el sello en el cuerpo y en la cabecera, y falla abierto", () => {
    const php = readFileSync(resolve(process.cwd(), "docs/kapta/wordpress/kapta-prepago.php"), "utf8");
    expect(php).toContain("base64_encode( hash_hmac( 'sha256', $body, KAPTA_PREPAY_SECRET, true ) )");
    expect(php).toContain("'X-Kapta-Signature' => $signature");
    expect(php).toContain("'X-Kapta-Timestamp' => (string) $timestamp");
    expect(php).toContain("array( 'phone' => $phone, 'timestamp' => $timestamp )");
    expect(php).toContain("woocommerce_available_payment_gateways");
    expect(php).toContain("unset( $gateways['cod'] )");
    expect(php).toContain("woocommerce_after_checkout_validation");
    expect(php).toContain("update_checkout");
    expect(php).toContain("define( 'KAPTA_PREPAY_TIMEOUT', 3 )");
    expect(php).toContain("10 * MINUTE_IN_SECONDS");
    // Falla abierto y no guarda la respuesta del celular, pero deja de
    // preguntar un minuto (Kapta lento no frena cada visita 3 s).
    expect(php).toMatch(/is_wp_error\( \$response \)[\s\S]{0,300}set_transient\( 'kapta_prepay_down', 1, KAPTA_PREPAY_DOWN_TTL \);\s*return \$memo\[ \$phone \] = false;/);
    expect(php).toContain("if ( get_transient( 'kapta_prepay_down' ) ) {");
    // Una pregunta por celular en cada pedido de página.
    expect(php).toContain("static $memo = array();");
    // Sin la lista de celulares en la base de WordPress: la caché va por un hash SALADO.
    expect(php).toContain("hash( 'sha256', $phone . '|' . KAPTA_PREPAY_SECRET )");
    // No es un buscador de la lista: 3 celulares distintos por visitante cada 10 minutos.
    expect(php).toContain("define( 'KAPTA_PREPAY_MAX_PHONES', 3 )");
    expect(php).toContain("if ( kapta_prepay_throttled( $hash ) ) {");
  });

  it("el contrato de COD Core: todo en el servidor, nunca el secreto en el navegador, y la caché con sal", () => {
    const doc = readFileSync(resolve(process.cwd(), "docs/kapta/cod-core-prepago.md"), "utf8");
    expect(doc).toContain("**Solo desde el servidor.**");
    expect(doc).toContain("admin-ajax");
    expect(doc).toContain("hash( 'sha256', $celular . '|' . $secreto )");
  });
});

describe("el sello", () => {
  it("igual en la cabecera y en el cuerpo, y a 5 minutos o menos", () => {
    expect(prepayTimestampProblem(String(TS), TS, NOW)).toBeNull();
    expect(prepayTimestampProblem(String(TS), String(TS), NOW)).toBeNull();
    expect(prepayTimestampProblem(String(TS - PREPAY_MAX_SKEW_S), TS - PREPAY_MAX_SKEW_S, NOW)).toBeNull();
    expect(prepayTimestampProblem(String(TS - PREPAY_MAX_SKEW_S - 1), TS - PREPAY_MAX_SKEW_S - 1, NOW)).toMatch(/5 minutos/);
    expect(prepayTimestampProblem(String(TS + 3600), TS + 3600, NOW)).toMatch(/5 minutos/);
    expect(prepayTimestampProblem(String(TS), TS - 1, NOW)).toMatch(/no coincide/);
    expect(prepayTimestampProblem(null, TS, NOW)).toMatch(/Falta/);
  });
});

describe("handlePrepayQuery", () => {
  it("un celular de la lista: true, y nada más (ni motivo ni evidencia)", async () => {
    const db = new FakeDb({ stores: [store()], prepay_list_entries: [ENTRY] });
    const res = await ask(db);
    expect(res).toEqual({ status: 200, body: { prepay_required: true } });
    expect(JSON.stringify(res.body)).not.toContain("AUR1");
  });

  it("no listado, quitado, de otra organización o sin celular válido: false", async () => {
    const db = new FakeDb({
      stores: [store()],
      prepay_list_entries: [
        { ...ENTRY, removed_at: "2026-11-02T00:00:00Z", removed_reason: "Era otra persona" },
        { ...ENTRY, id: "e2", org_id: "33333333-3333-4333-8333-333333333333", phone: "51911111111" },
      ],
    });
    expect(await ask(db)).toEqual({ status: 200, body: { prepay_required: false } });
    expect(await ask(db, { phone: "911 111 111" })).toEqual({ status: 200, body: { prepay_required: false } });
    expect(await ask(db, { phone: "014445566" })).toEqual({ status: 200, body: { prepay_required: false } });
  });

  it("otra firma, otro secreto o un cuerpo cambiado: 401, sin leer la lista", async () => {
    const db = new FakeDb({ stores: [store()], prepay_list_entries: [ENTRY] });
    expect((await ask(db, { secret: "otro" })).status).toBe(401);
    const raw = JSON.stringify({ phone: "987654321", timestamp: TS });
    const tampered = await handlePrepayQuery(db.client() as never, {
      storeId: STORE,
      rawBody: raw.replace("987654321", "987654322"),
      signature: sign(raw),
      timestamp: String(TS),
      nowMs: NOW,
    });
    expect(tampered.status).toBe(401);
    expect(db.ops.some((op) => op.table === "prepay_list_entries")).toBe(false);
  });

  it("un sello viejo o que no es el del cuerpo: 401 (una llamada capturada no sirve después)", async () => {
    const db = new FakeDb({ stores: [store()], prepay_list_entries: [ENTRY] });
    expect((await ask(db, { nowMs: NOW + (PREPAY_MAX_SKEW_S + 5) * 1000 })).status).toBe(401);
    expect((await ask(db, { headerTs: String(TS + 1) })).status).toBe(401);
    expect((await ask(db, { headerTs: null })).status).toBe(401);
  });

  it("la tienda: desconocida 404, sin secreto 401, en Shopify o pausada 409", async () => {
    expect((await ask(new FakeDb({ stores: [] }))).status).toBe(404);
    expect((await ask(new FakeDb({ stores: [store()] }), { storeId: "no-es-uuid" })).status).toBe(404);
    expect((await ask(new FakeDb({ stores: [store({ woo_webhook_secret_enc: null })] }))).status).toBe(401);
    expect((await ask(new FakeDb({ stores: [store({ platform: "shopify" })] }))).status).toBe(409);
    expect((await ask(new FakeDb({ stores: [store({ status: "paused" })] }))).status).toBe(409);
  });

  it("cuerpo que no es JSON o sin celular: 400; demasiado grande: 413", async () => {
    const db = new FakeDb({ stores: [store()] });
    expect((await ask(db, { raw: "phone=987654321" })).status).toBe(400);
    expect((await ask(db, { raw: JSON.stringify({ timestamp: TS }) })).status).toBe(400);
    expect((await ask(db, { raw: JSON.stringify({ phone: "x".repeat(5000), timestamp: TS }) })).status).toBe(413);
  });

  it("la lista no se pudo leer: 503 (la tienda falla abierto); sin la 0309: false", async () => {
    const db = new FakeDb({ stores: [store()], prepay_list_entries: [ENTRY] });
    db.failOn = (table) => (table === "prepay_list_entries" ? { message: "timeout" } : null);
    expect((await ask(db)).status).toBe(503);
    db.failOn = (table) => (table === "prepay_list_entries" ? { code: "42P01", message: 'relation "prepay_list_entries" does not exist' } : null);
    expect(await ask(db)).toEqual({ status: 200, body: { prepay_required: false } });
  });

  it("la ruta lee el cuerpo crudo y no se cachea", () => {
    const route = readFileSync(resolve(process.cwd(), "app/api/webhooks/woocommerce/[storeId]/prepago/route.ts"), "utf8");
    expect(route).toContain("await req.text()");
    expect(route).toContain('"Cache-Control": "no-store"');
    expect(route).toContain('export const runtime = "nodejs"');
  });
});

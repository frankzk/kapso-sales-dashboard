// Correo · Resend (MOM §46, 0355): lo puro (tramos, nombres, filtro de
// correos, CSV, estados y errores) y el cliente de la API con un fetch falso.

import { describe, expect, it } from "vitest";
import {
  RESEND_BUCKETS,
  RESEND_TOPIC_NAME_MAX,
  filterResendContacts,
  isResendBucket,
  isResendMigrationMissing,
  looksLikeResendKey,
  resendContactsCsv,
  resendCsvFilename,
  resendErrorMessage,
  resendImportDetail,
  resendImportStatus,
  resendKeyHint,
  resendSegmentKey,
  resendSegmentName,
  resendTopicName,
} from "@/lib/resend-marketing";
import {
  createResendContactImport,
  createResendTopic,
  listResendSegments,
  parseResendError,
  resendRequest,
} from "@/lib/resend-client";

describe("tramos y nombres", () => {
  it("van de 6 meses a todos, y el de 6 meses es el primero", () => {
    expect(RESEND_BUCKETS.map((b) => [b.key, b.months])).toEqual([
      ["6m", 6],
      ["9m", 9],
      ["12m", 12],
      ["todos", null],
    ]);
    expect(isResendBucket("6m")).toBe(true);
    expect(isResendBucket("9m")).toBe(true);
    expect(isResendBucket("24m")).toBe(false);
    expect(isResendBucket(null)).toBe(false);
  });

  it("nombra el segmento con la tienda y el tramo, y el tema con la tienda", () => {
    expect(resendSegmentName("Kenku Peru", "6m")).toBe("Kenku Peru · pidieron en 6 meses");
    expect(resendSegmentName("Aurela", "todos")).toBe("Aurela · todos los suscritos");
    expect(resendSegmentName("Kenku Peru", "9m")).toBe("Kenku Peru · pidieron en 9 meses");
    expect(resendSegmentKey("s1", "12m")).toBe("s1:12m");
    expect(resendTopicName("  Kenku Peru ")).toBe("Kenku Peru");
    expect(resendTopicName("x".repeat(80))).toHaveLength(RESEND_TOPIC_NAME_MAX);
  });

  it("arma un nombre de archivo sin tildes ni espacios", () => {
    expect(resendCsvFilename("Kenku Perú", "6m", "2026-11-25")).toBe("resend_kenku-peru_6m_2026-11-25.csv");
  });
});

describe("qué correos se suben", () => {
  it("deja fuera los inválidos, los repetidos y los dominios mal escritos", () => {
    const { contacts, excluded } = filterResendContacts([
      { email: " Ana@Gmail.com ", first_name: "Ana", last_name: "Ríos" },
      { email: "ana@gmail.com", first_name: "Ana bis", last_name: null },
      { email: "beto@gmial.com", first_name: "Beto", last_name: null },
      { email: "sin-arroba.com", first_name: null, last_name: null },
      { email: "=cmd@evil.com", first_name: null, last_name: null },
      { email: "carla@hotmail.com", first_name: "=HYPERLINK(1)", last_name: "  Paz\nSoto " },
    ]);
    expect(contacts).toEqual([
      { email: "ana@gmail.com", first_name: "Ana", last_name: "Ríos" },
      { email: "carla@hotmail.com", first_name: "HYPERLINK(1)", last_name: "Paz Soto" },
    ]);
    expect(excluded).toBe(4);
  });

  it("el CSV lleva las cabeceras que Resend reconoce solas y sin BOM", () => {
    const csv = resendContactsCsv([
      { email: "ana@gmail.com", first_name: "Ana, María", last_name: "O\"Neil" },
      { email: "beto@gmail.com", first_name: "", last_name: "" },
    ]);
    expect(csv.charCodeAt(0)).not.toBe(0xfeff);
    expect(csv).toBe('email,first_name,last_name\nana@gmail.com,"Ana, María","O""Neil"\nbeto@gmail.com,,\n');
  });
});

describe("estados, claves y errores", () => {
  it("traduce el estado de Resend", () => {
    expect(resendImportStatus("queued")).toBe("procesando");
    expect(resendImportStatus("in_progress")).toBe("procesando");
    expect(resendImportStatus("completed")).toBe("completada");
    expect(resendImportStatus("failed")).toBe("fallida");
    expect(resendImportStatus(undefined)).toBe("enviada");
  });

  it("resume las cifras de la importación", () => {
    expect(resendImportDetail({ total: 1300, created: 1200, updated: 90, skipped: 0, failed: 10 })).toBe(
      "1200 nuevos · 90 actualizados · 10 con error".replace("1200", (1200).toLocaleString("es-PE")),
    );
    expect(resendImportDetail({ created: 0 })).toBeNull();
    expect(resendImportDetail(null)).toBeNull();
  });

  it("reconoce una clave de Resend y muestra solo su final", () => {
    expect(looksLikeResendKey("re_123456789abcdefghijk")).toBe(true);
    expect(looksLikeResendKey("sk_live_123456789abcdefghijk")).toBe(false);
    expect(looksLikeResendKey("re_corta")).toBe(false);
    expect(resendKeyHint("re_123456789abcdefghijk")).toBe("re_…hijk");
  });

  it("explica en palabras lo que contestó Resend", () => {
    expect(resendErrorMessage({ status: 401, name: "restricted_api_key", message: "x" })).toMatch(/solo de envío/);
    expect(resendErrorMessage({ status: 401, name: "invalid_api_key", message: "x" })).toMatch(/no aceptó la clave/);
    expect(resendErrorMessage({ status: 429, name: "rate_limit_exceeded" })).toMatch(/esperar/);
    expect(resendErrorMessage({ status: null, name: "network" })).toMatch(/No pudimos hablar/);
    expect(resendErrorMessage({ status: 422, name: "validation_error", message: "File too large" })).toBe("Resend contestó: File too large");
    expect(resendErrorMessage({ status: 422, name: "validation_error", message: "Your plan includes 3 segments. Upgrade to add more." })).toMatch(
      /permite solo 3 segmentos.*Audience › Segments/,
    );
  });

  it("nota la migración que falta", () => {
    expect(isResendMigrationMissing({ code: "42P01", message: 'relation "public.resend_settings" does not exist' })).toBe(true);
    expect(isResendMigrationMissing({ code: "PGRST202", message: "Could not find the function public.resend_marketing_counts" })).toBe(true);
    expect(isResendMigrationMissing({ code: "42P01", message: 'relation "public.orders" does not exist' })).toBe(false);
    expect(isResendMigrationMissing(null)).toBe(false);
  });
});

type Call = { url: string; init: RequestInit };

function fakeFetch(responses: Array<{ status: number; body?: unknown; headers?: Record<string, string> }>) {
  const calls: Call[] = [];
  const impl = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const r = responses.shift() ?? { status: 500, body: { message: "sin respuesta" } };
    return new Response(r.body === undefined ? "" : JSON.stringify(r.body), { status: r.status, headers: r.headers });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

describe("cliente de la API", () => {
  it("lee los dos formatos de error", () => {
    expect(parseResendError(401, { name: "restricted_api_key", message: "Solo envío" }, "")).toEqual({
      status: 401,
      name: "restricted_api_key",
      message: "Solo envío",
    });
    expect(parseResendError(400, { error: { name: "validation_error", message: "Mal" } }, "")).toEqual({
      status: 400,
      name: "validation_error",
      message: "Mal",
    });
    expect(parseResendError(502, null, "Bad gateway")).toEqual({ status: 502, name: null, message: "Bad gateway" });
  });

  it("con 429 espera y reintenta una vez", async () => {
    const f = fakeFetch([
      { status: 429, body: { name: "rate_limit_exceeded" }, headers: { "retry-after": "0" } },
      { status: 200, body: { object: "list", data: [{ id: "seg1", name: "A" }], has_more: false } },
    ]);
    const res = await resendRequest<{ data: unknown[] }>("re_key", "/segments", {}, f.impl);
    expect(res.ok).toBe(true);
    expect(f.calls).toHaveLength(2);
    expect((f.calls[0]!.init.headers as Record<string, string>).Authorization).toBe("Bearer re_key");
  });

  it("recorre las páginas de segmentos con `after`", async () => {
    const f = fakeFetch([
      { status: 200, body: { data: [{ id: "a", name: "A" }], has_more: true } },
      { status: 200, body: { data: [{ id: "b", name: "B" }], has_more: false } },
    ]);
    const res = await listResendSegments("re_key", f.impl);
    expect(res.ok && res.data.map((s) => s.id)).toEqual(["a", "b"]);
    expect(f.calls[1]!.url).toContain("after=a");
  });

  it("crea el tema de la marca con suscripción por defecto", async () => {
    const f = fakeFetch([{ status: 201, body: { id: "top1" } }]);
    await createResendTopic("re_key", "Kenku Peru", "Novedades y ofertas de Kenku Peru", f.impl);
    expect(f.calls[0]!.url).toBe("https://api.resend.com/topics");
    expect(JSON.parse(String(f.calls[0]!.init.body))).toEqual({
      name: "Kenku Peru",
      description: "Novedades y ofertas de Kenku Peru",
      default_subscription: "opt_in",
    });
  });

  it("pide la importación con upsert y el segmento, sin tocar temas ni bajas", async () => {
    const f = fakeFetch([{ status: 202, body: { object: "contact_import", id: "imp1" } }]);
    const res = await createResendContactImport(
      "re_key",
      { csv: "email,first_name,last_name\nana@gmail.com,Ana,\n", filename: "resend_kenku_6m.csv", segmentId: "seg6" },
      f.impl,
    );
    expect(res).toEqual({ ok: true, data: { object: "contact_import", id: "imp1" } });
    const call = f.calls[0]!;
    expect(call.url).toBe("https://api.resend.com/contacts/imports");
    expect((call.init.headers as Record<string, string>)["Content-Type"]).toBeUndefined();
    const form = call.init.body as FormData;
    expect(form.get("on_conflict")).toBe("upsert");
    expect(JSON.parse(String(form.get("segments")))).toEqual([{ id: "seg6" }]);
    expect(form.get("topics")).toBeNull();
    expect(form.get("column_map")).toBeNull();
    const file = form.get("file") as File;
    expect(file.name).toBe("resend_kenku_6m.csv");
    expect(await file.text()).toContain("ana@gmail.com");
  });

  it("sin red, lo dice", async () => {
    const impl = (async () => {
      throw new Error("ENOTFOUND");
    }) as unknown as typeof fetch;
    const res = await resendRequest("re_key", "/segments", {}, impl);
    expect(res).toEqual({ ok: false, error: { status: null, name: "network", message: null } });
  });
});

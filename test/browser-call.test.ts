// Llamar desde la computadora (MOM §8.5, 11-10-2026). La ficha llama a la
// clienta por Telnyx WebRTC: el servidor entrega un token por persona y la
// llamada queda en el historial del pedido. Aquí se fija lo que no se ve en
// pantalla: qué se acepta del navegador, cómo se dice en el historial y que la
// clave de Telnyx no salga del servidor.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  browserCallNote,
  formatTalkTime,
  noAnswerReason,
  parseBrowserCallReport,
  phaseFromSdkState,
  talkTimeWords,
} from "@/lib/browser-call";
import { buildWebrtcConfig, credentialBody, looksLikeJwt, webrtcLoginToken, type WebrtcConfig } from "@/lib/telnyx-webrtc";

const read = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8");

describe("lo que ve la asesora mientras llama", () => {
  it("traduce el estado del SDK de Telnyx a la fase de la tarjeta", () => {
    expect(phaseFromSdkState("new")).toBe("conectando");
    expect(phaseFromSdkState("trying")).toBe("conectando");
    expect(phaseFromSdkState("ringing")).toBe("timbrando");
    expect(phaseFromSdkState("early")).toBe("timbrando");
    expect(phaseFromSdkState("active")).toBe("en_llamada");
    expect(phaseFromSdkState("held")).toBe("en_llamada");
    expect(phaseFromSdkState("hangup")).toBe("terminada");
    expect(phaseFromSdkState("destroy")).toBe("terminada");
    // Lo desconocido no promete nada.
    expect(phaseFromSdkState("algo_nuevo")).toBe("conectando");
    expect(phaseFromSdkState(undefined)).toBe("conectando");
  });

  it("el reloj y la duración en palabras", () => {
    expect(formatTalkTime(7)).toBe("0:07");
    expect(formatTalkTime(133)).toBe("2:13");
    expect(formatTalkTime(3723)).toBe("1:02:03");
    expect(formatTalkTime(-5)).toBe("0:00");
    expect(talkTimeWords(45)).toBe("45 s");
    expect(talkTimeWords(133)).toBe("2 min 13 s");
    expect(talkTimeWords(120)).toBe("2 min");
  });
});

describe("lo que se acepta del navegador", () => {
  const ok = { callId: "a1b2c3d4-e5f6", answered: true, talkSeconds: 130, totalSeconds: 145, cause: "NORMAL_CLEARING", sipCode: 200 };

  it("una llamada contestada pasa tal cual", () => {
    expect(parseBrowserCallReport(ok)).toEqual(ok);
  });

  it("sin contestar no hay conversación, y la conversación no supera la llamada", () => {
    expect(parseBrowserCallReport({ ...ok, answered: false })!.talkSeconds).toBe(0);
    expect(parseBrowserCallReport({ ...ok, talkSeconds: 500, totalSeconds: 200 })!.talkSeconds).toBe(200);
  });

  it("rechaza lo que no es una llamada", () => {
    expect(parseBrowserCallReport(null)).toBeNull();
    expect(parseBrowserCallReport({ ...ok, callId: "" })).toBeNull();
    expect(parseBrowserCallReport({ ...ok, callId: "x".repeat(101) })).toBeNull();
    expect(parseBrowserCallReport({ ...ok, callId: "id con espacios" })).toBeNull();
    expect(parseBrowserCallReport({ ...ok, answered: "sí" })).toBeNull();
    expect(parseBrowserCallReport({ ...ok, totalSeconds: -1 })).toBeNull();
    // Cuatro horas es un reloj roto, no una llamada.
    expect(parseBrowserCallReport({ ...ok, totalSeconds: 4 * 3600 + 1 })).toBeNull();
  });

  it("un código SIP raro se descarta; la causa se recorta", () => {
    expect(parseBrowserCallReport({ ...ok, sipCode: 99 })!.sipCode).toBeNull();
    expect(parseBrowserCallReport({ ...ok, sipCode: "486" })!.sipCode).toBe(486);
    expect(parseBrowserCallReport({ ...ok, cause: "X".repeat(80) })!.cause).toHaveLength(60);
  });
});

describe("cómo queda en el historial", () => {
  it("contestó: con cuánto se habló", () => {
    const report = parseBrowserCallReport({ callId: "c1", answered: true, talkSeconds: 133, totalSeconds: 150, cause: null, sipCode: null })!;
    expect(browserCallNote(report, "+51987654321", "+13105550100")).toBe(
      "Llamada desde Kapta al +51987654321 (número +13105550100): contestó, 2 min 13 s de conversación.",
    );
  });

  it("no contestó: por qué, en palabras", () => {
    expect(noAnswerReason("USER_BUSY", 486)).toBe("ocupado");
    expect(noAnswerReason("NO_ANSWER", 480)).toBe("no contestó");
    expect(noAnswerReason("CALL_REJECTED", 603)).toBe("rechazó la llamada");
    expect(noAnswerReason("UNALLOCATED_NUMBER", 404)).toBe("el número no existe");
    expect(noAnswerReason("ORIGINATOR_CANCEL", null)).toBe("se colgó antes de que contestara");
    expect(noAnswerReason(null, 503)).toBe("terminó sin contestar (SIP 503)");
    // Lo que no se conoce se dice tal cual, sin inventar un motivo.
    expect(noAnswerReason("RARE_CAUSE", null)).toBe("terminó sin contestar (RARE_CAUSE)");
    const report = parseBrowserCallReport({ callId: "c2", answered: false, talkSeconds: 0, totalSeconds: 25, cause: "USER_BUSY", sipCode: 486 })!;
    expect(browserCallNote(report, "+51987654321", "+13105550100")).toBe(
      "Llamada desde Kapta al +51987654321 (número +13105550100): ocupado.",
    );
  });
});

describe("la línea de Telnyx: configuración y token", () => {
  const cfg: WebrtcConfig = { apiKey: "KEY", connectionId: "conn-web", fromNumber: "+13105550100" };
  const JWT = "eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ4In0.c2lnbmF0dXJh";

  it("sin conexión, sin clave o sin número, no hay botón", () => {
    expect(buildWebrtcConfig({ apiKey: "KEY", connectionId: "conn", fromNumber: "+1" })).not.toBeNull();
    expect(buildWebrtcConfig({ apiKey: "KEY", connectionId: " ", fromNumber: "+1" })).toBeNull();
    expect(buildWebrtcConfig({ apiKey: "", connectionId: "conn", fromNumber: "+1" })).toBeNull();
    expect(buildWebrtcConfig({ apiKey: "KEY", connectionId: "conn" })).toBeNull();
  });

  it("la credencial cuelga de la conexión de credenciales y lleva el nombre de la persona", () => {
    expect(credentialBody(cfg, "u-1")).toEqual({ connection_id: "conn-web", name: "kapta-u-1", tag: "kapta-webrtc" });
    expect(looksLikeJwt(JWT)).toBe(true);
    expect(looksLikeJwt("<html>error</html>")).toBe(false);
  });

  function fakeAdmin(row: { credential_id: string; connection_id: string } | null) {
    const saved: unknown[] = [];
    const admin = {
      from: () => ({
        select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: row, error: null }) }) }),
        upsert: async (value: unknown) => {
          saved.push(value);
          return { error: null };
        },
      }),
    } as never;
    return { admin, saved };
  }

  function fakeTelnyx(replies: Record<string, { status: number; body: string }[]>) {
    const calls: { path: string; body: unknown; auth: string | null }[] = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      const path = url.replace("https://api.telnyx.com/v2", "");
      calls.push({ path, body: init.body ? JSON.parse(String(init.body)) : null, auth: new Headers(init.headers).get("Authorization") });
      const key = path.endsWith("/token") ? "token" : "create";
      const reply = replies[key]!.shift()!;
      return new Response(reply.body, { status: reply.status });
    }) as unknown as typeof fetch;
    return { fetchImpl, calls };
  }

  it("la primera vez crea la credencial, la guarda y pide el token", async () => {
    const { admin, saved } = fakeAdmin(null);
    const { fetchImpl, calls } = fakeTelnyx({
      create: [{ status: 201, body: JSON.stringify({ data: { id: "cred-1" } }) }],
      token: [{ status: 201, body: JWT }],
    });
    expect(await webrtcLoginToken(admin, cfg, "u-1", fetchImpl)).toEqual({ token: JWT });
    expect(calls.map((c) => c.path)).toEqual(["/telephony_credentials", "/telephony_credentials/cred-1/token"]);
    expect(calls[0]!.body).toMatchObject({ connection_id: "conn-web" });
    expect(calls[0]!.auth).toBe("Bearer KEY");
    expect(saved).toEqual([expect.objectContaining({ user_id: "u-1", credential_id: "cred-1", connection_id: "conn-web" })]);
  });

  it("después reutiliza la suya y solo pide el token", async () => {
    const { admin, saved } = fakeAdmin({ credential_id: "cred-1", connection_id: "conn-web" });
    const { fetchImpl, calls } = fakeTelnyx({ create: [], token: [{ status: 201, body: JWT }] });
    expect(await webrtcLoginToken(admin, cfg, "u-1", fetchImpl)).toEqual({ token: JWT });
    expect(calls.map((c) => c.path)).toEqual(["/telephony_credentials/cred-1/token"]);
    expect(saved).toEqual([]);
  });

  it("una credencial de otra conexión no sirve: se crea otra", async () => {
    const { admin } = fakeAdmin({ credential_id: "cred-viejo", connection_id: "conn-antigua" });
    const { fetchImpl, calls } = fakeTelnyx({
      create: [{ status: 201, body: JSON.stringify({ data: { id: "cred-2" } }) }],
      token: [{ status: 201, body: JWT }],
    });
    expect(await webrtcLoginToken(admin, cfg, "u-1", fetchImpl)).toEqual({ token: JWT });
    expect(calls.map((c) => c.path)).toEqual(["/telephony_credentials", "/telephony_credentials/cred-2/token"]);
  });

  it("si la borraron en Telnyx (404), la vuelve a crear UNA vez", async () => {
    const { admin } = fakeAdmin({ credential_id: "cred-borrada", connection_id: "conn-web" });
    const { fetchImpl, calls } = fakeTelnyx({
      create: [{ status: 201, body: JSON.stringify({ data: { id: "cred-3" } }) }],
      token: [{ status: 404, body: JSON.stringify({ errors: [{ title: "Not found" }] }) }, { status: 201, body: JWT }],
    });
    expect(await webrtcLoginToken(admin, cfg, "u-1", fetchImpl)).toEqual({ token: JWT });
    expect(calls.map((c) => c.path)).toEqual([
      "/telephony_credentials/cred-borrada/token",
      "/telephony_credentials",
      "/telephony_credentials/cred-3/token",
    ]);
  });

  it("un rechazo que no es 404 se dice, sin reintentar", async () => {
    const { admin } = fakeAdmin({ credential_id: "cred-1", connection_id: "conn-web" });
    const { fetchImpl, calls } = fakeTelnyx({
      create: [],
      token: [{ status: 401, body: JSON.stringify({ errors: [{ title: "Unauthorized", detail: "Bad API key" }] }) }],
    });
    expect(await webrtcLoginToken(admin, cfg, "u-1", fetchImpl)).toEqual({
      error: "Telnyx rechazó el acceso a la línea (401): Unauthorized: Bad API key",
    });
    expect(calls).toHaveLength(1);
  });
});

describe("dónde vive cada cosa", () => {
  const component = read("components/browser-call.tsx");
  const actions = read("app/dashboard/pedidos/actions.ts");
  const drawer = read("components/order-drawer.tsx");

  it("la clave de Telnyx no llega al navegador", () => {
    expect(component).not.toMatch(/@\/lib\/env|@\/lib\/telnyx-webrtc|TELNYX_API_KEY|api\.telnyx\.com/);
    // El SDK se carga al llamar, no con la ficha.
    expect(component).toContain('await import("@telnyx/webrtc")');
    expect(component).not.toMatch(/^import \{[^}]*\} from "@telnyx\/webrtc";$/m);
  });

  it("el token solo sale con permiso de edición y con acceso al pedido", () => {
    const body = actions.slice(actions.indexOf("export async function startBrowserCall("), actions.indexOf("export async function recordBrowserCall("));
    expect(body.indexOf('perms.can("master.edit")')).toBeLessThan(body.indexOf("webrtcLoginToken("));
    expect(body.indexOf("authorizeOrder(orderId)")).toBeLessThan(body.indexOf("webrtcLoginToken("));
    expect(body).toContain("telnyxPeruE164(ctx.row.customer_phone)");
  });

  it("una llamada se guarda una sola vez, como hecho del pedido", () => {
    const body = actions.slice(actions.indexOf("export async function recordBrowserCall("));
    expect(body).toContain('.eq("payload->>call_id", report.callId)');
    expect(body.indexOf('.eq("payload->>call_id", report.callId)')).toBeLessThan(body.indexOf("recordEvent("));
    expect(body).toContain('kind: "browser_call"');
  });

  it("el botón solo sale con la línea configurada y para quien puede editar", () => {
    expect(drawer).toContain("{detail.browserCallEnabled && canEdit && (");
    expect(actions).toContain("browserCallEnabled: webrtcConfigFromEnv() !== null");
    expect(read("components/order-master-shared.tsx")).toContain('browser_call: "Llamada desde Kapta"');
  });

  it("la tabla de credenciales es solo del servidor", () => {
    const sql = read("db/migrations/0243_telnyx_webrtc_credentials.sql");
    expect(sql).toContain("enable row level security");
    expect(sql).toContain("revoke all on telnyx_webrtc_credentials from anon, authenticated;");
  });
});

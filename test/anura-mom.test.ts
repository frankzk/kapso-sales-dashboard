// «Llamar con Anura» en el MOM (docs/mom/master-pedidos-v1.md §8.7, fase 1,
// 05-11-2026): la sección sigue a §8.6, cita los textos y los números del
// código tal cual (lib/anura/*), la tabla de estados es la máquina de
// estados, la llamada es un hecho y no una gestión, la grabación se copia
// porque el enlace de Anura vence, el aviso responde 401 solo a un token
// malo, Kapta no guarda credenciales SIP, los permisos son los de siempre y
// «Llamar desde Kapta» (Telnyx) se queda. Sin red: nada llama a Anura.

import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ANURA_CLICK2DIAL_TIMEOUT_MS,
  ANURA_CUSTOMS_PREFIX,
  ANURA_EVENT_RETENTION_DAYS,
  ANURA_EVENT_TEMPLATE,
  ANURA_POLL_INTERVAL_MS,
  ANURA_RECORDING_HOSTS,
  ANURA_RECORDING_TTL_MS,
  ANURA_STALE_REASON,
  ANURA_STALE_REQUEST_MS,
  ANURA_STATUS_LABEL,
  ANURA_STATUS_RANK,
  ANURA_STUCK_CALL_MS,
  ANURA_STUCK_REASON,
  anuraBusyError,
  anuraCustoms,
  anuraFailureReason,
  anuraPeruCalled,
  applyAnuraEvent,
  inboundEndStatus,
  maskPhone,
  normalizeAnuraExtension,
  outboundEndStatus,
  parseAnuraEvent,
  type AnuraCallStatus,
} from "@/lib/anura/events";
import { CLICK2DIAL_ERROR_TEXT, click2DialBody } from "@/lib/anura/click2dial";
import {
  ANURA_RECORDING_BUCKET,
  ANURA_RECORDING_MAX_ATTEMPTS,
  ANURA_RECORDING_SIGNED_SECONDS,
} from "@/lib/anura/recording";
import { ANURA_WEBHOOK_PATH, ANURA_WEBHOOK_TOKEN_LENGTH, anuraWebhookToken, anuraWebhookUrl } from "@/lib/anura/token";
import { ANURA_ORDER_EVENT_KIND, releaseStaleAnuraCalls } from "@/lib/anura/calls";
import { ANURA_AFTER_PANEL_STEPS, ANURA_PANEL_STEPS } from "@/lib/anura/ui";
import { handleAnuraWebhook } from "@/lib/anura/webhook";
import { createFakeDb } from "./helpers/anura-fake-db";

const read = (p: string) => readFileSync(resolve(process.cwd(), p), "utf8");
const MOM = read("docs/mom/master-pedidos-v1.md");
const flat = (text: string) => text.replace(/\s+/g, " ");
function raw(start: string, end: string): string {
  const from = MOM.indexOf(start);
  expect(from, start).toBeGreaterThanOrEqual(0);
  const to = MOM.indexOf(end, from + start.length);
  expect(to, end).toBeGreaterThan(from);
  return MOM.slice(from, to);
}

const S86_RAW = raw("### 8.7 Llamar con Anura (fase 1, 05-11-2026)", "\n## 9. Lima");
const s = flat(S86_RAW);
const S85 = flat(raw("### 8.5 Llamar desde la computadora (11-10-2026)", "### 8.6 "));
const S15 = flat(raw("## 15. Responsables actuales", "## 16. "));
const S16 = flat(raw("## 16. Permisos de alto riesgo", "### 16.1 "));
const S21 = flat(raw("## 21. Pendientes posteriores", "## 22. "));

describe("dónde va la sección", () => {
  it("§8.7 sigue a §8.6 y va antes de §9", () => {
    const i85 = MOM.indexOf("### 8.5 Llamar desde la computadora");
    const i86 = MOM.indexOf("### 8.7 Llamar con Anura");
    const i86b = MOM.indexOf("### 8.6 ");
    const i9 = MOM.indexOf("\n## 9. Lima");
    expect(i85).toBeGreaterThan(0);
    expect(i86b).toBeGreaterThan(i85);
    expect(i86).toBeGreaterThan(i86b);
    expect(i9).toBeGreaterThan(i86);
    expect(MOM.match(/^### 8\.7 /gm)).toHaveLength(1);
  });

  it("tiene los apartados de §8.5 y los suyos", () => {
    for (const head of [
      "**Dónde.**",
      "**Con qué número.**",
      "**Qué queda.**",
      "**No reemplaza la gestión.**",
      "**Grabaciones.**",
      "**Avisos de Anura.**",
      "**Configuración (una vez).**",
      "**Un anexo por persona.**",
      "**Lo que Kapta no guarda.**",
      "**Permisos.**",
      "**Llamada de prueba.**",
      "**«Llamar desde Kapta» se queda.**",
    ]) {
      expect(s, head).toContain(head);
    }
  });
});

describe("fase 1: sin teléfono en el navegador", () => {
  it("Click2Dial hace sonar primero el teléfono de Anura de la asesora", () => {
    expect(s).toContain("En la fase 1 **no hay teléfono dentro del navegador**");
    expect(s).toContain(
      "Anura hace sonar primero el teléfono de Anura de la asesora (la terminal principal de su anexo) y, cuando ella contesta, marca a la clienta.",
    );
  });

  it("Kapta no guarda credenciales SIP; la fase 2 es el teléfono en el navegador", () => {
    expect(s).toContain("Ni usuarios ni contraseñas SIP de Anura");
    expect(s).toContain("La fase 2 es el teléfono dentro del navegador");
    expect(S21).toContain("Anura, fase 2: el teléfono dentro del navegador");
    // Ni la base ni el código tienen dónde guardarlas.
    const migration = read("db/migrations/0310_anura_click2dial.sql");
    expect(migration).not.toMatch(/\bsip_\w+/i);
    expect(migration).not.toMatch(/password/i);
  });
});

describe("dónde sale el botón", () => {
  it("token, master.edit, anexo activo y celular peruano", () => {
    expect(s).toContain("«Llamar con Anura», en la cabecera de la ficha, junto a «Llamar desde Kapta» (§8.5)");
    expect(s).toContain("(`ANURA_CLICK2DIAL_TOKEN`)");
    expect(s).toContain("(`master.edit`, el mismo permiso que registra la gestión)");
    expect(s).toContain("tiene un anexo activo en la organización de la tienda del pedido");
    expect(s).toContain("**celular peruano** (9 dígitos que empiezan por 9; se acepta con +51, 51 o 0051 delante)");
    expect(s).toContain("Un fijo o un número extranjero no se marca en la fase 1.");
    expect(s).toContain("El teléfono lo lee el servidor del pedido: el navegador nunca lo manda.");
  });

  it("la regla del celular es la de anuraPeruCalled", () => {
    for (const ok of ["987654321", "+51 987 654 321", "51987654321", "0051987654321"]) {
      expect(anuraPeruCalled(ok), ok).toBe("987654321");
    }
    for (const no of ["014801497", "12025550123", "87654321", "", null]) {
      expect(anuraPeruCalled(no), String(no)).toBeNull();
    }
  });

  it("el sondeo de la ficha: 2,5 segundos", () => {
    expect(ANURA_POLL_INTERVAL_MS).toBe(2_500);
    expect(s).toContain("lo vuelve a preguntar cada 2,5 segundos");
  });

  it("una llamada viva por persona, con el texto de la pantalla", () => {
    expect(s).toContain("**Una llamada viva por persona.**");
    expect(s).toContain(`si todavía no sonó, «${anuraBusyError("solicitada")}»`);
    expect(s).toContain(`si ya suena o está en curso, «${anuraBusyError("en_curso")}»`);
    expect(anuraBusyError("sonando")).toBe(anuraBusyError("en_curso"));
    expect(s).toContain("La ficha retoma la llamada viva de quien mira aunque sea de otro pedido: entonces lo dice y enlaza a ese pedido");
    expect(s).toContain("Lo sostiene la base (un índice único)");
    expect(read("db/migrations/0310_anura_click2dial.sql")).toContain("anura_calls_one_active_per_user");
  });
});

describe("con qué número", () => {
  it("el de la central en Anura, una sola para la organización", () => {
    expect(s).toContain("**Con qué número.** El de la central en Anura");
    expect(s).toContain("Click2Dial no tiene un campo para elegirlo");
    expect(s).toContain("Hay **una sola central para la organización** (Kenku y Aurela comparten la cuenta de Anura)");
    // Click2Dial solo manda called, extension y customs: ningún número de salida.
    expect(click2DialBody({ called: "987654321", extension: "101", customs: anuraCustoms("x") })).toBe(
      "called=987654321&extension=101&customs=kapta-x",
    );
  });
});

describe("qué queda: un hecho, no una gestión", () => {
  it("el hecho del historial es anura_call, de fuente anura", () => {
    expect(ANURA_ORDER_EVENT_KIND).toBe("anura_call");
    expect(s).toContain("(`order_events`, `anura_call`, fuente `anura`, «Llamada con Anura»)");
    expect(s).toContain("(enmascarado en la nota, `98••••321`)");
    expect(maskPhone("987654321")).toBe("98••••321");
  });

  it("el token se ata a una org con ANURA_ORG_ID", () => {
    expect(s).toContain("`ANURA_ORG_ID` (opcional) lo ata a la organización dueña de la central");
    expect(read("lib/env.ts")).toContain("process.env.ANURA_ORG_ID");
    expect(read("lib/anura/server.ts")).toContain("env.anuraOrgId()");
  });

  it("solo el fin de Anura escribe el hecho; el cierre de las 2 horas no", async () => {
    expect(s).toContain("El hecho lo escribe **solo el aviso de fin de Anura**, también cuando el fin trae un fallo");
    expect(s).toContain(
      "Una llamada que sonó y que Kapta cerró a las 2 horas porque el fin nunca llegó tampoco entra al historial **mientras el fin de Anura no llegue**; si llega después, entra con lo que diga.",
    );
    const user = "7a7a7a7a-1111-4222-8333-444444444444";
    const db = createFakeDb({
      anura_calls: [
        {
          id: "3f2b8c1e-1d2a-4c3b-9a8f-0123456789ac",
          org_id: "0d6f6f3e-7c1b-4b8e-9d5a-1a2b3c4d5e6f",
          store_id: "5e5e5e5e-1111-4222-8333-444444444444",
          order_id: "6f6f6f6f-1111-4222-8333-444444444444",
          user_id: user,
          mode: "pedido",
          direction: "out",
          status: "en_curso",
          status_rank: 20,
          requested_at: "2026-11-05T10:00:00.000Z",
          last_event_at: "2026-11-05T10:00:30.000Z",
        },
      ],
    });
    expect(await releaseStaleAnuraCalls(db.client, { userId: user }, new Date("2026-11-05T12:01:00.000Z"))).toBe(1);
    expect(db.tables.anura_calls[0]).toMatchObject({ status: "fallida", closed_by_timeout: true });
    expect(db.tables.order_events).toHaveLength(0);
  });

  it("lo que nunca timbró no entra al historial, como en §8.5", () => {
    expect(s).toContain("como en §8.5, una llamada que no llegó a timbrar no es un intento de contacto.");
    expect(S85).toContain("Una llamada que no llegó a timbrar —sin micrófono, sin línea— no se guarda: no fue un intento de contacto.");
  });

  it("la gestión se sigue registrando en la mesa de confirmación", () => {
    expect(s).toContain("se sigue registrando en la mesa de confirmación (§6.1)");
    expect(s).toContain("Kapta no sube la gestión sola cuando la clienta no contesta (Rentabilify sí lo hace).");
    expect(s).toContain("no recalcula el pedido ni cuenta en «Gestión por persona»");
    expect(s).toContain("no en `voice_calls`");
    expect(s).toContain("ni en `shipment_calls` (las gestiones)");
  });

  it("un aviso de fin deja un solo hecho, con el número enmascarado, y nada más", async () => {
    const KEY = "clave-de-prueba";
    const ORG = "0d6f6f3e-7c1b-4b8e-9d5a-1a2b3c4d5e6f";
    const CALL = "3f2b8c1e-1d2a-4c3b-9a8f-0123456789ab";
    const db = createFakeDb({
      anura_calls: [
        {
          id: CALL,
          org_id: ORG,
          store_id: "5e5e5e5e-1111-4222-8333-444444444444",
          order_id: "6f6f6f6f-1111-4222-8333-444444444444",
          user_id: "7a7a7a7a-1111-4222-8333-444444444444",
          mode: "pedido",
          direction: "out",
          extension: "101",
          phone: "987654321",
          status: "sonando",
          status_rank: 10,
          closed_by_timeout: false,
          recording_status: "sin_grabacion",
          requested_at: "2026-11-05T15:00:00.000Z",
        },
      ],
      anura_extensions: [],
      anura_webhook_events: [],
      order_events: [],
    });
    const body = JSON.stringify({ callId: "cdr-1", event: "END", direction: "OUT", status: "NOANSWER", billSeconds: "0", custom1: anuraCustoms(CALL) });
    const send = () =>
      handleAnuraWebhook({ org: ORG, token: anuraWebhookToken(ORG, KEY), body }, { admin: db.client, key: KEY, defer: () => {} });
    expect((await send()).status).toBe(200);
    expect((await send()).status).toBe(200);
    const facts = db.tables.order_events.filter((e) => e.kind === "anura_call");
    expect(facts).toHaveLength(1);
    expect(facts[0]!.source).toBe("anura");
    expect(facts[0]!.note).toContain("98••••321");
    expect(facts[0]!.note).not.toContain("987654321");
    // Ninguna otra tabla del pedido: ni gestiones ni confirmación.
    expect(db.tables.order_events.every((e) => e.kind === "anura_call")).toBe(true);
    expect(db.tables.shipment_calls ?? []).toHaveLength(0);
    expect(db.tables.voice_calls ?? []).toHaveLength(0);
  });
});

describe("grabaciones", () => {
  it("el enlace vence a los 30 min: se copia al bucket privado", () => {
    expect(ANURA_RECORDING_TTL_MS).toBe(30 * 60_000);
    expect(ANURA_RECORDING_BUCKET).toBe("anura-recordings");
    expect(s).toContain("El enlace de la grabación que manda Anura **vence a los 30 minutos**.");
    expect(s).toContain("Kapta la descarga a su Storage privado (bucket `anura-recordings`) en cuanto llega el aviso de fin");
  });

  it("reintentos, «grabación vencida» y el enlace firmado de 5 minutos", () => {
    expect(ANURA_RECORDING_MAX_ATTEMPTS).toBe(6);
    expect(ANURA_RECORDING_SIGNED_SECONDS).toBe(5 * 60);
    expect(s).toContain("se reintenta al abrir la ficha del pedido mientras no pasen los 30 minutos, hasta 6 intentos.");
    expect(s).toContain("Queda «grabación vencida» al sexto intento fallido o cuando pasan los 30 minutos");
    expect(s).toContain("La ficha recibe un enlace firmado que dura 5 minutos.");
    expect(s).toContain("El enlace de Anura no sale del servidor: vive solo en la bitácora de avisos, y se borra de ella cuando la grabación queda guardada o vencida.");
  });

  it("solo de hosts de Anura, con redirecciones comprobadas y 40 MB como mucho", () => {
    expect(ANURA_RECORDING_HOSTS).toEqual(["anura.pe", "anura.com.pe", "anura.com.ar"]);
    expect(s).toContain("Kapta solo baja grabaciones de **hosts de Anura**: `anura.pe`, `anura.com.pe`, `anura.com.ar` o un subdominio suyo");
    expect(s).toContain("también después de una redirección (cada salto se vuelve a comprobar, hasta 3), y nunca más de 40 MB.");
    expect(s).toContain("«Grabación descartada: el enlace no es de Anura (host)»");
    expect(s).toContain("`ANURA_RECORDING_HOSTS`");
    expect(read("lib/anura/webhook.ts")).toContain("Grabación descartada: el enlace no es de Anura (");
  });
});

describe("los avisos de Anura", () => {
  it("la URL y el token derivado de ENCRYPTION_KEY", () => {
    const ORG = "0d6f6f3e-7c1b-4b8e-9d5a-1a2b3c4d5e6f";
    const key = "clave-de-prueba";
    const want = createHmac("sha256", key).update(`anura-webhook:${ORG}`).digest("hex").slice(0, 32);
    expect(ANURA_WEBHOOK_TOKEN_LENGTH).toBe(32);
    expect(anuraWebhookToken(ORG, key)).toBe(want);
    expect(ANURA_WEBHOOK_PATH).toBe("/api/webhooks/anura");
    expect(anuraWebhookUrl("https://kapta.test/", ORG, key)).toBe(`https://kapta.test/api/webhooks/anura?org=${ORG}&t=${want}`);
    expect(s).toContain("a `/api/webhooks/anura?org=<orgId>&t=<token>`");
    expect(s).toContain('son los primeros 32 caracteres hex de HMAC-SHA256(`ENCRYPTION_KEY`, "anura-webhook:" + orgId)');
    expect(s).toContain("Cambiar `ENCRYPTION_KEY` cambia la URL y hay que volver a pegarla en Anura.");
  });

  it("401 solo a un token malo; todo lo demás 200", async () => {
    expect(s).toContain("Un token malo recibe 401; todo lo demás recibe 200, aunque se ignore o falle, porque si no Anura reintenta.");
    const KEY = "clave-de-prueba";
    const ORG = "0d6f6f3e-7c1b-4b8e-9d5a-1a2b3c4d5e6f";
    const db = createFakeDb({ anura_calls: [], anura_extensions: [], anura_webhook_events: [], order_events: [] });
    const deps = { admin: db.client, key: KEY, defer: () => {} };
    expect((await handleAnuraWebhook({ org: ORG, token: "0".repeat(32), body: "{}" }, deps)).status).toBe(401);
    const good = anuraWebhookToken(ORG, KEY);
    const ignored = await handleAnuraWebhook({ org: ORG, token: good, body: "esto no es JSON" }, deps);
    expect(ignored.status).toBe(200);
    expect(ignored.body.outcome).toBe("ignorado");
    // Una saliente que no se pidió desde Kapta: ignorada, como Rentabilify.
    const foreign = await handleAnuraWebhook(
      { org: ORG, token: good, body: JSON.stringify({ callId: "c-9", event: "END", direction: "OUT", status: "NOANSWER", custom1: "" }) },
      deps,
    );
    expect(foreign.status).toBe(200);
    expect(foreign.body.outcome).toBe("ignorado");
    expect(s).toContain("Las salientes que no se pidieron desde Kapta se ignoran (quedan «ignorado» en la bitácora), como hace Rentabilify.");
  });

  it("la llamada se encuentra por custom1 (kapta-<id>)", () => {
    expect(ANURA_CUSTOMS_PREFIX).toBe("kapta-");
    expect(s).toContain("La llamada se encuentra primero por `custom1` (`kapta-<id>`");
  });

  it("la plantilla del MOM es la que da Ajustes", () => {
    const m = /```json\n([\s\S]*?)\n\s*```/.exec(S86_RAW);
    expect(m).not.toBeNull();
    const inMom = m![1]!.split("\n").map((l) => l.replace(/^ {2}/, "")).join("\n");
    expect(inMom).toBe(ANURA_EVENT_TEMPLATE);
    expect(parseAnuraEvent(JSON.parse(ANURA_EVENT_TEMPLATE))?.hook).toBe("OTRO");
  });

  it("la tabla de estados es la máquina de estados", () => {
    const rows: [string, AnuraCallStatus, number][] = [
      ["| — | Kapta la pidió |", "solicitada", 0],
      ["| START | — |", "sonando", 10],
      ["| TALK | — |", "en_curso", 20],
      ["| END | `billSeconds` > 0 o status ANSWER |", "contestada", 100],
      ["| END | BUSY |", "ocupado", 100],
      ["| END | NOANSWER o CANCEL |", "no_contestada", 100],
      ["| END | FAILED, CONGESTION o CHANUNAVAIL |", "fallida", 100],
      ["| END | cualquier otro |", "no_contestada", 100],
      ["| END de una entrante | sin anexo de asesora o sin conversación |", "perdida", 100],
    ];
    for (const [start, status, rank] of rows) {
      expect(S86_RAW, start).toContain(`${start} \`${status}\` | «${ANURA_STATUS_LABEL[status]}» | ${rank} |`);
      expect(ANURA_STATUS_RANK[status]).toBe(rank);
    }
    expect(outboundEndStatus("ANSWER", 0)).toBe("contestada");
    expect(outboundEndStatus("NOANSWER", 12)).toBe("contestada");
    expect(outboundEndStatus("BUSY", 0)).toBe("ocupado");
    expect(outboundEndStatus("NOANSWER", 0)).toBe("no_contestada");
    expect(outboundEndStatus("CANCEL", 0)).toBe("no_contestada");
    for (const f of ["FAILED", "CONGESTION", "CHANUNAVAIL"]) expect(outboundEndStatus(f, 0)).toBe("fallida");
    expect(outboundEndStatus("ALGO", 0)).toBe("no_contestada");
  });

  it("el estado solo sube; una cerrada sola acepta todavía el fin", () => {
    expect(s).toContain("El estado **solo sube**: un aviso repetido o fuera de orden no cambia nada.");
    const ev = (event: string, status = "") => parseAnuraEvent({ event, status, direction: "OUT" })!;
    expect(applyAnuraEvent({ status: "en_curso", closedByTimeout: false }, ev("START"), "out")).toBeNull();
    expect(applyAnuraEvent({ status: "sonando", closedByTimeout: false }, ev("START"), "out")).toBeNull();
    expect(applyAnuraEvent({ status: "contestada", closedByTimeout: false }, ev("END", "BUSY"), "out")).toBeNull();
    expect(applyAnuraEvent({ status: "fallida", closedByTimeout: true }, ev("END", "BUSY"), "out")?.status).toBe("ocupado");
    expect(s).toContain("Si después llega el fin de verdad, todavía se aplica y dice cómo terminó.");
  });

  it("los fallos del fin, con las palabras de la pantalla", () => {
    for (const st of ["CONGESTION", "CHANUNAVAIL", "FAILED"]) {
      expect(s, st).toContain(`${st}, «${anuraFailureReason(st)}»`);
    }
  });

  it("los cierres de Kapta: 60 s sin avisos y 2 horas sin fin", () => {
    expect(ANURA_STALE_REQUEST_MS).toBe(60_000);
    expect(ANURA_STUCK_CALL_MS).toBe(2 * 3_600_000);
    expect(s).toContain(`pedida y sin ningún aviso a los 60 s: «${ANURA_STALE_REASON}»`);
    expect(s).toContain(`sonando o en curso y sin aviso de fin a las 2 horas: «${ANURA_STUCK_REASON}»`);
    expect(s).toContain("Este tope lo agrega Kapta para que nadie quede bloqueado si Anura nunca manda el fin.");
  });

  it("lo que Anura rechaza al pedir la llamada, y los 12 segundos", () => {
    expect(ANURA_CLICK2DIAL_TIMEOUT_MS).toBe(12_000);
    expect(s).toContain("Kapta espera su respuesta 12 segundos como mucho");
    for (const k of ["token", "sin_terminal", "terminal_no_registrada", "tiempo", "red"] as const) {
      expect(s, k).toContain(`«${CLICK2DIAL_ERROR_TEXT[k]}»`);
    }
    expect(s).toContain("Los dos últimos no son un rechazo: Anura pudo haber hecho la llamada. Por eso la fila sigue «Llamada pedida»");
    expect(read("lib/anura/calls.ts")).toContain('const AMBIGUOUS_CLICK2DIAL: readonly Click2DialErrorKind[] = ["tiempo", "red"];');
  });

  it("entrantes: solo información, contestada si la tomó una asesora y se habló", () => {
    expect(s).toContain("Las **entrantes** se guardan solo como información, sin pedido");
    expect(s).toContain("En la fase 1 no entran al historial de ningún pedido ni se ven en ninguna pantalla.");
    expect(s).toContain("con el número de quien llamó **enmascarado**");
    const exts = new Set(["101"]);
    const end = (answerExtension: string, billSeconds: string) =>
      parseAnuraEvent({ event: "END", direction: "IN", status: "ANSWER", answerExtension, billSeconds })!;
    expect(inboundEndStatus(end("101", "30"), exts)).toBe("contestada");
    expect(inboundEndStatus(end("100", "30"), exts)).toBe("perdida");
    expect(inboundEndStatus(end("101", "0"), exts)).toBe("perdida");
  });

  it("la bitácora: 30 días, teléfonos enmascarados, solo quien administra", () => {
    expect(ANURA_EVENT_RETENTION_DAYS).toBe(30);
    expect(s).toContain("Cada aviso queda en una bitácora (`anura_webhook_events`): aplicado, repetido, ignorado o error, con los teléfonos enmascarados. Guarda 30 días y la ve solo quien administra, en Ajustes.");
  });
});

describe("configuración (una vez) y anexos", () => {
  it("los pasos numerados del panel de Anura son los de Ajustes, en orden y con las mismas palabras", () => {
    expect(ANURA_PANEL_STEPS).toHaveLength(7);
    let at = -1;
    ANURA_PANEL_STEPS.forEach((step, i) => {
      const line = `${i + 1}. **${step.title}** ${step.text}`;
      const found = s.indexOf(line);
      expect(found, line).toBeGreaterThan(at);
      at = found;
    });
    expect(s).toContain(ANURA_AFTER_PANEL_STEPS);
    expect(s).toContain("Kapta solo dice si está configurado, nunca el valor.");
    // Ajustes pinta exactamente esa lista.
    expect(read("components/anura-settings-section.tsx")).toContain("ANURA_PANEL_STEPS.map(");
  });

  it("un anexo por persona y uno por anexo, de 2 a 6 dígitos", () => {
    expect(s).toContain("uno por persona y uno por anexo en la organización, de 2 a 6 dígitos");
    expect(s).toContain("Para pasarlo a otra persona, primero se le quita a quien lo tiene.");
    expect(normalizeAnuraExtension("101")).toBe("101");
    expect(normalizeAnuraExtension("1")).toBeNull();
    expect(normalizeAnuraExtension("1234567")).toBeNull();
    const migration = read("db/migrations/0310_anura_click2dial.sql");
    expect(migration).toContain("unique (org_id, user_id)");
    expect(migration).toContain("unique (org_id, extension)");
  });

  it("la llamada de prueba no toca ningún pedido", () => {
    expect(s).toContain("No es un intento de ningún pedido: no escribe nada en ningún pedido.");
    expect(s).toContain("La fila de la prueba no lleva tienda, así que nadie más lee por RLS el número que se escribió.");
    expect(read("lib/anura/server.ts")).toContain('storeId: null, orderId: null, userId: target.userId, mode: "prueba"');
    expect(read("db/migrations/0310_anura_click2dial.sql")).toContain("(mode = 'prueba' and order_id is null and direction = 'out')");
  });
});

describe("permisos", () => {
  it("sin permiso nuevo: master.edit para llamar y stores.manage para Ajustes", () => {
    expect(s).toContain("Llamar pide «Gestionar pedidos» (`master.edit`), como §8.5.");
    expect(s).toContain("pide «Administrar tiendas» (`stores.manage`) en la organización de la tienda, lo mismo que Ajustes entero. No hay permiso nuevo.");
    expect(S16).toContain("Telefonía Anura (05-11-2026, §8.7): **sin permiso nuevo**.");
    expect(S15).toContain("| Anexos de Anura, URL del aviso y llamada de prueba (§8.7) | Administración (`stores.manage`) |");
    // Lo mismo dice el servidor.
    const server = read("lib/anura/server.ts");
    expect(server).toContain('perms.can("master.edit")');
    expect(server).toContain('hasOrgPermission(orgId, "stores.manage")');
  });
});

describe("«Llamar desde Kapta» (Telnyx) se queda", () => {
  it("§8.5 sigue igual y §8.7 lo dice", () => {
    expect(S85).toContain("«Llamar desde Kapta», en la cabecera de la ficha");
    expect(s).toContain("La llamada por Telnyx desde la computadora (§8.5) sigue igual, al lado. Anura no la reemplaza en la fase 1.");
  });
});

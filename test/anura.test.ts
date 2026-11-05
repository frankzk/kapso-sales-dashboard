// «Llamar con Anura», fase 1 (Click2Dial): las reglas puras. Qué número se
// marca, cómo se enmascara, el id que viaja en `customs`, cómo se lee un aviso,
// la máquina de estados (el rango solo sube), el token del webhook y el
// cliente de Click2Dial con fetch simulado (nunca la red).

import { describe, expect, it, vi } from "vitest";
import {
  ANURA_EVENT_TEMPLATE,
  anuraCallNote,
  anuraCustoms,
  anuraPeruCalled,
  applyAnuraEvent,
  callIdFromCustom1,
  eventTarget,
  maskPhone,
  maskedEventPayload,
  normalizeAnuraExtension,
  outboundEndStatus,
  allowedRecordingUrl,
  anuraRecordingHostAllowed,
  parseAnuraEvent,
  type AnuraEvent,
} from "@/lib/anura/events";
import { anuraWebhookToken, anuraWebhookTokenValid, anuraWebhookUrl } from "@/lib/anura/token";
import {
  ANURA_CLICK2CALL_URL,
  CLICK2DIAL_ERROR_TEXT,
  click2DialBody,
  requestClick2Dial,
} from "@/lib/anura/click2dial";

const CALL_ID = "3f2b8c1e-1d2a-4c3b-9a8f-0123456789ab";
const ORG = "0d6f6f3e-7c1b-4b8e-9d5a-1a2b3c4d5e6f";
const KEY = "clave-de-prueba-no-es-la-real";

function ev(over: Partial<Record<string, unknown>>): AnuraEvent {
  return parseAnuraEvent({
    callId: "cdr-1",
    event: "START",
    direction: "OUT",
    status: "",
    calling: "101",
    called: "987654321",
    billSeconds: "0",
    custom1: anuraCustoms(CALL_ID),
    ...over,
  })!;
}

describe("qué número se marca", () => {
  it("los 9 dígitos del celular, sin el 51", () => {
    expect(anuraPeruCalled("987654321")).toBe("987654321");
    expect(anuraPeruCalled("+51 987 654 321")).toBe("987654321");
    expect(anuraPeruCalled("51987654321")).toBe("987654321");
    expect(anuraPeruCalled("0051987654321")).toBe("987654321");
    expect(anuraPeruCalled("987-654-321")).toBe("987654321");
  });

  it("un fijo, un número corto o uno extranjero no se marca", () => {
    expect(anuraPeruCalled("014567890")).toBeNull();
    expect(anuraPeruCalled("12345678")).toBeNull();
    expect(anuraPeruCalled("98765432")).toBeNull();
    expect(anuraPeruCalled("+1 415 555 0100")).toBeNull();
    expect(anuraPeruCalled("")).toBeNull();
    expect(anuraPeruCalled(null)).toBeNull();
  });

  it("el número enmascarado deja ver solo los extremos", () => {
    expect(maskPhone("987654321")).toBe("98••••321");
    expect(maskPhone("+51 987 654 321")).toBe("51••••••321");
    expect(maskPhone("101")).toBe("•••");
    expect(maskPhone("")).toBe("");
    expect(maskPhone(null)).toBe("");
  });

  it("el anexo son de 2 a 6 dígitos", () => {
    expect(normalizeAnuraExtension(" 101 ")).toBe("101");
    expect(normalizeAnuraExtension("1")).toBeNull();
    expect(normalizeAnuraExtension("1234567")).toBeNull();
    expect(normalizeAnuraExtension("10a")).toBeNull();
  });
});

describe("el id que viaja en customs", () => {
  it("va y vuelve como custom1", () => {
    expect(anuraCustoms(CALL_ID)).toBe(`kapta-${CALL_ID}`);
    expect(callIdFromCustom1(`kapta-${CALL_ID}`)).toBe(CALL_ID);
    expect(callIdFromCustom1(`KAPTA-${CALL_ID.toUpperCase()}`)).toBe(CALL_ID);
  });

  it("lo que no es nuestro no se reconoce", () => {
    expect(callIdFromCustom1("")).toBeNull();
    expect(callIdFromCustom1("rb-123")).toBeNull();
    expect(callIdFromCustom1("kapta-no-es-uuid")).toBeNull();
    expect(callIdFromCustom1("{{ custom1 }}")).toBeNull();
  });
});

describe("cómo se lee un aviso", () => {
  it("la plantilla trae los trece campos", () => {
    const parsed = JSON.parse(ANURA_EVENT_TEMPLATE);
    expect(Object.keys(parsed)).toEqual([
      "callId",
      "event",
      "direction",
      "status",
      "calling",
      "called",
      "dialTime",
      "billSeconds",
      "wasRecorded",
      "accountExtension",
      "answerExtension",
      "custom1",
      "recordingUrl",
    ]);
    expect(parsed.recordingUrl).toBe("{{ audio_play_mp3 }}");
  });

  it("un valor que Anura no llenó queda vacío", () => {
    const e = parseAnuraEvent({ callId: "{{ cdrid }}", event: "END", billSeconds: "None", custom1: "{{ custom1 }}", recordingUrl: "" })!;
    expect(e.callId).toBeNull();
    expect(e.billSeconds).toBe(0);
    expect(e.custom1).toBeNull();
    expect(e.recordingUrl).toBeNull();
  });

  it("dirección, segundos, grabado y grabación", () => {
    const e = parseAnuraEvent({
      event: "end",
      direction: "IN",
      billSeconds: "42",
      wasRecorded: "1",
      recordingUrl: "https://audio.anura.pe/rec.mp3?sig=x",
    })!;
    expect(e.hook).toBe("END");
    expect(e.direction).toBe("in");
    expect(e.billSeconds).toBe(42);
    expect(e.wasRecorded).toBe(true);
    expect(e.recordingUrl).toBe("https://audio.anura.pe/rec.mp3?sig=x");
    // Un enlace que no es https no se sigue.
    expect(parseAnuraEvent({ event: "END", recordingUrl: "http://audio.anura.pe/a.mp3" })!.recordingUrl).toBeNull();
    expect(parseAnuraEvent({ event: "RECORDING" })!.hook).toBe("OTRO");
  });

  it("la grabación solo se acepta de un host de Anura", () => {
    const url = (recordingUrl: string, extra?: string[]) =>
      parseAnuraEvent({ event: "END", recordingUrl }, extra ? { extraRecordingHosts: extra } : {})!;
    for (const ok of ["https://anura.pe/r.mp3", "https://cdn.grab.anura.com.pe/r.mp3", "https://x.anura.com.ar:443/r.mp3"]) {
      expect(url(ok).recordingUrl, ok).not.toBeNull();
      expect(url(ok).recordingRejectedHost, ok).toBeNull();
    }
    for (const [bad, host] of [
      ["https://evil.example/r.mp3", "evil.example"],
      ["https://anura.pe.evil.example/r.mp3", "anura.pe.evil.example"],
      ["https://evilanura.pe/r.mp3", "evilanura.pe"],
      ["https://audio.anura.pe:8443/r.mp3", "audio.anura.pe"],
      ["https://user:pw@audio.anura.pe/r.mp3", "audio.anura.pe"],
      ["https://169.254.169.254/latest/meta-data", "169.254.169.254"],
    ] as const) {
      expect(url(bad).recordingUrl, bad).toBeNull();
      expect(url(bad).recordingRejectedHost, bad).toBe(host);
    }
    // ANURA_RECORDING_HOSTS agrega hosts.
    expect(url("https://grabaciones.s3.example/r.mp3", ["s3.example"]).recordingUrl).toBe("https://grabaciones.s3.example/r.mp3");
    expect(anuraRecordingHostAllowed("ANURA.PE.")).toBe(true);
    expect(allowedRecordingUrl("http://anura.pe/r.mp3")).toBeNull();
  });

  it("lo que no es un objeto no es un aviso", () => {
    expect(parseAnuraEvent(null)).toBeNull();
    expect(parseAnuraEvent("START")).toBeNull();
    expect(parseAnuraEvent([1, 2])).toBeNull();
  });

  it("la bitácora no guarda teléfonos enteros ni el enlace de la grabación", () => {
    const masked = maskedEventPayload(
      ev({ event: "END", calling: "51912345678", called: "987654321", recordingUrl: "https://audio.anura.pe/a.mp3" }),
    );
    const text = JSON.stringify(masked);
    expect(text).not.toContain("987654321");
    expect(text).not.toContain("912345678");
    expect(text).not.toContain("audio.anura.pe");
    expect(masked.hasRecording).toBe(true);
  });
});

describe("la máquina de estados", () => {
  it("START sonando, TALK en curso", () => {
    expect(eventTarget(ev({ event: "START" }), "out")!.status).toBe("sonando");
    expect(eventTarget(ev({ event: "TALK" }), "out")!.status).toBe("en_curso");
    expect(eventTarget(ev({ event: "RECORDING" }), "out")).toBeNull();
  });

  it("cómo termina una saliente", () => {
    expect(outboundEndStatus("ANSWER", 0)).toBe("contestada");
    expect(outboundEndStatus("NOANSWER", 12)).toBe("contestada");
    expect(outboundEndStatus("BUSY", 0)).toBe("ocupado");
    expect(outboundEndStatus("NOANSWER", 0)).toBe("no_contestada");
    expect(outboundEndStatus("CANCEL", 0)).toBe("no_contestada");
    expect(outboundEndStatus("FAILED", 0)).toBe("fallida");
    expect(outboundEndStatus("CONGESTION", 0)).toBe("fallida");
    expect(outboundEndStatus("CHANUNAVAIL", 0)).toBe("fallida");
    expect(outboundEndStatus("LOQUESEA", 0)).toBe("no_contestada");
    expect(outboundEndStatus(null, 0)).toBe("no_contestada");
  });

  it("un fallo de Anura trae el motivo en palabras", () => {
    expect(eventTarget(ev({ event: "END", status: "CONGESTION" }), "out")!.failureReason).toMatch(/restringido/);
    expect(eventTarget(ev({ event: "END", status: "CHANUNAVAIL" }), "out")!.failureReason).toMatch(/no está disponible/);
    expect(eventTarget(ev({ event: "END", status: "BUSY" }), "out")!.failureReason).toBeNull();
  });

  it("el rango solo sube: repetido o fuera de orden no retrocede", () => {
    const sonando = { status: "sonando" as const, closedByTimeout: false };
    expect(applyAnuraEvent({ status: "solicitada", closedByTimeout: false }, ev({ event: "START" }), "out")!.status).toBe("sonando");
    expect(applyAnuraEvent(sonando, ev({ event: "START" }), "out")).toBeNull();
    expect(applyAnuraEvent(sonando, ev({ event: "TALK" }), "out")!.status).toBe("en_curso");
    expect(applyAnuraEvent({ status: "en_curso", closedByTimeout: false }, ev({ event: "START" }), "out")).toBeNull();
    // El END puede llegar sin START ni TALK.
    expect(applyAnuraEvent({ status: "solicitada", closedByTimeout: false }, ev({ event: "END", status: "BUSY" }), "out")!.status).toBe("ocupado");
    // Terminada, nada la mueve: ni otro END.
    const done = { status: "contestada" as const, closedByTimeout: false };
    expect(applyAnuraEvent(done, ev({ event: "END", status: "BUSY" }), "out")).toBeNull();
    expect(applyAnuraEvent(done, ev({ event: "TALK" }), "out")).toBeNull();
  });

  it("cerrada sola por Kapta, todavía acepta el END de verdad (y solo el END)", () => {
    const timedOut = { status: "fallida" as const, closedByTimeout: true };
    expect(applyAnuraEvent(timedOut, ev({ event: "END", status: "ANSWER", billSeconds: "30" }), "out")!.status).toBe("contestada");
    expect(applyAnuraEvent(timedOut, ev({ event: "START" }), "out")).toBeNull();
  });

  it("una entrante solo es contestada si la tomó el anexo de una asesora y se habló", () => {
    const advisors = new Set(["101"]);
    const end = (over: Record<string, unknown>) => ev({ event: "END", direction: "IN", status: "ANSWER", ...over });
    expect(eventTarget(end({ answerExtension: "101", billSeconds: "25" }), "in", advisors)!.status).toBe("contestada");
    // ANSWER del mensaje automático de Anura: nadie atendió.
    expect(eventTarget(end({ answerExtension: "", billSeconds: "25" }), "in", advisors)!.status).toBe("perdida");
    expect(eventTarget(end({ answerExtension: "999", billSeconds: "25" }), "in", advisors)!.status).toBe("perdida");
    expect(eventTarget(end({ answerExtension: "101", billSeconds: "0" }), "in", advisors)!.status).toBe("perdida");
  });
});

describe("la línea del historial del pedido", () => {
  it("dice quién contestó y cuánto, con el número enmascarado", () => {
    const note = anuraCallNote({ status: "contestada", billSeconds: 133, phone: "987654321", extension: "101", failureReason: null });
    expect(note).toBe("Llamada con Anura al 98••••321 (anexo 101): contestó, 2 min 13 s de conversación.");
    expect(note).not.toContain("987654321");
    expect(anuraCallNote({ status: "no_contestada", billSeconds: 0, phone: "987654321", extension: "101", failureReason: null })).toMatch(
      /no contestó\.$/,
    );
    expect(anuraCallNote({ status: "fallida", billSeconds: 0, phone: "987654321", extension: "101", failureReason: "El número no está disponible." })).toMatch(
      /no se pudo llamar\. El número no está disponible\.$/,
    );
  });
});

describe("el token del webhook", () => {
  it("HMAC-SHA256 de ENCRYPTION_KEY y la org, 32 caracteres hex, estable", () => {
    const t = anuraWebhookToken(ORG, KEY);
    expect(t).toMatch(/^[0-9a-f]{32}$/);
    expect(anuraWebhookToken(ORG, KEY)).toBe(t);
    expect(anuraWebhookToken(ORG.toUpperCase(), KEY)).toBe(t);
  });

  it("solo vale para su org y con la misma clave", () => {
    const t = anuraWebhookToken(ORG, KEY);
    expect(anuraWebhookTokenValid(ORG, t, KEY)).toBe(true);
    expect(anuraWebhookTokenValid(ORG, t.toUpperCase(), KEY)).toBe(true);
    expect(anuraWebhookTokenValid("11111111-2222-4333-8444-555555555555", t, KEY)).toBe(false);
    expect(anuraWebhookTokenValid(ORG, t, "otra-clave")).toBe(false);
    expect(anuraWebhookTokenValid(ORG, t.slice(0, 31), KEY)).toBe(false);
    expect(anuraWebhookTokenValid(ORG, `${t.slice(0, 31)}x`, KEY)).toBe(false);
    expect(anuraWebhookTokenValid(ORG, null, KEY)).toBe(false);
    expect(anuraWebhookTokenValid("no-es-uuid", t, KEY)).toBe(false);
    expect(anuraWebhookTokenValid(null, t, KEY)).toBe(false);
  });

  it("sin clave no hay token válido (y no lanza)", () => {
    const prev = process.env.ENCRYPTION_KEY;
    delete process.env.ENCRYPTION_KEY;
    try {
      expect(anuraWebhookTokenValid(ORG, "a".repeat(32))).toBe(false);
      expect(() => anuraWebhookToken(ORG)).toThrow();
    } finally {
      if (prev !== undefined) process.env.ENCRYPTION_KEY = prev;
    }
  });

  it("la URL lleva la org y el token", () => {
    const url = anuraWebhookUrl("https://kapta.test/", ORG, KEY);
    expect(url).toBe(`https://kapta.test/api/webhooks/anura?org=${ORG}&t=${anuraWebhookToken(ORG, KEY)}`);
  });
});

describe("el cliente de Click2Dial (fetch simulado)", () => {
  const req = { token: "tok-123", called: "987654321", extension: "101", customs: anuraCustoms(CALL_ID) };

  it("POST form-urlencoded con Bearer al adaptador de Perú", async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 200 }));
    await expect(requestClick2Dial(req, { fetchImpl: fetchImpl as unknown as typeof fetch })).resolves.toEqual({ ok: true });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(ANURA_CLICK2CALL_URL);
    expect(url).toBe("https://api.anura.pe/adapter/default/click2call");
    expect(init.method).toBe("POST");
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer tok-123");
    expect(headers["Content-Type"]).toBe("application/x-www-form-urlencoded");
    expect(init.body).toBe(`called=987654321&extension=101&customs=kapta-${CALL_ID}`);
    expect(click2DialBody(req)).toBe(init.body);
  });

  it("sin token no llama", async () => {
    const fetchImpl = vi.fn();
    const r = await requestClick2Dial({ ...req, token: " " }, { fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(r).toMatchObject({ ok: false, kind: "sin_token" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("los errores conocidos se dicen en palabras, sin el token", async () => {
    const answer = (status: number, text: string) => vi.fn(async () => new Response(text, { status })) as unknown as typeof fetch;
    expect(await requestClick2Dial(req, { fetchImpl: answer(400, "No Originate terminal for extension 101") })).toMatchObject({
      ok: false,
      kind: "sin_terminal",
      error: CLICK2DIAL_ERROR_TEXT.sin_terminal,
    });
    expect(await requestClick2Dial(req, { fetchImpl: answer(400, "Originate Terminal is not registered") })).toMatchObject({
      kind: "terminal_no_registrada",
    });
    expect(await requestClick2Dial(req, { fetchImpl: answer(401, "SecretId [12] not found") })).toMatchObject({ kind: "token" });
    const other = await requestClick2Dial(req, { fetchImpl: answer(500, "boom tok-123 boom") });
    expect(other).toMatchObject({ ok: false, kind: "rechazo", httpStatus: 500 });
    expect(JSON.stringify(other)).not.toContain("tok-123");
  });

  it("a los 12 s se corta: «Anura no respondió a tiempo»", async () => {
    const hang = vi.fn(
      (_url: string, init: RequestInit) =>
        new Promise<Response>((_, reject) => {
          init.signal!.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
        }),
    ) as unknown as typeof fetch;
    const r = await requestClick2Dial(req, { fetchImpl: hang, timeoutMs: 5 });
    expect(r).toMatchObject({ ok: false, kind: "tiempo", error: CLICK2DIAL_ERROR_TEXT.tiempo });
  });

  it("un fallo de red no lanza", async () => {
    const broken = vi.fn(async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    await expect(requestClick2Dial(req, { fetchImpl: broken })).resolves.toMatchObject({ ok: false, kind: "red" });
  });
});

import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ELEVENLABS_AGENT_SUFFIX,
  callsForEngine,
  pickOpenCall,
  planVoiceSlots,
  voiceAgentNumberFor,
  type OpenCall,
} from "@/lib/voice-recovery";
import {
  zadarmaEndedCallFor,
  zadarmaGet,
  zadarmaLocalStamp,
  zadarmaNoAnswerResumen,
  zadarmaOffsetMs,
  zadarmaNotifyPhones,
  zadarmaNotifySignature,
  zadarmaNotifyString,
  zadarmaNotifyValid,
} from "@/lib/zadarma";

const shares = { telnyxShare: 33, elevenShare: 33, telnyxReady: true, elevenReady: true };
const sep = { elevenOwn: true, telnyxNumber: "" };

describe("agentes en paralelo (MOM §11.8, 05-10-2026)", () => {
  it("cada línea con su número: ElevenLabs con sufijo, Telnyx con el suyo si lo tiene", () => {
    const daaph = { telephony: "zadarma", engine: "grok" } as const;
    const telnyx = { telephony: "telnyx", engine: "grok" } as const;
    const eleven = { telephony: "telnyx", engine: "elevenlabs" } as const;
    expect(voiceAgentNumberFor("1-11", daaph, sep)).toBe("1-11");
    expect(voiceAgentNumberFor("1-11", eleven, sep)).toBe(`1-11${ELEVENLABS_AGENT_SUFFIX}`);
    expect(voiceAgentNumberFor("1-11", eleven, { elevenOwn: false, telnyxNumber: "" })).toBe("1-11");
    expect(voiceAgentNumberFor("1-11", telnyx, sep)).toBe("1-11");
    expect(voiceAgentNumberFor("1-11", telnyx, { elevenOwn: true, telnyxNumber: "1-12" })).toBe("1-12");
  });

  it("sin ElevenLabs separado, un solo turno sorteado entre los tres, como antes", () => {
    const slots = planVoiceSlots({ base: "1-11", ...shares, lanes: { elevenOwn: false, telnyxNumber: "" } }, () => 0.9);
    expect(slots).toEqual([{ agentNumber: "1-11", route: { telephony: "zadarma", engine: "grok" } }]);
  });

  it("con ElevenLabs separado: su turno aparte y el de Grok sorteado entre Daaph y Telnyx", () => {
    const toTelnyx = planVoiceSlots({ base: "1-11", ...shares, lanes: sep }, () => 0.1);
    expect(toTelnyx.map((s) => [s.agentNumber, s.route.telephony, s.route.engine])).toEqual([
      ["1-11", "telnyx", "grok"],
      ["1-11#elevenlabs", "telnyx", "elevenlabs"],
    ]);
    const toDaaph = planVoiceSlots({ base: "1-11", ...shares, lanes: sep }, () => 0.9);
    expect(toDaaph[0]!.route.telephony).toBe("zadarma");
  });

  it("con Telnyx también separado, los tres a la vez", () => {
    const slots = planVoiceSlots({ base: "1-11", ...shares, lanes: { elevenOwn: true, telnyxNumber: "1-12" } });
    expect(slots.map((s) => s.agentNumber)).toEqual(["1-11", "1-12", "1-11#elevenlabs"]);
  });

  it("un agente apagado (0 %) o sin configurar no recibe turno", () => {
    expect(planVoiceSlots({ base: "1-11", ...shares, elevenShare: 0, lanes: sep }, () => 0.9)).toHaveLength(1);
    expect(planVoiceSlots({ base: "1-11", ...shares, elevenReady: false, lanes: sep }, () => 0.9)).toHaveLength(1);
  });

  it("la tool ve solo las llamadas de su motor; el número `?agente=1-11` encuentra el sufijado", () => {
    const now = new Date("2026-10-05T14:00:00Z");
    const open: OpenCall[] = [
      { id: "daaph", agent_number: "1-11", phone: "930000001", provider: "grok", status: "dialing", dialed_at: now.toISOString(), started_at: null },
      { id: "eleven", agent_number: "1-11#elevenlabs", phone: "930000002", provider: "elevenlabs", status: "dialing", dialed_at: now.toISOString(), started_at: null },
    ];
    const asGrok = pickOpenCall(callsForEngine(open, "grok"), "dialing", { now, agentNumber: "1-11" });
    const asEleven = pickOpenCall(callsForEngine(open, "elevenlabs"), "dialing", { now, agentNumber: "1-11" });
    expect("call" in asGrok && asGrok.call.id).toBe("daaph");
    expect("call" in asEleven && asEleven.call.id).toBe("eleven");
    // Sin poder distinguir el motor, dos abiertas con el mismo número son ambiguas: nadie recibe ficha ajena.
    expect(pickOpenCall(callsForEngine(open, null), "dialing", { now, agentNumber: "1-11" })).toEqual({ error: "ambigua" });
  });

  it("las tools filtran por motor, y el inicio de ElevenLabs solo ve llamadas de ElevenLabs", () => {
    const read = (p: string) => readFileSync(resolve(__dirname, "..", p), "utf8");
    expect(read("app/api/voice/tools/identificar_llamada/route.ts")).toContain(
      "callsForEngine(await openCalls(admin), voiceToolEngine(req.headers))",
    );
    expect(read("app/api/voice/tools/registrar_gestion/route.ts")).toContain(
      "callsForEngine(await openCalls(admin), voiceToolEngine(req.headers))",
    );
    expect(read("app/api/voice/elevenlabs/inicio/route.ts")).toContain('callsForEngine(await openCalls(admin), "elevenlabs")');
  });
});

describe("aviso de fin de llamada de Zadarma (Daaph)", () => {
  const secret = "s3cr3t";
  const php = (str: string) => Buffer.from(createHmac("sha1", secret).update(str).digest("hex")).toString("base64");
  const outEnd = {
    event: "NOTIFY_OUT_END",
    internal: "100",
    destination: "51930555309",
    call_start: "2026-10-05 09:15:07",
    disposition: "answered",
    duration: "42",
  };

  it("firma como la librería oficial: base64 del hex de HMAC-SHA1", () => {
    expect(zadarmaNotifyString(outEnd)).toBe("10051930555309" + "2026-10-05 09:15:07");
    expect(zadarmaNotifySignature("abc", secret)).toBe(php("abc"));
    expect(zadarmaNotifyValid(outEnd, php(zadarmaNotifyString(outEnd)!), secret)).toBe(true);
  });

  it("firma ajena, vacía o de un evento que no se maneja → no vale", () => {
    expect(zadarmaNotifyValid(outEnd, php("otra cosa"), secret)).toBe(false);
    expect(zadarmaNotifyValid(outEnd, null, secret)).toBe(false);
    expect(zadarmaNotifyValid({ ...outEnd, event: "NOTIFY_RECORD" }, php("x"), secret)).toBe(false);
    const end = { event: "NOTIFY_END", caller_id: "930555309", called_did: "17058243", call_start: "t" };
    expect(zadarmaNotifyString(end)).toBe("93055530917058243t");
  });

  it("el teléfono de la clienta sale en el formato de la cuenta", () => {
    expect(zadarmaNotifyPhones(outEnd)).toContain("930555309");
  });

  it("verifica la firma antes de tocar la base; en curso → corte sin gestión; marcando → no contesta", () => {
    const route = readFileSync(resolve(__dirname, "../app/api/webhooks/zadarma/route.ts"), "utf8");
    expect(route.indexOf("zadarmaNotifyValid(form")).toBeLessThan(route.indexOf("createAdminSupabase()"));
    expect(route).toContain('.eq("telephony", "zadarma")');
    expect(route).toContain('.in("status", ["dialing", "in_progress"])');
    expect(route).toContain("await closeCutWithoutGestion(admin, row, now);");
    expect(route).toContain("await closeAsNoAnswer(admin, row, zadarmaNoAnswerResumen(form.disposition), now);");
    // Zadarma verifica la URL con zd_echo al guardarla.
    expect(route).toContain('searchParams.get("zd_echo")');
  });
});

describe("llamadas de Daaph terminadas, por la estadística de Zadarma", () => {
  // Cuenta en hora de Kiev (+3): la estadística da `callstart` en esa hora.
  const tz = { unixtime: Date.parse("2026-10-05T14:00:00Z") / 1000, datetime: "2026-10-05 17:00:00" };
  const offsetMs = zadarmaOffsetMs(tz)!;
  const dialedAt = "2026-10-05T14:10:00.000Z";

  it("la zona de la cuenta sale de la hora local y el unixtime", () => {
    expect(offsetMs).toBe(3 * 3600_000);
    expect(zadarmaOffsetMs({ unixtime: tz.unixtime + 7, datetime: "2026-10-05 09:00:07" })).toBe(-5 * 3600_000);
    expect(zadarmaOffsetMs(null)).toBeNull();
    expect(zadarmaLocalStamp(new Date(dialedAt), offsetMs)).toBe("2026-10-05 17:10:00");
  });

  it("encuentra la llamada al teléfono que empezó al marcar, con su causa y duración", () => {
    const stats = [
      { to: "51930555309", callstart: "2026-10-05 17:10:04", disposition: "answered", billseconds: "48" },
    ];
    expect(zadarmaEndedCallFor(stats, { phone: "930 555 309", dialedAt, offsetMs })).toEqual({
      disposition: "answered",
      seconds: 48,
      startedAt: "2026-10-05T14:10:04.000Z",
    });
    // La de la centralita trae el teléfono en `destination` y la duración en `seconds`.
    const pbx = [{ destination: "930555309", callstart: "2026-10-05 17:10:02", disposition: "busy", seconds: 0 }];
    expect(zadarmaEndedCallFor(pbx, { phone: "+51930555309", dialedAt, offsetMs })?.disposition).toBe("busy");
  });

  it("una llamada anterior al mismo teléfono, u otro teléfono, no cierra la de ahora", () => {
    const old = [{ to: "51930555309", callstart: "2026-10-05 16:40:00", disposition: "no answer" }];
    expect(zadarmaEndedCallFor(old, { phone: "930555309", dialedAt, offsetMs })).toBeNull();
    // Leída sin corregir la zona, esta parecería posterior: la corrección importa.
    expect(zadarmaEndedCallFor(old, { phone: "930555309", dialedAt, offsetMs: 0 })).not.toBeNull();
    const other = [{ to: "51999888777", callstart: "2026-10-05 17:10:04", disposition: "answered" }];
    expect(zadarmaEndedCallFor(other, { phone: "930555309", dialedAt, offsetMs })).toBeNull();
  });

  it("en curso, solo el registro contestado la da por terminada (no el «failed» de 0 s del callback)", () => {
    const stats = [
      { to: "51930555309", callstart: "2026-10-05 17:10:00", disposition: "failed", billseconds: "0" },
      { to: "51930555309", callstart: "2026-10-05 17:10:03", disposition: "answered", billseconds: "95" },
    ];
    const live = { phone: "930555309", dialedAt, offsetMs, answeredOnly: true };
    expect(zadarmaEndedCallFor(stats.slice(0, 1), live)).toBeNull();
    expect(zadarmaEndedCallFor(stats, live)).toMatchObject({ disposition: "answered", seconds: 95 });
    // Marcando, cualquier registro dice que terminó sin llegar al agente.
    expect(zadarmaEndedCallFor(stats, { ...live, answeredOnly: false })?.disposition).toBe("failed");
  });

  it("la causa de Zadarma se dice en el historial", () => {
    expect(zadarmaNoAnswerResumen("busy")).toBe("No contestó: la línea estaba ocupada.");
    expect(zadarmaNoAnswerResumen("failed")).toBe("No contestó: la llamada no se completó (failed).");
  });

  it("GET firmado; si Zadarma falla devuelve null y no se cierra nada", async () => {
    let seen: { url: string; auth: string | null } | null = null;
    const ok = (async (url: string, init: RequestInit) => {
      seen = { url, auth: new Headers(init.headers).get("authorization") };
      return new Response(JSON.stringify({ status: "success", stats: [] }));
    }) as unknown as typeof fetch;
    const creds = { key: "k", secret: "s" };
    expect(await zadarmaGet(creds, "/v1/statistics/", { start: "a", end: "b" }, ok)).toEqual({ status: "success", stats: [] });
    expect(seen!.url).toBe("https://api.zadarma.com/v1/statistics/?end=b&start=a");
    expect(seen!.auth).toMatch(/^k:.+/);
    const bad = (async () => new Response(JSON.stringify({ status: "error" }), { status: 401 })) as unknown as typeof fetch;
    expect(await zadarmaGet(creds, "/v1/statistics/", {}, bad)).toBeNull();
    const down = (async () => {
      throw new Error("red");
    }) as unknown as typeof fetch;
    expect(await zadarmaGet(creds, "/v1/statistics/", {}, down)).toBeNull();
  });

  it("el barrido consulta a Zadarma después del vigilante y antes de ver qué agentes están libres", () => {
    const route = readFileSync(resolve(__dirname, "../app/api/cron/voice-recovery/route.ts"), "utf8");
    const reconcile = route.indexOf("await reconcileZadarmaCalls(admin, now)");
    expect(reconcile).toBeGreaterThan(route.indexOf("await sweepStaleCalls(admin, now)"));
    expect(reconcile).toBeLessThan(route.indexOf("const busyAgents"));
    const server = readFileSync(resolve(__dirname, "../lib/voice-recovery-server.ts"), "utf8");
    expect(server).toContain("if (row.status === \"in_progress\") await closeCutWithoutGestion(admin, row, now);");
  });
});

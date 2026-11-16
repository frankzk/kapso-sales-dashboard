// La reserva por cita se suelta sola (owner, 08-11-2026, opción c; 0322): la
// regla pura de lib/lead-appointment-hold.ts, que la migración y el MOM digan
// lo mismo, y que la 0322 no deshaga lo que la 0312 hizo por el rendimiento.
// El comportamiento en la base, en scripts/sql/lead_appointment_release_smoke.sql.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  APPOINTMENT_HOLD_GRACE_HOURS,
  RETURN_HOLD_MINUTES,
  appointmentHoldState,
  appointmentHolds,
} from "@/lib/lead-appointment-hold";

const H = 3_600_000;
const NOW = Date.parse("2026-11-08T16:00:00.000Z");
const at = (offsetMs: number) => new Date(NOW + offsetMs).toISOString();

describe("appointmentHoldState", () => {
  it("sin hora o sin la llamada que la agendó no hay reserva", () => {
    expect(appointmentHoldState({ followupAt: null, bookedAt: at(-H), lastInboundAt: null }, NOW)).toEqual({ held: false, reason: "sin_cita" });
    expect(appointmentHoldState({ followupAt: at(H), bookedAt: null, lastInboundAt: null }, NOW)).toEqual({ held: false, reason: "sin_cita" });
    expect(appointmentHoldState({ followupAt: "no es fecha", bookedAt: at(-H), lastInboundAt: null }, NOW)).toEqual({ held: false, reason: "sin_cita" });
  });

  it("una cita futura reserva hasta 2 h después de su hora", () => {
    const s = appointmentHoldState({ followupAt: at(H), bookedAt: at(-10 * 60_000), lastInboundAt: null }, NOW);
    expect(s).toEqual({ held: true, releasesAt: at(3 * H), reason: "cita" });
  });

  it("pasada la hora, sigue reservada dentro de las 2 h de gracia", () => {
    expect(appointmentHolds({ followupAt: at(-H), bookedAt: at(-5 * H), lastInboundAt: null }, NOW)).toBe(true);
    expect(appointmentHolds({ followupAt: at(-2 * H + 60_000), bookedAt: at(-5 * H), lastInboundAt: null }, NOW)).toBe(true);
  });

  it("a las 2 h justas de la cita se suelta (el borde es inclusivo, como `<=` en SQL)", () => {
    expect(APPOINTMENT_HOLD_GRACE_HOURS).toBe(2);
    expect(appointmentHoldState({ followupAt: at(-2 * H), bookedAt: at(-5 * H), lastInboundAt: null }, NOW)).toEqual({ held: false, reason: "vencida" });
  });

  it("caso Antu Cruz: cita a las 10:00, a las 16:00 ya está suelta, se haya llamado o no", () => {
    const followupAt = "2026-11-08T15:00:00.000Z"; // 10:00 en Lima
    const bookedAt = "2026-11-07T22:00:00.000Z";
    expect(appointmentHoldState({ followupAt, bookedAt, lastInboundAt: null }, Date.parse("2026-11-08T16:59:59.000Z")).held).toBe(true);
    expect(appointmentHoldState({ followupAt, bookedAt, lastInboundAt: null }, Date.parse("2026-11-08T17:00:00.000Z"))).toEqual({ held: false, reason: "vencida" });
    expect(appointmentHoldState({ followupAt, bookedAt, lastInboundAt: null }, Date.parse("2026-11-08T21:00:00.000Z"))).toEqual({ held: false, reason: "vencida" });
  });

  it("la clienta que escribe después de agendada la cita la suelta pasados sus 10 minutos, aunque la cita sea futura", () => {
    expect(appointmentHoldState({ followupAt: at(5 * H), bookedAt: at(-20 * 60_000), lastInboundAt: at(-10 * 60_000) }, NOW)).toEqual({ held: false, reason: "volvio_sola" });
  });

  it("0351: el mensaje de la clienta devuelve el lead a quien agendó 10 minutos desde el mensaje", () => {
    expect(RETURN_HOLD_MINUTES).toBe(10);
    expect(appointmentHoldState({ followupAt: at(5 * H), bookedAt: at(-10 * 60_000), lastInboundAt: at(-60_000) }, NOW))
      .toEqual({ held: true, releasesAt: at(9 * 60_000), reason: "respondio" });
    // El borde: a los 10 minutos justos ya no reserva (como `>now()-10 min` en SQL).
    expect(appointmentHolds({ followupAt: at(5 * H), bookedAt: at(-H), lastInboundAt: at(-10 * 60_000) }, NOW)).toBe(false);
    expect(appointmentHolds({ followupAt: at(5 * H), bookedAt: at(-H), lastInboundAt: at(-10 * 60_000 + 1000) }, NOW)).toBe(true);
  });

  it("0351, caso del 16-11-2026: cita a las 10:00 vencida, la clienta escribe a las 15:01", () => {
    const followupAt = "2026-11-16T15:00:00.000Z"; // 10:00 en Lima
    const bookedAt = "2026-11-16T02:26:38.000Z";
    const lastInboundAt = "2026-11-16T20:01:30.000Z"; // 15:01:30 en Lima
    // 15:03: otra asesora ya no puede tomarlo; es de quien agendó hasta las 15:11:30.
    expect(appointmentHoldState({ followupAt, bookedAt, lastInboundAt }, Date.parse("2026-11-16T20:03:00.000Z")))
      .toEqual({ held: true, releasesAt: "2026-11-16T20:11:30.000Z", reason: "respondio" });
    expect(appointmentHoldState({ followupAt, bookedAt, lastInboundAt }, Date.parse("2026-11-16T20:11:30.000Z")))
      .toEqual({ held: false, reason: "vencida" });
  });

  it("un mensaje anterior a la cita, del mismo instante o con fecha futura no la suelta", () => {
    expect(appointmentHolds({ followupAt: at(5 * H), bookedAt: at(-10 * 60_000), lastInboundAt: at(-H) }, NOW)).toBe(true);
    expect(appointmentHolds({ followupAt: at(5 * H), bookedAt: at(-10 * 60_000), lastInboundAt: at(-10 * 60_000) }, NOW)).toBe(true);
    expect(appointmentHolds({ followupAt: at(5 * H), bookedAt: at(-10 * 60_000), lastInboundAt: at(H) }, NOW)).toBe(true);
  });

  it("vencida gana al motivo de la clienta cuando valen los dos, pasados los 10 minutos del mensaje", () => {
    expect(appointmentHoldState({ followupAt: at(-3 * H), bookedAt: at(-10 * H), lastInboundAt: at(-11 * 60_000) }, NOW)).toEqual({ held: false, reason: "vencida" });
  });
});

const read = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8");
const flat = (text: string) => text.replace(/\s+/g, " ");

describe("0322: la migración dice lo mismo que la regla pura", () => {
  const SQL = read("db/migrations/0322_lead_appointment_release.sql");
  const BODY = flat(SQL.slice(SQL.indexOf("$$"), SQL.lastIndexOf("$$")));

  it("2 horas desde la cita o un entrante posterior a la llamada que la agendó", () => {
    expect(BODY).toContain(`b.next_followup_at<=now()-interval '${APPOINTMENT_HOLD_GRACE_HOURS} hours'`);
    expect(BODY).toContain("b.last_inbound_at<=now() and b.last_inbound_at>c.appointment_booked_at");
    expect(BODY).toContain("max(x.occurred_at) filter(where x.appointment) as appointment_booked_at");
    expect(BODY).toContain("when appointment_owner is not null and not appointment_released then appointment_owner=p_actor");
  });

  it("handoff_at no suelta la reserva (también lo escribe el agente de voz)", () => {
    const release = BODY.slice(BODY.indexOf("as appointment_owner,"), BODY.indexOf("as appointment_released"));
    expect(release).not.toContain("handoff_at");
  });

  it("conserva lo que la 0312 hizo por el rendimiento", () => {
    // Las dos ramas excluyentes de `base` (cola por índice, lead suelto por clave).
    expect(BODY).toContain("where p_lead is null and sc.enabled and sc.advisor and l.store_id=sc.id and l.category in ('open','hot') union all");
    expect(BODY).toContain("where l.id=p_lead and l.store_id=sc.id");
    // Las llamadas que lee `calls` son las del índice parcial lead_calls_call_lead_idx.
    expect(BODY).toContain("c.kind='call' and c.vendedora is not null and c.occurred_at<=now() offset 0");
    // Sin un OR sobre p_lead ni lecturas nuevas de tablas.
    expect(BODY).not.toMatch(/p_lead is null or/);
    expect(BODY).not.toMatch(/\b(anura_calls|voice_calls|conversations|whatsapp_outbox)\b/);
    // Mismos permisos y contrato.
    expect(SQL).toContain("returns jsonb language sql stable security invoker set search_path=public,pg_temp");
    expect(SQL).toContain("revoke all on function public.lead_routing_scope(uuid,uuid[],uuid) from public,anon,authenticated;");
    expect(SQL).toContain("grant execute on function public.lead_routing_scope(uuid,uuid[],uuid) to service_role;");
  });

  it("no cambia datos ni la cita", () => {
    expect(SQL).not.toMatch(/^\s*(update|delete|insert|truncate|alter table)\b/im);
  });
});

describe("MOM: la reserva por cita se suelta", () => {
  const MOM = flat(read("docs/mom/master-pedidos-v1.md"));
  it("documenta los dos casos, que la cita queda como historial y la 0322", () => {
    expect(MOM).toContain("La reserva por cita se suelta sola (08-11-2026, decisión del owner, opción c; 0322)");
    expect(MOM).toContain("**2 horas** después de la hora de la cita");
    expect(MOM).toContain("escribió por WhatsApp **después** de que se agendó la cita");
    expect(MOM).toContain("La cita no se borra");
  });
});

describe("0351: el mensaje de la clienta devuelve el lead 10 minutos a quien agendó", () => {
  const SQL = read("db/migrations/0351_lead_appointment_return_hold.sql");
  const BODY = flat(SQL);

  it("el reparto y «Tomar» manual usan la misma ventana de 10 minutos", () => {
    expect(BODY).toContain(`and not coalesce(b.last_inbound_at<=now() and b.last_inbound_at>c.appointment_booked_at and b.last_inbound_at>now()-interval '${RETURN_HOLD_MINUTES} minutes',false)`);
    expect(BODY).toContain(`coalesce(l.last_inbound_at<=now() and l.last_inbound_at>appointment.occurred_at and l.last_inbound_at>now()-interval '${RETURN_HOLD_MINUTES} minutes',false)`);
    // Fuera de la ventana, la 0322 tal cual.
    expect(BODY).toContain(`b.next_followup_at<=now()-interval '${APPOINTMENT_HOLD_GRACE_HOURS} hours'`);
    expect(BODY).toContain("when appointment_owner is not null and not appointment_released then appointment_owner=p_actor");
  });

  it("conserva el cuerpo de la 0322 fuera de la condición y sus permisos", () => {
    const old = flat(read("db/migrations/0322_lead_appointment_release.sql"));
    const cut = (text: string) => text.slice(text.indexOf("create or replace function public.lead_routing_scope"), text.indexOf("), classified as materialized"));
    expect(cut(BODY)).toBe(cut(old));
    expect(SQL).toContain("grant execute on function public.lead_routing_scope(uuid,uuid[],uuid) to service_role;");
    expect(SQL).toContain("grant execute on function public.lead_manual_take_check(uuid,uuid) to service_role;");
    expect(SQL).not.toMatch(/^\s*(update|delete|insert|truncate|alter table)\b/im);
  });

  it("el MOM lo documenta", () => {
    const MOM = flat(read("docs/mom/master-pedidos-v1.md"));
    expect(MOM).toContain("La clienta que responde vuelve 10 minutos a quien agendó (16-11-2026, decisión del owner; 0351)");
  });
});

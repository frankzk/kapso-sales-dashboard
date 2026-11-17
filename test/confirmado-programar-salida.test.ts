// «Confirmado · programar salida» (MOM §6.2, owner 17-11-2026).
//
// #AUR900908 (Aurela, Juliaca) se confirmó el 15-11 con «Sale el» vacío: quedó
// en Preparación · Por generar rótulo sin guía ni fecha, y el automático no lo
// tomaba porque solo crea la guía en un día programado. Lo programó otra
// persona al día siguiente. #KP205536 llevaba cinco días así. Y en 30 días,
// 1.140 de 2.654 guías Aliclik de Provincia COD se crearon sin «Confirmó»
// antes: confirmar de verdad ya era crear la guía. Lo que se fija aquí:
//   - en Provincia COD confirmar ES programar: día desde mañana y GPS;
//   - lo que sale hoy se confirma creando la guía Aliclik (o con el adelanto),
//     una vez, con quien lo hizo; el automático no confirma por nadie;
//   - Swayp desde Por confirmar NO confirma (§11.11);
//   - si la guía no sale, el panel lleva a programar;
//   - Lima y Agencia no cambian.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

type Row = Record<string, any>;

const st = vi.hoisted(() => ({
  row: null as Row | null,
  inserts: [] as { table: string; value: any }[],
  rpcs: [] as { fn: string; args: any }[],
}));

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({
  redirect: (path: string) => {
    throw new Error(`redirect:${path}`);
  },
}));
vi.mock("@/lib/order-master", () => ({
  recomputeOrderMasterSafe: vi.fn(async () => {}),
  applyConfirmationCycleToStore: vi.fn(async () => {}),
}));
vi.mock("@/lib/permissions-access", () => ({
  getMasterPermissions: async () => ({ can: () => true, readOnly: false }),
  hasOrgPermission: async () => true,
}));
vi.mock("@/lib/db", () => {
  const from = (table: string) => {
    let insert: any = null;
    const q: any = {
      select: () => q,
      eq: () => q,
      in: () => q,
      order: () => q,
      limit: () => q,
      maybeSingle: () => q,
      single: () => q,
      insert: (value: any) => {
        insert = value;
        return q;
      },
      upsert: (value: any) => {
        insert = { upsert: true, ...value };
        return q;
      },
      then: (ok: any, ko: any) => {
        if (insert) {
          st.inserts.push({ table, value: insert });
          return Promise.resolve({ data: null, error: null }).then(ok, ko);
        }
        return Promise.resolve({ data: table === "order_master" ? st.row : null, error: null }).then(ok, ko);
      },
    };
    return q;
  };
  const client = {
    from,
    rpc: async (fn: string, args: any) => {
      st.rpcs.push({ fn, args });
      return { data: { duplicate: false, day_count: 1 }, error: null };
    },
    auth: { getUser: async () => ({ data: { user: { id: "u-1" } }, error: null }) },
  };
  return { createServerSupabase: async () => client, createAdminSupabase: () => client };
});

import { registerConfirmationAttempt } from "@/app/dashboard/pedidos/actions";
import {
  IMPLICIT_CONFIRMATION_NOTE,
  PROGRAM_CONFIRM_LABEL,
  SALE_HOY_HINT,
  confirmationProgramsDispatch,
  confirmationResultsFor,
  firstProgrammableDay,
  implicitConfirmationEvent,
  programmedConfirmationError,
  scheduleInsteadSection,
  withSection,
  writesImplicitConfirmation,
} from "@/lib/confirmation-dispatch";
import { DISPATCH_NEEDS_COORDINATE_ERROR } from "@/lib/dispatch-date";
import { CONFIRMATION_RESULTS } from "@/lib/order-confirmation";
import { limaTodayKey } from "@/lib/shipments";

const read = (...p: string[]) => readFileSync(join(process.cwd(), ...p), "utf8");
const ORDER = "order-900908";

function addDays(day: string, n: number): string {
  const d = new Date(`${day}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** #AUR900908 como llegó: Provincia COD, Juliaca, sin coordenada. */
const PROVINCIA: Row = {
  order_id: ORDER,
  store_id: "store-aurela",
  coverage: "provincia_cod",
  region: "Puno",
  province: "San Roman",
  district: "Juliaca",
  address: "Entrada taza, cerca al colegio",
  macro_stage: "por_confirmar",
  macro_substage: "sin_llamar",
  macro_operation: "provincia_cod",
  payment_state: null,
  latitude: null,
  longitude: null,
};
const CON_GPS: Row = { ...PROVINCIA, latitude: -15.4968, longitude: -70.1331 };
const LIMA: Row = { ...CON_GPS, coverage: "lima", macro_operation: "lima", region: "Lima", province: "Lima", district: "Surco" };

const dispatchEvents = () => st.inserts.filter((i) => i.table === "order_events" && i.value.kind === "dispatch_date_set");
const confirmar = (dispatchOn: string, coordinate?: string) =>
  registerConfirmationAttempt(ORDER, { result: "confirmado", channel: "llamada", dispatchOn, coordinate });

beforeEach(() => {
  st.row = null;
  st.inserts = [];
  st.rpcs = [];
});

describe("la regla, pura", () => {
  const today = "2026-11-17";

  it("solo Provincia COD programa al confirmar", () => {
    expect(confirmationProgramsDispatch("provincia_cod")).toBe(true);
    for (const op of ["lima", "agencia", "desconocida", null, undefined]) {
      expect(confirmationProgramsDispatch(op), String(op)).toBe(false);
    }
  });

  it("en Provincia COD «Confirmó el pedido» se llama «Confirmado · programar salida»; el código no cambia", () => {
    const provincia = confirmationResultsFor(CONFIRMATION_RESULTS, "provincia_cod");
    const confirma = provincia.find((r) => r.confirms)!;
    expect(confirma.code).toBe("confirmado");
    expect(confirma.label).toBe(PROGRAM_CONFIRM_LABEL);
    expect(PROGRAM_CONFIRM_LABEL).toBe("Confirmado · programar salida");
    expect(provincia.filter((r) => !r.confirms)).toEqual(CONFIRMATION_RESULTS.filter((r) => !r.confirms));
    expect(confirmationResultsFor(CONFIRMATION_RESULTS, "lima").find((r) => r.confirms)!.label).toBe("Confirmó el pedido");
    expect(confirmationResultsFor(CONFIRMATION_RESULTS, "agencia")).toEqual([...CONFIRMATION_RESULTS]);
  });

  it("la fecha es obligatoria y desde mañana; hoy no se confirma aquí", () => {
    const base = { todayLima: today, coordinateMissing: false, coordinate: "" };
    expect(firstProgrammableDay(today)).toBe("2026-11-18");
    expect(firstProgrammableDay("2026-12-31")).toBe("2027-01-01");
    expect(programmedConfirmationError({ ...base, dispatchOn: "" })).toMatch(/^Elige el día de salida/);
    expect(programmedConfirmationError({ ...base, dispatchOn: null })).toContain(SALE_HOY_HINT);
    expect(programmedConfirmationError({ ...base, dispatchOn: today })).toBe(`El día de salida es desde mañana. ${SALE_HOY_HINT}`);
    expect(programmedConfirmationError({ ...base, dispatchOn: "2026-11-10" })).toContain("desde mañana");
    expect(programmedConfirmationError({ ...base, dispatchOn: "17/11/2026" })).toBe("Día de salida: elige una fecha válida.");
    expect(programmedConfirmationError({ ...base, dispatchOn: "2027-03-01" })).toMatch(/45 días/);
    expect(programmedConfirmationError({ ...base, dispatchOn: "2026-11-18" })).toBeNull();
  });

  it("y el GPS también, si el pedido no lo tiene", () => {
    const base = { todayLima: today, dispatchOn: "2026-11-19" };
    expect(programmedConfirmationError({ ...base, coordinateMissing: true, coordinate: "  " })).toBe(DISPATCH_NEEDS_COORDINATE_ERROR);
    expect(programmedConfirmationError({ ...base, coordinateMissing: true, coordinate: "-15.49, -70.13" })).toBeNull();
    expect(programmedConfirmationError({ ...base, coordinateMissing: false, coordinate: "" })).toBeNull();
  });

  it("la confirmación implícita: una persona, Provincia COD, una vez", () => {
    const base = { operation: "provincia_cod", actor: "u-1", automatic: false, alreadyConfirmed: false };
    expect(writesImplicitConfirmation(base)).toBe(true);
    expect(writesImplicitConfirmation({ ...base, automatic: true })).toBe(false);
    expect(writesImplicitConfirmation({ ...base, actor: null })).toBe(false);
    expect(writesImplicitConfirmation({ ...base, alreadyConfirmed: true })).toBe(false);
    expect(writesImplicitConfirmation({ ...base, operation: "lima" })).toBe(false);
    expect(writesImplicitConfirmation({ ...base, operation: "agencia" })).toBe(false);
  });

  it("el hecho: `confirmed` con quien lo hizo, sin canal inventado", () => {
    const event = implicitConfirmationEvent({
      storeId: "s",
      orderId: "o",
      actor: "u-1",
      via: "guia_aliclik",
      occurredAt: "2026-11-17T15:00:00.000Z",
      courier: "aliclik",
      guideCode: "AUR5X1",
    });
    expect(event).toMatchObject({
      kind: "confirmed",
      actor: "u-1",
      source: "manual",
      courier: "aliclik",
      guide_code: "AUR5X1",
      payload: { channel: null, via: "guia_aliclik" },
    });
    expect(event.note).toBe(IMPLICIT_CONFIRMATION_NOTE.guia_aliclik);
    const adelanto = implicitConfirmationEvent({ storeId: "s", orderId: "o", actor: "u-1", via: "adelanto", occurredAt: "x" });
    expect(adelanto).not.toHaveProperty("courier");
    expect(adelanto.note).toBe("Confirmado al registrar el adelanto.");
  });

  it("si la guía no sale, «Programar salida» lleva a donde se programa", () => {
    expect(scheduleInsteadSection({ macro_stage: "por_confirmar" }, "provincia_cod")).toBe("confirmacion");
    expect(scheduleInsteadSection({ macro_stage: "en_curso", macro_substage: "gestion_reproprovincia" }, "provincia_cod")).toBe("confirmacion");
    expect(scheduleInsteadSection({ macro_stage: "preparacion", macro_substage: "por_generar_rotulo" }, "provincia_cod")).toBe("resumen");
    expect(scheduleInsteadSection({ macro_stage: "preparacion", macro_substage: "por_armar" }, "provincia_cod")).toBeNull();
    expect(scheduleInsteadSection({ macro_stage: "por_confirmar" }, "lima")).toBeNull();
    const go = vi.fn();
    withSection("resumen", go)!();
    expect(go).toHaveBeenCalledWith("resumen");
    expect(withSection(null, go)).toBeUndefined();
  });
});

describe("el servidor: registrar el intento", () => {
  it("#AUR900908: confirmar un Provincia COD sin fecha se rechaza antes de registrar nada", async () => {
    st.row = CON_GPS;
    const res = await confirmar("");
    expect(res.error).toMatch(/^Elige el día de salida/);
    expect(st.rpcs).toHaveLength(0);
    expect(dispatchEvents()).toHaveLength(0);
  });

  it("con fecha de hoy tampoco: lo de hoy se confirma creando la guía", async () => {
    st.row = CON_GPS;
    const res = await confirmar(limaTodayKey());
    expect(res.error).toContain(SALE_HOY_HINT);
    expect(st.rpcs).toHaveLength(0);
  });

  it("sin GPS se pide; con él se guarda, se confirma y se programa", async () => {
    st.row = PROVINCIA;
    const date = addDays(limaTodayKey(), 2);
    const sinGps = await confirmar(date);
    expect(sinGps.error).toBe(DISPATCH_NEEDS_COORDINATE_ERROR);
    expect(st.rpcs).toHaveLength(0);

    const res = await confirmar(date, "-15.4968, -70.1331");
    expect(res.error).toBeUndefined();
    expect(st.inserts.filter((i) => i.table === "order_geo_overrides")).toHaveLength(1);
    expect(st.rpcs.map((r) => r.fn)).toEqual(["register_confirmation_attempt_v1"]);
    expect(dispatchEvents()).toHaveLength(1);
    expect(dispatchEvents()[0]!.value.payload).toEqual({ date, at_confirmation: true });
  });

  it("los demás resultados no piden fecha", async () => {
    st.row = PROVINCIA;
    const res = await registerConfirmationAttempt(ORDER, { result: "sin_respuesta", channel: "llamada" });
    expect(res.error).toBeUndefined();
    expect(st.rpcs).toHaveLength(1);
  });

  it("Lima no cambia: confirma sin fecha", async () => {
    st.row = LIMA;
    const res = await confirmar("");
    expect(res.error).toBeUndefined();
    expect(st.rpcs).toHaveLength(1);
    expect(dispatchEvents()).toHaveLength(0);
  });
});

describe("la regla vive donde se decide", () => {
  it("la acción la aplica antes de la lista de prepago y de registrar el intento", () => {
    const src = read("app/dashboard/pedidos/actions.ts");
    const gate = src.indexOf("const programs = result.confirms && confirmationProgramsDispatch(classifyOperation(ctx.row));");
    const prepay = src.indexOf("// LA LISTA DE PAGO ADELANTADO (MOM §41).");
    const rpc = src.indexOf('admin.rpc("register_confirmation_attempt_v1"');
    expect(gate).toBeGreaterThan(0);
    expect(prepay).toBeGreaterThan(gate);
    expect(rpc).toBeGreaterThan(prepay);
  });

  it("la ficha: «Sale el» obligatorio desde mañana, y el GPS antes de la fecha", () => {
    const drawer = read("components/order-drawer.tsx");
    expect(drawer).toContain("const results = confirmationResultsFor(CONFIRMATION_RESULTS, operation);");
    expect(drawer).toContain('{programs ? "Sale el" : "Sale el (opcional)"}');
    expect(drawer).toContain("min={firstDay}");
    expect(drawer).toContain("(schedules || programs) && coordinateMissing && (");
    expect(drawer).toContain("programIncomplete;");
  });

  it("crear la guía Aliclik a mano confirma; el automático no", () => {
    const src = read("lib/aliclik-guide.ts");
    expect(src).toContain("automatic: Boolean(origin),");
    expect(src).toContain('via: "guia_aliclik",');
    expect(src).toContain('.eq("kind", "confirmed")');
    expect(src).toContain('(confirmsHere ? " El pedido queda confirmado." : "")');
  });

  it("el adelanto o el pago total confirman, salvo lo que va a revisión", () => {
    const src = read("app/dashboard/pedidos/payment-actions.ts");
    expect(src).toContain('if ((input.kind === "adelanto" || input.kind === "total") && status !== "revision_admin") {');
    expect(src).toContain('via: input.kind === "total" ? "pago_total" : "adelanto",');
  });

  it("Swayp desde Por confirmar sigue sin confirmar (§11.11)", () => {
    expect(read("lib/swayp-directa.ts")).not.toContain("implicitConfirmationEvent");
  });

  it("si la guía no sale, el panel ofrece «Programar salida»", () => {
    const panel = read("components/aliclik-guide-panel.tsx");
    expect(panel).toContain("<ScheduleInsteadLine onScheduleInstead={onScheduleInstead} />");
    expect(panel).toContain("Programar salida");
    expect(read("components/order-drawer.tsx")).toContain(
      "scheduleInsteadSection(detail.row, classifyOperation(detail.row)),",
    );
  });

  it("y el MOM lo dice", () => {
    const mom = read("docs/mom/master-pedidos-v1.md").replace(/\s+/g, " ");
    expect(mom).toContain("#### Confirmado · programar salida (owner, 17-11-2026)");
    expect(mom).toContain("1.140 de 2.654");
    expect(mom).toContain("Swayp desde Por confirmar **no** confirma");
  });
});

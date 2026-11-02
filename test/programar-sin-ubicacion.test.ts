// «Programar sin ubicación» (MOM §6.2, owner 30-10-2026).
//
// #KP142558 (Kenku) llegó sin dirección ni cliente: cobertura «Por revisar»,
// región y distrito vacíos. El 22-10 una asesora lo confirmó y programó el
// envío para el 27-10 desde la confirmación; nunca pudo salir (sin courier,
// «Por generar rótulo») y nadie se enteró. Lo que se fija aquí:
//   - programar (en la ficha o al confirmar con «Sale el») se rechaza sin
//     ubicación, con el mensaje claro, y no escribe nada;
//   - confirmar sin ubicación SÍ se permite, sin fecha;
//   - con ubicación todo sigue igual (la programación y su guía automática);
//   - el Master lo alerta: chapa en la fila, píldora con su conteo, filtro
//     `su=1` en la base (también para el Excel) y la ficha abre en Ubicación.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createClient } from "@supabase/supabase-js";
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

import { registerConfirmationAttempt, scheduleOrderDispatch } from "@/app/dashboard/pedidos/actions";
import {
  DISPATCH_NEEDS_COORDINATE_ERROR,
  DISPATCH_NEEDS_LOCATION_ERROR,
  SCHEDULED_NO_LOCATION_LABEL,
  dispatchLocationMissing,
  scheduledWithoutLocation,
  withScheduledNoLocation,
} from "@/lib/dispatch-date";
import { limaTodayKey } from "@/lib/shipments";
import { applyScheduledNoLocation, applyServerFilters } from "@/lib/orders-master-access";
import { emptyFilters, hasActiveFilters, matchesFilters, type MasterFilters } from "@/lib/order-master-filters";
import { buildMasterQuery, parseMasterQuery } from "@/lib/master-query";
import type { OrderMasterRow } from "@/lib/types";

const ORDER = "order-142558";

/** #KP142558 tal como estaba: sin región, distrito ni dirección. */
const SIN_UBICACION: Row = {
  order_id: ORDER,
  store_id: "store-kenku",
  coverage: "por_revisar",
  region: null,
  province: null,
  district: null,
  address: null,
  macro_stage: "preparacion",
  macro_substage: "por_generar_rotulo",
  macro_operation: "provincia_cod",
  payment_state: null,
  dispatch_scheduled_on: null,
};

const CON_UBICACION: Row = {
  ...SIN_UBICACION,
  coverage: "provincia_cod",
  region: "Piura",
  province: "Sullana",
  district: "Sullana",
  address: "Av. Grau 123",
  // Provincia COD programado necesita la coordenada de Aliclik (02-11-2026).
  latitude: -4.9039,
  longitude: -80.6853,
};

/** #AUR900167: Provincia COD con dirección pero sin coordenada. */
const SIN_COORDENADA: Row = { ...CON_UBICACION, latitude: null, longitude: null };

function addDays(day: string, n: number): string {
  const d = new Date(`${day}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

const dispatchEvents = () => st.inserts.filter((i) => i.table === "order_events" && i.value.kind === "dispatch_date_set");

beforeEach(() => {
  st.row = null;
  st.inserts = [];
  st.rpcs = [];
});

describe("la regla: falta la ubicación", () => {
  it("«Por revisar» sin región, distrito o dirección no se programa", () => {
    expect(dispatchLocationMissing(SIN_UBICACION)).toBe(true);
    expect(dispatchLocationMissing({ ...CON_UBICACION, coverage: "por_revisar", district: null })).toBe(true);
    expect(dispatchLocationMissing({ ...CON_UBICACION, coverage: "por_revisar", address: "  " })).toBe(true);
    // Cobertura sin calcular cuenta como «Por revisar», igual que en §37.8.
    expect(dispatchLocationMissing({ ...SIN_UBICACION, coverage: null })).toBe(true);
  });

  it("con su ubicación, o con una cobertura decidida, se programa como siempre", () => {
    expect(dispatchLocationMissing(CON_UBICACION)).toBe(false);
    expect(dispatchLocationMissing({ ...CON_UBICACION, coverage: "por_revisar" })).toBe(false);
    expect(dispatchLocationMissing({ ...SIN_UBICACION, coverage: "agencia" })).toBe(false);
  });

  it("la alerta pide además la fecha programada (hoy, vencida o futura)", () => {
    expect(scheduledWithoutLocation({ ...SIN_UBICACION, dispatch_scheduled_on: "2026-10-27" })).toBe(true);
    expect(scheduledWithoutLocation({ ...SIN_UBICACION, dispatch_scheduled_on: "2026-11-30" })).toBe(true);
    expect(scheduledWithoutLocation(SIN_UBICACION)).toBe(false);
    expect(scheduledWithoutLocation({ ...CON_UBICACION, dispatch_scheduled_on: "2026-10-27" })).toBe(false);
  });
});

describe("«Programar envío» en la ficha", () => {
  it("sin ubicación lo rechaza con el mensaje claro y no escribe nada", async () => {
    st.row = SIN_UBICACION;
    const res = await scheduleOrderDispatch(ORDER, { date: limaTodayKey() });
    expect(res.error).toBe(DISPATCH_NEEDS_LOCATION_ERROR);
    expect(res.error).toBe("Falta la ubicación: corrígela antes de programar el envío.");
    expect(dispatchEvents()).toHaveLength(0);
  });

  it("con ubicación programa como siempre", async () => {
    st.row = CON_UBICACION;
    const date = addDays(limaTodayKey(), 3);
    const res = await scheduleOrderDispatch(ORDER, { date });
    expect(res.error).toBeUndefined();
    expect(dispatchEvents()).toHaveLength(1);
    expect(dispatchEvents()[0]!.value.payload).toEqual({ date });
  });
});

describe("«Sale el» al confirmar", () => {
  const confirmar = (dispatchOn: string) =>
    registerConfirmationAttempt(ORDER, { result: "confirmado", channel: "llamada", dispatchOn });

  it("confirmar sin ubicación SÍ se permite, sin fecha", async () => {
    st.row = { ...SIN_UBICACION, macro_stage: "por_confirmar", macro_substage: "sin_llamar" };
    const res = await confirmar("");
    expect(res.error).toBeUndefined();
    expect(st.rpcs.map((r) => r.fn)).toContain("register_confirmation_attempt_v1");
    expect(dispatchEvents()).toHaveLength(0);
  });

  it("confirmar CON fecha y sin ubicación se rechaza antes de registrar nada", async () => {
    st.row = { ...SIN_UBICACION, macro_stage: "por_confirmar", macro_substage: "sin_llamar" };
    const res = await confirmar(addDays(limaTodayKey(), 5));
    expect(res.error).toContain(DISPATCH_NEEDS_LOCATION_ERROR);
    expect(st.rpcs).toHaveLength(0);
    expect(dispatchEvents()).toHaveLength(0);
  });

  it("con ubicación, confirmar y programar sigue igual", async () => {
    st.row = { ...CON_UBICACION, macro_stage: "por_confirmar", macro_substage: "sin_llamar" };
    const date = addDays(limaTodayKey(), 5);
    const res = await confirmar(date);
    expect(res.error).toBeUndefined();
    expect(dispatchEvents()).toHaveLength(1);
    expect(dispatchEvents()[0]!.value.payload).toEqual({ date, at_confirmation: true });
  });
});

describe("la alerta del Master", () => {
  it("viaja por la URL como su=1 y cuenta como filtro activo", () => {
    expect(parseMasterQuery(new URLSearchParams("su=1")).filters.scheduledNoLocation).toBe(true);
    const f: MasterFilters = { ...emptyFilters(), scheduledNoLocation: true };
    expect(hasActiveFilters(f)).toBe(true);
    expect(buildMasterQuery({ filters: f, sortKey: "created", page: 1 }).toString()).toBe("su=1");
  });

  const sb = createClient("http://local", "anon");
  const url = (f: MasterFilters) =>
    (applyServerFilters(sb.from("order_master").select("id"), f, new Date()) as unknown as { url: URL }).url;

  it("se filtra en la base por columnas del Master (página, conteos y Excel)", () => {
    const params = url({ ...emptyFilters(), scheduledNoLocation: true }).searchParams;
    expect(params.get("dispatch_scheduled_on")).toBe("not.is.null");
    expect(params.getAll("or")).toEqual([
      "(coverage.is.null,coverage.eq.por_revisar)",
      "(region.is.null,district.is.null,address.is.null)",
    ]);
    expect(url(emptyFilters()).searchParams.get("dispatch_scheduled_on")).toBeNull();
    const direct = (applyScheduledNoLocation(sb.from("order_master").select("order_id")) as unknown as { url: URL }).url;
    expect(direct.searchParams.getAll("or")).toHaveLength(2);
  });

  it("marca las filas con los ids leídos; sin lectura no afirma nada", () => {
    const [con, sin] = withScheduledNoLocation([{ order_id: ORDER }, { order_id: "otro" }], new Set([ORDER]));
    expect(con!.scheduled_no_location).toBe(true);
    expect(sin!.scheduled_no_location).toBe(false);
    expect(withScheduledNoLocation([{ order_id: ORDER }], null)[0]).not.toHaveProperty("scheduled_no_location");
    const f: MasterFilters = { ...emptyFilters(), scheduledNoLocation: true };
    expect(matchesFilters({ ...SIN_UBICACION, scheduled_no_location: true } as unknown as OrderMasterRow, f)).toBe(true);
    expect(matchesFilters({ ...CON_UBICACION, scheduled_no_location: false } as unknown as OrderMasterRow, f)).toBe(false);
  });

  it("la página lo lee una vez, a la par; la fila lleva la chapa y abre en Ubicación", () => {
    const page = readFileSync(join(process.cwd(), "app/dashboard/pedidos/page.tsx"), "utf8");
    expect(page).toContain("getScheduledNoLocationIds(storeIds)");
    expect(page).toContain("scheduledNoLocationPromise,\n  ]);");
    expect(page).toContain("scheduledNoLocationCount=");
    const board = readFileSync(join(process.cwd(), "components/orders-master.tsx"), "utf8");
    expect(board).toContain("label={SCHEDULED_NO_LOCATION_LABEL}");
    expect(board).toContain("r.scheduled_no_location");
    expect(board).toMatch(/r\.scheduled_no_location\s*\?\s*"ubicacion"/);
    expect(SCHEDULED_NO_LOCATION_LABEL).toBe("Programado sin ubicación");
  });

  it("la ficha no deja programar sin ubicación y ofrece «Corregir ubicación»", () => {
    const drawer = readFileSync(join(process.cwd(), "components/order-drawer.tsx"), "utf8");
    expect(drawer).toContain("locationMissing={dispatchLocationMissing(detail.row)}");
    expect(drawer).toContain('onFixLocation={() => jumpTo("ubicacion")}');
    expect(drawer).toContain("disabled={locationMissing}");
    const panel = readFileSync(join(process.cwd(), "components/dispatch-date-panel.tsx"), "utf8");
    expect(panel).toContain("Corregir ubicación");
  });
});

describe("Provincia COD sin coordenada (#AUR900167, 02-11-2026)", () => {
  const geo = () => st.inserts.filter((i) => i.table === "order_geo_overrides");

  it("«Programar envío» sin la ubicación se rechaza y no escribe nada", async () => {
    st.row = SIN_COORDENADA;
    const res = await scheduleOrderDispatch(ORDER, { date: addDays(limaTodayKey(), 2) });
    expect(res.error).toBe(DISPATCH_NEEDS_COORDINATE_ERROR);
    expect(dispatchEvents()).toHaveLength(0);
    expect(geo()).toHaveLength(0);
  });

  it("con el enlace de Maps la guarda en el pedido y programa", async () => {
    st.row = SIN_COORDENADA;
    const date = addDays(limaTodayKey(), 2);
    const res = await scheduleOrderDispatch(ORDER, {
      date,
      coordinate: "https://www.google.com/maps/place/X/@-4.9,-80.6,17z/data=!3d-4.90391!4d-80.68534",
    });
    expect(res.error).toBeUndefined();
    expect(geo()).toHaveLength(1);
    expect(geo()[0]!.value).toMatchObject({ order_id: ORDER, latitude: -4.90391, longitude: -80.68534 });
    expect(dispatchEvents()).toHaveLength(1);
  });

  it("«Sale el» al confirmar sin ubicación se rechaza antes de registrar el intento; sin fecha confirma igual", async () => {
    st.row = { ...SIN_COORDENADA, macro_stage: "por_confirmar", macro_substage: "sin_llamar" };
    const res = await registerConfirmationAttempt(ORDER, {
      result: "confirmado",
      channel: "llamada",
      dispatchOn: addDays(limaTodayKey(), 2),
      coordinate: "https://maps.app.goo.gl/abc",
    });
    expect(res.error).toMatch(/acortado/);
    expect(res.error).toContain("Puedes confirmar dejando «Sale el» vacío.");
    expect(st.rpcs).toHaveLength(0);
    const sinFecha = await registerConfirmationAttempt(ORDER, { result: "confirmado", channel: "llamada", dispatchOn: "" });
    expect(sinFecha.error).toBeUndefined();
    expect(geo()).toHaveLength(0);
  });
});

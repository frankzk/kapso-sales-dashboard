import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  OLVA_PICKUP_WINDOW_DAYS,
  formatOlvaTracking,
  olvaBranchFromObs,
  olvaDateToIso,
  olvaNeedsTracking,
  olvaPickupDeadline,
  olvaTrackingChanged,
  parseOlvaTracking,
  readOlvaTracking,
  type OlvaTrackingPayload,
} from "@/lib/olva/tracking";
import { fetchOlvaTracking, isOlvaTrackingPayload, OlvaApiError, trackingUrl } from "@/lib/olva/client";

// Las dos respuestas REALES de `getTrackingInformation?details=1` capturadas
// el 20-09-2026 desde la página de Olva: un envío en camino (Lima → Jaén) y uno
// entregado a domicilio (Lima → Nuevo Progreso). Son la única especificación
// que existe del servicio —Olva no documenta nada—, así que se guardan enteras.

const EN_CAMINO: OlvaTrackingPayload = {
  success: true,
  msg: "resultados obtenidos",
  data: {
    general: {
      fecha_envio: "19/09/2026",
      fecha_emision_fresh: "2026-09-19",
      emision: "26",
      remito: "2552504",
      consignado: "CARLOS MERLIN DIAZ JULON",
      nombre_estado_tracking: "DESPACHADO",
      nombre_estado: "CONTADO FACTURADO",
      nombre_oficina: "OLVA PUEBLO LIBRE - AV. SIMON BOLIVAR 1427",
      origen: "LIMA",
      destino: "JAEN",
      flg_devolucion: null,
    },
    details: [
      { fecha_creacion: "2026-09-19", id_rpt_envio_ruta: "516081494", nombre_sede: "LIMA", estado_tracking: "DESPACHADO", obs: "Pistoleo por Valija. 26-2557187 / Guía T155-208233-JAEN" },
      { fecha_creacion: "2026-09-19", id_rpt_envio_ruta: "516075132", nombre_sede: "LIMA", estado_tracking: "EN VALIJA", obs: "Valija 26-2557187" },
      { fecha_creacion: "2026-09-19", id_rpt_envio_ruta: "516070402", nombre_sede: "LIMA", estado_tracking: "PRE VALIJA", obs: "Rampa: 5. Oleada: 8" },
      { fecha_creacion: "2026-09-19", id_rpt_envio_ruta: "516070401", nombre_sede: "LIMA", estado_tracking: "RECEPCION GUIA", obs: "Guía: TG12-1844 - Fecha recepción: 19/09/2026" },
      { fecha_creacion: "2026-09-19", id_rpt_envio_ruta: "516042251", nombre_sede: "LIMA", estado_tracking: "TRACKING EN GUIA", obs: "Guía: TG12-1844 - Fecha emisión: 19/09/2026 - Fecha traslado: 19/09/2026 - Tienda/Agente: OLVA ALMACEN INTERNO -AV. ARGENTINA 4458 CALLAO" },
      { fecha_creacion: "2026-09-19", id_rpt_envio_ruta: "516030795", nombre_sede: "LIMA", estado_tracking: "RECEPCION TIENDA", obs: "Recepción de Preventa Facturada: 202600689461" },
      { fecha_creacion: "2026-09-19", id_rpt_envio_ruta: "516030794", nombre_sede: "LIMA", estado_tracking: "REGISTRADO", obs: "Contado: F457 - 0051928 - Pieza: 1" },
    ],
  },
};

const ENTREGADO: OlvaTrackingPayload = {
  success: true,
  msg: "resultados obtenidos",
  data: {
    general: {
      fecha_envio: "08/09/2026",
      fecha_emision_fresh: "2026-09-08",
      emision: "26",
      remito: "2442338",
      consignado: "ALONDRA JHOYSI PISCO TAUMA",
      nombre_estado_tracking: "ENTREGADO",
      nombre_estado: "CONTADO FACTURADO",
      origen: "LIMA",
      destino: "NUEVO PROGRESO",
      flg_devolucion: null,
    },
    details: [
      { fecha_creacion: "2026-09-12", id_rpt_envio_ruta: "514797021", nombre_sede: "NUEVO PROGRESO", estado_tracking: "ENTREGADO", obs: "Codigo operador: LQM - Fecha entregado: 12/09/2026 - Salida: 1 - Foto: SI - Foto Movil: SI" },
      { fecha_creacion: "2026-09-12", id_rpt_envio_ruta: "514797013", nombre_sede: "NUEVO PROGRESO", estado_tracking: "ASIGNADO", obs: "Codigo operador: LQM - Fecha salida: 12/09/2026 - Salida: 1 - Id Tipo Operador: 2633 - Id Operador: 6884 - Nombre Operador: LOPEZ QUISPE MARCO  ANTONIO - Nombre Coordinador: " },
      { fecha_creacion: "2026-09-10", id_rpt_envio_ruta: "514435731", nombre_sede: "NUEVO PROGRESO", estado_tracking: "CONFIRMACION EN TIENDA", obs: "Id Oficina : 275 _|_ Nombre Oficina : NUEVO PROGRESO - HUAYRANGA S/N (CUADRA 2 S/N) _|_ Id Tipo Oficina : 1450 _|_ Nombre Tipo Oficina : OFICINA OPERACIONES" },
      { fecha_creacion: "2026-09-09", id_rpt_envio_ruta: "514132225", nombre_sede: "NUEVO PROGRESO", estado_tracking: "ASIGNADO", obs: "Codigo operador: LQM - Fecha salida: 09/09/2026 - Salida: 1 - Id Tipo Operador: 2640 - Id Operador: 6884 - Nombre Operador: LOPEZ QUISPE MARCO  ANTONIO - Nombre Coordinador: " },
      { fecha_creacion: "2026-09-09", id_rpt_envio_ruta: "514132224", nombre_sede: "LIMA", estado_tracking: "DESPACHADO", obs: "Pistoleo por Valija. 26-2454399 / Guía T155-206322-NUEVO PROGRESO" },
      { fecha_creacion: "2026-09-08", id_rpt_envio_ruta: "514126513", nombre_sede: "LIMA", estado_tracking: "EN VALIJA", obs: "Valija 26-2454399" },
      { fecha_creacion: "2026-09-08", id_rpt_envio_ruta: "514104681", nombre_sede: "LIMA", estado_tracking: "PRE VALIJA", obs: "Rampa: 22. Oleada: 2" },
      { fecha_creacion: "2026-09-08", id_rpt_envio_ruta: "514104680", nombre_sede: "LIMA", estado_tracking: "RECEPCION GUIA", obs: "Guía: TG12-1817 - Fecha recepción: 08/09/2026" },
      { fecha_creacion: "2026-09-08", id_rpt_envio_ruta: "514028122", nombre_sede: "LIMA", estado_tracking: "TRACKING EN GUIA", obs: "Guía: TG12-1817 - Fecha emisión: 08/09/2026 - Fecha traslado: 08/09/2026 - Tienda/Agente: OLVA ALMACEN INTERNO -AV. ARGENTINA 4458 CALLAO" },
      { fecha_creacion: "2026-09-08", id_rpt_envio_ruta: "514008303", nombre_sede: "LIMA", estado_tracking: "RECEPCION TIENDA", obs: "Recepción de Preventa Facturada: 202600666486" },
      { fecha_creacion: "2026-09-08", id_rpt_envio_ruta: "514008302", nombre_sede: "LIMA", estado_tracking: "REGISTRADO", obs: "Contado: F457 - 0051858 - Pieza: 1" },
    ],
  },
};

/** El mismo historial, recortado hasta un movimiento dado (el resto no ocurrió). */
function upTo(payload: OlvaTrackingPayload, estado: string, nth = 0): OlvaTrackingPayload {
  const details = payload.data!.details!;
  const idx = details.map((d, i) => (d.estado_tracking === estado ? i : -1)).filter((i) => i >= 0)[nth];
  const cut = details.slice(idx);
  return { ...payload, data: { general: { ...payload.data!.general!, nombre_estado_tracking: estado }, details: cut } };
}

describe("parseOlvaTracking", () => {
  it("acepta el formato de la página, el del correo y el número solo", () => {
    expect(parseOlvaTracking("2552504 - 26")).toEqual({ ok: true, value: { tracking: "2552504", emision: "26" } });
    expect(parseOlvaTracking("2552504-26")).toEqual({ ok: true, value: { tracking: "2552504", emision: "26" } });
    expect(parseOlvaTracking("26-2552504")).toEqual({ ok: true, value: { tracking: "2552504", emision: "26" } });
    expect(parseOlvaTracking("2552504", "26")).toEqual({ ok: true, value: { tracking: "2552504", emision: "26" } });
    expect(formatOlvaTracking({ tracking: "2552504", emision: "26" })).toBe("2552504-26");
  });

  it("rechaza lo que no es un tracking", () => {
    expect(parseOlvaTracking("")).toMatchObject({ ok: false });
    expect(parseOlvaTracking("TG12-1844")).toMatchObject({ ok: false });
    expect(parseOlvaTracking("2552504")).toMatchObject({ ok: false, error: expect.stringContaining("año") });
    expect(parseOlvaTracking("123-456")).toMatchObject({ ok: false });
    expect(parseOlvaTracking("26-2552504-99")).toMatchObject({ ok: false });
  });
});

describe("readOlvaTracking", () => {
  it("en camino: DESPACHADO es en_transito y la guía va en ruta", () => {
    expect(readOlvaTracking(EN_CAMINO)).toMatchObject({
      deliveryStatus: "en_ruta",
      pickupState: "en_transito",
      at: "2026-09-19T12:00:00-05:00",
      rawStatus: "DESPACHADO",
      known: true,
      returnFlagged: false,
      agencyBranch: null,
    });
  });

  it("todo lo de Lima antes del despacho es registrado_en_agencia", () => {
    for (const estado of ["REGISTRADO", "RECEPCION TIENDA", "TRACKING EN GUIA", "RECEPCION GUIA", "PRE VALIJA", "EN VALIJA"]) {
      expect(readOlvaTracking(upTo(EN_CAMINO, estado))).toMatchObject({
        deliveryStatus: "pendiente",
        pickupState: "registrado_en_agencia",
        rawStatus: estado,
        known: true,
      });
    }
  });

  // Llegar a la oficina de destino NO es entregar: el paquete espera, y desde
  // aquí corren los 6 días de Olva. La oficina sale de la observación.
  it("CONFIRMACION EN TIENDA queda disponible para recojo, viva, con la oficina", () => {
    expect(readOlvaTracking(upTo(ENTREGADO, "CONFIRMACION EN TIENDA"))).toMatchObject({
      deliveryStatus: "pendiente",
      pickupState: "disponible_para_recojo",
      at: "2026-09-10T12:00:00-05:00",
      agencyBranch: "NUEVO PROGRESO - HUAYRANGA S/N (CUADRA 2 S/N)",
    });
  });

  // El caso real: asignado el 09/09, en tienda el 10/09, asignado otra vez el
  // 12/09. Manda lo que Olva dice que es el vigente, no el hito «más avanzado»:
  // con una escalera, «asignado» habría tapado tres días de «en tienda».
  it("manda el estado vigente de Olva, no el hito más avanzado", () => {
    const enTienda = upTo(ENTREGADO, "CONFIRMACION EN TIENDA");
    expect(readOlvaTracking(enTienda).pickupState).toBe("disponible_para_recojo");
    const asignadoDeNuevo = upTo(ENTREGADO, "ASIGNADO", 0);
    expect(readOlvaTracking(asignadoDeNuevo)).toMatchObject({
      deliveryStatus: "en_ruta",
      pickupState: "en_reparto",
      at: "2026-09-12T12:00:00-05:00",
    });
  });

  it("entregado a domicilio (hubo operador asignado) cierra como entregado", () => {
    expect(readOlvaTracking(ENTREGADO)).toMatchObject({
      deliveryStatus: "entregado",
      pickupState: "entregado",
      at: "2026-09-12T12:00:00-05:00",
      rawStatus: "ENTREGADO",
    });
  });

  it("entregado sin operador es un recojo en la oficina", () => {
    const recogido: OlvaTrackingPayload = {
      ...ENTREGADO,
      data: {
        general: ENTREGADO.data!.general,
        details: ENTREGADO.data!.details!.filter((d) => d.estado_tracking !== "ASIGNADO"),
      },
    };
    expect(readOlvaTracking(recogido)).toMatchObject({ deliveryStatus: "entregado", pickupState: "recogido" });
  });

  // Un estado nuevo de Olva no se traduce a ciegas: se devuelve crudo y el cron
  // no toca `pickup_state`. Inventar es peor que no saber.
  it("un estado desconocido no inventa nada", () => {
    const raro = { ...EN_CAMINO, data: { ...EN_CAMINO.data, general: { ...EN_CAMINO.data!.general, nombre_estado_tracking: "EN DEVOLUCION" } } };
    const snap = readOlvaTracking(raro);
    expect(snap.known).toBe(false);
    expect(snap.rawStatus).toBe("EN DEVOLUCION");
    expect(olvaTrackingChanged({ delivery_status: "en_ruta", pickup_state: "en_transito", olva_status: "DESPACHADO" }, snap)).toBe(true);
    expect(olvaTrackingChanged({ delivery_status: "en_ruta", pickup_state: "en_transito", olva_status: "EN DEVOLUCION" }, snap)).toBe(false);
  });

  it("sin respuesta no inventa nada", () => {
    expect(readOlvaTracking(null)).toMatchObject({ known: false, rawStatus: null, at: null });
    expect(readOlvaTracking({ success: true, data: { general: {}, details: [] } })).toMatchObject({ known: false });
  });

  it("flg_devolucion marca la devolución sin cambiar el estado", () => {
    const dev = { ...EN_CAMINO, data: { ...EN_CAMINO.data, general: { ...EN_CAMINO.data!.general, flg_devolucion: "1" } } };
    expect(readOlvaTracking(dev)).toMatchObject({ returnFlagged: true, pickupState: "en_transito" });
    expect(readOlvaTracking(EN_CAMINO).returnFlagged).toBe(false);
  });
});

describe("olvaTrackingChanged", () => {
  it("un movimiento nuevo dentro del mismo pickup_state sí cuenta", () => {
    const next = readOlvaTracking(upTo(EN_CAMINO, "EN VALIJA"));
    expect(olvaTrackingChanged({ delivery_status: "pendiente", pickup_state: "registrado_en_agencia", olva_status: "PRE VALIJA" }, next)).toBe(true);
    expect(olvaTrackingChanged({ delivery_status: "pendiente", pickup_state: "registrado_en_agencia", olva_status: "EN VALIJA" }, next)).toBe(false);
  });

  it("la primera lectura de una guía recién registrada siempre escribe", () => {
    const next = readOlvaTracking(upTo(EN_CAMINO, "REGISTRADO"));
    expect(olvaTrackingChanged({ delivery_status: "pendiente", pickup_state: "pendiente_de_envio", olva_status: null }, next)).toBe(true);
  });
});

describe("fechas y plazo", () => {
  it("el día de Olva se ancla al mediodía de Lima", () => {
    expect(olvaDateToIso("2026-09-12")).toBe("2026-09-12T12:00:00-05:00");
    expect(olvaDateToIso("12/09/2026")).toBe("2026-09-12T12:00:00-05:00");
    expect(olvaDateToIso("2026-09-12 08:15:00")).toBe("2026-09-12T08:15:00-05:00");
    expect(olvaDateToIso("")).toBeNull();
    expect(olvaDateToIso("ayer")).toBeNull();
  });

  it("Olva guarda el paquete 6 días, no 28", () => {
    expect(OLVA_PICKUP_WINDOW_DAYS).toBe(6);
    expect(olvaPickupDeadline("2026-09-10T12:00:00-05:00")).toBe("2026-09-16T17:00:00.000Z");
    expect(olvaPickupDeadline("nunca")).toBeNull();
  });

  it("las terminales dejan de consultarse", () => {
    expect(olvaNeedsTracking("pendiente")).toBe(true);
    expect(olvaNeedsTracking("en_ruta")).toBe(true);
    expect(olvaNeedsTracking("entregado")).toBe(false);
    expect(olvaNeedsTracking("anulado")).toBe(false);
  });

  it("la oficina sale de la observación de Olva", () => {
    expect(olvaBranchFromObs("Id Oficina : 275 _|_ Nombre Oficina : NUEVO PROGRESO - HUAYRANGA S/N _|_ Id Tipo")).toBe("NUEVO PROGRESO - HUAYRANGA S/N");
    expect(olvaBranchFromObs("Rampa: 5. Oleada: 8")).toBeNull();
    expect(olvaBranchFromObs(null)).toBeNull();
  });
});

describe("cliente", () => {
  it("arma la misma llamada que la página de Olva", () => {
    const url = new URL(trackingUrl("https://reports.olvaexpress.pe", { tracking: "2552504", emision: "26" }, "k"));
    expect(url.pathname).toBe("/webservice/rest/getTrackingInformation");
    expect(Object.fromEntries(url.searchParams)).toEqual({ tracking: "2552504", emision: "26", apikey: "k", details: "1" });
  });

  it("reconoce la forma de la respuesta y rechaza otra cosa", () => {
    expect(isOlvaTrackingPayload(EN_CAMINO)).toBe(true);
    expect(isOlvaTrackingPayload({ success: false, msg: "no existe" })).toBe(true);
    expect(isOlvaTrackingPayload({ message: "Información de tracking(s) obtenida!", data: [] , success: true })).toBe(false);
    expect(isOlvaTrackingPayload("<html>")).toBe(false);
  });

  it("devuelve el payload, o el motivo cuando Olva no reconoce la guía", async () => {
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const u = String(input);
      const body = u.includes("tracking=2552504") ? EN_CAMINO : { success: false, msg: "no se encontraron resultados" };
      return new Response(JSON.stringify(body), { status: 200 });
    }) as unknown as typeof fetch;
    const ok = await fetchOlvaTracking({ tracking: "2552504", emision: "26" }, { apiKey: "k", fetchImpl });
    expect(ok).toMatchObject({ ok: true });
    const no = await fetchOlvaTracking({ tracking: "1", emision: "26" }, { apiKey: "k", fetchImpl });
    expect(no).toEqual({ ok: false, reason: "no se encontraron resultados" });
    // Origin y Referer de la página, como el navegador.
    const init = (fetchImpl as unknown as { mock: { calls: [string, RequestInit][] } }).mock.calls[0]?.[1];
    expect((init?.headers as Record<string, string>).origin).toBe("https://tracking.olvaexpress.pe");
  });

  // Una apikey rotada o un HTML de error no pueden colarse como «sin novedad»:
  // se lanzan, el cron los cuenta como fallo y no toca estados.
  it("un 403 o un cuerpo raro se lanzan como error, sin la apikey en el mensaje", async () => {
    const forbidden = (async () => new Response("denied", { status: 403 })) as unknown as typeof fetch;
    await expect(fetchOlvaTracking({ tracking: "2552504", emision: "26" }, { apiKey: "SECRETA", fetchImpl: forbidden })).rejects.toThrow(OlvaApiError);
    await expect(fetchOlvaTracking({ tracking: "2552504", emision: "26" }, { apiKey: "SECRETA", fetchImpl: forbidden })).rejects.not.toThrow(/SECRETA/);
    const html = (async () => new Response("<html>challenge</html>", { status: 200 })) as unknown as typeof fetch;
    await expect(fetchOlvaTracking({ tracking: "2552504", emision: "26" }, { apiKey: "k", fetchImpl: html })).rejects.toThrow(/formato/);
  });
});

describe("la especificación", () => {
  const mom = readFileSync(resolve(process.cwd(), "docs/mom/master-pedidos-v1.md"), "utf8");

  it("documenta el rastreo de Olva y de dónde sale", () => {
    expect(mom).toContain("olva-reconcile");
    expect(mom).toContain("getTrackingInformation");
    expect(mom).toContain("CONFIRMACION EN TIENDA");
    expect(mom).toContain(`Plazo: ${OLVA_PICKUP_WINDOW_DAYS} días desde disponibilidad en agencia destino`);
  });

  it("y el cron está programado", () => {
    const vercel = JSON.parse(readFileSync(resolve(process.cwd(), "vercel.json"), "utf8")) as { crons: { path: string }[] };
    expect(vercel.crons.some((c) => c.path === "/api/cron/olva-reconcile")).toBe(true);
  });
});

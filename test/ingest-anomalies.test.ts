import { describe, it, expect, vi } from "vitest";
import {
  buildAnomalyDigest,
  localDay,
  noteAnomaly,
  type AnomalyRow,
} from "@/lib/ingest-anomalies";

/**
 * La superficie de anomalías (0106): hacer visible el trabajo que la ingesta
 * descarta. Lo que se afirma acá es lo que decide si sirve o no: que compare
 * contra AYER (el salto, no el nivel) y que jamás rompa lo que observa.
 */

const row = (over: Partial<AnomalyRow>): AnomalyRow => ({
  store_id: "s1",
  dia: "2026-08-06",
  source: "leads_sync",
  reason: "conversacion_sin_identidad",
  count: 1,
  sample: null,
  last_seen_at: "2026-08-06T12:00:00Z",
  ...over,
});

describe("buildAnomalyDigest", () => {
  it("separa hoy de ayer — que es lo único que hace legible el número", () => {
    // "25 descartes" no dice nada suelto: puede ser lo normal. "Ayer 0, hoy 25"
    // es exactamente la señal que permitió fechar la migración de Meta al día.
    const d = buildAnomalyDigest(
      [
        row({ dia: "2026-08-06", count: 25 }),
        row({ dia: "2026-08-05", count: 0 }),
      ],
      "2026-08-06",
      "2026-08-05",
    );
    expect(d.hoy).toBe(25);
    expect(d.ayer).toBe(0);
  });

  it("agrupa el mismo problema de dos tiendas en una sola línea", () => {
    // Con la cola combinada, el mismo fallo en Aurela y en Kenku es UN problema,
    // no dos. Verlo partido invita a tratarlos como casos distintos.
    const d = buildAnomalyDigest(
      [
        row({ store_id: "aurela", count: 3 }),
        row({ store_id: "kenku", count: 4 }),
      ],
      "2026-08-06",
      "2026-08-05",
    );
    expect(d.detalle).toEqual([
      { source: "leads_sync", reason: "conversacion_sin_identidad", count: 7 },
    ]);
  });

  it("ordena el desglose por volumen", () => {
    const d = buildAnomalyDigest(
      [
        row({ source: "handoff", reason: "sin_identidad", count: 2 }),
        row({ source: "lead_enrich", reason: "excepcion", count: 9 }),
      ],
      "2026-08-06",
      "2026-08-05",
    );
    expect(d.detalle.map((x) => x.source)).toEqual(["lead_enrich", "handoff"]);
  });

  it("ignora días que no son ni hoy ni ayer", () => {
    // La consulta pide dos días, pero el resumen no debe depender de eso: si un
    // día viejo se colara, inflaría "hoy" y el salto dejaría de significar nada.
    const d = buildAnomalyDigest([row({ dia: "2026-07-01", count: 99 })], "2026-08-06", "2026-08-05");
    expect(d).toEqual({ hoy: 0, ayer: 0, detalle: [] });
  });

  it("sin filas devuelve el resumen vacío", () => {
    expect(buildAnomalyDigest([], "2026-08-06", "2026-08-05")).toEqual({
      hoy: 0,
      ayer: 0,
      detalle: [],
    });
  });
});

describe("noteAnomaly", () => {
  it("no escribe cuando no hubo descartes", async () => {
    // Los sitios que instrumentan un bucle llaman con el total al final. Un cero
    // NO debe dejar fila: "hoy hubo 0 anomalías" y "hoy no hubo anomalías" se
    // leen igual en pantalla, pero la fila ensucia la comparación con ayer.
    const rpc = vi.fn();
    await noteAnomaly({ rpc } as never, {
      storeId: "s1",
      source: "leads_sync",
      reason: "conversacion_sin_identidad",
      count: 0,
    });
    expect(rpc).not.toHaveBeenCalled();
  });

  it("pasa el total de golpe en vez de una llamada por descarte", async () => {
    const rpc = vi.fn().mockResolvedValue({ error: null });
    await noteAnomaly({ rpc } as never, {
      storeId: "s1",
      source: "leads_sync",
      reason: "conversacion_sin_identidad",
      count: 25,
    });
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc.mock.calls[0]![1]).toMatchObject({ p_count: 25, p_store_id: "s1" });
  });

  it("NUNCA propaga un fallo propio", async () => {
    // La regla de oro: el medidor no puede tumbar lo que mide. Si esto lanzara,
    // una tabla ausente o un permiso mal puesto dejaría caer el sync entero —
    // convirtiendo la herramienta de diagnóstico en la causa de la caída.
    const rpc = vi.fn().mockRejectedValue(new Error("relation does not exist"));
    await expect(
      noteAnomaly({ rpc } as never, { storeId: "s1", source: "handoff", reason: "sin_identidad" }),
    ).resolves.toBeUndefined();
  });
});

describe("localDay", () => {
  it("usa el día LOCAL, no el UTC", () => {
    // En Lima (UTC-5) las 01:00 UTC del día 7 son todavía el 6 por la tarde. Con
    // el día UTC, el trabajo de una misma jornada quedaría partido en dos filas y
    // la comparación "ayer vs hoy" mezclaría medias tardes.
    const nocheEnLima = new Date("2026-08-07T01:00:00Z");
    expect(localDay("America/Lima", 0, nocheEnLima)).toBe("2026-08-06");
    expect(localDay("UTC", 0, nocheEnLima)).toBe("2026-08-07");
  });

  it("el desplazamiento de días da el día anterior", () => {
    const t = new Date("2026-08-06T15:00:00Z");
    expect(localDay("America/Lima", -1, t)).toBe("2026-08-05");
  });
});

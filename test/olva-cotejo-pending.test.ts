import { describe, expect, it } from "vitest";
import { stillWaiting, waitingTrackings } from "@/lib/olva/cotejo-pending";
import type { CotejoResumen, CotejoResumenRow } from "@/lib/olva/portal-sync";

// El número del menú lateral junto a «Cotejar Olva» (MOM §12): lo que espera
// a una persona HOY, no lo que la bitácora vio al cotejar.
const row = (tracking: string, outcome: CotejoResumenRow["outcome"]): CotejoResumenRow => ({
  tracking,
  outcome,
  estado: null,
  destinatario: "X",
  distrito: null,
  direccion: "",
  fecha: null,
  docExterno: null,
});

describe("cuántos quedan por cotejar", () => {
  const resumen: CotejoResumen = {
    skipped: 0,
    rows: [
      row("2609755-26", "sin_pareja"),
      row("2617757-26", "sin_pareja"),
      row("2590639-26", "revisar"),
      row("2617754-26", "vinculado"),
      row("2649805-26", "ya_vinculado"),
    ],
  };

  it("cuenta solo «por revisar» y «sin pareja»", () => {
    expect(waitingTrackings(resumen)).toEqual(["2609755-26", "2617757-26", "2590639-26"]);
    expect(waitingTrackings(null)).toEqual([]);
  });

  it("lo vinculado después a mano deja de contar", () => {
    // 02-10-2026: «Vincular a pedido» puso 2609755-26 en #KP136660 y «Es este»
    // resolvió a Yolanda; el menú tiene que bajar sin esperar al cron.
    expect(stillWaiting(waitingTrackings(resumen), new Set(["2609755-26", "2590639-26"]))).toEqual(["2617757-26"]);
  });
});

// Repro Lima: el acuerdo cuyo pedido ya tiene su guía viva de otro courier se
// lee «Listo» y no pide gestión (owner, 13-11-2026; MOM §9.5). El equipo creó
// las guías de #KP205595 y #KP205580 (Aliclik) y #KP204592 (Swayp) para el
// 13/11 y la fila seguía en «Sale … · crea la salida en la Mesa de ruta» o
// «Falta la salida nueva»: Kapta nunca se enteraba de la guía. Lo que se fija:
//   - con la guía viva, `guia_lista`, antes que lo que pedía el plan;
//   - la fecha pasada sigue venciendo el acuerdo;
//   - la guía de otro courier cuenta, y la chapa lo avisa;
//   - no cuenta la guía que falló en el episodio, ni una de Grupo GF, devuelta
//     o anulada.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  agreementState,
  agreementStateLabel,
  isProblemState,
  type BoxLocation,
  type ReproAgreementFacts,
} from "@/lib/repro-lima";
import { liveGuideOf } from "@/lib/repro-box-action";

const HOY = "2026-11-12";
const MANANA = "2026-11-13";
const office: BoxLocation = { kind: "en_oficina", since: null, courier: "propio" };
const agreed = (extra: Partial<ReproAgreementFacts> = {}): ReproAgreementFacts => ({
  agreed_on: MANANA,
  agreed_courier: "aliclik",
  box_action: "salida_nueva_rearmar",
  materialized_at: null,
  materialized_on: null,
  ...extra,
});
const aliclik = { courier: "aliclik", code: "AUR5X965016553040" };

describe("agreementState con la guía ya creada", () => {
  it("acordado con otro courier y su guía viva: «Listo», no «crea la salida»", () => {
    expect(agreementState({ c: agreed(), program: null, box: office, plan: { no: "otro_courier" }, today: HOY })).toEqual({ kind: "otro_courier" });
    expect(agreementState({ c: agreed(), program: null, box: office, plan: { no: "otro_courier" }, today: HOY, liveGuide: aliclik }))
      .toEqual({ kind: "guia_lista", courier: "aliclik", code: "AUR5X965016553040" });
  });

  it("acordado con Grupo GF y salida nueva, pero salió con Swayp: también «Listo» (#KP204592)", () => {
    const c = agreed({ agreed_courier: "propio" });
    expect(agreementState({ c, program: null, box: office, plan: { no: "falta_salida" }, today: HOY, liveGuide: { courier: "fenix", code: "50000172589" } }))
      .toEqual({ kind: "guia_lista", courier: "fenix", code: "50000172589" });
  });

  it("el día acordado que pasó sigue venciendo el acuerdo, con guía o sin ella", () => {
    expect(agreementState({ c: agreed({ agreed_on: "2026-11-11" }), program: null, box: office, plan: { no: "otro_courier" }, today: HOY, liveGuide: aliclik }))
      .toEqual({ kind: "acuerdo_vencido" });
  });

  it("materializado sin programa: la guía viva manda sobre «falta programarlo»", () => {
    const c = agreed({ agreed_courier: "propio", materialized_at: "2026-11-12T15:00:00Z", materialized_on: MANANA });
    expect(agreementState({ c, program: null, box: office, plan: "ahora", today: HOY })).toEqual({ kind: "por_programar" });
    expect(agreementState({ c, program: null, box: office, plan: "ahora", today: HOY, liveGuide: aliclik })).toMatchObject({ kind: "guia_lista" });
  });

  it("materializado con su programa: sigue siendo «Programado»", () => {
    const c = agreed({ agreed_courier: "propio", materialized_at: "2026-11-12T15:00:00Z", materialized_on: MANANA });
    expect(agreementState({ c, program: { scheduled_for: MANANA, reason: null }, box: office, plan: "ahora", today: HOY, liveGuide: aliclik }))
      .toEqual({ kind: "programado" });
  });

  it("no pide a nadie", () => {
    expect(isProblemState("guia_lista")).toBe(false);
  });
});

describe("la chapa", () => {
  it("dice el día, el courier de la guía y su código", () => {
    expect(agreementStateLabel({ kind: "guia_lista", courier: "aliclik", code: "AUR5X965016553040" }, { agreed_on: MANANA, agreed_courier: "aliclik" }))
      .toBe("Listo · sale vie 13/11 con Aliclik · guía AUR5X965016553040");
  });

  it("si la guía es de otro courier que el acordado, lo avisa (#KP205580)", () => {
    const label = agreementStateLabel({ kind: "guia_lista", courier: "aliclik", code: "AUR5X674294083232" }, { agreed_on: MANANA, agreed_courier: "fenix" });
    expect(label).toMatch(/^Listo · sale vie 13\/11 con Aliclik · guía AUR5X674294083232 \(acordado con .+\)$/);
  });
});

describe("liveGuideOf", () => {
  const out = (over: Partial<Parameters<typeof liveGuideOf>[0][number]> = {}) => ({
    id: "s1",
    courier: "aliclik",
    delivery_status: "pendiente",
    returned_at: null,
    custody_state: null,
    output_number: 1,
    guide_code: "AUR5X1",
    output_code: "KP1-S01",
    ...over,
  });

  it("la guía viva de otro courier, la de consecutivo más alto", () => {
    expect(liveGuideOf([out(), out({ id: "s2", courier: "fenix", delivery_status: "en_ruta", output_number: 2, guide_code: "5000" })]))
      .toEqual({ courier: "fenix", code: "5000" });
  });

  it("no cuenta: la de Grupo GF, la devuelta, la anulada, la entregada ni la que falló en el episodio", () => {
    expect(liveGuideOf([out({ courier: "propio" })])).toBeNull();
    expect(liveGuideOf([out({ returned_at: "2026-11-12T10:00:00Z" })])).toBeNull();
    expect(liveGuideOf([out({ custody_state: "devuelto" })])).toBeNull();
    expect(liveGuideOf([out({ delivery_status: "anulado" })])).toBeNull();
    expect(liveGuideOf([out({ delivery_status: "entregado" })])).toBeNull();
    expect(liveGuideOf([out({ courier: "fenix", delivery_status: "en_ruta" })], "s1")).toBeNull();
  });

  it("sin guía, la salida", () => {
    expect(liveGuideOf([out({ guide_code: null })])).toEqual({ courier: "aliclik", code: "KP1-S01" });
  });
});

describe("la fila", () => {
  const read = (p: string) => readFileSync(resolve(process.cwd(), p), "utf8");
  it("Repro Lima calcula la guía sin la que falló y la fila de atención dice «Listo»", () => {
    expect(read("lib/repro-lima-access.ts")).toContain("const liveGuide = liveGuideOf(f.outputs, f.failedOutput?.id ?? null);");
    const panel = read("components/repro-lima-panel.tsx");
    expect(panel).toContain("No requiere gestión salvo que el cliente cambie algo.");
    expect(panel).toContain('if (kind === "programado" || kind === "guia_lista") return "ok";');
  });

  it("el MOM lo registra", () => {
    const mom = read("docs/mom/master-pedidos-v1.md").replace(/\s+/g, " ");
    expect(mom).toContain("**Acuerdo con la guía ya creada (decisión del owner, 13-11-2026).**");
    expect(mom).toContain("| `guia_lista` |");
    expect(mom).toContain("**Cuenta aunque sea de otro courier que el acordado**");
    expect(mom).toContain("Solo cambia la lectura: no programa, no cierra el caso ni cambia la guía.");
  });
});

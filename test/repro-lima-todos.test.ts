// «Todos» de Repro Lima (MOM §9.5, 14-10-2026). Las reglas puras de
// lib/repro-lima-todos.ts: lectura de la RPC, antigüedad del tablero y el
// resumen por etapa y subetapa del Master, sin inventar estados.

import { describe, expect, it } from "vitest";
import { parseMasterQuery } from "@/lib/master-query";
import { MASTER_PATH } from "@/lib/order-drawer-href";
import {
  MACRO_SUBSTAGES_BY_STAGE,
  MACRO_SUBSTAGE_LABEL,
  ORDER_MACRO_STAGES,
  macroStageLabel,
  type MacroSubstage,
  type OrderMacroStage,
} from "@/lib/order-macro-stage";
import {
  TODOS_POR_ENTREGAR,
  TODOS_SIN_SUBETAPA,
  TODOS_STAGE_HINT,
  limaOpenBreakdown,
  parseLimaOpenCounts,
  reproAging,
  type LimaOpenCountRow,
  type StageAging,
  type TodosBreakdown,
  type TodosStage,
} from "@/lib/repro-lima-todos";

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const NO_REPRO: StageAging = { total: 0, over7: 0, over30: 0 };

function row(
  stage: OrderMacroStage,
  substage: string | null,
  total: number,
  over7 = 0,
  over30 = 0,
  storeId = A,
): LimaOpenCountRow {
  return { storeId, stage, substage, total, over7, over30 };
}

function allStages(b: TodosBreakdown): TodosStage[] {
  return [...b.porEntregar, ...(b.porCerrar ? [b.porCerrar] : [])];
}

function findStage(b: TodosBreakdown, stage: OrderMacroStage): TodosStage | undefined {
  return allStages(b).find((s) => s.stage === stage);
}

// Las cifras de producción del 14-10 (coverage = 'lima'), en desorden a propósito.
const PRODUCCION: LimaOpenCountRow[] = [
  row("por_cerrar", "validacion_cierre_pendiente", 641, 283, 5),
  row("en_curso", "en_reparto", 104, 30, 0),
  row("preparacion", "por_armar", 13, 11, 11),
  row("por_cerrar", "pendiente_liquidacion", 4624, 4576, 3845),
  row("en_curso", "en_retorno", 1, 0, 0),
  row("por_despachar", "listo_para_asignar", 1094, 948, 351),
  row("en_curso", "por_reprogramar_lima", 451, 236, 51),
  row("por_cerrar", "devolucion_fisica_pendiente", 186, 98, 1),
  row("en_curso", "en_transito", 91, 48, 20),
  row("por_cerrar", "salida_adicional_activa", 773, 770, 655),
  row("en_curso", "pendiente_pago_diferencia", 2, 1, 0),
  row("preparacion", "por_generar_rotulo", 183, 141, 132),
  row("por_cerrar", "recogido_sin_pago_completo", 5, 5, 2),
  row("en_curso", "disponible_para_recojo", 1, 0, 0),
  row("por_cerrar", "devolucion_pendiente_inventario", 164, 147, 20),
];
const REPRO_PRODUCCION: StageAging = { total: 451, over7: 236, over30: 51 };

describe("TODOS_POR_ENTREGAR y las pistas", () => {
  it("son las etapas del MOM antes de «Por cerrar», en su orden", () => {
    const order = ORDER_MACRO_STAGES.map((s) => s.code);
    expect([...TODOS_POR_ENTREGAR]).toEqual(order.slice(0, order.indexOf("por_cerrar")));
  });

  it("hay una pista por etapa abierta y ninguna para «Finalizado»", () => {
    const open = ORDER_MACRO_STAGES.map((s) => s.code).filter((c) => c !== "finalizado");
    expect(Object.keys(TODOS_STAGE_HINT).sort()).toEqual([...open].sort());
    for (const code of open) expect(TODOS_STAGE_HINT[code as Exclude<OrderMacroStage, "finalizado">]).toBeTruthy();
  });
});

describe("limaOpenBreakdown", () => {
  it("con las cifras del 14-10: 1.940 por entregar y 6.393 por cerrar", () => {
    const b = limaOpenBreakdown(PRODUCCION, { storeId: null, repro: REPRO_PRODUCCION });
    expect(b.totals).toEqual({ porEntregar: 1940, porCerrar: 6393, all: 8333 });
  });

  it("ordena etapas y subetapas como el MOM, venga como venga", () => {
    const forward = limaOpenBreakdown(PRODUCCION, { storeId: null, repro: REPRO_PRODUCCION });
    const reversed = limaOpenBreakdown([...PRODUCCION].reverse(), { storeId: null, repro: REPRO_PRODUCCION });
    expect(reversed).toEqual(forward);

    const stageOrder = ORDER_MACRO_STAGES.map((s) => s.code);
    const codes = allStages(forward).map((s) => s.stage);
    expect(codes).toEqual([...codes].sort((a, b) => stageOrder.indexOf(a) - stageOrder.indexOf(b)));
    expect(codes).toEqual(["preparacion", "por_despachar", "en_curso", "por_cerrar"]);

    for (const stage of allStages(forward)) {
      const canon: readonly string[] = MACRO_SUBSTAGES_BY_STAGE[stage.stage];
      const idx = stage.substages.map((s) => canon.indexOf(s.substage!));
      expect(idx.every((i) => i >= 0)).toBe(true);
      expect(idx).toEqual([...idx].sort((a, b) => a - b));
    }
    expect(findStage(forward, "en_curso")!.substages.map((s) => s.substage)).toEqual([
      "en_transito",
      "en_reparto",
      "disponible_para_recojo",
      "pendiente_pago_diferencia",
      "por_reprogramar_lima",
      "en_retorno",
    ]);
  });

  it("omite subetapas y etapas en cero, también «Por confirmar» en Lima", () => {
    const b = limaOpenBreakdown(
      [row("preparacion", "por_armar", 0), row("preparacion", "por_generar_rotulo", 3), row("por_despachar", "listo_para_asignar", 0)],
      { storeId: null, repro: NO_REPRO },
    );
    expect(b.porEntregar.map((s) => s.stage)).toEqual(["preparacion"]);
    expect(b.porEntregar[0]!.substages.map((s) => s.substage)).toEqual(["por_generar_rotulo"]);
    expect(findStage(b, "por_confirmar")).toBeUndefined();
    expect(b.porCerrar).toBeNull();
    expect(b.totals).toEqual({ porEntregar: 3, porCerrar: 0, all: 3 });
  });

  it("sin filas: nada que mostrar y todo en cero", () => {
    const b = limaOpenBreakdown([], { storeId: null, repro: NO_REPRO });
    expect(b).toEqual({ porEntregar: [], porCerrar: null, totals: { porEntregar: 0, porCerrar: 0, all: 0 } });
  });

  it("ignora «Finalizado» aunque llegue", () => {
    const b = limaOpenBreakdown([row("finalizado", "entregado_cerrado", 50), row("por_cerrar", "pendiente_liquidacion", 2)], {
      storeId: null,
      repro: NO_REPRO,
    });
    expect(findStage(b, "finalizado")).toBeUndefined();
    expect(b.totals.all).toBe(2);
  });

  it("una subetapa que el MOM no lista para la etapa va al final, por código, con el enlace a la etapa", () => {
    const b = limaOpenBreakdown(
      [
        row("en_curso", "zz_codigo_nuevo", 2),
        row("en_curso", "listo_para_asignar", 1), // de otra etapa
        row("en_curso", "en_reparto", 4),
        row("en_curso", "en_transito", 3),
      ],
      { storeId: null, repro: NO_REPRO },
    );
    const subs = findStage(b, "en_curso")!.substages;
    expect(subs.map((s) => s.substage)).toEqual(["en_transito", "en_reparto", "listo_para_asignar", "zz_codigo_nuevo"]);
    const stageOnly = new URLSearchParams(subs[2]!.href!.split("?")[1]);
    expect(stageOnly.get("view")).toBe("en_curso");
    expect(stageOnly.has("substage")).toBe(false);
    expect(new URLSearchParams(subs[3]!.href!.split("?")[1]).has("substage")).toBe(false);
    expect(new URLSearchParams(subs[0]!.href!.split("?")[1]).get("substage")).toBe("en_transito");
  });

  it("sin subetapa va al final como «Sin subetapa», con el enlace a la etapa", () => {
    const b = limaOpenBreakdown(
      [row("por_cerrar", null, 2, 1, 0), row("por_cerrar", "codigo_raro", 1), row("por_cerrar", "pendiente_liquidacion", 5)],
      { storeId: null, repro: NO_REPRO },
    );
    const subs = b.porCerrar!.substages;
    expect(subs.map((s) => s.substage)).toEqual(["pendiente_liquidacion", "codigo_raro", null]);
    const none = subs[2]!;
    expect(none.label).toBe(TODOS_SIN_SUBETAPA);
    expect(none.inPage).toBe(false);
    const params = new URLSearchParams(none.href!.split("?")[1]);
    expect(params.get("view")).toBe("por_cerrar");
    expect(params.has("substage")).toBe(false);
    expect(none).toMatchObject({ total: 2, over7: 1, over30: 0 });
  });

  it("filtra por tienda; sin tienda suma todas", () => {
    const rows = [
      row("preparacion", "por_armar", 2, 1, 0, A),
      row("preparacion", "por_armar", 5, 3, 1, B),
      row("por_cerrar", "pendiente_liquidacion", 7, 7, 7, B),
    ];
    const soloA = limaOpenBreakdown(rows, { storeId: A, repro: NO_REPRO });
    expect(soloA.totals).toEqual({ porEntregar: 2, porCerrar: 0, all: 2 });
    expect(soloA.porCerrar).toBeNull();
    expect(soloA.porEntregar[0]!.substages[0]).toMatchObject({ total: 2, over7: 1, over30: 0 });
    expect(new URLSearchParams(soloA.porEntregar[0]!.substages[0]!.href!.split("?")[1]).get("st")).toBe(A);

    const todas = limaOpenBreakdown(rows, { storeId: null, repro: NO_REPRO });
    expect(todas.totals).toEqual({ porEntregar: 7, porCerrar: 7, all: 14 });
    expect(todas.porEntregar[0]!.substages[0]).toMatchObject({ total: 7, over7: 4, over30: 1 });
    expect(new URLSearchParams(todas.porEntregar[0]!.substages[0]!.href!.split("?")[1]).has("st")).toBe(false);
  });

  it("«Por reprogramar Lima» sale del tablero, no de la RPC, y se abre en la pantalla", () => {
    const rows = [row("en_curso", "por_reprogramar_lima", 451, 236, 51), row("en_curso", "en_reparto", 4)];
    const b = limaOpenBreakdown(rows, { storeId: null, repro: { total: 9, over7: 4, over30: 1 } });
    const repro = findStage(b, "en_curso")!.substages.find((s) => s.substage === "por_reprogramar_lima")!;
    expect(repro).toMatchObject({ total: 9, over7: 4, over30: 1, inPage: true, href: null });
    expect(repro.label).toBe(MACRO_SUBSTAGE_LABEL.por_reprogramar_lima);
    expect(findStage(b, "en_curso")!.total).toBe(13);
    // Las demás filas siempre llevan enlace y no se abren en la pantalla.
    for (const stage of allStages(b)) {
      for (const s of stage.substages) if (s.substage !== "por_reprogramar_lima") expect(s).toMatchObject({ inPage: false });
    }

    const sinRepro = limaOpenBreakdown(rows, { storeId: null, repro: NO_REPRO });
    const enCurso = findStage(sinRepro, "en_curso")!;
    expect(enCurso.substages.map((s) => s.substage)).toEqual(["en_reparto"]);
    expect(enCurso.total).toBe(4);
  });

  it("solo con «Por reprogramar Lima», En curso aparece igual", () => {
    const b = limaOpenBreakdown([], { storeId: null, repro: { total: 3, over7: 0, over30: 0 } });
    expect(b.porEntregar.map((s) => s.stage)).toEqual(["en_curso"]);
    expect(b.totals).toEqual({ porEntregar: 3, porCerrar: 0, all: 3 });
  });

  it("las subetapas suman su etapa y las etapas suman los totales", () => {
    const b = limaOpenBreakdown(
      [...PRODUCCION, row("por_cerrar", null, 3, 2, 1), row("preparacion", "otro", 2, 2, 0, B)],
      { storeId: null, repro: REPRO_PRODUCCION },
    );
    for (const stage of allStages(b)) {
      for (const key of ["total", "over7", "over30"] as const) {
        expect(stage.substages.reduce((sum, s) => sum + s[key], 0)).toBe(stage[key]);
      }
    }
    expect(b.porEntregar.reduce((sum, s) => sum + s.total, 0)).toBe(b.totals.porEntregar);
    expect(b.totals.porCerrar).toBe(b.porCerrar!.total);
    expect(b.totals.all).toBe(b.totals.porEntregar + b.totals.porCerrar);
  });

  it("no inventa estados: los nombres son los del Master", () => {
    const b = limaOpenBreakdown(
      [
        ...PRODUCCION,
        row("en_curso", "pago_requerido_pendiente", 1), // código conocido, de otra etapa
        row("por_despachar", "estado_inventado", 1),
      ],
      { storeId: null, repro: REPRO_PRODUCCION },
    );
    for (const stage of allStages(b)) {
      expect(stage.label).toBe(macroStageLabel(stage.stage));
      expect(stage.hint).toBe(TODOS_STAGE_HINT[stage.stage as Exclude<OrderMacroStage, "finalizado">]);
      for (const s of stage.substages) {
        if (s.substage === null) expect(s.label).toBe(TODOS_SIN_SUBETAPA);
        else if (s.substage in MACRO_SUBSTAGE_LABEL) expect(s.label).toBe(MACRO_SUBSTAGE_LABEL[s.substage as MacroSubstage]);
        else expect(s.label).toBe(s.substage);
      }
    }
    expect(findStage(b, "en_curso")!.substages.at(-1)!.label).toBe(MACRO_SUBSTAGE_LABEL.pago_requerido_pendiente);
    expect(findStage(b, "por_despachar")!.substages.at(-1)!.label).toBe("estado_inventado");
  });

  it("cada enlace abre el Master con la cobertura Lima, la etapa y, si es del canon, la subetapa", () => {
    for (const storeId of [null, A]) {
      const b = limaOpenBreakdown(
        [...PRODUCCION, row("por_cerrar", null, 1), row("en_curso", "codigo_raro", 1)].map((r) => ({ ...r, storeId: A })),
        { storeId, repro: REPRO_PRODUCCION },
      );
      for (const stage of allStages(b)) {
        for (const s of stage.substages) {
          if (s.inPage) continue;
          expect(s.href!.startsWith(`${MASTER_PATH}?`)).toBe(true);
          const params = new URLSearchParams(s.href!.slice(MASTER_PATH.length + 1));
          const q = parseMasterQuery(params);
          expect([...q.filters.coverages]).toEqual(["lima"]);
          expect([...q.filters.stores]).toEqual(storeId ? [storeId] : []);
          expect(q.page).toBe(1);
          expect(q.sortKey).toBe("created");
          expect(params.get("view")).toBe(stage.stage);
          const canon: readonly string[] = MACRO_SUBSTAGES_BY_STAGE[stage.stage];
          if (s.substage && canon.includes(s.substage)) expect(params.get("substage")).toBe(s.substage);
          else expect(params.has("substage")).toBe(false);
        }
      }
    }
  });
});

describe("parseLimaOpenCounts", () => {
  it("lee el snake_case de la RPC y convierte el bigint en texto a número", () => {
    expect(
      parseLimaOpenCounts([
        { store_id: A, macro_stage: "en_curso", macro_substage: "en_reparto", total: "12", over_7: "3", over_30: 0 },
        { store_id: B, macro_stage: "por_cerrar", macro_substage: null, total: 4, over_7: 4, over_30: "1" },
      ]),
    ).toEqual([
      { storeId: A, stage: "en_curso", substage: "en_reparto", total: 12, over7: 3, over30: 0 },
      { storeId: B, stage: "por_cerrar", substage: null, total: 4, over7: 4, over30: 1 },
    ]);
  });

  it("descarta finalizado, etapas desconocidas, filas sin tienda y cifras que no se entienden", () => {
    const ok = { store_id: A, macro_stage: "preparacion", macro_substage: "por_armar", total: 1, over_7: 0, over_30: 0 };
    expect(
      parseLimaOpenCounts([
        ok,
        { ...ok, macro_stage: "finalizado", macro_substage: "entregado_cerrado" },
        { ...ok, macro_stage: "inventada" },
        { ...ok, macro_stage: null },
        { ...ok, store_id: null },
        { ...ok, store_id: "" },
        { ...ok, total: "doce" },
        { ...ok, total: -1 },
        { ...ok, total: 1.5 },
        { ...ok, over_7: null },
        { ...ok, over_30: undefined },
        null,
        "fila",
        42,
      ]),
    ).toEqual([{ storeId: A, stage: "preparacion", substage: "por_armar", total: 1, over7: 0, over30: 0 }]);
  });

  it("una subetapa vacía es «sin subetapa»", () => {
    const [r] = parseLimaOpenCounts([{ store_id: A, macro_stage: "por_cerrar", macro_substage: "  ", total: 1, over_7: 0, over_30: 0 }]);
    expect(r!.substage).toBeNull();
  });

  it("lo que no es una lista da una lista vacía", () => {
    expect(parseLimaOpenCounts(null)).toEqual([]);
    expect(parseLimaOpenCounts(undefined)).toEqual([]);
    expect(parseLimaOpenCounts({ total: 1 })).toEqual([]);
  });
});

describe("reproAging", () => {
  it("más de 7 y más de 30 son estrictos", () => {
    const days = (d: number | null) => ({ daysInStage: d });
    expect(reproAging([days(7)])).toEqual({ total: 1, over7: 0, over30: 0 });
    expect(reproAging([days(8)])).toEqual({ total: 1, over7: 1, over30: 0 });
    expect(reproAging([days(30)])).toEqual({ total: 1, over7: 1, over30: 0 });
    expect(reproAging([days(31)])).toEqual({ total: 1, over7: 1, over30: 1 });
  });

  it("sin días cuenta solo en el total", () => {
    expect(reproAging([{ daysInStage: null }, { daysInStage: 0 }, { daysInStage: 45 }])).toEqual({ total: 3, over7: 1, over30: 1 });
    expect(reproAging([])).toEqual({ total: 0, over7: 0, over30: 0 });
  });
});

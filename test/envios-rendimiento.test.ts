import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Envíos no repinta 3.000 filas por cada tecla.
 *
 * Medido el 12-09-2026: Pendiente carga 3.089 filas y Entregado 4.042 (≈3 MB
 * de JSON cada una), y la tabla las pintaba TODAS —once celdas y un botón por
 * fila, más de 30.000 nodos— aunque la pantalla mostrara veinte. Y como la
 * cadena de filtros corría en cada render del tablero devolviendo un array
 * nuevo, cada tecla del buscador, abrir el cajón o un latido de la reserva
 * repintaba la tabla entera detrás.
 */

const src = readFileSync(resolve(process.cwd(), "components/shipments.tsx"), "utf8");

describe("la tabla solo se repinta cuando cambian sus filas", () => {
  it("está memoizada y sus props son estables", () => {
    expect(src).toContain("const ShipmentTable = memo(function ShipmentTable({");
    expect(src).toContain("const storeName = useCallback(");
    // El orden vive en el tablero (para poder ofrecer «Siguiente») y también
    // está memoizado: si cambiara de identidad en cada render, la tabla
    // memoizada se repintaría igual.
    expect(src).toContain("const queueOrder = useMemo(");
    expect(src).toContain("const toggleSort = useCallback(");
    expect(src).toContain("const claimedBy = useCallback(");
    const chain = src.slice(src.indexOf("const { filteredWithoutAliclikRoute, aliclikRouteCounts, filtered, fenixRowsForExport } = useMemo("));
    expect(chain).toContain("aliclikRouteFilter,\n  ]);");
    // Las opciones de los filtros tampoco se recalculan por tecla.
    expect(src).toContain("const departmentOptions = useMemo(");
    expect(src).toContain("const districtOptions = useMemo(");
  });
});

describe("se pintan 200 filas, no 4.000", () => {
  it("la ventana se aplica DESPUÉS de ordenar y filtrar el conjunto entero", () => {
    expect(src).toContain("const VISIBLE_STEP = 200;");
    // La tabla recibe las filas YA ordenadas y solo entonces recorta.
    expect(src).toContain("rows: sortedRows,");
    const i = src.indexOf("const queueOrder = useMemo(");
    const j = src.indexOf("const shownRows = shownCount < sortedRows.length ? sortedRows.slice(0, shownCount) : sortedRows;");
    expect(i).toBeGreaterThan(-1);
    expect(j).toBeGreaterThan(i);
    expect(src).toContain("{shownRows.map((s) => (");
  });

  it("la ventana vuelve al principio cuando cambian las filas", () => {
    expect(src).toContain(
      "if (windowFor !== sortedRows) {\n    setWindowFor(sortedRows);\n    setVisibleCount(VISIBLE_STEP);",
    );
  });

  it("la fila recién actualizada se ve aunque caiga fuera de la ventana", () => {
    expect(src).toContain("Math.max(visibleCount, highlightedIndex + 1)");
  });

  it("nada se esconde: el pie dice cuántas hay y ofrece más o todas", () => {
    expect(src).toContain("Se muestran {shownRows.length} de {sortedRows.length}.");
    expect(src).toContain("Mostrar {Math.min(VISIBLE_STEP, hiddenCount)} más");
    expect(src).toContain("onClick={() => setVisibleCount(sortedRows.length)}");
  });
});

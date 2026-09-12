import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Envíos es una cola, y el ciclo termina en la siguiente guía.
 *
 * Segunda crítica (25/40): cada vuelta acababa en la misma guía —cerrar,
 * buscar otra vez la fila, volver a abrir—; no se veía quién tenía tomada una
 * guía hasta entrar y encontrarse el cajón bloqueado; y `?open=` se leía al
 * cargar pero no se escribía, así que no había forma de compartir una guía ni
 * de recuperarla tras un F5.
 */

const ui = readFileSync(resolve(process.cwd(), "components/shipments.tsx"), "utf8");

describe("«Siguiente» sin pasar por la tabla", () => {
  it("el orden vive en el tablero, que es quien sabe cuál es la siguiente", () => {
    expect(ui).toContain("const queueOrder = useMemo(");
    expect(ui).toContain("const visibleOrder = searchActive ? (searchOrder ?? []) : queueOrder;");
    expect(ui).toContain("const nextInQueue = (() => {");
    // Si la guía abierta ya salió de la vista, la siguiente es la primera.
    expect(ui).toContain("if (i === -1) return visibleOrder[0]?.id ?? null;");
    expect(ui).toContain("return visibleOrder[i + 1]?.id ?? null;");
  });

  it("la tabla recibe el orden resuelto y el tablero manda el sort", () => {
    expect(ui).toContain("rows: sortedRows,");
    expect(ui).toContain("sort: ShipmentSort;");
    expect(ui).toContain("rows={queueOrder}");
    expect(ui).toContain("rows={searchOrder ?? results}");
    // La tabla ya no guarda su propio `sort`: lo recibe.
    expect(ui).not.toContain("const [sort, setSort] = useState<{");
    expect(ui.match(/claimedBy=\{claimedBy\}/g)?.length).toBe(2);
  });

  it("el botón libera la reserva de esta guía al tomar la siguiente", () => {
    expect(ui).toContain("nextShipmentId={nextInQueue}");
    expect(ui).toContain("onClick={() => handleOpenShipment(nextShipmentId)}");
    expect(ui).toContain("Siguiente →");
    // `handleOpenShipment` pasa por requestExit → doExit, que suelta el claim.
    expect(ui).toContain('if (exit.kind === "open") onOpenShipment(exit.id);');
    expect(ui).toContain("releaseCurrentClaim();\n    if (exit.kind === \"open\")");
  });
});

describe("quién tiene la guía se ve en la fila", () => {
  it("respeta el TTL del servidor y no marca la guía abierta", () => {
    expect(ui).toContain("const claimedBy = useCallback(");
    expect(ui).toContain("if (!row.claimed_by || row.id === openId) return null;");
    expect(ui).toContain("Date.now() - since > CLAIM_TTL_MINUTES * 60_000");
    // En la tabla y en la tarjeta de teléfono.
    expect(ui.match(/\{claimedBy\(s\) && \(/g)?.length).toBe(2);
  });
});

describe("la guía abierta va en la URL", () => {
  it("por replaceState, no por router.push: un push volvería a bajar la vista entera", () => {
    expect(ui).toContain('url.searchParams.set("open", openId)');
    expect(ui).toContain('url.searchParams.delete("open")');
    expect(ui).toContain("window.history.replaceState(window.history.state, \"\", url);");
    const effect = ui.slice(ui.indexOf("const url = new URL(window.location.href);"));
    expect(effect.slice(0, 400)).not.toContain("router.push");
  });
});

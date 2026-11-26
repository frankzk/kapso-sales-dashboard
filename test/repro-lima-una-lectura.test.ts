// Owner, 25-11-2026: «me dicen por ejemplo ahorita que Repro Lima carga demasiado lento».
// Medido el 24-11: 1.056 lecturas enteras de la pantalla en un día (los 1.157 pedidos de Lima cada vez, 2 a
// 8,7 s), porque abrir una ficha, cerrarla y guardar la volvían a pedir, y guardar la pedía tres veces. Ahora
// tomar y soltar el caso no la piden, y cada guardado la trae UNA vez, en su misma respuesta.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  dropReproLimaClaim,
  holdReproLimaClaim,
  localClaimView,
  reproLimaHeldClaims,
  subscribeReproLimaClaims,
  withLocalClaims,
} from "@/lib/repro-lima-queue";

const read = (p: string) => readFileSync(resolve(process.cwd(), p), "utf8");
const actions = read("app/dashboard/pedidos/repro-lima/actions.ts");
const agenda = read("app/dashboard/pedidos/repro-lima/agenda-actions.ts");
const panel = read("components/repro-lima-panel.tsx");
const board = read("components/repro-lima-board.tsx");
const drawer = read("components/order-drawer.tsx");
const body = (src: string, signature: string) => {
  const start = src.indexOf(signature);
  expect(start, signature).toBeGreaterThanOrEqual(0);
  const next = src.indexOf("\nexport ", start + signature.length);
  return src.slice(start, next === -1 ? undefined : next);
};

describe("tomar y soltar el caso no vuelven a pedir la pantalla", () => {
  it("tomar solo revalida cuando la lista estaba vieja: otra persona lo cerró o lo tiene", () => {
    const claim = body(actions, "export async function claimReproCase(");
    const afterRpc = claim.slice(claim.indexOf('admin.rpc("lima_repro_claim"'));
    expect(afterRpc).toContain("const listWasStale = Boolean(claim.needs_reopen) || !claim.claimed || !claim.case_id;");
    expect(afterRpc).toContain("if (listWasStale) revalidatePath(REPRO_LIMA_PATH);");
    // La única revalidación después de la RPC es esa: la toma lograda no pide nada.
    expect(afterRpc.match(/revalidatePath\(/g)?.length).toBe(1);
    expect(afterRpc.indexOf("if (listWasStale) revalidatePath(REPRO_LIMA_PATH);")).toBeLessThan(afterRpc.indexOf("return { caseId: claim.case_id, until: claim.until ?? null };"));
  });

  it("soltar y el latido no revalidan", () => {
    expect(body(actions, "export async function releaseReproCase(")).not.toContain("revalidatePath(");
    expect(body(actions, "export async function renewReproCase(")).not.toContain("revalidatePath(");
  });

  it("un caso fuera de etapa sí: la fila tiene que salir de la lista", () => {
    const claim = body(actions, "export async function claimReproCase(");
    const stale = claim.slice(claim.indexOf('"fuera_de_etapa"'), claim.indexOf('admin.rpc("lima_repro_claim"'));
    expect(stale).toContain("revalidatePath(REPRO_LIMA_PATH);");
  });
});

describe("«Lo atiendes tú» lo dice la ficha de esta pestaña", () => {
  it("la vista: mío es lo tomado aquí; otro viene de la lectura", () => {
    expect(localClaimView("libre", true)).toBe("mio");
    expect(localClaimView("libre", false)).toBe("libre");
    // La lectura decía «mío» y la ficha ya lo soltó: la fila no se queda diciendo «Lo atiendes tú».
    expect(localClaimView("mio", false)).toBe("libre");
    expect(localClaimView("mio", true)).toBe("mio");
    expect(localClaimView("otro", false)).toBe("otro");
    // Lo acabo de tomar y la lectura es de antes: gana lo de esta pestaña.
    expect(localClaimView("otro", true)).toBe("mio");
  });

  it("las filas: la misma lista si nada cambia, y solo se copia la fila que cambia", () => {
    const rows = [
      { orderId: "a", claim: { view: "libre", byName: null } },
      { orderId: "b", claim: { view: "otro", byName: "Daysi" } },
      { orderId: "c", claim: { view: "mio", byName: "Yo" } },
    ];
    expect(withLocalClaims(rows.slice(0, 2), new Set())).toEqual(rows.slice(0, 2));
    const same = rows.slice(0, 2);
    expect(withLocalClaims(same, new Set())).toBe(same);
    const next = withLocalClaims(rows, new Set(["a"]));
    expect(next.map((row) => row.claim.view)).toEqual(["mio", "otro", "libre"]);
    expect(next[1]).toBe(rows[1]);
    expect(next[1]?.claim.byName).toBe("Daysi");
    // No toca las filas de entrada.
    expect(rows.map((row) => row.claim.view)).toEqual(["libre", "otro", "mio"]);
  });

  it("el aviso entre la ficha y el tablero: tomar, soltar, y avisa solo cuando cambia", () => {
    let calls = 0;
    const off = subscribeReproLimaClaims(() => { calls += 1; });
    const before = reproLimaHeldClaims();
    holdReproLimaClaim("pedido-1");
    expect(reproLimaHeldClaims().has("pedido-1")).toBe(true);
    expect(reproLimaHeldClaims()).not.toBe(before);
    const held = reproLimaHeldClaims();
    holdReproLimaClaim("pedido-1");
    // Lo mismo dos veces no avisa ni cambia el objeto (`useSyncExternalStore`).
    expect(reproLimaHeldClaims()).toBe(held);
    expect(calls).toBe(1);
    dropReproLimaClaim("pedido-1");
    dropReproLimaClaim("pedido-1");
    expect(reproLimaHeldClaims().has("pedido-1")).toBe(false);
    expect(calls).toBe(2);
    off();
    holdReproLimaClaim("pedido-2");
    expect(calls).toBe(2);
    dropReproLimaClaim("pedido-2");
  });

  it("la ficha avisa al tomar y al soltar, perder o cerrar", () => {
    expect(panel).toContain('import { dropReproLimaClaim, holdReproLimaClaim } from "@/lib/repro-lima-queue";');
    expect(panel).toContain("holdReproLimaClaim(orderId);");
    // Cerrar la pestaña, perder el latido (dos ramas), la limpieza del efecto, soltar a mano y perderlo al guardar.
    expect(panel.match(/dropReproLimaClaim\(/g)?.length).toBe(6);
    const release = panel.slice(panel.indexOf("function releaseCurrentClaim() {"), panel.indexOf("const mine = mode"));
    expect(release).toContain("dropReproLimaClaim(session.orderId);");
  });

  it("el tablero pone ese candado encima de las filas que enseña", () => {
    expect(board).toContain("const heldHere = useSyncExternalStore(subscribeReproLimaClaims, reproLimaHeldClaims, () => NO_CLAIMS);");
    expect(board).toContain("const reproRows = useMemo(() => withLocalClaims(data.rows, heldHere), [data.rows, heldHere]);");
    expect(board).toContain("const caseById = useMemo(() => new Map(reproRows.map((row) => [row.orderId, row])), [reproRows]);");
    expect(board).toContain("reproRows={reproRows}");
    expect(board).not.toContain("reproRows={data.rows}");
  });
});

describe("una lectura por guardado", () => {
  it("guardar la llamada: la ficha no vuelve a pedir la pantalla que la acción ya trajo", () => {
    // `callId` solo vuelve después de revalidar.
    const record = actions.slice(actions.indexOf("async function recordCall("), actions.indexOf("async function clearPrograms("));
    const done = record.lastIndexOf("revalidatePath(REPRO_LIMA_PATH);");
    expect(done).toBeGreaterThan(-1);
    expect(record.match(/callId: recorded\.call_id,/g)?.length).toBe(2);
    expect(record.lastIndexOf("callId: recorded.call_id,")).toBeGreaterThan(done);
    // Salvo al pasar al siguiente (25-11-2026): ahí la acción no la trae y la ficha la pide de fondo.
    expect(panel).toContain("refreshed: Boolean(result.callId) && !result.refreshDeferred,");
    const onSaved = drawer.slice(drawer.indexOf("function onReproSaved(saved: ReproSaved, advance: boolean) {"));
    expect(onSaved.slice(0, onSaved.indexOf("\n  }\n"))).toContain("if (!saved.refreshed) onSaved();");
  });

  it("«Programar» de la lista trae la pantalla en su respuesta y el tablero no la pide otra vez", () => {
    const fn = body(agenda, "export async function agendarReproLima(");
    expect(fn).toContain("const result = await agendar(input);");
    expect(fn).toContain("if (result.notice) revalidatePath(REPRO_LIMA_PATH);");
    expect(board).toContain("onDone={(f) => setFeedback({ kind: f.kind, text: f.text, mesa: f.mesa ? [f.mesa] : undefined })}");
  });

  it("«No se entregó» y la guía rápida: sus acciones ya revalidan, el tablero no repite", () => {
    expect(board).toContain("<NoEntregoButton row={row} size={size} onDone={(f) => setFeedback(f)} />");
    const reparto = read("app/reparto/actions.ts");
    const report = reparto.slice(reparto.indexOf("export async function reportStop("), reparto.indexOf("async function syncStopForRoute("));
    expect(report.indexOf('revalidatePath("/dashboard/pedidos/repro-lima");')).toBeGreaterThan(-1);
    // El único retorno con éxito va después de revalidar.
    expect(report.match(/ok: true,/g)?.length).toBe(1);
    expect(report.indexOf("ok: true,")).toBeGreaterThan(report.indexOf('revalidatePath("/dashboard/pedidos/repro-lima");'));
    const quick = board.slice(board.indexOf("<QuickGuideButtons"), board.indexOf("onOpenFicha="));
    expect(quick).not.toContain("refresh();");
    const aliclik = read("app/dashboard/pedidos/aliclik-actions.ts");
    const create = aliclik.slice(aliclik.indexOf("export async function createAliclikGuide("), aliclik.indexOf("export async function linkExistingAliclikGuide("));
    expect(create.indexOf("revalidatePath(MASTER_PATH);")).toBeLessThan(create.indexOf("return { notice: result.notice };"));
    const gf = read("app/dashboard/pedidos/gf-courier-actions.ts");
    const gfCreate = gf.slice(gf.indexOf("export async function createGfCourierGuide("), gf.indexOf("export async function cancelGfCourierGuide("));
    expect(gfCreate.indexOf("revalidatePath(MASTER_PATH);")).toBeLessThan(gfCreate.indexOf("return { notice:"));
  });

  it("una lectura que llega sola cuenta como recién leída: volver a la pestaña no la repite", () => {
    expect(board).toContain("  useEffect(() => {\n    lastRefresh.current = Date.now();\n  }, [data, pending]);");
    // Los lotes y volver a la pestaña siguen pidiendo la pantalla.
    expect(board).toContain("startRefresh(() => router.refresh())");
    expect(board).toContain('window.addEventListener("focus", onFocus);');
  });
});

describe("MOM §9.5 lo cuenta", () => {
  it("cuándo se vuelve a leer la lista", () => {
    const mom = read("docs/mom/master-pedidos-v1.md").replace(/\s+/g, " ");
    for (const text of [
      "**Cuándo se vuelve a leer la lista (owner, 25-11-2026: «Repro Lima carga demasiado lento»).**",
      "**Tomar y soltar el caso no vuelven a pedir la lista.**",
      "La fila dice «Lo atiendes tú» por lo que la ficha de esa pestaña tiene tomado, no por la última lectura",
      "**Guardar la trae una sola vez**, en la misma respuesta del guardado",
      "**Al volver a la pestaña** se relee si pasaron 20 segundos desde la última lectura",
      "No cambia ninguna regla: ni el candado, ni el episodio, ni qué se puede atender. Solo cuándo se lee.",
    ]) expect(mom).toContain(text);
    // Los 20 segundos del MOM son los del tablero.
    expect(board).toContain("const FOCUS_REFRESH_MS = 20_000;");
  });
});

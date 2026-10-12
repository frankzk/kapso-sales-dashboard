// «Repro Lima» · la pantalla (fase 1, entrega 1a; MOM §9.5, §11.4-§11.7).
// Lo que la pantalla tiene que cumplir, leído en el código: quién entra, la
// entrada del menú, el candado de la hoja (latido y beacon), el `operationId`
// que se estrena al cambiar el formulario, y las vistas de solo lectura.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8");

const page = read("app/dashboard/pedidos/repro-lima/page.tsx");
const loading = read("app/dashboard/pedidos/repro-lima/loading.tsx");
const board = read("components/repro-lima-board.tsx");
const sheet = read("components/repro-lima-sheet.tsx");
const sidebar = read("components/sidebar.tsx");
const shell = read("components/dashboard-shell.tsx");
const layout = read("app/dashboard/layout.tsx");
const access = read("lib/repro-lima-access.ts");

/** Lo que va entre dos marcas del mismo archivo. */
function between(src: string, start: string, end: string): string {
  const from = src.indexOf(start);
  expect(from, start).toBeGreaterThanOrEqual(0);
  const to = src.indexOf(end, from + start.length);
  expect(to, end).toBeGreaterThan(from);
  return src.slice(from, to + end.length);
}

describe("quién entra (D11, E32, E36)", () => {
  it("la página pide Repro Lima antes de leer nada, con el cliente de servicio", () => {
    expect(page).toContain('export const dynamic = "force-dynamic";');
    const gate = page.indexOf("await requireReproLima()");
    const load = page.indexOf("loadReproLima(createAdminSupabase(), scope)");
    expect(gate).toBeGreaterThan(-1);
    expect(load).toBeGreaterThan(gate);
  });

  it("sin permiso dice de quién es, sin tiendas lo dice, y el error de lectura no tumba el panel", () => {
    expect(page).toContain('scope.reason === "permiso"');
    expect(page).toContain('<EmptyState title="Acceso restringido">{scope.error}</EmptyState>');
    expect(page).toContain('<EmptyState title="No tienes tiendas asignadas">{scope.error}</EmptyState>');
    expect(page).toContain('title="No pudimos cargar Repro Lima"');
    // El texto de E32: el permiso viene del rol, no de un control de Equipo.
    expect(access).toContain("Repro Lima es de quien despacha (rol admin o vendedora). Pide acceso en Equipo.");
    expect(page).not.toContain("Pide «Despachar» en Equipo");
  });

  it("la carga es su propia silueta, no la del Master", () => {
    expect(loading).toContain('aria-label="Cargando Repro Lima"');
    expect(page).toContain('import ReproLimaLoading from "./loading";');
    expect(page).toContain("<Suspense fallback={<ReproLimaLoading />}>");
  });

  it("los componentes de cliente solo importan tipos del acceso (que es de servidor)", () => {
    for (const src of [board, sheet]) {
      expect(src.startsWith('"use client";')).toBe(true);
      expect(src).toContain('import type { ');
      expect(src).not.toMatch(/import \{[^}]*\} from "@\/lib\/repro-lima-access"/);
      expect(src).not.toContain("revalidatePath");
    }
  });
});

describe("la entrada del menú (§9.5, D11)", () => {
  it("«Repro Lima» va justo después de «Repro Provincia» en los dos menús, solo con dispatch.manage", () => {
    expect(sidebar).toContain('const REPRO_LIMA_ITEM: NavItem = { href: "/dashboard/pedidos/repro-lima", label: "Repro Lima", icon: IconTruck };');
    const after = /\{ href: "\/dashboard\/envios", label: "Repro Provincia", icon: IconTruck \},\n\s*\.\.\.\(canReproLima \? \[REPRO_LIMA_ITEM\] : \[\]\),/g;
    expect(sidebar.match(after)?.length).toBe(2);
    expect(sidebar).toContain("navItems(isVendedoraOnly, canValidatePayments, canManageLogistics, canReproLima)");
  });

  it("el permiso sale del layout y pasa por el armazón", () => {
    expect(layout).toContain('const canReproLima = permissions.can("dispatch.manage");');
    expect(layout).toContain("canReproLima={canReproLima}");
    expect(shell).toContain("canReproLima={canReproLima}");
  });

  it("el prefijo más largo la marca a ella y no al Master", () => {
    // /dashboard/pedidos/repro-lima empieza por /dashboard/pedidos/: gana la más larga.
    expect(sidebar).toContain(".sort((a, b) => b.href.length - a.href.length)[0]?.href");
  });
});

describe("el candado de la hoja (D10)", () => {
  const claimEffect = between(sheet, "const onPageHide = () => {", "}, [orderId, mode, reopen, claimAttempt, reload]);");

  it("se toma al abrir, solo al atender: «Ver acuerdo» y «Cerrados» no toman nada (E29)", () => {
    const effect = between(sheet, "useEffect(() => {\n    if (mode !== \"edit\") return;", "}, [orderId, mode, reopen, claimAttempt, reload]);");
    expect(effect.indexOf('if (mode !== "edit") return;')).toBeLessThan(effect.indexOf("claimReproCase(orderId"));
    expect(board).toContain('openRow(row, "read")}>Ver acuerdo</OpsButton>');
    expect(board).toContain('openRow(row, "read")}>Ver</OpsButton>');
    expect(board).toContain('openRow(row, "edit")}>');
  });

  it("late con el mismo intervalo que Envíos y avisa si se pierde, sin borrar el borrador", () => {
    expect(claimEffect).toContain("renewReproCase(result.caseId)");
    expect(claimEffect).toContain("}, REPRO_CLAIM_HEARTBEAT_MS);");
    expect(claimEffect).toContain('setClaimState("lost");');
    expect(sheet).toContain("Lo que escribiste sigue aquí. Vuelve a tomarlo para guardarlo.");
    // Perder el caso apaga el formulario, no lo desmonta.
    expect(sheet).toContain('<fieldset disabled={claimState === "lost"} className="contents">');
  });

  it("cerrar o recargar la pestaña lo suelta con un beacon, solo después de tenerlo", () => {
    expect(claimEffect).toContain('navigator.sendBeacon?.(\n        "/api/repro-lima/release-claim"');
    expect(claimEffect).toContain("JSON.stringify({ caseId: session.caseId })");
    expect(claimEffect.indexOf('setClaimState("mine")')).toBeLessThan(claimEffect.indexOf('window.addEventListener("pagehide", onPageHide)'));
    expect(claimEffect).toContain('window.removeEventListener("pagehide", onPageHide)');
    const route = read("app/api/repro-lima/release-claim/route.ts");
    expect(route).toContain("sb.auth.getClaims()");
    expect(route).toContain('.eq("claimed_by", userId)');
  });

  it("cerrar la hoja, «Soltar» y pasar al siguiente sueltan el caso", () => {
    const release = between(sheet, "function releaseCurrentClaim() {", "\n  }");
    expect(release).toContain("session.shouldRelease = true;");
    expect(release).toContain("releaseReproCase(session.caseId)");
    expect(between(sheet, "function doExit() {", "\n  }")).toContain("releaseCurrentClaim();");
    expect(between(sheet, "function finish(", "\n  }")).toContain("releaseCurrentClaim();");
    expect(sheet).toContain('onClick={() => requestExit("release")}>Soltar</OpsButton>');
  });

  it("con otra persona, solo lectura con la hora en que se libera", () => {
    expect(sheet).toContain('está atendiendo este pedido${holder?.until ? `; se libera a las ${limaHour(holder.until)}` : ""}.');
  });

  it("con texto sin guardar, avisa antes de salir (§11.5)", () => {
    expect(sheet).toContain("Escribiste algo que todavía no se guardó.");
    expect(between(sheet, "function requestExit(", "\n  }")).toContain("setPendingExit(kind)");
  });
});

describe("un envío, un operationId (E3)", () => {
  it("cada formulario estrena un crypto.randomUUID()", () => {
    expect(sheet).toContain("c.randomUUID()");
    expect(sheet).toContain("const [operationId, setOperationId] = useState(newOperationId);");
  });

  it("si el formulario cambia después de enviarlo, se estrena otro", () => {
    const regen = between(sheet, "useEffect(() => {\n    if (submittedRef.current !== null", "}, [fingerprint]);");
    expect(regen).toContain("submittedRef.current !== fingerprint");
    expect(regen).toContain("setOperationId(newOperationId());");
    const save = between(sheet, "function save(advance: boolean) {", "\n  }\n");
    // Antes de cualquiera de los dos envíos: la llamada y «Desarmar y cerrar sin llamada».
    expect(save.indexOf("submittedRef.current = fingerprint;")).toBeLessThan(save.indexOf("closeReproCase("));
    expect(save.indexOf("submittedRef.current = fingerprint;")).toBeLessThan(save.indexOf("registerReproCall(input)"));
    expect(save).toContain("closeReproCase({ caseId: id, operationId,");
    expect(save).toContain("operationId,\n      outcome,");
  });
});

describe("la hoja decide con las reglas del servidor (§11.6, E14-E19)", () => {
  it("la fecha nunca se preselecciona (D9) y el Swayp usa su selector sin domingos (E15)", () => {
    expect(sheet).toContain('const [agreedOn, setAgreedOn] = useState("");');
    expect(sheet).toContain("<SwaypDispatchDateSelect");
    expect(sheet).toContain('const swayp = courier === "fenix";');
    expect(sheet).toContain("agreementDateProblem({ day, today, nowMinute: clock.minute, cutoff: current.cutoff, courier, boxAction: action })");
  });

  it("la hora de la próxima llamada pasa siempre por limaDateTimeIso (E19)", () => {
    expect(sheet).toContain("iso: limaDateTimeFromInput(e.target.value)");
    expect(sheet).not.toMatch(/new Date\(e\.target\.value\)/);
    expect(sheet).toContain("nextRoundAt(new Date())");
  });

  it("Urpi va apagado con su porqué (E16) y la acción de caja viaja como expectedBoxAction", () => {
    expect(sheet).toContain('[...REPRO_COURIER_CHOICES, "urpi" as const]');
    expect(sheet).toContain("reproCourierDisabledReason(c)");
    expect(sheet).toContain("input.expectedBoxAction = action;");
    expect(sheet).toContain("boxActionReadyLabel(decided.action, courier, current.cutoff)");
  });

  it("«Ya no lo quiere» pide un segundo clic que nombra el pedido y no anula la venta (§11.5)", () => {
    expect(sheet).toContain("Sí, desarmar y cerrar {current.orderName}");
    expect(sheet).toContain("No anula la venta: solo Shopify la anula.");
    expect(sheet).toContain('if (outcome === "no_quiere") input.confirmOrderName = current.orderName;');
  });
});

describe("solo lectura y reabrir (E12, E29)", () => {
  it("«Volver a atender» pide el segundo clic en la hoja y reabre con `reopen`", () => {
    expect(board).toContain('openRow(row, "read", true)}>Volver a atender</OpsButton>');
    expect(sheet).toContain("Si Almacén ya la desarmó, elige «No esperar la caja».");
    expect(sheet).toContain('onClick={() => { setShowReopen(false); setReopen(true); setMode("edit"); }}');
    expect(sheet).toContain("claimReproCase(orderId, reopen ? { reopen: true } : {})");
  });

  it("«Ya la encontré: programar» pide «La caja está en la oficina» antes de programar", () => {
    for (const src of [board, sheet]) {
      expect(src).toContain("Ya la encontré: programar");
      expect(src).toContain("La caja está en la oficina");
      expect(src).toContain("...(found ? { found: true } : {})");
    }
  });
});

describe("el tablero (E31, E33)", () => {
  it("la ficha se abre sobre Repro Lima, nunca navegando al Master", () => {
    expect(sheet).toContain("const openDrawer = useOpenOrderDrawer();");
    expect(board).toContain("<OrderLink");
    for (const src of [board, sheet]) expect(src).not.toContain('href="/dashboard/pedidos?');
  });

  it("tabla desde 1280 px y filas con líneas finas más angosto", () => {
    expect(board).toContain("hidden max-h-[70vh] overflow-auto border-t border-line xl:block");
    expect(board).toContain('<ul className="divide-y divide-line border-t border-line xl:hidden">');
  });

  it("cuatro tarjetas que filtran y cuentan, también «Cerrados»", () => {
    expect(board).toContain("grid grid-cols-2 gap-2 sm:grid-cols-4");
    expect(board).toContain("{REPRO_LISTS.map((l) => (\n          <StatusCard");
    expect(board).toContain('label: "Cerrados · esperan anulación"');
    expect(board).toContain("`Programados · ${toReview} a revisar`");
  });

  it("las listas vacías y la búsqueda sin resultado lo dicen", () => {
    for (const text of [
      "Nada por decidir. Los «No entregado» nuevos aparecen aquí.",
      "Nadie pidió que lo llamen después.",
      "Todavía no hay acuerdos.",
      "Ningún caso cerrado espera la anulación.",
      "`Ningún pedido coincide con «${query.trim()}».`",
    ]) expect(board).toContain(text);
  });

  it("se relee tras cada acción y al volver a la pestaña", () => {
    expect(board).toContain("startRefresh(() => router.refresh())");
    expect(board).toContain('window.addEventListener("focus", onFocus);');
  });
});

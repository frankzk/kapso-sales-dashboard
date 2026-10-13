// «Repro Lima» · la pantalla (fase 1, entrega 1a; MOM §9.5, §11.4-§11.7).
// Lo que la pantalla tiene que cumplir, leído en el código: quién entra, la
// entrada del menú, el candado de la hoja (latido y beacon), el `operationId`
// que se estrena al cambiar el formulario, y las vistas de solo lectura.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { RESCHEDULE_MAX_DAYS } from "@/lib/gf-dispatch-program";
import { agreementDateProblem, materializationPlan, type BoxLocation } from "@/lib/repro-lima";
import { swaypDispatchDayOptions } from "@/lib/swayp-dispatch-days";
import { planText } from "@/components/repro-lima-sheet";
import { navItems } from "@/components/sidebar";

// La hoja importa las acciones de servidor; aquí solo se prueban sus textos.
vi.mock("@/app/dashboard/pedidos/repro-lima/actions", () => ({}));

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
    expect(access).toContain("Repro Lima es de quien despacha (rol «Despacho y Grupo GF»). Pide ese rol en Equipo.");
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
    expect(sidebar).toContain("navItems(isVendedoraOnly, canValidatePayments, canManageLogistics, navAccess, canReproLima)");
  });

  it("con los roles que se acumulan (§16), la entrada sigue al permiso, no al menú de cada rol", () => {
    const hrefs = (vendedora: boolean, repro: boolean) => navItems(vendedora, false, false, undefined, repro).map((it) => it.href);
    for (const vendedora of [false, true]) {
      const items = hrefs(vendedora, true);
      expect(items[items.indexOf("/dashboard/envios") + 1]).toBe("/dashboard/pedidos/repro-lima");
      expect(hrefs(vendedora, false)).not.toContain("/dashboard/pedidos/repro-lima");
    }
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
  const claimEffect = between(sheet, "const onPageHide = () => {", "}, [orderId, mode, claimAttempt, reload]);");
  const cleanup = between(claimEffect, "    return () => {\n      active = false;", "\n    };\n  }, [orderId");
  const finish = between(sheet, "function finish(", "\n  }\n");

  it("se toma al abrir, solo al atender: «Ver acuerdo» y «Cerrados» no toman nada (E29)", () => {
    const effect = between(sheet, "useEffect(() => {\n    if (mode !== \"edit\") return;", "}, [orderId, mode, claimAttempt, reload]);");
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
    expect(sheet).toContain('const showForm = mine || (mode === "edit" && (claimState === "lost" || hasDraft));');
    expect(sheet).toContain('{showForm && (\n          <fieldset disabled={!mine} className="contents">');
  });

  it("con algo escrito, sin el caso (tomándolo, con otra persona o si falló la toma) lo escrito se ve apagado (§9.5)", () => {
    // La vuelta del bfcache o «Volver a tomarlo» pueden terminar en «held» o
    // «error»: el borrador no se esconde, solo se apaga hasta tener el caso.
    expect(sheet).toContain('(claimState === "lost" || hasDraft)');
    // La silueta de «Tomando el caso…» solo cuando no hay nada que mostrar.
    expect(sheet).toContain('{mode === "edit" && claimState === "claiming" && !showForm && (');
    expect(sheet).not.toContain("{(mine || claimState === \"lost\") && (");
    expect(sheet).toContain("Lo que escribiste sigue aquí. Reintenta para guardarlo.");
  });

  it("la hoja calcula «Qué hacer con la caja» con lo mismo que el servidor (reabierto y reintento)", () => {
    const call = between(sheet, "const boxInput = (c: ReproCourier): ReproBoxActionResult => reproBoxAction({", "});");
    expect(call).toContain("reopened: current.reopened,");
    expect(call).toContain("retryAdmission: current.retryAdmission,");
    expect(sheet).toContain("Kapta no la crea ${faltaSalidaWhy(boxAction)}");
  });

  it("el MOM dice lo que hace la hoja si tomar el caso falla (§9.5, el candado)", () => {
    const mom = readFileSync(resolve(process.cwd(), "docs/mom/master-pedidos-v1.md"), "utf8").replace(/\s+/g, " ");
    expect(mom).toContain("tomarlo falla, la hoja dice «No pudimos tomar el caso. Vuelve a intentarlo.», también con «Reintentar».");
    expect(mom).toContain("lo escrito sigue a la vista pero sin poder editarse («Lo que escribiste sigue aquí. Reintenta para guardarlo.»)");
  });

  it("si la toma falla, «Reintentar» vuelve a tomar sin cerrar la hoja", () => {
    expect(sheet).toContain('{(claimState === "held" || claimState === "error") && (');
    const retry = between(sheet, '{(claimState === "held" || claimState === "error") && (', "</OpsButton>");
    expect(retry).toContain("onClick={() => setClaimAttempt((n) => n + 1)}>Reintentar</OpsButton>");
    // Cerrar ya no es la única salida: cerrar descartaría lo escrito.
    expect(sheet).not.toContain("Cierra y vuelve a intentarlo");
    expect(sheet).toContain('setClaimMessage("No pudimos tomar el caso. Vuelve a intentarlo.");');
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

  it("desmontar la hoja sin «Cerrar» ni «Soltar» (atrás del navegador) también lo suelta, una sola vez", () => {
    // Con el caso tomado y todavía sin soltar: así no suelta dos veces lo que
    // ya soltaron «Cerrar», «Soltar», el guardado o el beacon.
    expect(cleanup).toContain("if (session.caseId && !session.shouldRelease) {");
    expect(cleanup.indexOf("session.shouldRelease = true;")).toBeLessThan(cleanup.indexOf("releaseReproCase(session.caseId)"));
    // Con la toma en camino, la suelta al responder; si el efecto volvió a
    // correr (otra sesión), no suelta la toma nueva.
    const inactive = between(claimEffect, "if (!active) {", "return;\n        }");
    expect(inactive).toContain("claimSessionRef.current === session && !(\"error\" in result)");
    expect(inactive).toContain("releaseReproCase(result.caseId)");
    expect(claimEffect.indexOf("if (session.shouldRelease) {")).toBeLessThan(claimEffect.indexOf("if (!active) {"));
  });

  it("si la página vuelve del bfcache, vuelve a tomar el caso que soltó el beacon", () => {
    expect(claimEffect).toContain("if (event.persisted && session.shouldRelease) setClaimAttempt((n) => n + 1);");
    expect(claimEffect.indexOf('setClaimState("mine")')).toBeLessThan(claimEffect.indexOf('window.addEventListener("pageshow", onPageShow)'));
    expect(cleanup).toContain('window.removeEventListener("pageshow", onPageShow)');
  });

  it("un guardado sin el caso (claimLost) lo da por perdido: «Volver a tomarlo» y lo escrito se queda", () => {
    const lost = between(finish, "if (result.claimLost) {", "return;\n    }");
    expect(lost).toContain('setClaimState("lost");');
    expect(lost).toContain("setClaimMessage(result.error ?? null);");
    // Antes del aviso de error y sin soltar ni avisar al tablero: la hoja sigue abierta.
    expect(finish.indexOf("if (result.claimLost)")).toBeLessThan(finish.indexOf('setFeedback({ kind: "error"'));
    expect(lost).not.toContain("releaseCurrentClaim");
    expect(lost).not.toContain("onSaved");
    expect(sheet).toContain('onClick={() => setClaimAttempt((n) => n + 1)}>Volver a tomarlo</OpsButton>');
  });

  it("«La caja cambió mientras decidías» (boxChanged) relee los hechos y conserva lo escrito (§9.5)", () => {
    const changed = between(finish, "if (result.boxChanged) {", "\n    }");
    expect(changed).toContain("void reload();");
    expect(changed).toContain("onChanged();");
    // Releer recalcula la acción de la caja desde los hechos frescos (`current`).
    expect(sheet).toContain("const current = fresh ?? row;");
    expect(sheet).toContain("const box = current.box;");
    // El borrador vive en el estado de la hoja: releer no lo toca.
    expect(changed).not.toMatch(/setNote|setOutcome|setAgreedOn|setChanges/);
  });

  it("con otra persona, solo lectura con la hora en que se libera", () => {
    expect(sheet).toContain('está atendiendo este pedido${holder?.until ? `; se libera a las ${limaHour(holder.until)}` : ""}.');
  });

  it("con texto sin guardar, avisa antes de salir (§11.5)", () => {
    expect(sheet).toContain("Escribiste algo que todavía no se guardó.");
    expect(between(sheet, "function requestExit(", "\n  }")).toContain("setPendingExit(kind)");
  });

  it("el aviso de texto sin guardar vale en cualquier estado del candado, no solo con el caso", () => {
    // Con otra persona («held»), tomándolo o si falló la toma, «Cerrar», la X y
    // Escape también pasan por aquí: sin el aviso, la nota se perdía callada.
    const exit = between(sheet, "function requestExit(", "\n  }");
    expect(exit).toContain('if (mode === "edit" && hasDraft) { setPendingExit(kind); return; }');
    expect(exit).not.toContain("mine");
    expect(exit).not.toContain("claimState");
    expect(sheet).toContain('onClose={() => requestExit("close")}');
    expect(sheet).toContain('exitRef.current("close");');
    expect(sheet).toContain('onClick={() => requestExit("close")}>Cerrar</OpsButton>');
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

  it("«No esperar la caja» con la caja que no consta solo en un caso reabierto, como el servidor (E29, §9.3)", () => {
    expect(sheet).toContain("const showNoEsperar = noEsperarCajaAplica(box, current.reopened);");
    expect(between(sheet, "const boxInput = (c: ReproCourier)", "\n  });")).toContain("reopened: current.reopened,");
  });

  it("Swayp ofrece todas las fechas hasta los 60 días del servidor, también la que viene de otro courier", () => {
    expect(sheet).toContain("const maxDay = shiftDay(today, RESCHEDULE_MAX_DAYS);");
    expect(sheet).toContain("<SwaypDispatchDateSelect value={agreedOn} lastDay={maxDay}");
    const select = read("components/swayp-dispatch-date-select.tsx");
    expect(select).toContain("swaypDispatchDayOptions(limaTodayKey(), undefined, lastDay)");
  });

  it("toda fecha Swayp que acepta el acuerdo está en la lista de la hoja, y ninguna que rechace", () => {
    // Lunes 12-10-2026 a las 10:00 de Lima, como la hoja: hoy, el tope de 60 días y la regla del servidor.
    const today = "2026-10-12";
    const lastDay = new Date(Date.parse(`${today}T12:00:00Z`) + RESCHEDULE_MAX_DAYS * 86_400_000).toISOString().slice(0, 10);
    const offered = new Set(swaypDispatchDayOptions(today, undefined, lastDay).map((o) => o.value));
    for (let i = 0; i <= RESCHEDULE_MAX_DAYS + 2; i += 1) {
      const day = new Date(Date.parse(`${today}T12:00:00Z`) + i * 86_400_000).toISOString().slice(0, 10);
      const ok = agreementDateProblem({ day, today, nowMinute: 600, cutoff: "12:00:00", courier: "fenix", boxAction: null }) === null;
      expect(offered.has(day), day).toBe(ok);
    }
    // vie 20/11: a 39 días, la que traía «Otra fecha» de Grupo GF.
    expect(offered.has("2026-11-20")).toBe(true);
  });

  it("«Falta la salida nueva» de una caja nueva desde stock no culpa a la caja en oficina (§9.5)", () => {
    // Un caso reabierto con la salida propia fuera de la oficina, y la caja que
    // vuelve con Tanders sin reintento: nadie saca la salida y la caja no está.
    const lost: BoxLocation = { kind: "desconocida", own: true, block: "fuera_de_oficina" };
    const returning: BoxLocation = { kind: "volviendo_courier", courier: "Tanders" };
    for (const box of [lost, returning]) {
      const plan = materializationPlan({ courier: "propio", boxAction: "caja_nueva_stock", box, retryAdmission: false });
      expect(plan, box.kind).toEqual({ no: "falta_salida" });
      const text = planText(plan, "propio", box, "caja_nueva_stock");
      expect(text).toBe("todavía no: falta la salida nueva (Kapta no la crea para una caja nueva desde stock). Avisa a Despacho GF.");
      expect(text).not.toContain("en oficina");
    }
    // Las lagunas (un cambio de producto con la salida propia viva) siguen igual.
    const office: BoxLocation = { kind: "en_oficina", since: null };
    expect(planText({ no: "falta_salida" }, "propio", office, "desarmar_rearmar")).toContain("Kapta no la crea con la caja en oficina");
    expect(planText({ no: "falta_salida" }, "propio", office, null)).toContain("Kapta no la crea con la caja en oficina");
    // Las dos llamadas le pasan la acción de la caja: la del acuerdo guardado y la calculada.
    expect(sheet).toContain("planText(current.plan, agreement.courier, current.box, isBoxAction(agreement.boxAction) ? agreement.boxAction : null)");
    expect(sheet).toContain("planText(plan, courier, box, decided.action)");
    expect(sheet.match(/planText\(/g)?.length).toBe(3);
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
    expect(sheet).toContain('onClick={() => { setShowReopen(false); reopenRef.current = true; setMode("edit"); setClaimAttempt((n) => n + 1); }}');
    expect(sheet).toContain("claimReproCase(orderId, reopen ? { reopen: true } : {})");
  });

  it("`reopen` vale para una sola toma: «Reintentar» y «Volver a tomarlo» no reabren", () => {
    // Un ref, no un estado en las dependencias: borrarlo no vuelve a tomar.
    expect(sheet).toContain("const reopenRef = useRef(false);");
    expect(sheet).not.toMatch(/useState\(false\);\s*\n.*setReopen|const \[reopen, setReopen\]/);
    const effect = between(sheet, "useEffect(() => {\n    if (mode !== \"edit\") return;", "}, [orderId, mode, claimAttempt, reload]);");
    expect(effect).toContain("const reopen = reopenRef.current;");
    // Se borra al responder la toma (éxito, otra persona, error o fallo de red).
    expect(between(effect, ".then((result) => {", "if (session.shouldRelease)")).toContain("reopenRef.current = false;");
    expect(between(effect, ".catch(() => {\n        reopenRef", "});")).toContain("reopenRef.current = false;");
    // Los botones que vuelven a tomar no lo encienden.
    expect(sheet.match(/reopenRef\.current = true/g)?.length).toBe(1);
    expect(sheet).toContain('onClick={() => setClaimAttempt((n) => n + 1)}>Reintentar</OpsButton>');
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

  it("«Guardar y pasar al siguiente» no tapa un error ni un aviso con la hoja siguiente", () => {
    const onSaved = between(board, "function onSaved(saved: ReproSaved, advance: boolean) {", "\n  }\n");
    // Un error o la Mesa de ruta: no pasa; la hoja se cierra y el aviso queda en el tablero.
    expect(onSaved).toContain("const next = advance && !saved.error && !saved.mesa ? nextAfter(saved.orderId) : null;");
    expect(onSaved).toContain("else setOpen(null);");
    // Lo demás («Avisa a Almacén…») va arriba de la hoja siguiente.
    expect(onSaved).toContain('if (next) openRow(next, "edit", false, { orderName: saved.orderName, text });');
    expect(board).toContain("previous={open.previous}");
    expect(sheet).toContain('<Banner tone="ok" role="status" title={previous.orderName}>');
    // Arriba de todo: antes del candado.
    expect(sheet.indexOf("{previous && (")).toBeLessThan(sheet.indexOf("{/* El candado, en una línea con su punto. */}"));
  });
});

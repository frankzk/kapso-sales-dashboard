// «Repro Lima» · la pantalla (fase 1, entrega 1a; MOM §9.5, §11.4-§11.7).
// Lo que la pantalla tiene que cumplir, leído en el código: quién entra, la
// entrada del menú, el candado de la hoja (latido y beacon), el `operationId`
// que se estrena al cambiar el formulario, y las vistas de solo lectura.

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { RESCHEDULE_MAX_DAYS } from "@/lib/gf-dispatch-program";
import { parseMasterQuery } from "@/lib/master-query";
import { agreementDateProblem, materializationPlan, REPRO_LISTS, type BoxLocation } from "@/lib/repro-lima";
import { limaOpenBreakdown, type LimaOpenCountRow, type StageAging } from "@/lib/repro-lima-todos";
import { swaypDispatchDayOptions } from "@/lib/swayp-dispatch-days";
import { planText } from "@/components/repro-lima-sheet";
import { ReproLimaTodos } from "@/components/repro-lima-todos";
import { ReproLimaBoard } from "@/components/repro-lima-board";
import type { ReproLimaData, ReproRow } from "@/lib/repro-lima-access";
import { navItems } from "@/components/sidebar";

// La hoja importa las acciones de servidor; aquí solo se prueban sus textos.
vi.mock("@/app/dashboard/pedidos/repro-lima/actions", () => ({}));
// La chapa de etapa vive junto a la ficha, que arrastra acciones de servidor:
// aquí basta con saber de qué etapa es.
vi.mock("@/components/order-master-shared", () => ({
  MacroStageDot: ({ stage }: { stage: string }) => createElement("span", { "data-dot": stage }),
}));
// El tablero lee la vista de la URL; cada prueba elige la suya.
const nav = vi.hoisted(() => ({ search: "" }));
vi.mock("next/navigation", () => ({
  usePathname: () => "/dashboard/pedidos/repro-lima",
  useSearchParams: () => new URLSearchParams(nav.search),
  useRouter: () => ({ refresh: () => {} }),
}));

const read = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8");

const page = read("app/dashboard/pedidos/repro-lima/page.tsx");
const loading = read("app/dashboard/pedidos/repro-lima/loading.tsx");
const board = read("components/repro-lima-board.tsx");
const todos = read("components/repro-lima-todos.tsx");
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
    // «Todos» también se cuenta después del permiso, y llega al tablero.
    expect(page.indexOf("loadLimaOpenCounts(createAdminSupabase(), scope)")).toBeGreaterThan(gate);
    expect(page).toContain("openCounts={openCounts}");
  });

  it("sin permiso dice de quién es, sin tiendas lo dice, y el error de lectura no tumba el panel", () => {
    expect(page).toContain('scope.reason === "permiso"');
    expect(page).toContain('<EmptyState title="Acceso restringido">{scope.error}</EmptyState>');
    expect(page).toContain('<EmptyState title="No tienes tiendas asignadas">{scope.error}</EmptyState>');
    expect(page).toContain('title="No pudimos cargar Repro Lima"');
    // El texto de E32: el permiso viene del rol, no de un control de Equipo.
    expect(access).toContain("Repro Lima es de quien llama a los clientes o despacha (rol «Asesora» o «Despacho y Grupo GF»). Pide uno de esos roles en Equipo.");
    expect(page).not.toContain("Pide «Despachar» en Equipo");
  });

  it("la carga es su propia silueta, no la del Master", () => {
    expect(loading).toContain('aria-label="Cargando Repro Lima"');
    // Las cuatro tarjetas de lista y «Todos».
    expect(loading).toContain("length: 5");
    expect(page).toContain('import ReproLimaLoading from "./loading";');
    expect(page).toContain("<Suspense fallback={<ReproLimaLoading />}>");
  });

  it("los componentes de cliente solo importan tipos del acceso (que es de servidor)", () => {
    for (const src of [board, sheet, todos]) {
      expect(src.startsWith('"use client";')).toBe(true);
      expect(src).toContain('import type { ');
      expect(src).not.toMatch(/import \{[^}]*\} from "@\/lib\/repro-lima-access"/);
      expect(src).not.toContain("revalidatePath");
    }
  });
});

describe("la entrada del menú (§9.5, D11)", () => {
  it("«Repro Lima» va justo después de «Repro Provincia» en los dos menús, solo con repro_lima.manage", () => {
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
    expect(layout).toContain('const canReproLima = permissions.can("repro_lima.manage");');
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
    for (const src of [board, sheet, todos]) expect(src).not.toContain('href="/dashboard/pedidos?');
  });

  it("tabla desde 1280 px y filas con líneas finas más angosto", () => {
    expect(board).toContain("hidden max-h-[70vh] overflow-auto border-t border-line xl:block");
    expect(board).toContain('<ul className="divide-y divide-line border-t border-line xl:hidden">');
  });

  it("cuatro listas y «Todos» que filtran y cuentan", () => {
    expect(board).toContain("grid grid-cols-2 gap-2 sm:grid-cols-4");
    expect(board).toContain("{REPRO_LISTS.map((l) => (\n          <StatusCard");
    expect(board).toContain('label: "Cerrados · esperan anulación"');
    expect(board).toContain("`Programados · ${toReview} a revisar`");
    // «Todos»: la quinta columna desde 1024 px y una fila entera en el teléfono.
    expect(board).toContain("lg:grid-cols-5");
    expect(board).toContain("col-span-2 sm:col-span-4 lg:col-span-1");
    expect(board).toContain('label="Todos · por entregar"');
    expect(board).toContain("value={breakdown.totals.porEntregar}");
    // Va DESPUÉS de las cuatro listas y solo con el conteo leído.
    expect(board.indexOf('label="Todos · por entregar"')).toBeGreaterThan(board.indexOf("{REPRO_LISTS.map((l) => (\n          <StatusCard"));
    expect(board).toContain("{breakdown && (");
    // La vista va en la URL, sin volver a pedir la página.
    expect(board).toContain('searchParams.get("vista") === "todos"');
    expect(board).toContain("window.history.replaceState(");
    expect(board).not.toMatch(/router\.(push|replace)\(/);
    // Entrar a «Todos» quita la búsqueda; una lista vuelve a las listas.
    const todosCard = between(board, 'label="Todos · por entregar"', "/>");
    expect(todosCard).toContain('onClick={() => { setQuery(""); showView("todos"); }}');
    expect(todosCard).toContain('active={view === "todos"}');
    expect(board).toContain('active={view === "listas" && list === l}');
    expect(board).toContain('onClick={() => { setList(l); showView("listas"); }}');
    // «Por reprogramar Lima» sale de las filas del tablero, por tienda y sin la búsqueda.
    expect(board).toContain("reproAging(storeScoped)");
    expect(board).toContain("const scoped = useMemo(() => storeScoped.filter((row) => matches(row, query))");
    // En «Todos», sin búsqueda, y la línea dice lo que falta entregar.
    expect(board).toContain("todavía por entregar");
    expect(board).toContain('aria-label={todos ? "Todos" : LIST_CARD[list].label}');
    expect(board).toContain("<ReproLimaTodos breakdown={todos} lists={lists} onOpenList={onOpenList} />");
    // Las cuatro listas de «Todos» se cuentan sin la búsqueda, y la búsqueda se
    // quita aunque se llegue a «Todos» por la URL.
    expect(board).toContain("for (const row of storeScoped) out[row.list] += 1;");
    expect(board).toContain("count: storeCounts[l]");
    expect(board).toContain('useEffect(() => { if (view === "todos") setQuery(""); }, [view]);');
    // Sin conteo, `vista` sale de la URL; al abrir una lista desde «Todos» el foco va a la sección.
    expect(board).toContain('const staleTodos = !openCounts && searchParams.get("vista") === "todos";');
    expect(board).toContain("window.requestAnimationFrame(() => listSection.current?.focus());");
    expect(board).toContain("<section ref={listSection} tabIndex={-1}");
  });

  it("«Todos» agrupa por etapa y subetapa del Master, con enlaces a sus colas (§9.5)", () => {
    expect(todos).toContain("No hay pedidos de Lima sin estado final.");
    expect(todos).toContain("con más de 7 días");
    expect(todos).toContain("con más de 30");
    expect(todos).toContain("MacroStageDot");
    // Los dos bloques: lo que falta entregar y, aparte y abierto, lo que falta cerrar.
    expect(todos).toContain('title="Todavía por entregar"');
    expect(todos).toContain('title="Ya entregado, anulado o devuelto: falta cerrar"');
    expect(todos).toContain("En Lima, lo que no se entrega vuelve a «Por reprogramar Lima»; solo la entrega lo pasa a «Por cerrar».");
    expect(todos).toContain("Cada pedido cuenta una vez, en su subetapa del Master.");
    expect(todos).toContain("lg:grid lg:grid-cols-2 lg:divide-x");
    // Líneas finas y objetivos de 44 px (E33).
    expect(todos).toContain('<ul className="mt-2 divide-y divide-line border-t border-line">');
    expect(todos).toContain("flex min-h-11 items-start justify-between gap-3 px-4 py-2.5 hover:bg-wash");
    // Los enlaces vienen del resumen (masterQueueHref): ninguna URL escrita a mano.
    expect(todos).toContain("href={s.href}");
    expect(todos).not.toContain("/dashboard/pedidos");
    expect(todos).toContain("Abrir en el Master de Pedidos.");
    // «Por reprogramar Lima» abre las cuatro listas, que van debajo y no dentro del botón.
    expect(todos).toContain('onOpenList("por_decidir")');
    expect(todos).toContain("Ver sus cuatro listas.");
    const inPage = between(todos, "if (s.inPage) {", "\n  }\n");
    expect(inPage.indexOf("</button>")).toBeLessThan(inPage.indexOf("<ChoiceChip"));
    expect(inPage).toContain("active={false} onClick={() => onOpenList(l.list)}");
    // Sin anchos fijos: nada se desplaza de lado a 360 px.
    expect(todos).not.toMatch(/\bw-\[|\bmin-w-\[|\bw-(48|56|64|72|80|96)\b/);
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

describe("«Todos» en pantalla (§9.5, 14-10-2026)", () => {
  const STORE = "11111111-1111-4111-8111-111111111111";
  const row = (stage: LimaOpenCountRow["stage"], substage: string | null, total: number, over7 = 0, over30 = 0): LimaOpenCountRow =>
    ({ storeId: STORE, stage, substage, total, over7, over30 });
  // Producción el 14-10-2026 (cobertura Lima, sin «Por reprogramar Lima»: sale del tablero).
  const PROD: LimaOpenCountRow[] = [
    row("por_cerrar", "validacion_cierre_pendiente", 641, 283, 5),
    row("en_curso", "en_retorno", 1),
    row("preparacion", "por_armar", 13, 11, 11),
    row("por_despachar", "listo_para_asignar", 1094, 948, 351),
    row("en_curso", "en_transito", 91, 48, 20),
    row("en_curso", "en_reparto", 104, 30, 0),
    row("en_curso", "disponible_para_recojo", 1),
    row("en_curso", "pendiente_pago_diferencia", 2, 1, 0),
    row("preparacion", "por_generar_rotulo", 183, 141, 132),
    row("por_cerrar", "pendiente_liquidacion", 4624, 4576, 3845),
    row("por_cerrar", "salida_adicional_activa", 773, 770, 655),
    row("por_cerrar", "devolucion_fisica_pendiente", 186, 98, 1),
    row("por_cerrar", "devolucion_pendiente_inventario", 164, 147, 20),
    row("por_cerrar", "recogido_sin_pago_completo", 5, 5, 2),
  ];
  const REPRO: StageAging = { total: 451, over7: 236, over30: 51 };
  const LISTS = REPRO_LISTS.map((l, i) => ({ list: l, label: `Lista ${i}`, count: i }));
  const fmt = (n: number) => n.toLocaleString("es-PE");
  const render = (rows: LimaOpenCountRow[], repro: StageAging = REPRO, storeId: string | null = null) =>
    renderToStaticMarkup(createElement(ReproLimaTodos, {
      breakdown: limaOpenBreakdown(rows, { storeId, repro }),
      lists: LISTS,
      onOpenList: () => {},
    }));
  const hrefs = (html: string) => [...html.matchAll(/href="([^"]+)"/g)].map((m) => m[1]!.replace(/&amp;/g, "&"));

  it("los dos bloques con su total: 1.940 por entregar y, aparte, 6.393 por cerrar", () => {
    const html = render(PROD);
    expect(html).toContain(`Todavía por entregar</span><span class="shrink-0 tabular-nums">${fmt(1940)}</span>`);
    expect(html).toContain(`Ya entregado, anulado o devuelto: falta cerrar</span><span class="shrink-0 tabular-nums">${fmt(6393)}</span>`);
    expect(html).toContain("En Lima, lo que no se entrega vuelve a «Por reprogramar Lima»; solo la entrega lo pasa a «Por cerrar».");
    expect(html).toContain("Cada pedido cuenta una vez, en su subetapa del Master.");
    expect(html).not.toContain("No hay pedidos de Lima sin estado final.");
  });

  it("las etapas en el orden del MOM, Por confirmar oculta, y Por cerrar en su bloque", () => {
    const html = render(PROD);
    const at = (stage: string) => html.indexOf(`data-dot="${stage}"`);
    expect(at("por_confirmar")).toBe(-1);
    expect(at("preparacion")).toBeGreaterThan(-1);
    expect(at("preparacion")).toBeLessThan(at("por_despachar"));
    expect(at("por_despachar")).toBeLessThan(at("en_curso"));
    expect(at("en_curso")).toBeLessThan(html.indexOf("Ya entregado, anulado o devuelto"));
    expect(html.indexOf("Ya entregado, anulado o devuelto")).toBeLessThan(at("por_cerrar"));
    // Las subetapas en su orden canónico, aunque lleguen desordenadas.
    const order = ["Por generar rótulo", "Por armar", "Listo para asignar", "En tránsito", "En reparto", "Disponible para recojo",
      "Pendiente de pago de diferencia", "Por reprogramar Lima", "En retorno", "Pendiente de liquidación", "Salida adicional activa",
      "Devolución física pendiente", "Devolución pendiente de inventario", "Recogido sin pago completo", "Validación de cierre pendiente"];
    const positions = order.map((label) => html.indexOf(`text-ink-900">${label}</span>`));
    expect(positions.every((p) => p > -1), JSON.stringify(positions)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
  });

  it("cada subetapa abre su cola del Master con «Lima», y sus chapas solo si hay antigüedad", () => {
    const html = render(PROD);
    const links = hrefs(html);
    // Todas menos «Por reprogramar Lima», que se queda en la pantalla.
    expect(links).toHaveLength(14);
    for (const href of links) {
      expect(href.startsWith("/dashboard/pedidos?")).toBe(true);
      const q = parseMasterQuery(new URLSearchParams(href.split("?")[1]));
      expect([...q.filters.coverages]).toEqual(["lima"]);
    }
    expect(links).toContain("/dashboard/pedidos?cv=lima&view=por_cerrar&substage=salida_adicional_activa");
    expect(html).toContain(`aria-label="Pendiente de liquidación: ${fmt(4624)} pedidos, ${fmt(4576)} con más de 7 días y ${fmt(3845)} con más de 30. Abrir en el Master de Pedidos."`);
    expect(html).toContain(`>${fmt(948)} con más de 7 días</span>`);
    expect(html).toContain(`>${fmt(351)} con más de 30</span>`);
    // Sin antigüedad, sin chapas ni cifras de más en el nombre.
    expect(html).toContain('aria-label="Disponible para recojo: 1 pedido. Abrir en el Master de Pedidos."');
    expect(html).toContain('aria-label="En reparto: 104 pedidos, 30 con más de 7 días. Abrir en el Master de Pedidos."');
    const reparto = html.slice(html.indexOf('aria-label="En reparto:'), html.indexOf("</a>", html.indexOf('aria-label="En reparto:')));
    expect(reparto).not.toContain("con más de 30</span>");
  });

  it("con una tienda elegida, cada enlace lleva esa tienda", () => {
    const html = render(PROD, REPRO, STORE);
    const links = hrefs(html);
    expect(links.length).toBeGreaterThan(0);
    for (const href of links) {
      expect([...parseMasterQuery(new URLSearchParams(href.split("?")[1])).filters.stores]).toEqual([STORE]);
    }
  });

  it("«Por reprogramar Lima» es un botón con las cuatro listas debajo, nunca dentro", () => {
    const html = render(PROD);
    const start = html.indexOf('<button type="button" aria-label="Por reprogramar Lima:');
    expect(start).toBeGreaterThan(-1);
    const end = html.indexOf("</button>", start);
    // Ningún botón dentro del botón.
    expect(html.slice(start + 1, end)).not.toContain("<button");
    expect(html.slice(start, end)).toContain(`aria-label="Por reprogramar Lima: 451 pedidos, 236 con más de 7 días y 51 con más de 30. Ver sus cuatro listas."`);
    // Las cuatro listas, como hermanas, justo después.
    const chips = html.slice(end, html.indexOf("</li>", end));
    expect(chips.match(/<button type="button" aria-pressed="false"/g)?.length).toBe(4);
    for (const l of LISTS) expect(chips).toContain(`>${l.label}<span`);
    // Sin casos en Repro Lima, la fila no aparece (y no hay botón).
    expect(render(PROD, { total: 0, over7: 0, over30: 0 })).not.toContain("Por reprogramar Lima:");
  });

  it("sin nada abierto lo dice; con solo «Por cerrar», el primer bloque queda en cero", () => {
    const empty = render([], { total: 0, over7: 0, over30: 0 });
    expect(empty).toContain("No hay pedidos de Lima sin estado final.");
    expect(empty).not.toContain("<h2");
    const onlyClose = render([row("por_cerrar", "pendiente_liquidacion", 3)], { total: 0, over7: 0, over30: 0 });
    expect(onlyClose).toContain('Todavía por entregar</span><span class="shrink-0 tabular-nums">0</span>');
    expect(onlyClose).toContain('data-dot="por_cerrar"');
    expect(onlyClose).not.toContain("No hay pedidos de Lima sin estado final.");
  });
});

describe("el tablero con «Todos» (§9.5, 14-10-2026)", () => {
  const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  // Solo lo que el tablero lee fuera de las filas dibujadas: la lista, la tienda y los días.
  const caseRow = (orderId: string, storeId: string, list: ReproRow["list"], daysInStage: number | null) =>
    ({ orderId, storeId, list, daysInStage, orderName: `#${orderId}`, customerName: "", customerPhone: null, state: { kind: "vigente" } }) as unknown as ReproRow;
  const data = {
    today: "2026-10-14",
    nowIso: "2026-10-14T15:00:00.000Z",
    cutoffLabel: "12:00",
    cutoffPassed: false,
    cutoffText: "",
    stores: [{ id: A, name: "Tienda A" }, { id: B, name: "Tienda B" }],
    // Todas en «Cerrados»: la lista por omisión («Por decidir») queda vacía y no dibuja filas.
    rows: [caseRow("1", A, "cerrados", 3), caseRow("2", A, "cerrados", 8), caseRow("3", B, "cerrados", 31)],
    me: "u",
  } as unknown as ReproLimaData;
  const openCounts = {
    today: "2026-10-14",
    rows: [
      { storeId: A, stage: "preparacion" as const, substage: "por_generar_rotulo", total: 5, over7: 1, over30: 0 },
      { storeId: B, stage: "por_cerrar" as const, substage: "pendiente_liquidacion", total: 7, over7: 7, over30: 2 },
    ],
  };
  const render = (search: string, counts: typeof openCounts | null = openCounts) => {
    nav.search = search;
    return renderToStaticMarkup(createElement(ReproLimaBoard, { data, openCounts: counts }));
  };
  const card = (html: string) => {
    const at = html.indexOf("Todos · por entregar");
    return at < 0 ? "" : html.slice(html.lastIndexOf("<button", at), html.indexOf("</button>", at));
  };

  it("sin conteo, ni tarjeta ni quinta columna, y «?vista=todos» se queda en las listas", () => {
    for (const search of ["", "vista=todos"]) {
      const html = render(search, null);
      expect(html).not.toContain("Todos · por entregar");
      expect(html).not.toContain("lg:grid-cols-5");
      expect(html).toContain('type="search"');
      expect(html).not.toContain("Todavía por entregar");
    }
  });

  it("en las listas, la tarjeta cuenta lo que falta entregar (con Repro Lima) y no está elegida", () => {
    const html = render("");
    expect(html).toContain("lg:grid-cols-5");
    const todosCard = card(html);
    // 5 en Preparación + los 3 casos del tablero; Por cerrar no suma.
    expect(todosCard).toContain('aria-pressed="false"');
    expect(todosCard).toContain(">8</span>");
    expect(html).toContain('type="search"');
    expect(html).toContain('aria-label="Por decidir"');
  });

  it("con «?vista=todos», el resumen sin búsqueda y con la línea de lo que falta", () => {
    const html = render("vista=todos&ficha=x");
    expect(card(html)).toContain('aria-pressed="true"');
    // Ninguna lista elegida mientras se mira «Todos».
    expect(html.match(/aria-pressed="true"/g)?.length).toBe(1);
    expect(html).toContain('<section tabindex="-1" aria-label="Todos"');
    expect(html).not.toContain('type="search"');
    expect(html).toContain('<b class="font-semibold text-ink-900">8</b> todavía por entregar · 7 por cerrar');
    expect(html).toContain("Todavía por entregar");
    expect(html).toContain('aria-label="Por reprogramar Lima: 3 pedidos, 2 con más de 7 días y 1 con más de 30. Ver sus cuatro listas."');
    // La píldora de tienda sigue ahí.
    expect(html).toContain("Tienda");
  });
});

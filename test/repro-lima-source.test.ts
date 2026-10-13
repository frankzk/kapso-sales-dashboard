// «Repro Lima» (fase 1, entrega 1a; MOM §9.5, §29.6, §29.13): las piezas del
// servidor en el código. Quién entra, las dos RPC, un solo escritor del
// programa de Grupo GF, los tres ganchos de «Recibir en oficina», los kinds
// nuevos del historial, la migración y el MOM.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  CONFIRMATION_CONTACT_KINDS,
  CONFIRMATION_FOLLOWUP_KINDS,
  CONFIRMATION_LAST_ATTEMPT_KINDS,
  CONFIRMATION_SIGNAL_KINDS,
} from "@/lib/order-confirmation";
import { REPRO_EVENT_KINDS } from "@/lib/repro-lima";

const root = process.cwd();
const read = (path: string) => readFileSync(resolve(root, path), "utf8");
/** El MOM en una línea: sus citas se parten al ajustar el párrafo. */
const flat = (text: string) => text.replace(/\s+/g, " ");

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(resolve(root, dir))) {
    if (name === "node_modules" || name.startsWith(".")) continue;
    const full = join(resolve(root, dir), name);
    if (statSync(full).isDirectory()) out.push(...sourceFiles(relative(root, full)));
    else if (/\.(ts|tsx)$/.test(name)) out.push(relative(root, full));
  }
  return out;
}

const actions = read("app/dashboard/pedidos/repro-lima/actions.ts");
const program = read("lib/repro-lima-program.ts");
const access = read("lib/repro-lima-access.ts");
const courier = read("app/dashboard/courier/actions.ts");
const despacho = read("app/dashboard/pedidos/despacho/actions.ts");
const writer = read("lib/gf-dispatch-program.ts");

/** El cuerpo de una función de un archivo, hasta la siguiente exportada. */
function body(src: string, signature: string): string {
  const start = src.indexOf(signature);
  expect(start, signature).toBeGreaterThanOrEqual(0);
  const next = src.indexOf("\nexport ", start + signature.length);
  return src.slice(start, next === -1 ? undefined : next);
}

describe("quién entra (§9.5, D11, E32, E36)", () => {
  it("cada acción exportada pide Repro Lima antes de leer nada", () => {
    expect(actions.startsWith('"use server";')).toBe(true);
    const exported = [...actions.matchAll(/^export async function (\w+)\(/gm)].map((m) => m[1]!);
    expect(exported).toEqual(expect.arrayContaining([
      "claimReproCase",
      "renewReproCase",
      "releaseReproCase",
      "registerReproCall",
      "closeReproCase",
      "programReproAgreement",
      "loadReproCalls",
      "loadReproRow",
    ]));
    for (const name of exported) {
      const fn = body(actions, `export async function ${name}(`);
      expect(fn, name).toContain("await requireReproLima()");
      expect(fn.indexOf("await requireReproLima()"), name).toBeLessThan(fn.indexOf("createAdminSupabase()") === -1 ? Infinity : fn.indexOf("createAdminSupabase()"));
    }
    // Un archivo "use server" solo exporta funciones.
    expect(actions).not.toMatch(/^export (const|let|class) /m);
  });

  it("el permiso es el de «Programar» y el alcance, las tiendas de Equipo", () => {
    const gate = body(access, "export async function requireReproLima(");
    expect(gate).toContain('if (!user) redirect("/login");');
    expect(gate).toContain('permissions.can("repro_lima.manage")');
    expect(gate).toContain("await getAccessibleStores()");
    expect(access).toContain('"Repro Lima es de quien llama a los clientes o despacha (rol «Asesora» o «Despacho y Grupo GF»). Pide uno de esos roles en Equipo."');
    expect(access).toContain('"No tienes tiendas asignadas. Pide acceso en Equipo."');
    // Cada caso se mira contra la tienda antes de tocarlo.
    expect(actions).toContain("if (!scope.storeIds.has(row.store_id)) return { error: REPRO_OUTSIDE_STORE };");
    expect(actions).toContain("if (!scope.storeIds.has(f.storeId)) return { error: REPRO_OUTSIDE_STORE };");
  });
});

describe("el candado y la llamada: dos RPC (D10, E1-E4)", () => {
  it("tomar va por lima_repro_claim con el episodio y su momento", () => {
    const claim = body(actions, "export async function claimReproCase(");
    expect(claim).toContain('admin.rpc("lima_repro_claim", {');
    expect(claim).toContain("p_episode: f.episode.key,");
    expect(claim).toContain("p_episode_at: f.episode.at,");
    expect(claim).toContain("p_ttl_minutes: REPRO_CLAIM_TTL_MINUTES,");
    // Reabrir un «Desarmar y cerrar» del mismo episodio pide el segundo clic
    // (E29), también si el cierre llega después de leer los hechos: la RPC lo
    // mira dentro de su candado (`needs_reopen`).
    expect(claim).toContain("needsReopen: true");
    expect(claim).toContain("p_reopen: Boolean(opts.reopen),");
    expect(claim).toContain("if (claim.needs_reopen) return { error: NEEDS_REOPEN, needsReopen: true };");
  });

  it("«Programar ahora» toma el candado de su caso con una escritura condicional, nunca con la RPC que abre casos (E21, E29)", () => {
    const program = body(actions, "export async function programReproAgreement(");
    expect(program).not.toContain('rpc("lima_repro_claim"');
    expect(program).toContain(".or(`claimed_by.is.null,claimed_by.eq.${scope.userId},claimed_until.lte.${now.toISOString()}`)");
    const claim = program.slice(program.indexOf("const hadClaim"), program.indexOf("try {", program.indexOf("const hadClaim")));
    expect(claim).toContain('.eq("id", c0.id)');
    expect(claim).toContain('.is("closed_at", null)');
    expect(program).toContain('if (!holder || holder.closed_at) return { error: "El caso ya está cerrado." };');
  });

  it("guardar dice si la caja cambió (boxChanged) o se perdió el caso (claimLost): C3", () => {
    const record = actions.slice(actions.indexOf("async function recordCall("), actions.indexOf("async function clearPrograms("));
    expect(record).toContain("return { error: CASE_GONE, claimLost: true };");
    expect(record).toContain("if (error) return error.message === CASE_GONE ? { error: CASE_GONE, claimLost: true } : { error: error.message };");
    expect(record).toContain("return { error: BOX_CHANGED, boxChanged: true };");
    expect(record).toContain('return problem.reason === "cambio" ? { error: problem.message, boxChanged: true } : { error: problem.message };');
    // El caso reabierto (E29) decide «No esperar la caja» igual que la hoja (C2).
    expect(record).toContain("reopened: f.reopened,");
  });

  it("registrar va por lima_repro_record, una sola vez por envío", () => {
    expect(actions).toContain('admin.rpc("lima_repro_record", {');
    expect(actions).toContain("p_operation: input.operationId,");
    expect(actions).toContain("p_event_note: eventNote,");
    // El reintento del mismo envío no se vuelve a validar: lo resuelve la RPC.
    expect(actions).toContain('.from("lima_repro_calls").select("id").eq("operation_id", input.operationId)');
    // «Desarmar y cerrar sin llamada» es la misma RPC por `sin_contacto` (E2).
    const close = body(actions, "export async function closeReproCase(");
    expect(close).toContain('outcome: "no_quiere",');
    expect(close).toContain('channel: "sin_contacto",');
    expect(body(actions, "export async function registerReproCall(")).toContain('if (input.channel === "sin_contacto")');
  });

  it("renovar y soltar son escrituras condicionales sobre el candado propio", () => {
    const renew = body(actions, "export async function renewReproCase(");
    expect(renew).toContain('.eq("claimed_by", scope.userId)');
    expect(renew).toContain('.gt("claimed_until", now.toISOString())');
    expect(renew).toContain('.is("closed_at", null)');
    expect(body(actions, "export async function releaseReproCase(")).toContain('.eq("claimed_by", scope.userId);');
    const beacon = read("app/api/repro-lima/release-claim/route.ts");
    expect(beacon).toContain('.from("lima_repro_cases")');
    expect(beacon).toContain('.eq("claimed_by", userId)');
    expect(beacon).toContain("caseId");
  });

  it("«Ya no lo quiere» pide motivo de 8 y el pedido escrito (§11.5); la caja la calcula Kapta (D8)", () => {
    expect(actions).toContain("validarMotivoDescarte(note)");
    expect(actions).toContain("sameOrderName(input.confirmOrderName, f.order.order_name)");
    expect(actions).toContain("reproBoxAction({");
    expect(actions).toContain("if (decided.action !== input.expectedBoxAction) {");
    expect(actions).toContain("La caja cambió mientras decidías: revisa «Qué hacer con la caja» y vuelve a guardar.");
    expect(actions).toContain("agreementDateProblem({");
    expect(actions).toContain("loadGroupGfCourierRouteCheck(admin, {");
  });

  it("lo que sigue a la llamada se decide con hechos releídos, también en un duplicado (E24)", () => {
    const record = actions.slice(actions.indexOf("async function recordCall("), actions.indexOf("async function clearPrograms("));
    const rpc = record.indexOf('admin.rpc("lima_repro_record", {');
    const reread = record.indexOf("const fresh = await factsOf(admin, c.order_id);");
    expect(rpc).toBeGreaterThan(0);
    expect(reread).toBeGreaterThan(rpc);
    expect(record.slice(reread)).toContain("await afterCall(admin, {");
    expect(record.slice(rpc, reread)).not.toContain("if (recorded.duplicate");
  });
});

describe("un solo escritor del programa de Grupo GF (D4, §29.6)", () => {
  it("toda escritura de gf_dispatch_programs vive en lib/gf-dispatch-program.ts o en settlePrograms", () => {
    const write = /\.from\("gf_dispatch_programs"\)\s*\.(upsert|insert|update|delete)\(/g;
    const settle = courier.slice(courier.indexOf("async function settlePrograms("), courier.indexOf("async function loadCourierOperations("));
    for (const file of [...sourceFiles("app"), ...sourceFiles("lib"), ...sourceFiles("components")]) {
      if (file === "lib/gf-dispatch-program.ts") continue;
      const src = read(file);
      for (const match of src.matchAll(write)) {
        expect(file === "app/dashboard/courier/actions.ts" && settle.includes(match[0]), `${file}: ${match[0]}`).toBe(true);
      }
    }
    expect(program).toContain("await writeGfDispatchProgram(admin, {");
    expect(writer).toContain("export async function clearGfDispatchPrograms(");
    expect(writer).toContain("export async function loadGfRequest(");
  });

  it("«Quitar la fecha» borra solo lo leído y conserva requireOperator (E22)", () => {
    const clear = writer.slice(writer.indexOf("export async function clearGfDispatchPrograms("));
    expect(clear).toContain('.eq("scheduled_for", program.scheduled_for)');
    expect(clear).toContain('query = query.eq("set_at", program.set_at)');
    expect(clear).toContain("if ((data as unknown[] | null)?.length) cleared.push(program);");
    const gf = body(courier, "export async function clearGroupGfCourierPrograms(");
    expect(gf).toContain("await requireOperator(");
    expect(gf).toContain("await clearGfDispatchPrograms(admin, programs, auth.userId)");
    expect(courier).toContain('.select("order_id,store_id,scheduled_for,reason,set_at")');
  });

  it("la marca del acuerdo es condicional y se deshace si no se programa (CAS)", () => {
    const fn = program.slice(program.indexOf("export async function materializeAgreement("), program.indexOf("// «Recibir en oficina» (§29.13)"));
    expect(fn).toContain('.eq("agreement_call_id", callId)\n    .is("materialized_at", null)\n    .is("closed_at", null)');
    expect(fn).toContain('.eq("materialized_at", markAt);');
    // E21 antes de marcar; E22 después de escribir.
    expect(fn.indexOf("reproCaseProblem(facts, c)")).toBeLessThan(fn.indexOf(".update({ materialized_at: markAt, materialized_on: day })"));
    expect(fn.indexOf("await writeGfDispatchProgram(admin, {")).toBeLessThan(fn.indexOf("reread.agreement_call_id !== callId"));
    expect(fn).toContain('"Repro Lima: el acuerdo cambió mientras se programaba."');
    // E26: solo el programa de Repro Lima del mismo día se deja sin tocar.
    expect(fn).toContain('programOrigin(program.reason) === "repro_lima"');
  });
});

describe("«Recibir en oficina» programa el acuerdo que esperaba la caja (§29.13)", () => {
  it("los tres ganchos llaman al mismo ayudante", () => {
    const shipments = courier.slice(courier.indexOf("async function returnUndeliveredShipments("), courier.indexOf("export async function returnUndeliveredOutputs("));
    expect(shipments).toContain('await materializeWaitingAgreementsSafe(admin, [...requeuedOrders], auth.userId, { via: "recepcion" });');
    // Solo lo que vuelve a «por asignar»; antes del recálculo del Master.
    expect(shipments).toContain("orderOfShipment.set(item.shipment_id, data as string);");
    expect(shipments.indexOf("materializeWaitingAgreementsSafe(")).toBeLessThan(shipments.indexOf("await recomputeOrderMasterSafe("));
    expect(shipments).toContain("reproReceptionNotice(repro, { single: changed.length === 1 })");
    expect(shipments).toContain("revalidatePath(REPRO_LIMA_PATH);");

    const gfReturn = despacho.slice(despacho.indexOf("async function receiveGrupoGfReturn("), despacho.indexOf("async function receiveShalomReturn("));
    expect(gfReturn).toContain('await materializeWaitingAgreementsSafe(admin, [orderId as string], user.id, { via: "recepcion" })');
    // Después de saber que vuelve a «por asignar» (la reemplazada va a stock).
    expect(gfReturn.indexOf('if (outcome === "a_stock_reemplazada")')).toBeLessThan(gfReturn.indexOf("materializeWaitingAgreementsSafe("));

    const scan = body(courier, "export async function scanAssignToRider(");
    const hook = scan.indexOf('await materializeWaitingAgreementsSafe(admin, [orderId], auth.userId, { via: "escaneo" });');
    expect(hook).toBeGreaterThan(scan.indexOf('if (outcome !== "por_asignar") {'));
    expect(hook).toBeLessThan(scan.indexOf("programConflicts("));
    expect(scan).toContain("reproReceptionNotice(repro, { single: true, omitProgrammed: true })");
    // «No lo quiere» (§9.3 fila 1): recibida, no se programa, ni se toma, ni se asigna.
    const refused = scan.indexOf("if (repro.noLoQuiere.some((row) => row.orderId === orderId)) {");
    expect(refused).toBeGreaterThan(hook);
    expect(refused).toBeLessThan(scan.indexOf("programConflicts("));
    expect(refused).toBeLessThan(scan.indexOf("takeOrdersCore("));
    expect(scan.slice(refused, scan.indexOf("} else if (box) {"))).toContain('status: "recibido_a_stock",');
  });

  it("el ayudante nunca lanza, no revalida, no recalcula ni llama RPC (E30)", () => {
    expect(program).not.toContain("revalidatePath");
    expect(program).not.toContain("recomputeOrderMaster");
    expect(program).not.toMatch(/\.rpc\(/);
    expect(program).not.toContain('"server-only"');
    expect(program).not.toContain("@/lib/access");
    const helper = program.slice(program.indexOf("export async function materializeWaitingAgreementsSafe("), program.indexOf("export const REPRO_NO_LO_QUIERE_NOTICE"));
    expect(helper.indexOf("try {")).toBeLessThan(helper.indexOf("courierRowsByIds("));
    expect(helper).toContain("} catch (error) {");
    // Dentro del escaneo tampoco se revalida.
    const scan = body(courier, "export async function scanAssignToRider(");
    const branch = scan.slice(scan.indexOf("// Una caja de un día ANTERIOR"), scan.indexOf("} else if (box) {"));
    expect(branch).not.toContain("revalidatePath(");
  });

  it("los avisos son los que cita el MOM", () => {
    expect(program).toContain("con acuerdo de Repro Lima: quedaron programados para su día (van al anaquel de ese día).");
    expect(program).toContain("con fecha acordada que ya pasó: vuelve a confirmarla en Repro Lima.");
    expect(program).toContain('"Repro Lima: el cliente ya no lo quiere. Desármala (cuaderno «DESARMAR»); no va al estante."');
    expect(program).toContain('"Repro Lima: no lo quiere · desarmar"');
    expect(program).toContain("`Repro Lima: caja nueva desde stock, sale ${programDayLabel(day.slice(0, 10))}`");
    expect(actions).toContain('"Repro Lima: el acuerdo con el cliente es otro."');
    expect(actions).toContain('"Repro Lima: el cliente ya no lo quiere."');
  });
});

describe("las chapas de la cola de Despacho del día (E28)", () => {
  it("una lectura por los pedidos de la cola, sin tocar la forma de la respuesta", () => {
    const ops = courier.slice(courier.indexOf("async function loadCourierOperations("), courier.indexOf("\nexport async function loadCourierConfig("));
    expect(ops).toContain("await loadReproQueueFlags(admin, [");
    expect(ops).toContain("row.reproLimaChip = nueva?.open ? reproCajaNuevaChip(nueva.day) : noLoQuiereChip(row.orderId);");
    // Lo tomado con la caja todavía con el motorizado (su caja dice «No
    // entregado») también lleva «caja nueva desde stock»: es donde se ofrece
    // «Sacar con salida nueva».
    const acceptedLoop = ops.slice(ops.indexOf("for (const row of accepted) {"), ops.indexOf("for (const row of returnable) {"));
    expect(acceptedLoop).toContain("const nueva = row.route?.undeliveredReason ? reproFlags.cajaNueva.get(row.orderId) : undefined;");
    expect(acceptedLoop).toContain("row.reproLimaChip = nueva?.open ? reproCajaNuevaChip(nueva.day) : noLoQuiereChip(row.orderId);");
    expect(ops).toContain("return { available, returnable, returning, accepted,");
    expect(read("lib/dispatch-day.ts")).toContain("reproLimaChip?: string | null;");
    const board = read("components/dispatch-day-board.tsx");
    expect(board).toContain("{q.reproLimaChip && <Badge");
    expect(board).toContain("{r.reproLimaChip && <Badge");
  });
});

describe("el historial: kinds propios que no gastan el cupo de confirmación (D3)", () => {
  const kinds = Object.values(REPRO_EVENT_KINDS);

  it("ninguno está en los kinds de la confirmación", () => {
    for (const list of [CONFIRMATION_CONTACT_KINDS, CONFIRMATION_FOLLOWUP_KINDS, CONFIRMATION_LAST_ATTEMPT_KINDS, CONFIRMATION_SIGNAL_KINDS]) {
      for (const kind of kinds) expect((list as readonly string[]).includes(kind), kind).toBe(false);
    }
    expect(kinds).toEqual(["lima_repro_call", "lima_repro_agreed", "lima_repro_closed"]);
  });

  it("el historial del pedido los nombra", () => {
    const shared = read("components/order-master-shared.tsx");
    expect(shared).toContain('lima_repro_call: "Repro Lima: llamada",');
    expect(shared).toContain('lima_repro_agreed: "Repro Lima: acuerdo",');
    expect(shared).toContain('lima_repro_closed: "Repro Lima: caso cerrado",');
  });

  it("la acción nunca escribe `call`, `confirmation_contact` ni `contact_attempt`", () => {
    for (const src of [actions, program]) {
      expect(src).not.toMatch(/kind: "(call|confirmation_contact|contact_attempt)"/);
    }
  });

  it("el Master no lee nada de esto: la versión sigue en mom-v1.26 (D2)", () => {
    const macro = read("lib/order-macro-stage.ts");
    expect(macro).not.toMatch(/lima_repro|requested_date/);
    expect(macro).toContain('export const MOM_RESOLUTION_VERSION = "mom-v1.26" as const;');
  });
});

describe("la migración 0251 (D12)", () => {
  const sql = read("db/migrations/0251_lima_repro.sql");

  it("un caso abierto por pedido, llamadas append-only, escrituras solo del servidor", () => {
    expect(sql).toContain("create unique index if not exists lima_repro_cases_open_uniq\n  on public.lima_repro_cases(order_id) where closed_at is null;");
    expect(sql).toContain("execute function public.reject_mutation();");
    expect(sql).toContain("revoke all on public.lima_repro_cases from anon, authenticated, service_role;");
    expect(sql).toContain("revoke all on public.lima_repro_calls from anon, authenticated, service_role;");
    expect(sql).toContain("grant execute on function public.lima_repro_claim(uuid, uuid, uuid, text, timestamptz, integer, boolean) to service_role;");
    // Sin ningún `drop`: la herramienta que aplica en producción se queda
    // esperando con ellos (DEPLOY.md). Los triggers son `create or replace` y
    // las políticas se crean si faltan, así que se puede volver a correr.
    expect(sql).not.toMatch(/^\s*drop\s/im);
    expect(sql).toContain("create or replace trigger lima_repro_calls_append_only");
    expect(sql).toContain("policyname = 'lima_repro_cases_select') then");
    expect(sql).not.toMatch(/^\s*begin;/im);
    expect(sql).not.toMatch(/^\s*commit;/im);
  });

  it("tomar no reabre un «Desarmar y cerrar» del mismo episodio sin el segundo clic (E29)", () => {
    const claim = sql.slice(sql.indexOf("create or replace function public.lima_repro_claim("), sql.indexOf("revoke all on function public.lima_repro_claim("));
    expect(claim).toContain("p_reopen boolean default false");
    // Dentro del candado del pedido, antes de abrir el caso.
    expect(claim.indexOf("pg_advisory_xact_lock(")).toBeLessThan(claim.indexOf("'needs_reopen', true"));
    expect(claim.indexOf("'needs_reopen', true")).toBeLessThan(claim.indexOf("insert into lima_repro_cases"));
    expect(claim).toContain("v_last.close_reason = 'desarmar_cerrar' and v_last.episode_key = p_episode");
    expect(claim).toContain("and not coalesce(p_reopen, false) then");
  });

  it("la acción manda los parámetros que la RPC espera", () => {
    for (const param of ["p_case", "p_actor", "p_operation", "p_episode", "p_outcome", "p_channel", "p_next_call_at", "p_agreed_on", "p_courier", "p_changes", "p_box_action", "p_box_location", "p_note", "p_event_note", "p_ttl_minutes"]) {
      expect(sql).toContain(`${param} `);
      expect(actions).toContain(`${param}:`);
    }
  });
});

describe("el MOM lo documenta (§9.5, §29.6, §29.13)", () => {
  const mom = read("docs/mom/master-pedidos-v1.md");

  it("con sus títulos", () => {
    expect(mom).toContain("### 9.5 Reprogramación en Lima: «Repro Lima» (fase 1, entrega 1a)");
    expect(mom).toContain("#### «Repro Lima» (fase 1, entrega 1a, 12-10-2026)");
    expect(mom).toContain("#### Procedimiento de la fase 0 (11-10-2026)");
    expect(mom).toContain("#### Qué hacer con la caja (12-10-2026, decisión 8 del owner)");
    expect(mom).toContain("**Quién escribe el programa (12-10-2026).**");
    expect(mom).toContain("**«Recibir en oficina» programa el acuerdo de Repro Lima que esperaba la caja\n(12-10-2026).**");
  });

  it("y con los textos que dice la pantalla", () => {
    const text = flat(mom);
    for (const quote of [
      "Repro Lima es de quien llama a los clientes o despacha (rol «Asesora» o «Despacho y Grupo GF»). Pide uno de esos roles en Equipo.",
      "con acuerdo de Repro Lima: quedaron programados para su día (van al anaquel de ese día).",
      "con fecha acordada que ya pasó: vuelve a confirmarla en Repro Lima.",
      "Repro Lima: el cliente ya no lo quiere. Desármala (cuaderno «DESARMAR»); no va al estante.",
      "Repro Lima: no lo quiere · desarmar",
      "Repro Lima: caja nueva desde stock, sale jue 15/10",
      "Repro Lima: el acuerdo con el cliente es otro.",
      "Repro Lima: el cliente ya no lo quiere.",
      "Repro Lima: el acuerdo cambió mientras se programaba",
      "Programado para el jue 15/10 («Repro Lima: …»): confirma para que salga hoy.",
    ]) {
      expect(text, quote).toContain(quote);
    }
  });

  // Lo que cambió con la revisión de la entrega 1a: el MOM cita la pantalla y
  // la pantalla dice lo que el MOM cita.
  it("cita lo que dicen la hoja, la fila y el escaneo desde la revisión", () => {
    const text = flat(mom);
    const core = read("lib/repro-lima.ts");
    const sheet = read("components/repro-lima-sheet.tsx");
    const pairs: Array<[mom: string, src: string, code: string]> = [
      // Un acuerdo para hoy que ya no alcanza, y las tres chapas de la regla 4.
      ["El acuerdo era para hoy (lun 12/10) y ya no alcanza: confírmalo de nuevo", core, "`El acuerdo era para hoy (${day}) y ya no alcanza: confírmalo de nuevo`"],
      ["«Acuerdo vencido: era para hoy y ya no alcanza»", core, '"Acuerdo vencido: era para hoy y ya no alcanza"'],
      ["«Grupo GF lo programó para el mié 14/10 y no salió; acordado vie 16/10»", core, "`Grupo GF lo programó para el ${programDayLabel(programDay)} y no salió; acordado ${programDayLabel(agreedOn)}`"],
      // La línea del fallo de Tanders y Swayp dice la salida.
      ["«Salió el lun 12/10 con Swayp · motivo»", core, "`Salió el ${programDayLabel(dispatchedOn)} con ${reproCourierName(f.courier)} · ${motivo}`"],
      // El candado y los rechazos al guardar.
      ["«Ya no tienes este caso: vuelve a tomarlo.»", actions, 'const CASE_GONE = "Ya no tienes este caso: vuelve a tomarlo.";'],
      ["«La caja cambió mientras decidías: revisa «Qué hacer con la caja» y vuelve a guardar.»", actions, 'const BOX_CHANGED = "La caja cambió mientras decidías: revisa «Qué hacer con la caja» y vuelve a guardar.";'],
      ["«El pedido cambió mientras lo abrías: vuelve a intentarlo.»", program, '"El pedido cambió mientras lo abrías: vuelve a intentarlo."'],
      ["«El caso ya está cerrado.»", actions, 'return { error: "El caso ya está cerrado." };'],
      // «Volver a atender» (0251, `needs_reopen`) y su segundo clic.
      ["«Este pedido se cerró con «Desarmar y cerrar». «Volver a atender» lo reabre.»", actions, 'const NEEDS_REOPEN = "Este pedido se cerró con «Desarmar y cerrar». «Volver a atender» lo reabre.";'],
      ["«Si Almacén ya la desarmó, elige «No esperar la caja».»", sheet, "<p>Si Almacén ya la desarmó, elige «No esperar la caja».</p>"],
      // El programa de otro día que se quita aunque no se pudo programar.
      ["Se quitó la fecha que tenía en Grupo GF. Usa «Programar ahora».", actions, 'const CLEARED_NOTE = " Se quitó la fecha que tenía en Grupo GF.";'],
      ["«Acuerdo guardado, pero no se pudo programar: …", actions, "error: `Acuerdo guardado, pero no se pudo programar: ${why}${tail} Usa «Programar ahora».`,"],
      // «Falta la salida nueva» de una caja nueva desde stock.
      ["«Acuerdo guardado. Falta la salida nueva: Kapta todavía no la crea para una caja nueva desde stock. Anótalo en la ficha y avisa a Despacho GF.»", core, '"para una caja nueva desde stock"'],
      // Y la acción de la caja antes de guardar, que ya no promete que Grupo GF la crea.
      ["«Caja nueva desde stock: falta la salida nueva de Grupo GF (Kapta todavía no la crea; avisa a Despacho GF).»", read("lib/repro-box-action.ts"), "`Caja nueva desde stock: falta la salida nueva de Grupo GF (Kapta todavía no la crea; avisa a Despacho GF). ${"],
      // «Guardar y pasar al siguiente» lleva el aviso a la hoja siguiente.
      ["(«Avisa a Almacén: la caja tiene que estar en el anaquel antes de las 12:30.»)", actions, '" Avisa a Almacén: la caja tiene que estar en el anaquel antes de las 12:30."'],
      // El escaneo de una caja que el cliente ya no quiere.
      ["«Recibido en oficina (salió de la caja de Johnny del 12/10). Repro Lima: el cliente ya no lo quiere. Desármala (cuaderno «DESARMAR»); no va al estante. No se asigna.»", courier, "message: `Recibido en oficina (salió de la caja de ${receivedFrom}). ${reproNote}No se asigna.`,"],
    ];
    for (const [quote, src, code] of pairs) {
      expect(text, quote).toContain(quote);
      expect(src, code).toContain(code);
    }
    expect(actions).toContain("Kapta todavía no la crea ${why}. Anótalo en la ficha y avisa a Despacho GF.");
    expect(actions).toContain("const why = faltaSalidaWhy(boxAction);");
    // El servidor calcula la acción de la caja con el reintento, como el plan.
    const decided = actions.slice(actions.indexOf("const decided = reproBoxAction({"));
    expect(decided.slice(0, decided.indexOf("});"))).toContain("retryAdmission: f.retryAdmission,");
    // La firma de 0251 que cita el MOM y DEPLOY.md.
    expect(text).toContain("`lima_repro_claim` (0251) recibe `p_reopen` (por defecto false)");
    expect(flat(read("DEPLOY.md"))).toContain("`lima_repro_claim` lleva `p_reopen`");
  });

  it("dice las reglas nuevas en su sección", () => {
    const section = (start: string, end: string) => {
      const from = mom.indexOf(start);
      expect(from, start).toBeGreaterThanOrEqual(0);
      const to = mom.indexOf(end, from);
      return flat(mom.slice(from, to === -1 ? undefined : to));
    };
    const s93 = section("### 9.3 Resultado fallido y nueva salida", "### 9.4 ");
    const s95 = section("### 9.5 Reprogramación en Lima", "## 10. ");
    const s2913 = section("### 29.13 ", "### 29.14 ");
    // §9.3: «No esperar la caja» con la caja que no consta, solo reabierto; la misma salida.
    expect(s93).toContain("Con la caja que no consta, solo en un caso reabierto después de «Desarmar y cerrar» (§9.5)");
    expect(s93).toContain("**la misma salida**: se reimprime su rótulo (mismo QR)");
    // §9.5: el episodio por el día de la ruta, el acuerdo de hoy que ya no alcanza, la caja nueva.
    expect(s95).toContain("La parada más reciente se elige **por el día de su ruta**");
    expect(s95).toContain("en el mismo día, por la que nació después (`delivery_stops.created_at`");
    expect(s95).toContain("La que se recibe después de reabrir sigue «En oficina»");
    expect(s95).toContain("no abre otro episodio ni cierra el caso como `nuevo_intento`");
    expect(s95).toContain("Pasado ese día, es `acuerdo_vencido`");
    expect(s95).toContain("se programa al decidir solo si alguien puede sacar la salida");
    expect(s95).toContain("Una recepción de un episodio anterior no cuenta.");
    expect(s95).toContain("Solo otra solicitud, también una cancelada, la deja en «No consta».");
    // §29.13: la chapa sigue mientras el cierre sea del episodio vigente.
    expect(s2913).toContain("solo un fallo nuevo (otro episodio) la quita");
    expect(s2913).toContain("Acordada con Tanders, Swayp o Axel no lleva chapa");
    expect(s2913).toContain("**En «Por QR», esa caja se recibe y ahí termina.**");
  });
});

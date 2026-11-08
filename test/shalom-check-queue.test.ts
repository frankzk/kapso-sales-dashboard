// La fila del rastreo de Shalom y la guía que Shalom ya no reconoce (MOM §12,
// 08-11-2026; 0321). Cada pasada preguntaba por 250 de 367 guías en el orden
// de `last_report_at`; las 71 que Shalom rechazaba con `not_found` nunca se
// movían y la cola de la fila no entraba nunca.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  groupShalomCheckWrites,
  nextShalomCheck,
  shalomCheckAnswer,
  shalomCheckColumnsMissing,
  shalomUnrecognized,
  shalomUnrecognizedLine,
  shalomUnrecognizedNote,
  SHALOM_UNRECOGNIZED_HOURS,
  SHALOM_UNRECOGNIZED_PASSES,
  SHALOM_UNRECOGNIZED_REASON,
  type ShalomNotFoundState,
} from "@/lib/shalom/check-queue";
import { buildWarehouseQueue, stallDiagnosis } from "@/lib/warehouse-queue";

const read = (p: string) => readFileSync(resolve(process.cwd(), p), "utf8");
const flat = (text: string) => text.replace(/\s+/g, " ");
const NOW = "2026-11-08T15:00:00.000Z";
const hoursAgo = (h: number) => new Date(Date.parse(NOW) - h * 3_600_000).toISOString();
const FRESH: ShalomNotFoundState = { shalom_not_found_since: null, shalom_not_found_count: 0 };
const NOT_FOUND = { ok: false, error: { code: "not_found", message: "No se encontró la orden de servicio." } };

describe("qué contestó Shalom por una guía", () => {
  it("con estado, `not_found`, otro rechazo o sin respuesta", () => {
    expect(shalomCheckAnswer({ ok: true })).toBe("contesto");
    expect(shalomCheckAnswer(NOT_FOUND)).toBe("no_encontrada");
    expect(shalomCheckAnswer({ ok: false, error: { code: "NOT_FOUND" } })).toBe("no_encontrada");
    expect(shalomCheckAnswer({ ok: false, error: { code: "invalid", message: "falta codigo" } })).toBe("otro");
    expect(shalomCheckAnswer({ ok: false, error: null })).toBe("otro");
    expect(shalomCheckAnswer(undefined)).toBe("otro");
  });
});

describe("lo que se escribe tras preguntar", () => {
  it("toda guía preguntada lleva el sello de cuándo se preguntó", () => {
    for (const answer of ["contesto", "no_encontrada", "otro"] as const) {
      expect(nextShalomCheck(FRESH, answer, NOW).shalom_checked_at).toBe(NOW);
    }
  });

  it("`not_found` suma uno a la racha y guarda desde cuándo", () => {
    const first = nextShalomCheck(FRESH, "no_encontrada", NOW);
    expect(first).toEqual({ shalom_checked_at: NOW, shalom_not_found_since: NOW, shalom_not_found_count: 1 });
    const prev = { shalom_not_found_since: hoursAgo(30), shalom_not_found_count: 5 };
    expect(nextShalomCheck(prev, "no_encontrada", NOW)).toEqual({
      shalom_checked_at: NOW,
      shalom_not_found_since: hoursAgo(30),
      shalom_not_found_count: 6,
    });
  });

  it("una respuesta de verdad borra la racha", () => {
    const prev = { shalom_not_found_since: hoursAgo(30), shalom_not_found_count: 9 };
    expect(nextShalomCheck(prev, "contesto", NOW)).toEqual({
      shalom_checked_at: NOW,
      shalom_not_found_since: null,
      shalom_not_found_count: 0,
    });
  });

  it("otro rechazo no toca la racha: «falta codigo» no dice si Shalom la conoce", () => {
    const prev = { shalom_not_found_since: hoursAgo(30), shalom_not_found_count: 4 };
    expect(nextShalomCheck(prev, "otro", NOW)).toEqual({ shalom_checked_at: NOW });
  });

  it("agrupa las escrituras iguales: un update por grupo, no uno por guía", () => {
    const answered = nextShalomCheck(FRESH, "contesto", NOW);
    const groups = groupShalomCheckWrites([
      { id: "a", patch: answered },
      { id: "b", patch: nextShalomCheck(FRESH, "no_encontrada", NOW) },
      { id: "c", patch: { ...answered } },
      { id: "d", patch: nextShalomCheck(FRESH, "no_encontrada", NOW) },
      { id: "e", patch: nextShalomCheck({ shalom_not_found_since: hoursAgo(2), shalom_not_found_count: 1 }, "no_encontrada", NOW) },
    ]);
    expect(groups.map((g) => g.ids)).toEqual([["a", "c"], ["b", "d"], ["e"]]);
  });
});

describe("la fila rota: toda guía preguntada vuelve al final", () => {
  // La pasada de producción: 362 guías con cómo preguntar, 71 que Shalom no
  // encuentra (al frente de la fila) y 250 por pasada.
  type Guide = { id: number; dead: boolean; checkedAt: string | null; state: ShalomNotFoundState };
  const PER_RUN = 250;

  function run(guides: Guide[], at: string, byColumn: "checked" | "reported") {
    const key = (g: Guide) => (byColumn === "checked" ? g.checkedAt : g.dead ? null : g.checkedAt);
    const queue = [...guides].sort((a, b) => {
      const ka = key(a);
      const kb = key(b);
      if (ka === kb) return a.id - b.id;
      if (ka === null) return -1;
      if (kb === null) return 1;
      return ka < kb ? -1 : 1;
    });
    const asked = queue.slice(0, PER_RUN);
    for (const [index, g] of asked.entries()) {
      // Lo que se preguntó antes queda antes en la fila siguiente (en el cron,
      // cada lote sella a su hora y, dentro del lote, desempata `created_at`).
      const stampAt = new Date(Date.parse(at) + index).toISOString();
      const patch = nextShalomCheck(g.state, g.dead ? "no_encontrada" : "contesto", stampAt);
      g.checkedAt = patch.shalom_checked_at;
      g.state = {
        shalom_not_found_since: patch.shalom_not_found_since ?? null,
        shalom_not_found_count: patch.shalom_not_found_count ?? 0,
      };
    }
    return new Set(asked.map((g) => g.id));
  }

  function fleet(): Guide[] {
    return Array.from({ length: 362 }, (_, id) => ({ id, dead: id < 71, checkedAt: id < 71 ? null : "2026-11-07T00:00:00.000Z", state: FRESH }));
  }

  const runs = (byColumn: "checked" | "reported", n: number) => {
    const guides = fleet();
    const times = new Map<number, number>();
    const sets: Set<number>[] = [];
    for (let k = 0; k < n; k += 1) {
      const asked = run(guides, new Date(Date.parse("2026-11-08T10:00:00.000Z") + k * 1_800_000).toISOString(), byColumn);
      for (const id of asked) times.set(id, (times.get(id) ?? 0) + 1);
      sets.push(asked);
    }
    return { sets, times: Array.from({ length: 362 }, (_, id) => times.get(id) ?? 0) };
  };

  it("por `shalom_checked_at`, todas se preguntan en dos pasadas y ninguna más que otra", () => {
    const { sets, times } = runs("checked", 10);
    expect(new Set([...sets[0]!, ...sets[1]!]).size).toBe(362);
    // Diez pasadas de 250 son 2 500 preguntas para 362 guías: 6 o 7 cada una,
    // las `not_found` igual que las demás.
    expect(Math.min(...times)).toBeGreaterThanOrEqual(6);
    expect(Math.max(...times)).toBeLessThanOrEqual(7);
  });

  it("por `last_report_at` (lo de antes), las 71 vuelven en cada pasada y otras esperan", () => {
    const { sets, times } = runs("reported", 10);
    for (const asked of sets) expect([...asked].filter((id) => id < 71)).toHaveLength(71);
    expect(times.slice(0, 71).every((t) => t === 10)).toBe(true);
    expect(Math.min(...times.slice(71))).toBeLessThan(10);
  });
});

describe("«Guía Shalom no reconocida»", () => {
  const at = Date.parse(NOW);

  it(`hace falta ${SHALOM_UNRECOGNIZED_PASSES} consultas y ${SHALOM_UNRECOGNIZED_HOURS} h, las dos`, () => {
    expect(shalomUnrecognized({ shalom_not_found_since: hoursAgo(24), shalom_not_found_count: 6 }, at)).toBe(true);
    expect(shalomUnrecognized({ shalom_not_found_since: hoursAgo(200), shalom_not_found_count: 40 }, at)).toBe(true);
    // Seis seguidas en una tarde de caída de Shalom no bastan.
    expect(shalomUnrecognized({ shalom_not_found_since: hoursAgo(5), shalom_not_found_count: 10 }, at)).toBe(false);
    // Una sola pasada tras días sin preguntar, tampoco.
    expect(shalomUnrecognized({ shalom_not_found_since: hoursAgo(72), shalom_not_found_count: 5 }, at)).toBe(false);
    expect(shalomUnrecognized(FRESH, at)).toBe(false);
    expect(shalomUnrecognized({ shalom_not_found_since: "no-es-fecha", shalom_not_found_count: 9 }, at)).toBe(false);
  });

  it("dice qué pasa y qué hacer, y que Kapta solo la anula al reemplazarla", () => {
    const state = { shalom_not_found_since: "2026-11-03T15:00:00.000Z", shalom_not_found_count: 12 };
    expect(shalomUnrecognizedLine(state, "90172429")).toBe(
      "Guía Shalom no reconocida: el rastreo no encuentra la guía 90172429 desde el 03-11-2026 (12 consultas seguidas). " +
        "Si la caja salió con otra guía hecha en Shalom Pro, regístrala en «Ya la creé en Shalom Pro» (Cotejar Shalom también la busca); " +
        "si no salió, Shalom la venció: genera una guía nueva antes de llevarla. Kapta solo la anula al registrar la que la reemplaza.",
    );
    expect(shalomUnrecognizedNote(state, "90172429")).toMatch(/^Rastreo de Shalom: guía Shalom no reconocida: /);
  });

  it("el día va en la hora de Lima", () => {
    // 04:00 UTC del 04-11 son las 23:00 del 03-11 en Lima.
    expect(shalomUnrecognizedLine({ shalom_not_found_since: "2026-11-04T04:00:00.000Z", shalom_not_found_count: 6 }, null)).toContain(
      "desde el 03-11-2026",
    );
  });

  it("reconoce que falta la 0321 y nada más", () => {
    expect(shalomCheckColumnsMissing({ code: "42703", message: "column shipments.shalom_checked_at does not exist" })).toBe(true);
    expect(shalomCheckColumnsMissing({ code: "PGRST204", message: "Could not find the 'shalom_not_found_count' column of 'shipments'" })).toBe(true);
    expect(shalomCheckColumnsMissing({ code: "42703", message: "column shipments.otra does not exist" })).toBe(false);
    expect(shalomCheckColumnsMissing({ code: "57014", message: "shalom_checked_at timeout" })).toBe(false);
    expect(shalomCheckColumnsMissing(null)).toBe(false);
  });
});

describe("Almacén: la caja con la guía que Shalom no reconoce", () => {
  const line = shalomUnrecognizedLine({ shalom_not_found_since: "2026-11-03T15:00:00.000Z", shalom_not_found_count: 12 }, "90172429");
  const box = {
    courier: "shalom",
    delivery_status: "pendiente",
    operation: "agencia",
    created_at: hoursAgo(5),
    shalom_unrecognized: line,
  };

  it("se detiene aunque sea de hoy, y dice el motivo", () => {
    const queue = buildWarehouseQueue([box], Date.parse(NOW));
    const entry = queue.groups[0]!.entries[0]!;
    expect(entry.stalled).toBe(true);
    expect(entry.diagnosis).toBe(line);
    expect(queue.stalled).toBe(1);
    // Sigue en la cola: la caja está aquí y hay que hacer algo con ella.
    expect(queue.blocked).toHaveLength(0);
  });

  it("gana a las demás razones; a los 30 días suma la de decidir", () => {
    const previousOutputs = [{ id: "p", courier: "shalom", delivery_status: "anulado", custody_state: "empresa", created_at: hoursAgo(900) }];
    expect(stallDiagnosis({ shipment: { ...box, previousOutputs }, closer: "escaneo", ageDays: 4 })).toBe(line);
    expect(stallDiagnosis({ shipment: box, closer: "escaneo", ageDays: 31 })).toBe(
      `${line} 30 días o más sin armar: hay que decidir si sale o se cancela.`,
    );
  });

  it("sin la marca, la caja de hoy no se detiene", () => {
    const queue = buildWarehouseQueue([{ ...box, shalom_unrecognized: null }], Date.parse(NOW));
    expect(queue.groups[0]!.entries[0]!.stalled).toBe(false);
  });
});

describe("el cron, Almacén y la Mesa de despacho usan la regla", () => {
  const route = read("app/api/cron/shalom-reconcile/route.ts");

  it("la fila va por `shalom_checked_at` y, sin la 0321, por `last_report_at`", () => {
    expect(route).toContain('query.order("shalom_checked_at", { ascending: true, nullsFirst: true })');
    expect(route).toContain('query.order("last_report_at", { ascending: true, nullsFirst: true })');
    expect(route).toContain("if (error && shalomCheckColumnsMissing(error)) {");
  });

  it("sella TODAS las preguntadas del lote, también la que no volvió y el lote caído", () => {
    expect(route).toContain("answer: shalomCheckAnswer(replies.get(item.custom_id))");
    expect(route).toContain("const stamp = await stampChecks(admin, asked, checkColumns, errors);");
    expect(route).toContain('return guide ? [{ guide, answer: "otro" as const }] : [];');
    // `last_report_at` sigue siendo solo de las que contestaron.
    expect(route).toContain('patch: answer === "contesto" ? { ...check, last_report_at: nowIso } : check');
  });

  it("la avisa una vez por racha en la línea de tiempo, con el `guide_check` de siempre, y no anula nada", () => {
    expect(route).toContain("kind: GUIDE_CHECK_EVENT,");
    expect(route).toContain('.eq("payload->>motivo", SHALOM_UNRECOGNIZED_MOTIVO)');
    expect(route).toContain("desde: instant(state.shalom_not_found_since) || null,");
    expect(route).toContain("if (seen.has(`${guide.id}|${instant(state.shalom_not_found_since)}`)) continue;");
    const flag = route.slice(route.indexOf("async function flagUnrecognized"), route.indexOf("export async function GET"));
    expect(flag).not.toMatch(/from\("shipments"\)/);
    expect(flag).not.toContain("anulado");
  });

  it("Almacén y la Mesa de despacho leen la marca sin caerse sin la 0321", () => {
    const access = read("lib/dispatch-access.ts");
    expect(access.match(/await loadShalomUnrecognized\(/g)).toHaveLength(2);
    const lib = read("lib/shalom/check-queue.ts");
    expect(lib).toContain("if (!shalomCheckColumnsMissing(error)) console.error");
    expect(read("components/dispatch-workspace.tsx")).toContain("{SHALOM_UNRECOGNIZED_REASON}</Badge>");
  });
});

describe("la 0321, el MOM y DEPLOY", () => {
  it("la migración: tres columnas, sellos fuera del trigger y el sello inicial", () => {
    const sql = read("db/migrations/0321_shalom_checked_at.sql");
    expect(sql).toContain("add column if not exists shalom_checked_at timestamptz");
    expect(sql).toContain("add column if not exists shalom_not_found_since timestamptz");
    expect(sql).toContain("add column if not exists shalom_not_found_count integer not null default 0");
    expect(sql).toContain("'shalom_checked_at', 'shalom_not_found_since', 'shalom_not_found_count'");
    expect(sql).toContain("set shalom_checked_at = last_report_at");
    expect(read("scripts/verify-db.sh")).toContain("scripts/sql/shalom_checked_at_smoke.sql");
  });

  it("el MOM documenta la fila y el motivo con sus números", () => {
    const mom = flat(read("docs/mom/master-pedidos-v1.md"));
    expect(mom).toContain("#### La fila del rastreo y la guía que Shalom no reconoce (decidido el 08-11-2026)");
    expect(mom).toContain(`«${SHALOM_UNRECOGNIZED_REASON}»`);
    expect(mom).toContain(`**${SHALOM_UNRECOGNIZED_PASSES} consultas \`not_found\` seguidas y ${SHALOM_UNRECOGNIZED_HOURS} h**`);
    expect(mom).toContain("Kapta no anula ni recrea la guía");
  });

  it("DEPLOY: la entrada de la 0321 está y la migración no se aplica sola", () => {
    const deploy = read("DEPLOY.md");
    // Ya no es la primera: las entradas nuevas van arriba (0317 la siguió).
    const first = deploy.indexOf("\n### 08-11-2026 · Rastreo de Shalom: la fila va por cuándo se preguntó");
    expect(first).toBeGreaterThan(0);
    const body = flat(deploy.slice(first, deploy.indexOf("\n### ", first + 10)));
    expect(body).toContain("psql \"$DATABASE_URL\" -f db/migrations/0321_shalom_checked_at.sql");
    expect(body).toContain("Se puede desplegar **antes** de aplicarla");
  });
});

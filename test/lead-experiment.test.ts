import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import {
  ACTIVE_EXPERIMENT,
  FRIO_COVERAGE_EXPERIMENT,
  FRIO_GOLDEN_EXPERIMENT,
  TREATMENT_FRACTION,
  assignArm,
  isExperimentEligible,
} from "@/lib/lead-experiment";

// 14:00 en Lima (UTC-5) = 19:00 UTC.
const enHorario = "2026-09-05T19:00:00.000Z";
// 03:00 en Lima = 08:00 UTC.
const deMadrugada = "2026-09-05T08:00:00.000Z";

describe("isExperimentEligible", () => {
  it("entra el lead sin ninguna señal de compra", () => {
    expect(isExperimentEligible({ first_seen_at: enHorario })).toBe(true);
    expect(
      isExperimentEligible({ source: "meta_ad", first_inbound_text: "hola", first_seen_at: enHorario }),
    ).toBe(true);
    expect(
      isExperimentEligible({ source: "organic", first_inbound_text: null, first_seen_at: enHorario }),
    ).toBe(true);
  });

  it("queda fuera el que ya trae carrito o ficha", () => {
    expect(isExperimentEligible({ source: "cod_cart", first_seen_at: enHorario })).toBe(false);
    expect(
      isExperimentEligible({
        first_inbound_text: "https://kenku.pe/products/x hola",
        first_seen_at: enHorario,
      }),
    ).toBe(false);
  });

  // v1 exigía entrar entre las 7 y las 18 porque su tratamiento era "llámalo
  // dentro de su primera hora" y esa hora tenía que caer donde hubiera alguien.
  // v2 pide "que se llame", sin prisa: el de las 3 de la madrugada se llama a las
  // 9 y recibe el tratamiento igual. Quitar la franja DUPLICA la población —el
  // 57% entraba fuera— y con ella la velocidad del experimento.
  it("ya no mira la hora de entrada: sin franja desde v2", () => {
    expect(isExperimentEligible({ first_seen_at: deMadrugada })).toBe(true);
    expect(isExperimentEligible({ first_seen_at: null })).toBe(true);
    expect(isExperimentEligible({ first_seen_at: "no-es-fecha" })).toBe(true);
  });

  // Si la elegibilidad mirara un campo que la llamada puede reescribir, quién
  // entra al estudio dependería de lo que el estudio quiere medir. `district` es
  // exactamente ese campo: tras una llamada el cliente lo manda por WhatsApp y
  // el bot lo ingesta.
  it("NO mira el distrito, aunque leadSegment sí lo mire", () => {
    expect(isExperimentEligible({ district: "Miraflores", first_seen_at: enHorario } as never)).toBe(true);
  });

  // Igual con el estado y el conteo de entrantes: los dos cambian después de una
  // llamada.
  it("NO mira el estado ni el número de mensajes", () => {
    expect(
      isExperimentEligible({ status: "no_responde", inbound_count: 9, first_seen_at: enHorario } as never),
    ).toBe(true);
  });
});

describe("assignArm", () => {
  const EXP = ACTIVE_EXPERIMENT;

  it("es determinista: el mismo lead cae siempre en el mismo brazo", () => {
    const id = "9f1d2c3b-4a5e-6f70-8192-a3b4c5d6e7f8";
    const primero = assignArm(id, EXP);
    for (let i = 0; i < 20; i++) expect(assignArm(id, EXP)).toBe(primero);
  });

  it("reparte cerca de la fracción pedida", () => {
    const ids = Array.from({ length: 20_000 }, () => randomUUID());
    const tratados = ids.filter((id) => assignArm(id, EXP) === "tratamiento").length;
    // 20 % de 20.000 = 4.000; ±1,5 pp es holgado para n=20.000 y detecta un
    // hash que reparta mal (p. ej. si devolviera casi siempre lo mismo).
    expect(tratados / ids.length).toBeGreaterThan(TREATMENT_FRACTION - 0.015);
    expect(tratados / ids.length).toBeLessThan(TREATMENT_FRACTION + 0.015);
  });

  it("respeta una fracción distinta", () => {
    const ids = Array.from({ length: 20_000 }, () => randomUUID());
    const mitad = ids.filter((id) => assignArm(id, EXP, 0.5) === "tratamiento").length;
    expect(mitad / ids.length).toBeGreaterThan(0.48);
    expect(mitad / ids.length).toBeLessThan(0.52);
  });

  it("0 y 1 son apagados válidos", () => {
    const ids = Array.from({ length: 200 }, () => randomUUID());
    expect(ids.every((id) => assignArm(id, EXP, 0) === "control")).toBe(true);
    expect(ids.every((id) => assignArm(id, EXP, 1) === "tratamiento")).toBe(true);
  });

  it("una fracción inválida no reparte en vez de repartir raro", () => {
    const id = randomUUID();
    expect(assignArm(id, EXP, Number.NaN)).toBe("control");
    expect(assignArm(id, EXP, -1)).toBe("control");
  });

  // Sin sal, quien cayó en tratamiento en un experimento caería en TODOS, y dos
  // experimentos dejarían de ser independientes. Importa AHORA y no en abstracto:
  // v2 reparte sobre la misma población que v1, así que sin sal heredaría sus
  // brazos enteros — y con ellos el resultado de un tratamiento que ya se
  // administró mal.
  it("dos experimentos reparten a gente distinta", () => {
    const ids = Array.from({ length: 5_000 }, () => randomUUID());
    const a = new Set(ids.filter((id) => assignArm(id, "exp_a", 0.5) === "tratamiento"));
    const b = new Set(ids.filter((id) => assignArm(id, "exp_b", 0.5) === "tratamiento"));
    const solapan = [...a].filter((id) => b.has(id)).length;
    // Independientes ⇒ ~25 % de los ids caen en tratamiento en ambos. Si el
    // reparto ignorara el nombre del experimento serían el 50 %.
    expect(solapan / ids.length).toBeGreaterThan(0.21);
    expect(solapan / ids.length).toBeLessThan(0.29);
  });

  // El caso concreto del test anterior, con los dos nombres de verdad: los
  // tratados de v2 no pueden ser los mismos que los de v1.
  it("v2 no hereda los brazos de v1", () => {
    const ids = Array.from({ length: 5_000 }, () => randomUUID());
    const v1 = new Set(ids.filter((id) => assignArm(id, FRIO_GOLDEN_EXPERIMENT) === "tratamiento"));
    const v2 = new Set(ids.filter((id) => assignArm(id, FRIO_COVERAGE_EXPERIMENT) === "tratamiento"));
    const solapan = [...v2].filter((id) => v1.has(id)).length;
    // Independientes ⇒ ~20 % de los tratados de v2 también lo fueron en v1. Si
    // los heredara sería el 100 %.
    expect(solapan / Math.max(1, v2.size)).toBeLessThan(0.3);
  });

  // Los ids de hoy son UUID v4 (aleatorios), pero si mañana fueran ordenados
  // —v7, o una secuencia— leer los primeros bits en vez de hashear ataría el
  // brazo a la HORA DE ENTRADA, y las horas del día no convierten igual. Esto lo
  // detecta: ids casi idénticos y consecutivos tienen que repartirse igual de
  // bien que los aleatorios.
  it("ids casi idénticos y consecutivos se reparten igual de bien", () => {
    const ids = Array.from({ length: 20_000 }, (_, i) => `0198f2a1-0000-7000-8000-${String(i).padStart(12, "0")}`);
    const tratados = ids.filter((id) => assignArm(id, EXP) === "tratamiento").length;
    expect(tratados / ids.length).toBeGreaterThan(TREATMENT_FRACTION - 0.015);
    expect(tratados / ids.length).toBeLessThan(TREATMENT_FRACTION + 0.015);
  });

  // El nombre del experimento NO tiene valor por defecto, y este test es el que
  // lo fija. Lo tenía, apuntando a v1; cuando v1 se paró el defecto se quedó
  // nombrando un experimento muerto sin que nada fallara, porque el único caller
  // pasaba el nombre explícito. Es la misma trampa que dejó pasar M51.
  it("el nombre del experimento es obligatorio", () => {
    const src = readFileSync(new URL("../lib/lead-experiment.ts", import.meta.url), "utf8");
    const firma = src.slice(src.indexOf("export function assignArm"), src.indexOf("): ExperimentArm"));
    expect(firma).toContain("experiment: string,");
    expect(firma).not.toMatch(/experiment:\s*string\s*=/);
  });

  it("el experimento que se reparte es el de cobertura", () => {
    expect(ACTIVE_EXPERIMENT).toBe(FRIO_COVERAGE_EXPERIMENT);
    expect(ACTIVE_EXPERIMENT).not.toBe(FRIO_GOLDEN_EXPERIMENT);
  });
});

// El experimento puede estar perfectamente diseñado y no administrarse: si la
// asesora no recibe el lead, no lo llama, y los dos brazos acaban iguales. Es
// literalmente lo que pasó en v1 — dos veces. Estas guardas leen el fuente para
// probar que el tratamiento SALE.
describe("el tratamiento se administra de verdad", () => {
  const leadsSrc = readFileSync(new URL("../components/leads.tsx", import.meta.url), "utf8");
  const priority = readFileSync(new URL("../lib/lead-priority.ts", import.meta.url), "utf8");
  const cron = readFileSync(new URL("../app/api/cron/sync/route.ts", import.meta.url), "utf8");
  const push = readFileSync(new URL("../app/api/cron/coverage-push/route.ts", import.meta.url), "utf8");
  const vercel = readFileSync(new URL("../vercel.json", import.meta.url), "utf8");

  // LAS DOS SEÑALES EN PANTALLA FALLARON, en la misma dirección. El empujón:
  // mediana 47 min hasta la llamada contra 17 del control. El chip 🧪: 23,5% de
  // leads llamados alguna vez contra 34,3% (p ≈ 0,04). Marcar un lead como "de la
  // prueba" hace que se salte. Que la cola vuelva a saber del experimento es la
  // regresión concreta que este test existe para impedir.
  it("la cola no sabe nada del experimento", () => {
    expect(leadsSrc).not.toContain("lead-experiment");
    expect(leadsSrc).not.toContain("assignArm");
    expect(leadsSrc).not.toContain("isExperimentEligible");
    expect(leadsSrc).not.toContain("🧪");
  });

  it("la cola tampoco se reordena por el experimento", () => {
    expect(priority).not.toContain("pinned");
    expect(priority).not.toMatch(/pin\?\.\(/);
    // Y en particular el puntaje sigue siendo solo lo medido.
    expect(priority).not.toMatch(/score:[^\n]*\+[^\n]*pin/);
  });

  it("el cron reparte, y no puede tumbar el sync si falla", () => {
    expect(cron).toContain("assignPendingExperimentArms(admin, storeIds)");
    // Desde la declaración hasta el final del fichero: `return NextResponse`
    // aparece antes (el 500 de la carga de tiendas), así que cortar por ahí
    // dejaba el bloque vacío y la aserción no probaba nada.
    const bloque = cron.slice(cron.indexOf("let experimento"));
    expect(bloque).toContain("try {");
    expect(bloque).toContain("catch");
    expect(bloque).toContain("el experimento nunca bloquea el sync");
  });

  // La entrega es TODO el tratamiento de v2: sin este cron el brazo de
  // tratamiento y el de control reciben exactamente lo mismo.
  it("hay un cron que entrega la lista, y está programado", () => {
    expect(push).toContain("pendingCoverageLeads");
    expect(push).toContain("sendTelegramToAll");
    expect(vercel).toContain("/api/cron/coverage-push");
  });

  // Se apunta DESPUÉS de enviar. Al revés, un fallo de Telegram quemaría esos
  // leads —no volverían a salir nunca— y el tratamiento se evaporaría en
  // silencio para ellos, que es exactamente como v1 se fue al traste sin que
  // nadie lo notara.
  it("solo se apunta lo que salió, y después de que saliera", () => {
    expect(push).toContain("res.sent > 0 ? await recordCoveragePush");
    expect(push.indexOf("sendTelegramToAll(")).toBeLessThan(push.indexOf("recordCoveragePush("));
  });
});

// La migración es el método, no solo un esquema: si el brazo se pudiera
// reescribir, alguien podría moverlo después de ver el resultado y el
// experimento no probaría nada.
describe("la asignación es inmutable", () => {
  const sql = readFileSync(new URL("../db/migrations/0144_lead_experiments.sql", import.meta.url), "utf8");
  // Sin comentarios: la cabecera EXPLICA los permisos que no queremos, así que
  // una regex sobre el texto crudo se dispara con la prosa y no con el SQL.
  const codigo = sql.replace(/--[^\n]*/g, "");

  it("append-only con trigger, no solo por convención", () => {
    expect(sql).toContain("before update or delete on lead_experiments");
    expect(sql).toContain("public.reject_mutation()");
  });

  it("sin update ni delete ni para service_role", () => {
    expect(codigo).toContain("grant select, insert on lead_experiments to service_role;");
    expect(codigo).not.toMatch(/grant[^;]*\b(update|delete|truncate)\b[^;]*on lead_experiments/i);
  });

  // Supabase trae `alter default privileges ... grant all on tables`, así que la
  // tabla NACE con update, delete y truncate para todos y un `grant select`
  // posterior no quita nada — los grants suman. Sin el revoke, la migración cree
  // estar restringiendo y solo confirma lo que ya había. Se vio al aplicar 0144
  // en producción: `order_sales` llevaba así desde 0132.
  it("revoca antes de conceder, o el grant no restringe nada", () => {
    expect(sql).toMatch(/revoke all on lead_experiments from anon, authenticated, service_role;/);
    expect(sql.indexOf("revoke all on lead_experiments")).toBeLessThan(
      sql.indexOf("grant select on lead_experiments"),
    );
  });
});

// Guarda general: la siguiente tabla append-only no debe repetir el fallo. El
// trigger `reject_mutation` es de FILA sobre update/delete, así que NO cubre
// TRUNCATE; sin revocar el permiso, la garantía de "esto no se reescribe" se
// salta entera con un truncate.
describe("toda tabla append-only revoca sus permisos de más", () => {
  const dir = new URL("../db/migrations/", import.meta.url);
  const ficheros = readdirSync(dir).filter((f) => f.endsWith(".sql"));

  it("cada migración que instala reject_mutation revoca sobre esa tabla", () => {
    const sinRevoke: string[] = [];
    for (const f of ficheros) {
      const src = readFileSync(new URL(f, dir), "utf8");
      // Tablas a las que ESTA migración les pone el candado append-only. La
      // captura llega hasta `reject_mutation` a propósito: mirar solo
      // `before update ... on X` cogía también los triggers corrientes de
      // `updated_at`, y marcaba como append-only tablas que no lo son
      // (order_master, order_payments).
      const tablas = [
        ...src.matchAll(/before\s+(?:update|delete)[\s\S]{0,120}?\son\s+(\w+)[\s\S]{0,200}?reject_mutation/gi),
      ]
        .map((m) => m[1]!)
        .filter((t, i, a) => a.indexOf(t) === i);
      for (const tabla of tablas) {
        // Sirve el revoke en su propia migración O estar en la lista de 0145.
        // Sin lista de excepciones por antigüedad: que las viejas estén bien en
        // producción es suerte de calendario —nacieron antes de que el proyecto
        // tuviera los privilegios por defecto—, no una propiedad del código.
        if (!new RegExp(`revoke\\s+all\\s+on\\s+(public\\.)?${tabla}\\b`, "i").test(src)) {
          sinRevoke.push(tabla);
        }
      }
    }
    const barrido = readFileSync(
      new URL("0145_append_only_revoke_excess_grants.sql", dir),
      "utf8",
    );
    const pendientes = [...new Set(sinRevoke)].filter((t) => !barrido.includes(`'${t}'`));
    expect(pendientes).toEqual([]);
  });
});

describe("la lectura del experimento no reintroduce el sesgo", () => {
  // La lectura de v1 vive ahora en 0150. 0144 contaba los toques de máquina como
  // llamadas (arreglado en 0146), 0147 le metió la franja horaria fija y 0150 la
  // ató a v1 para que no se le aplique a v2.
  const sql = readFileSync(
    new URL("../db/migrations/0150_lead_coverage_pushes.sql", import.meta.url),
    "utf8",
  );
  const sql144 = readFileSync(new URL("../db/migrations/0144_lead_experiments.sql", import.meta.url), "utf8");

  it("la PK es compuesta, para que quepa un segundo experimento", () => {
    expect(sql144).toContain("primary key (lead_id, experiment)");
  });

  // La tabla es append-only, así que las asignaciones de v1 hechas antes de que
  // existiera el filtro de franja siguen ahí —131 de 167 cuando se escribió—. Si
  // la lectura no las descartara, mezclaría dos poblaciones con reglas de
  // elegibilidad distintas y arrastraría el resultado con leads intratables.
  it("la franja sigue acotando la población de v1", () => {
    expect(sql).toContain(
      "extract(hour from l.first_seen_at at time zone 'America/Lima')::int between 7 and 18",
    );
  });

  // 0147 dejaba la franja fija para CUALQUIER experimento. v2 reparte sin
  // franja, así que leerlo con ese literal tiraría el 57% de su población en
  // silencio, y encima por una regla que a v2 no se le aplicó al repartir.
  it("y solo a la de v1", () => {
    // La expresión entera, no las dos piezas por separado: lo que importa es que
    // la franja esté DENTRO del `or` que la ata a v1. Comprobar solo que las dos
    // cadenas aparecen las daría por buenas aunque estuvieran en cláusulas
    // distintas, que es precisamente el fallo posible.
    expect(sql.replace(/--[^\n]*/g, "").replace(/\s+/g, " ")).toContain(
      "and ( p_experiment <> 'frio_hora_dorada_v1' " +
        "or extract(hour from l.first_seen_at at time zone 'America/Lima')::int between 7 and 18 )",
    );
    // Y el nombre del literal SQL es el mismo que el del código: si se separaran,
    // la franja se le aplicaría al experimento equivocado en silencio.
    expect(sql).toContain(`'${FRIO_GOLDEN_EXPERIMENT}'`);
  });

  it("la primera llamada solo cuenta toques de PERSONAS", () => {
    expect(sql).toContain("where kind in ('call', 'message', 'sale')");
    // Y la versión vieja, que no filtraba, ya no puede ser la que corre: si
    // alguien reaplicara 0144 sobre 0146 volvería el fallo en silencio.
    const fnDe144 = sql144.slice(sql144.indexOf("create or replace function public.read_lead_experiment"));
    expect(fnDe144).not.toContain("kind in ('call'");
    expect(Number("0150".slice(0, 4))).toBeGreaterThan(Number("0144".slice(0, 4)));
  });

  it("el análisis descarta las filas asignadas después de la primera llamada", () => {
    expect(sql).toContain("e.assigned_at <= f.first_call");
  });

  // Agrupar por quién acabó llamándose volvería a meter la selección que el
  // experimento existe para eliminar.
  it("el análisis agrupa por brazo asignado, no por cumplimiento", () => {
    expect(sql).toContain("group by 1, 2");
    expect(sql).toContain("e.arm");
  });
});

// v2 mide la COBERTURA, no la velocidad, y su lectura tiene que decir por
// separado si el tratamiento salió (`empujados`) y si se trabajó (`llamados`).
// En v1 los dos brazos salieron iguales y hubo que reconstruir a mano si el
// tratamiento había llegado a administrarse.
describe("la lectura de v2 separa entrega de cumplimiento", () => {
  const sql = readFileSync(
    new URL("../db/migrations/0150_lead_coverage_pushes.sql", import.meta.url),
    "utf8",
  );
  const codigo = sql.replace(/--[^\n]*/g, "");

  it("devuelve empujados y llamados por separado", () => {
    const fn = sql.slice(sql.indexOf("create or replace function public.read_lead_coverage"));
    expect(fn).toContain("empujados bigint");
    expect(fn).toContain("llamados bigint");
    expect(fn).toContain("pct_llamado numeric");
    expect(fn).toContain("count(p.lead_id) as empujados");
  });

  it("cuenta como llamada solo el toque de una persona", () => {
    const fn = sql.slice(sql.indexOf("create or replace function public.read_lead_coverage"));
    expect(fn).toContain("where kind in ('call', 'message', 'sale')");
  });

  it("agrupa por brazo asignado y madura antes de mirar la conversión", () => {
    const fn = sql.slice(sql.indexOf("create or replace function public.read_lead_coverage"));
    expect(fn).toContain("e.arm");
    expect(fn).toContain("make_interval(days => p_maduracion_dias)");
    expect(fn).toContain("e.assigned_at <= f.first_call");
  });

  // Cada lead sale UNA vez, y eso es de la PK, no de la consulta: dos pasadas
  // simultáneas del cron chocan en vez de mandar el lead dos veces.
  it("la entrega se registra una sola vez por lead y experimento", () => {
    expect(sql).toContain("primary key (lead_id, experiment)");
    expect(sql).toContain("before update or delete on lead_coverage_pushes");
    expect(codigo).toContain("grant select, insert on lead_coverage_pushes to service_role;");
    expect(codigo).not.toMatch(/grant[^;]*\b(update|delete|truncate)\b[^;]*on lead_coverage_pushes/i);
  });
});

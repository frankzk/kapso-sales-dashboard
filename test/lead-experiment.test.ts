import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import {
  FRIO_GOLDEN_EXPERIMENT,
  TREATABLE_HOUR_END,
  TREATABLE_HOUR_START,
  TREATMENT_FRACTION,
  assignArm,
  isExperimentEligible,
  isWithinTreatableWindow,
  shouldPin,
} from "@/lib/lead-experiment";

// 14:00 en Lima (UTC-5) = 19:00 UTC. Dentro de la franja tratable.
const enHorario = "2026-09-05T19:00:00.000Z";
// 03:00 en Lima = 08:00 UTC. Nadie trabajando.
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

  // El 57% de los leads sin señal entra fuera de horario, cuando solo ocurre el
  // 10,7% de los toques humanos. Asignarlos metería en el estudio leads que
  // NADIE puede tratar: no sesga (le pasa igual a los dos brazos) pero aplasta
  // el contraste de cumplimiento y multiplica el tamaño de muestra necesario.
  it("queda fuera el que entra cuando no hay nadie para llamarlo", () => {
    expect(isExperimentEligible({ first_seen_at: deMadrugada })).toBe(false);
    expect(isExperimentEligible({ first_seen_at: null })).toBe(false);
    expect(isExperimentEligible({ first_seen_at: "no-es-fecha" })).toBe(false);
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

describe("isWithinTreatableWindow", () => {
  const aLasLima = (h: number) =>
    new Date(Date.UTC(2026, 8, 5, (h + 5) % 24, 30)).toISOString();

  it("los bordes son los medidos: 7 y 18 dentro, 6 y 19 fuera", () => {
    expect(isWithinTreatableWindow(aLasLima(TREATABLE_HOUR_START))).toBe(true);
    expect(isWithinTreatableWindow(aLasLima(TREATABLE_HOUR_END))).toBe(true);
    expect(isWithinTreatableWindow(aLasLima(TREATABLE_HOUR_START - 1))).toBe(false);
    expect(isWithinTreatableWindow(aLasLima(TREATABLE_HOUR_END + 1))).toBe(false);
  });

  it("resuelve la hora en Lima, no en UTC", () => {
    // 23:30 UTC = 18:30 en Lima → dentro. En UTC caería fuera.
    expect(isWithinTreatableWindow("2026-09-05T23:30:00.000Z")).toBe(true);
    // 09:00 UTC = 04:00 en Lima → fuera. En UTC caería dentro.
    expect(isWithinTreatableWindow("2026-09-05T09:00:00.000Z")).toBe(false);
  });

  it("sin hora usable no entra", () => {
    expect(isWithinTreatableWindow(null)).toBe(false);
    expect(isWithinTreatableWindow("")).toBe(false);
    expect(isWithinTreatableWindow("roto")).toBe(false);
  });
});

describe("assignArm", () => {
  it("es determinista: el mismo lead cae siempre en el mismo brazo", () => {
    const id = "9f1d2c3b-4a5e-6f70-8192-a3b4c5d6e7f8";
    const primero = assignArm(id);
    for (let i = 0; i < 20; i++) expect(assignArm(id)).toBe(primero);
  });

  it("reparte cerca de la fracción pedida", () => {
    const ids = Array.from({ length: 20_000 }, () => randomUUID());
    const tratados = ids.filter((id) => assignArm(id) === "tratamiento").length;
    // 20 % de 20.000 = 4.000; ±1,5 pp es holgado para n=20.000 y detecta un
    // hash que reparta mal (p. ej. si devolviera casi siempre lo mismo).
    expect(tratados / ids.length).toBeGreaterThan(TREATMENT_FRACTION - 0.015);
    expect(tratados / ids.length).toBeLessThan(TREATMENT_FRACTION + 0.015);
  });

  it("respeta una fracción distinta", () => {
    const ids = Array.from({ length: 20_000 }, () => randomUUID());
    const mitad = ids.filter((id) => assignArm(id, 0.5) === "tratamiento").length;
    expect(mitad / ids.length).toBeGreaterThan(0.48);
    expect(mitad / ids.length).toBeLessThan(0.52);
  });

  it("0 y 1 son apagados válidos", () => {
    const ids = Array.from({ length: 200 }, () => randomUUID());
    expect(ids.every((id) => assignArm(id, 0) === "control")).toBe(true);
    expect(ids.every((id) => assignArm(id, 1) === "tratamiento")).toBe(true);
  });

  it("una fracción inválida no reparte en vez de repartir raro", () => {
    const id = randomUUID();
    expect(assignArm(id, Number.NaN)).toBe("control");
    expect(assignArm(id, -1)).toBe("control");
  });

  // Sin sal, quien cayó en tratamiento en un experimento caería en TODOS, y dos
  // experimentos dejarían de ser independientes.
  it("dos experimentos reparten a gente distinta", () => {
    const ids = Array.from({ length: 5_000 }, () => randomUUID());
    const a = new Set(ids.filter((id) => assignArm(id, 0.5, "exp_a") === "tratamiento"));
    const b = new Set(ids.filter((id) => assignArm(id, 0.5, "exp_b") === "tratamiento"));
    const solapan = [...a].filter((id) => b.has(id)).length;
    // Independientes ⇒ ~25 % de los ids caen en tratamiento en ambos. Si el
    // reparto ignorara el nombre del experimento serían el 50 %.
    expect(solapan / ids.length).toBeGreaterThan(0.21);
    expect(solapan / ids.length).toBeLessThan(0.29);
  });

  // Los ids de hoy son UUID v4 (aleatorios), pero si mañana fueran ordenados
  // —v7, o una secuencia— leer los primeros bits en vez de hashear ataría el
  // brazo a la HORA DE ENTRADA, y las horas del día no convierten igual. Esto lo
  // detecta: ids casi idénticos y consecutivos tienen que repartirse igual de
  // bien que los aleatorios.
  it("ids casi idénticos y consecutivos se reparten igual de bien", () => {
    const ids = Array.from({ length: 20_000 }, (_, i) => `0198f2a1-0000-7000-8000-${String(i).padStart(12, "0")}`);
    const tratados = ids.filter((id) => assignArm(id) === "tratamiento").length;
    expect(tratados / ids.length).toBeGreaterThan(TREATMENT_FRACTION - 0.015);
    expect(tratados / ids.length).toBeLessThan(TREATMENT_FRACTION + 0.015);
  });

  it("el experimento por defecto es el de la hora dorada", () => {
    const ids = Array.from({ length: 500 }, () => randomUUID());
    for (const id of ids) {
      expect(assignArm(id)).toBe(assignArm(id, TREATMENT_FRACTION, FRIO_GOLDEN_EXPERIMENT));
    }
  });
});

describe("shouldPin", () => {
  it("solo el tratamiento y solo dentro de su hora", () => {
    expect(shouldPin("tratamiento", "dorada")).toBe(true);
    expect(shouldPin("tratamiento", "tibia")).toBe(false);
    expect(shouldPin("control", "dorada")).toBe(false);
    expect(shouldPin(null, "dorada")).toBe(false);
    expect(shouldPin("tratamiento", null)).toBe(false);
  });
});

// El experimento puede estar perfectamente diseñado y no administrarse: si el
// lead no sube a la cola ni se marca, la asesora no lo llama y los dos brazos
// acaban iguales. Estas guardas leen el fuente para probar que el tratamiento
// LLEGA a la pantalla.
describe("el tratamiento se administra de verdad", () => {
  const src = readFileSync(new URL("../components/leads.tsx", import.meta.url), "utf8");
  const priority = readFileSync(new URL("../lib/lead-priority.ts", import.meta.url), "utf8");
  const cron = readFileSync(new URL("../app/api/cron/sync/route.ts", import.meta.url), "utf8");

  it("el brazo se deriva con la misma función pura que usa el reparto", () => {
    expect(src).toContain('assignArm(lead.id) === "tratamiento"');
    expect(src).toContain("isExperimentEligible(lead)");
  });

  // El empujón se RETIRÓ. Medido sobre las primeras 78 asignaciones, el brazo de
  // tratamiento se llamaba a los 47 minutos de mediana contra 14 del control, y
  // 1 de 19 dentro de los primeros 30 minutos contra 15 de 59. Marginal
  // (p ≈ 0,06) pero en la dirección equivocada en todos los cortes — y con un
  // coste cierto: ponía un frío (~9-19%) por encima de un carrito fresco (41%).
  it("la cola NO se reordena por el experimento", () => {
    expect(priority).not.toContain("pinned");
    expect(priority).not.toMatch(/pin\?\.\(/);
    // Y en particular el puntaje sigue siendo solo lo medido.
    expect(priority).not.toMatch(/score:[^\n]*\+[^\n]*pin/);
  });

  // El aviso reemplaza al empujón, y tiene que contarse ignorando el chip de
  // segmento: al filtrar por Carrito, un lead frío del tratamiento desaparecería
  // de la lista y nadie lo llamaría nunca. Es el fallo que hundió la primera
  // versión del tratamiento.
  it("el aviso de la prueba sobrevive al filtro de segmento", () => {
    expect(src).toContain('enPruebaIds: facets\n        .except("seg", "edad")');
    expect(src).toContain("🧪 {enPruebaIds.length}");
    // Y su botón limpia los filtros, o la lista mostraría menos filas que el
    // número del aviso — y la que faltaría sería justo la de la prueba.
    const boton = src.slice(src.indexOf("Ver la cola sin filtros") - 700, src.indexOf("Ver la cola sin filtros"));
    expect(boton).toContain("setSegFilter(null);");
    expect(boton).toContain('setEdadFilter("all");');
  });

  it("la fila dice por qué está arriba", () => {
    expect(src).toContain("🧪 prueba");
    expect(src).toContain("enExperimento(lead) && (");
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
  // La función vive ahora en 0147. 0144 contaba los toques de máquina como
  // llamadas (arreglado en 0146) y no filtraba la franja horaria (0147).
  const sql = readFileSync(
    new URL("../db/migrations/0147_read_lead_experiment_franja.sql", import.meta.url),
    "utf8",
  );
  const sql144 = readFileSync(new URL("../db/migrations/0144_lead_experiments.sql", import.meta.url), "utf8");

  it("la PK es compuesta, para que quepa un segundo experimento", () => {
    expect(sql144).toContain("primary key (lead_id, experiment)");
  });

  // El 51,3% de `lead_calls` es `kind='system'` — drip, winback y secuencias de
  // carrito. Contarlas como llamadas destruye justo el indicador que existe para
  // detectar que el experimento no se administró: `pct_en_1h` saldría alto en los
  // DOS brazos (a los dos les saltan drips) y la diferencia se aplanaría.
  // La tabla es append-only, así que las asignaciones hechas antes de que
  // existiera el filtro de franja siguen ahí —131 de 167 cuando se escribió
  // esto—. Si la lectura no las descartara, mezclaría dos poblaciones con reglas
  // de elegibilidad distintas y arrastraría el resultado con leads intratables.
  it("analiza la misma población que el reparto selecciona", () => {
    expect(sql).toContain(
      "extract(hour from l.first_seen_at at time zone 'America/Lima')::int between 7 and 18",
    );
  });

  // El SQL no puede importar las constantes del código, así que se comprueba que
  // no se hayan separado: mover una sin la otra dejaría el análisis mirando una
  // franja distinta de la que se reparte, en silencio.
  it("la franja del SQL coincide con la del código", () => {
    expect(sql).toContain(`between ${TREATABLE_HOUR_START} and ${TREATABLE_HOUR_END}`);
  });

  it("la primera llamada solo cuenta toques de PERSONAS", () => {
    expect(sql).toContain("where kind in ('call', 'message', 'sale')");
    // Y la versión vieja, que no filtraba, ya no puede ser la que corre: si
    // alguien reaplicara 0144 sobre 0146 volvería el fallo en silencio.
    const fnDe144 = sql144.slice(sql144.indexOf("create or replace function public.read_lead_experiment"));
    expect(fnDe144).not.toContain("kind in ('call'");
    expect(Number("0146".slice(0, 4))).toBeGreaterThan(Number("0144".slice(0, 4)));
  });

  it("el análisis descarta las filas asignadas después de la primera llamada", () => {
    expect(sql).toContain("e.assigned_at <= f.first_call");
  });

  // Agrupar por quién acabó llamándose dentro de la hora volvería a meter la
  // selección que el experimento existe para eliminar.
  it("el análisis agrupa por brazo asignado, no por cumplimiento", () => {
    expect(sql).toContain("group by 1, 2");
    expect(sql).toContain("e.arm");
    expect(sql).toContain("pct_en_1h");
  });
});

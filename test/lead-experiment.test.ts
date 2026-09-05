import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import {
  FRIO_GOLDEN_EXPERIMENT,
  TREATMENT_FRACTION,
  assignArm,
  isExperimentEligible,
  shouldPin,
} from "@/lib/lead-experiment";

describe("isExperimentEligible", () => {
  it("entra el lead sin ninguna señal de compra", () => {
    expect(isExperimentEligible({})).toBe(true);
    expect(isExperimentEligible({ source: "meta_ad", first_inbound_text: "hola" })).toBe(true);
    expect(isExperimentEligible({ source: "organic", first_inbound_text: null })).toBe(true);
  });

  it("queda fuera el que ya trae carrito o ficha", () => {
    expect(isExperimentEligible({ source: "cod_cart" })).toBe(false);
    expect(
      isExperimentEligible({ first_inbound_text: "https://kenku.pe/products/x hola" }),
    ).toBe(false);
  });

  // Si la elegibilidad mirara un campo que la llamada puede reescribir, quién
  // entra al estudio dependería de lo que el estudio quiere medir. `district` es
  // exactamente ese campo: tras una llamada el cliente lo manda por WhatsApp y
  // el bot lo ingesta.
  it("NO mira el distrito, aunque leadSegment sí lo mire", () => {
    expect(isExperimentEligible({ district: "Miraflores" } as never)).toBe(true);
  });

  // Igual con el estado y el conteo de entrantes: los dos cambian después de una
  // llamada.
  it("NO mira el estado ni el número de mensajes", () => {
    expect(isExperimentEligible({ status: "no_responde", inbound_count: 9 } as never)).toBe(true);
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

  it("el lead del tratamiento sube al principio de la cola", () => {
    expect(src).toContain("enExperimento,");
    expect(priority).toContain("Number(b.pinned) - Number(a.pinned) ||");
  });

  // El empujón NO puede ir sumado al puntaje: los pesos son probabilidades de
  // cierre medidas y falsearlas haría que el próximo que las lea concluya que un
  // frío cierra más.
  it("el empujón es una llave aparte, no un puntaje inflado", () => {
    expect(priority).toContain("pinned: pin?.(lead) === true,");
    expect(priority).not.toMatch(/score:[^\n]*\+[^\n]*pin/);
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
  const sql = readFileSync(new URL("../db/migrations/0144_lead_experiments.sql", import.meta.url), "utf8");

  it("la PK es compuesta, para que quepa un segundo experimento", () => {
    expect(sql).toContain("primary key (lead_id, experiment)");
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

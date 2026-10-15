// Los comprobantes por RUC (MOM §35) están escritos en prosa, y la regla que de
// verdad corre vive en sitios que nadie compila juntos: las reglas puras
// (lib/invoicing/rules.ts), la 0257 y la 0260 (lo que la base acepta y lo que
// el turno vuelve a revisar), los permisos y el cron. Ninguno falla solo si se separa del
// MOM: un motivo que el panel no sabe decir, un tope que el MOM promete y la
// base no guarda, un estado «vivo» que el índice único no cuenta, un 4xx que el
// MOM da por «no hay boleta» y el código trata como duda. Y una boleta de más
// ante SUNAT no se borra. Estas pruebas atan cada cifra y cada nombre del MOM
// al código que de verdad corre.

import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";
import {
  BOLETA_MAX_CENTS,
  BOLETA_TYPE,
  IGV_PERCENT,
  INVOICE_DAILY_LIMIT_DEFAULT,
  INVOICE_DAILY_LIMIT_MAX,
  INVOICE_DAILY_LIMIT_MIN,
  INVOICE_MAX_PER_RUN,
  INVOICE_MODES,
  INVOICE_MODE_LABEL,
  INVOICE_REASONS,
  INVOICE_REASON_LABEL,
  INVOICE_STATUSES,
  LIVE_REAL_STATUSES,
  WALKIN_CUSTOMER,
  buildSalePayload,
  classifySaleResponse,
  invoiceEligibility,
  invoiceNote,
  invoiceNoteRef,
  isValidRuc,
  normalizeSubdomain,
  rucFromSimplefactText,
  simplefactBaseUrl,
  type InvoiceAccount,
  type InvoiceIssuer,
  type InvoiceOrderFacts,
  type InvoicePayment,
} from "@/lib/invoicing/rules";
import {
  INVOICE_MIGRATION_OBJECTS,
  INVOICE_SHOPIFY_RECHECK_MS,
  INVOICE_STALE_EMITTING_MS,
  INVOICE_SWEEP_MAX_CANDIDATES,
  INVOICE_UNRECONCILED_BATCH,
  SHOPIFY_LEVEL_REASONS,
  invoiceUnreconciledError,
  isInvoiceMigrationMissing,
  runInvoiceSweep,
  shopifyBlockedReasons,
} from "@/lib/invoicing/server";
import { mapOrderForInvoice, webPrepaidConfirmed } from "@/lib/invoicing/shopify-order";
import { CHECKOUT_GATEWAYS } from "@/lib/payment-gateway";
import {
  FUNCTIONAL_ROLES,
  GRANTED_ONE_BY_ONE,
  PERMISSIONS,
  PERMISSION_LABEL,
  permissionsFor,
} from "@/lib/permissions";

const read = (...p: string[]) => readFileSync(resolve(process.cwd(), ...p), "utf8");
/** El texto en una sola línea: la prosa del MOM se reparte en renglones de 80. */
const flat = (text: string) => text.replace(/\s+/g, " ");

const MOM = read("docs/mom/master-pedidos-v1.md");
/**
 * La 0257 corrió en producción el 14-10-2026 tal como está y no se reescribe:
 * las tablas, sus restricciones e índices, los permisos de las tablas y la
 * semilla se leen en ella. La 0260 vuelve a escribir cuatro de sus funciones
 * (los arreglos de la revisión adversaria): lo que dice una función se lee en
 * su última versión, con `funcion`.
 */
const SQL_0257 = read("db/migrations/0257_invoices.sql");
const SQL_0257_FLAT = flat(SQL_0257);
const SQL_0260 = read("db/migrations/0260_invoices_hardening.sql");
const SQL_0260_FLAT = flat(SQL_0260);
/** Lo que la 0260 vuelve a escribir (o crea), y nada más. */
const FUNCIONES_0260 = ["invoice_issuers_touch", "order_invoices_guard", "invoice_claim", "invoice_candidates"];

/**
 * La versión vigente de una función: su último `create or replace` en la 0257 y
 * la 0260, en ese orden, hasta su `$$;`, en una línea. "" si no está.
 */
function funcion(nombre: string): string {
  const todo = flat(`${SQL_0257}\n${SQL_0260}`);
  const desde = todo.lastIndexOf(`create or replace function ${nombre}(`);
  return desde < 0 ? "" : todo.slice(desde, todo.indexOf("$$;", desde) + 3);
}

/** Desde un encabezado hasta el siguiente del mismo nivel (o el final). */
function section(text: string, heading: string, nextHeadingPrefix: string): string {
  const start = text.indexOf(heading);
  expect(start, heading).toBeGreaterThanOrEqual(0);
  const end = text.indexOf(nextHeadingPrefix, start + heading.length);
  return end < 0 ? text.slice(start) : text.slice(start, end);
}

/** Cada texto aparece, y en ese orden. */
function enOrden(text: string, partes: string[]): void {
  let last = -1;
  for (const p of partes) {
    const at = text.indexOf(p, last + 1);
    expect(at, p).toBeGreaterThan(last);
    last = at;
  }
}

/** Los valores de una lista SQL: «'a', 'b'» → ["a", "b"]. */
const sqlList = (text: string | undefined) => (text ?? "").split(",").map((s) => s.trim().replace(/^'|'$/g, ""));

/** Los códigos entre comillas invertidas: `ruc_apagado`. */
const codigos = (text: string) => [...text.matchAll(/`([a-z][a-z0-9_]*)`/g)].map((m) => m[1]!);

/** Como lo enumera el MOM: «a, b o c». */
const lista = (xs: readonly string[]) => (xs.length < 2 ? xs.join("") : `${xs.slice(0, -1).join(", ")} o ${xs.at(-1)}`);

const HEADING = "## 35. Comprobantes electrónicos por RUC (SimpleFact, 14-10-2026)";
const S35 = section(MOM, "## 35. Comprobantes electrónicos por RUC", "\n## ");
const sub = (n: number) => section(S35, `### 35.${n} `, "\n### ");

const REASON_SET: ReadonlySet<string> = new Set(INVOICE_REASONS);
const WRITE_MODES = INVOICE_MODES.filter((m) => m !== "apagado");

describe("MOM §35: la sección existe y dice su estado", () => {
  it("encabezado exacto, y nada de §35 colgando dentro de otra sección", () => {
    expect(MOM).toContain(HEADING);
    expect(MOM.replace(S35, "")).not.toMatch(/^#{3,4} 35\./m);
  });

  it("nace apagado: «Ningún RUC emite», y la 0257 lo siembra así", () => {
    const desde = S35.indexOf("Estado:");
    expect(desde).toBeGreaterThan(0);
    const estado = flat(S35.slice(desde, S35.indexOf("\n\n", desde)));
    expect(estado.startsWith("Estado: construido y apagado.")).toBe(true);
    // Las dos migraciones, y lo que trae cada una.
    expect(estado).toContain(
      "Existen las migraciones 0257 (empresas emisoras, cuenta → RUC, comprobantes y el candado de emisión) y 0260 (los arreglos de la revisión adversaria sobre la 0257: el turno que vuelve a revisar los pagos, la excepción de borrar la cuenta de una persona, el token nuevo que borra el motivo de la prueba anterior y los pedidos por revisar)",
    );
    expect(estado).toContain("**Ningún RUC emite**");
    expect(estado).toContain(`GRUPO GF S.A.C. nace dado de alta, en «${INVOICE_MODE_LABEL.apagado}» y sin token`);
    // «Apagado y sin token» no lo dice el código del barrido sino la base: el
    // modo nace en apagado y la semilla no escribe ni el modo ni el token.
    expect(SQL_0257_FLAT).toContain("mode text not null default 'apagado'");
    const semilla = /insert into invoice_issuers \(([^)]*)\)/.exec(SQL_0257_FLAT);
    expect(sqlList(semilla?.[1])).toEqual(["org_id", "ruc", "legal_name", "simplefact_subdomain"]);
  });

  it("subsecciones 35.1 a 35.9, en orden y ninguna más", () => {
    enOrden(
      S35,
      Array.from({ length: 9 }, (_, i) => `\n### 35.${i + 1} `),
    );
    expect(S35.match(/^### 35\.\d+ /gm)).toHaveLength(9);
  });

  describe("«Implementación:»", () => {
    const desde = S35.indexOf("\nImplementación:");
    const impl = desde < 0 ? "" : S35.slice(desde);
    const rutas = [...impl.matchAll(/`([^`\s]+)`/g)]
      .map((m) => m[1]!)
      .filter((t) => t.includes("/") && /\.[a-z]+$/.test(t));

    it("existe y nombra los archivos de cada capa", () => {
      expect(desde).toBeGreaterThan(0);
      for (const capa of [
        "db/migrations/0257_invoices.sql",
        "db/migrations/0260_invoices_hardening.sql",
        "lib/invoicing/rules.ts",
        "lib/invoicing/server.ts",
        "app/api/cron/invoices/route.ts",
        "lib/permissions.ts",
        "test/invoicing-*.test.ts",
      ]) {
        expect(rutas).toContain(capa);
      }
    });

    it("cada archivo que nombra existe en el repo", () => {
      for (const ruta of rutas) {
        if (!ruta.includes("*")) {
          expect(existsSync(resolve(process.cwd(), ruta)), ruta).toBe(true);
          continue;
        }
        // Un patrón (`test/invoicing-*.test.ts`) tiene que encontrar algo.
        const patron = new RegExp(
          `^${basename(ruta).replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*")}$`,
        );
        const dir = resolve(process.cwd(), dirname(ruta));
        const hallados = existsSync(dir) ? readdirSync(dir).filter((f) => patron.test(f)) : [];
        expect(hallados.length, ruta).toBeGreaterThan(0);
      }
    });

    /** El renglón de un archivo en «Implementación:», hasta el siguiente, en una línea. */
    const renglon = (ruta: string) => {
      const i = impl.indexOf(`\n- \`${ruta}\`:`);
      if (i < 0) return "";
      const j = impl.indexOf("\n- ", i + 1);
      return flat(j < 0 ? impl.slice(i) : impl.slice(i, j));
    };

    it("las tablas, la columna y el turno que nombra están en la 0257", () => {
      const r0257 = renglon("db/migrations/0257_invoices.sql");
      for (const tabla of ["invoice_issuers", "order_invoices", "invoice_order_checks"]) {
        expect(r0257).toContain(`\`${tabla}\``);
        expect(SQL_0257).toContain(`create table if not exists ${tabla} (`);
      }
      expect(r0257).toContain("`store_collection_accounts.invoice_issuer_id` con su trigger");
      expect(SQL_0257_FLAT).toContain("alter table store_collection_accounts add column if not exists invoice_issuer_id");
      expect(r0257).toContain("la función `invoice_claim` (el turno) y la semilla de GRUPO GF S.A.C.");
      expect(SQL_0257).toContain("create or replace function invoice_claim(");
      expect(r0257).toContain(
        "Es la que corrió en producción el 14-10-2026, y no se reescribe: lo que cambió después va en la 0260.",
      );
    });

    it("la 0257 es la que corrió en producción el 14-10-2026: no se reescribe", () => {
      // Producción no la vuelve a correr: lo que se le cambie no llega nunca, y
      // una base nueva quedaría distinta de producción bajo el mismo número. Lo
      // nuevo va en una migración nueva, como la 0260.
      const huella = createHash("sha256").update(SQL_0257.replace(/\r\n/g, "\n")).digest("hex");
      expect(huella).toBe("cc38c9c4c96a4c63b1e788dd54d4ad6cdbbffbbb7678ca2f7d4078eb1ab8f33f");
    });

    it("la 0260 vuelve a escribir las cuatro funciones que nombra, y nada más", () => {
      const r0260 = renglon("db/migrations/0260_invoices_hardening.sql");
      expect(r0260).toContain(
        "las funciones `invoice_claim` (el turno) e `invoice_candidates` (qué pedidos mira el barrido)",
      );
      expect(r0260).toContain(
        "y las de los triggers `invoice_issuers_touch` (un token nuevo borra también el motivo de la prueba anterior) y `order_invoices_guard` (la excepción de borrar la cuenta de una persona, 35.6).",
      );
      expect(r0260).toContain("Solo funciones: no toca datos ni recrea triggers.");
      // Cada una, en su versión vigente, es la de la 0260; y la 0260 no tiene otra.
      const creadas = [...SQL_0260.matchAll(/^create or replace function (\w+)\(/gm)].map((m) => m[1]);
      expect(creadas).toEqual(FUNCIONES_0260);
      for (const nombre of FUNCIONES_0260) {
        expect(r0260, nombre).toContain(`\`${nombre}\``);
        expect(funcion(nombre), nombre).not.toBe("");
        expect(SQL_0260_FLAT, nombre).toContain(funcion(nombre));
      }
      // Ni tablas, ni datos, ni triggers: lo que va en la columna 0 son las
      // funciones y sus permisos (dentro de una función, todo va indentado).
      expect(SQL_0260).not.toMatch(/^(?:insert|update|delete|truncate|alter|drop|comment|do|create (?!or replace function ))/im);
      expect([...SQL_0260.matchAll(/^(revoke all on function|grant execute on function) (\w+)\(/gm)].map((m) => `${m[1]} ${m[2]}`)).toEqual([
        "revoke all on function invoice_issuers_touch",
        "revoke all on function order_invoices_guard",
        "revoke all on function invoice_claim",
        "grant execute on function invoice_claim",
        "revoke all on function invoice_candidates",
        "grant execute on function invoice_candidates",
      ]);
      expect(SQL_0260_FLAT).toContain(
        "revoke all on function invoice_claim(uuid, uuid, uuid, uuid, numeric, timestamptz, text, jsonb, jsonb) from public, anon, authenticated;",
      );
      expect(SQL_0260_FLAT).toContain(
        "grant execute on function invoice_claim(uuid, uuid, uuid, uuid, numeric, timestamptz, text, jsonb, jsonb) to service_role;",
      );
      // La cabecera, como las otras: dice qué pasaba y que se aplica a mano.
      expect(SQL_0260_FLAT).toContain("-- QUÉ PASABA. La 0257 se aplicó en producción el 14-10-2026");
      expect(SQL_0260_FLAT).toContain("-- Se aplica a mano ANTES del código (DEPLOY.md). Es idempotente.");
    });

    it("la prueba SQL que nombra corre en verify-db", () => {
      const verify = read("scripts/verify-db.sh");
      const smokes = rutas.filter((r) => r.startsWith("scripts/sql/"));
      expect(smokes).toContain("scripts/sql/invoices_smoke.sql");
      for (const smoke of smokes) expect(verify, smoke).toContain(`$ROOT/${smoke}`);
    });
  });
});

describe("MOM §35.2 y §35.3: los motivos", () => {
  const s3 = sub(3);
  const filas = s3
    .split("\n")
    .filter((l) => /^\| \d+ \|/.test(l))
    .map((l) => {
      const celdas = l.split("|").map((c) => c.trim());
      return { n: Number(celdas[1]), codes: codigos(celdas.at(-2) ?? "") };
    });
  const deLaTabla = filas.flatMap((f) => f.codes);
  const delTurno = [...funcion("invoice_claim").matchAll(/'reason', '([a-z_0-9]+)'/g)].map((m) => m[1]!);

  it("la tabla tiene sus 10 condiciones numeradas seguidas", () => {
    expect(filas.map((f) => f.n)).toEqual(Array.from({ length: 10 }, (_, i) => i + 1));
  });

  it("cada código de la tabla es un motivo de INVOICE_REASONS, en el mismo orden", () => {
    // El orden importa: la primera condición que falla es el motivo que
    // guardan el barrido y el panel. Un MOM con otro orden contaría otro.
    for (const code of deLaTabla) expect(REASON_SET.has(code), code).toBe(true);
    const enCodigo = INVOICE_REASONS.filter((r) => deLaTabla.includes(r));
    expect(deLaTabla).toEqual(enCodigo);
    enOrden(flat(s3), enCodigo.map((r) => `\`${r}\``));
    // Y la tabla es el bloque entero de las reglas de la base, sin huecos: un
    // motivo nuevo en `invoiceEligibility` se escribe primero aquí.
    expect(deLaTabla).toEqual(INVOICE_REASONS.slice(0, INVOICE_REASONS.indexOf("error_previo") + 1));
  });

  it("la relectura en Shopify nombra motivos de la lectura de Shopify, en el orden de INVOICE_REASONS", () => {
    const desde = s3.indexOf("**Justo antes de emitir");
    const hasta = s3.indexOf("Recién entonces se pide el turno");
    expect(desde).toBeGreaterThan(0);
    expect(hasta).toBeGreaterThan(desde);
    const nombrados = codigos(s3.slice(desde, hasta));
    expect(nombrados.length).toBeGreaterThanOrEqual(10);
    const primero = INVOICE_REASONS.indexOf("no_encontrado");
    const ultimo = INVOICE_REASONS.indexOf("lectura_fallida");
    let last = -1;
    for (const code of nombrados) {
      const at = (INVOICE_REASONS as readonly string[]).indexOf(code);
      expect(at, code).toBeGreaterThanOrEqual(primero);
      expect(at, code).toBeLessThanOrEqual(ultimo);
      expect(at, code).toBeGreaterThan(last);
      last = at;
    }
    // «más de 100 líneas» es lo que la consulta trae de una vez.
    expect(flat(s3)).toContain("con más de 100 líneas (`demasiadas_lineas`)");
    expect(read("lib/invoicing/shopify-order.ts")).toContain("lineItems(first: 100)");
    expect(INVOICE_REASON_LABEL.demasiadas_lineas).toContain("100");
  });

  it("lo que el MOM dice que revisa el turno lo devuelve `invoice_claim`", () => {
    const desde = s3.indexOf("Recién entonces se pide el turno");
    const hasta = s3.indexOf("**Falla cerrada.**");
    expect(hasta).toBeGreaterThan(desde);
    const nombrados = codigos(s3.slice(desde, hasta)).filter((c) => c !== "invoice_claim" && c !== "registered_at");
    expect(nombrados).toEqual(["sin_conexion", "tope", "pagos_en_revision", "antes_de_inicio"]);
    for (const code of nombrados) expect(delTurno, code).toContain(code);
  });

  it("el turno saca la fecha de pago de los pagos de la base, no de lo que manda el barrido", () => {
    const turno = flat(s3.slice(s3.indexOf("Recién entonces se pide el turno"), s3.indexOf("**Falla cerrada.**")));
    expect(turno).toContain(
      "**La fecha de pago no se la cree al barrido**: la vuelve a sacar de los pagos de la base, con la cuenta de las condiciones 2 y 8, en los dos modos.",
    );
    expect(turno).toContain("Si queda un pago vivo (no rechazado) sin validar, no da el turno (`pagos_en_revision`).");
    expect(turno).toContain(
      "Si no, cuenta el `registered_at` del último pago validado o, sin pagos validados, la fecha del pedido.",
    );
    expect(turno).toContain(
      "Esa fecha y la que manda el barrido tienen que ser las dos desde «Emitir desde»; si falta una, o una es anterior, no da el turno (`antes_de_inicio`).",
    );
    // El turno vigente es el de la 0260: la 0257 que corrió no lo revisaba.
    const fn = funcion("invoice_claim");
    expect(SQL_0260_FLAT).toContain(fn);
    // Un pago vivo que no está validado (`posible_duplicado` incluido, y uno sin
    // estado) no da turno: la misma condición 2 de las reglas.
    expect(fn).toContain(
      "if exists ( select 1 from order_payments where order_id = p_order and validation_status is distinct from 'rechazado' and validation_status is distinct from 'validado' ) then return jsonb_build_object('reason', 'pagos_en_revision');",
    );
    // La fecha: el `registered_at` del último validado, nunca `validated_at`;
    // sin validados, la fecha del pedido, la misma que usan las reglas.
    expect(fn).toContain(
      "select count(*), max(registered_at) into v_live, v_paid from order_payments where order_id = p_order and validation_status = 'validado';",
    );
    expect(fn).not.toContain("validated_at");
    expect(fn).toContain("if v_live = 0 then v_paid := coalesce(v_order.processed_at, v_order.created_at);");
    expect(read("lib/invoicing/server.ts")).toContain("orderDate: o.processed_at ?? o.created_at,");
    // Las dos fechas, y sin una de ellas no hay turno.
    expect(fn).toContain(
      "if v_iss.emit_from is null or p_paid_at is null or p_paid_at < v_iss.emit_from or v_paid is null or v_paid < v_iss.emit_from then return jsonb_build_object('reason', 'antes_de_inicio');",
    );
    // «En los dos modos»: antes de que el turno se separe por modo.
    const porModo = fn.indexOf("if v_iss.mode = 'simulacion' then");
    expect(porModo).toBeGreaterThan(0);
    expect(fn.indexOf("'pagos_en_revision'")).toBeLessThan(porModo);
    expect(fn.indexOf("'antes_de_inicio'")).toBeLessThan(porModo);
  });

  it("todo motivo que nombra el MOM tiene su texto en INVOICE_REASON_LABEL", () => {
    // En §35.3 todo código entre comillas invertidas es un motivo, salvo tres
    // nombres de la base y el estado `error` de la condición 10.
    const noSonMotivos = new Set(["invoice_claim", "registered_at", "validated_at", "error"]);
    expect(INVOICE_STATUSES).toContain("error");
    const enS3 = codigos(s3).filter((c) => !noSonMotivos.has(c));
    expect(enS3.length).toBeGreaterThan(deLaTabla.length);
    for (const code of enS3) expect(Object.keys(INVOICE_REASON_LABEL), code).toContain(code);

    // §35.2 nombra los tres motivos de la cuenta y el RUC.
    const s2 = flat(sub(2));
    expect(s2).toContain("| — | Cualquier otro caso:");
    expect(s2).toContain("| Ninguna: `pago_sin_cuenta` |");
    expect(s2).toContain("Una candidata sin RUC da `cuenta_sin_ruc`, y dos RUC distintos, `ruc_mezclados`.");
    for (const code of ["pago_sin_cuenta", "cuenta_sin_ruc", "ruc_mezclados"] as const) {
      expect(INVOICE_REASON_LABEL[code].trim()).not.toBe("");
    }
  });
});

describe("MOM §35: las cifras son las del código y las de la base (0257 y 0260)", () => {
  const item = (priceCents: number) => ({ code: "SKU-1", name: "Producto", qty: 1, priceCents });
  const payload = (totalCents: number) =>
    buildSalePayload({
      invoiceId: "6f1c2a3b-0000-4000-8000-000000000000",
      orderName: "#KP136181",
      items: [item(totalCents)],
      totalCents,
    });

  it("S/ 700: el tope de la boleta, inclusive", () => {
    expect(BOLETA_MAX_CENTS).toBe(70_000);
    const soles = `S/ ${BOLETA_MAX_CENTS / 100}`;
    expect(flat(sub(1))).toContain(`un tope de ${soles};`);
    expect(flat(sub(3))).toContain(`El total es mayor que 0 y no pasa de ${soles} (35.5) | \`monto_cero\` / \`monto_mayor_700\` |`);
    expect(flat(sub(5))).toContain(`**no emite boletas de más de ${soles}**`);
    expect(INVOICE_REASON_LABEL.monto_mayor_700).toContain(soles);
    // «de más de»: S/ 700.00 sale, S/ 700.01 no. La base dice lo mismo.
    expect(payload(BOLETA_MAX_CENTS)).not.toBeNull();
    expect(payload(BOLETA_MAX_CENTS + 1)).toBeNull();
    expect(funcion("invoice_claim")).toContain(`if p_total > ${BOLETA_MAX_CENTS / 100} then`);
  });

  it("tope diario: 40 por defecto, de 1 a 300, por día de Lima", () => {
    expect([INVOICE_DAILY_LIMIT_DEFAULT, INVOICE_DAILY_LIMIT_MIN, INVOICE_DAILY_LIMIT_MAX]).toEqual([40, 1, 300]);
    const s4 = flat(sub(4));
    expect(s4).toContain(
      `**Tope diario por RUC** (\`daily_limit\`): ${INVOICE_DAILY_LIMIT_DEFAULT} por defecto, de ${INVOICE_DAILY_LIMIT_MIN} a ${INVOICE_DAILY_LIMIT_MAX}, por día de Lima.`,
    );
    expect(SQL_0257_FLAT).toContain(
      `daily_limit integer not null default ${INVOICE_DAILY_LIMIT_DEFAULT} check (daily_limit between ${INVOICE_DAILY_LIMIT_MIN} and ${INVOICE_DAILY_LIMIT_MAX})`,
    );
  });

  it("el tope cuenta lo que el MOM dice, en su modo, desde el inicio del día de Lima", () => {
    const cuenta =
      /select count\(\*\) into v_count from order_invoices where issuer_id = p_issuer and mode = v_iss\.mode and status in \(([^)]*)\) and created_at >= \(date_trunc\('day', now\(\) at time zone 'America\/Lima'\) at time zone 'America\/Lima'\)/.exec(
        funcion("invoice_claim"),
      );
    expect(cuenta).not.toBeNull();
    // Lo emitido, lo que se está emitiendo y lo en duda; en simulación, lo
    // simulado. Un `error` no es boleta y una `externa` no la emitió Kapta.
    expect(sqlList(cuenta![1])).toEqual(["simulada", "emitiendo", "emitida", "en_duda"]);
    expect(flat(sub(4))).toContain(
      "Cuenta lo emitido, lo que se está emitiendo y lo que está en duda; en simulación, lo simulado.",
    );
  });

  it("por pasada, a lo más 15 comprobantes por RUC", () => {
    expect(INVOICE_MAX_PER_RUN).toBe(15);
    expect(flat(sub(4))).toContain(`**Por pasada,** a lo más ${INVOICE_MAX_PER_RUN} comprobantes por RUC.`);
  });

  it("boleta `03`, IGV 18 incluido y «CLIENTES VARIOS» con DNI 00000000", () => {
    const s5 = flat(sub(5));
    expect(BOLETA_TYPE).toBe("03");
    expect(s5).toContain(`**Boleta** (\`invoice_type = '${BOLETA_TYPE}'\`) por defecto. La factura (\`'01'\`)`);
    expect(SQL_0257_FLAT).toContain(`invoice_type text not null default '${BOLETA_TYPE}' check (invoice_type in ('01', '${BOLETA_TYPE}'))`);

    expect(IGV_PERCENT).toBe(18);
    expect(s5).toContain(`\`tax_percent\` ${IGV_PERCENT}`);

    expect(s5).toContain(
      `Hasta S/ ${BOLETA_MAX_CENTS / 100} la boleta va a «${WALKIN_CUSTOMER.name}» con DNI \`${WALKIN_CUSTOMER.documentNumber}\`, sin correo ni celular`,
    );
    expect(s5).toContain("(`email_send = false`)");
    expect(flat(sub(8))).toContain(`«${WALKIN_CUSTOMER.name}» / \`${WALKIN_CUSTOMER.documentNumber}\``);
    // Tipo 1 = DNI en el catálogo 06 de SUNAT: lo que el MOM llama «DNI».
    expect(WALKIN_CUSTOMER).toEqual({ name: "CLIENTES VARIOS", documentType: 1, documentNumber: "00000000" });

    const p = payload(5_990)!;
    expect(p.invoice_type).toBe(BOLETA_TYPE);
    expect(p.items.every((i) => i.tax_percent === IGV_PERCENT)).toBe(true);
    expect([p.customer_name, p.customer_document_type, p.customer_document_number, p.email_send]).toEqual([
      WALKIN_CUSTOMER.name,
      WALKIN_CUSTOMER.documentType,
      WALKIN_CUSTOMER.documentNumber,
      false,
    ]);
  });

  it("la nota: «Pedido #KP… · Kapta ‹ref›», con los primeros 8 caracteres del id", () => {
    expect(flat(sub(5))).toContain(
      "Cada boleta lleva «Pedido #KP… · Kapta ‹ref›», donde ‹ref› son los primeros 8 caracteres del id del comprobante en Kapta.",
    );
    expect(invoiceNote("#KP136181", "6f1c2a3b-0000-4000-8000-000000000000")).toBe("Pedido #KP136181 · Kapta 6f1c2a3b");
    expect(payload(5_990)!.notes).toBe("Pedido #KP136181 · Kapta 6f1c2a3b");
  });

  it("la semilla: GRUPO GF S.A.C., RUC 20556792829, subdominio `grupogf`, con el Yape ···309 y Flow", () => {
    const s2 = flat(sub(2));
    expect(s2).toContain("**GRUPO GF S.A.C., RUC 20556792829**");
    expect(s2).toContain("(subdominio `grupogf`, apagado y sin token)");
    expect(s2).toContain("«Grupo GF S.A.C.» ···309 y «Aurela Kenku» (la pasarela Flow, sin celular, 0198)");

    expect(isValidRuc("20556792829")).toBe(true);
    const rucDeLaBase = /ruc text not null check \(ruc ~ '([^']+)'\)/.exec(SQL_0257_FLAT);
    expect(rucDeLaBase).not.toBeNull();
    expect(new RegExp(rucDeLaBase![1]!).test("20556792829")).toBe(true);

    expect(SQL_0257_FLAT).toContain("values (v_org.org_id, '20556792829', 'GRUPO GF S.A.C.', 'grupogf')");
    expect(SQL_0257_FLAT).toContain("(a.phone_last_digits = '309' and lower(a.label) = lower('Grupo GF S.A.C.'))");
    expect(SQL_0257_FLAT).toContain("(a.phone_last_digits is null and lower(a.label) = lower('Aurela Kenku'))");
    // Solo la primera vez: lo que el owner reasignó no se pisa.
    expect(SQL_0257_FLAT).toContain("and a.invoice_issuer_id is null");
  });

  it("el subdominio arma la dirección que dice el MOM, y el RUC sale del nombre de los archivos", () => {
    expect(normalizeSubdomain("grupogf")).toBe("grupogf");
    expect(simplefactBaseUrl("grupogf")).toBe("https://grupogf.simplefact.pe/api/v1");
    expect(flat(sub(2))).toContain("(`grupogf` → `https://grupogf.simplefact.pe/api/v1`)");
    expect(flat(sub(2))).toContain("El token solo viaja a un subdominio de `simplefact.pe`.");

    expect(flat(sub(4))).toContain("del nombre de sus archivos (`20556792829-03-B001-…`)");
    expect(rucFromSimplefactText("invoices/20556792829-03-B001-97.xml")).toBe("20556792829");
  });

  it("el barrido `/api/cron/invoices` corre cada 10 minutos", () => {
    expect(S35).toContain("el barrido (`/api/cron/invoices`)");
    expect(flat(S35)).toContain("`app/api/cron/invoices/route.ts`: el barrido, cada 10 minutos.");
    const crons = (JSON.parse(read("vercel.json")) as { crons: { path: string; schedule: string }[] }).crons;
    const cron = crons.find((c) => c.path === "/api/cron/invoices");
    expect(cron, "/api/cron/invoices en vercel.json").toBeDefined();
    const [minute, ...rest] = cron!.schedule.split(" ");
    expect(rest).toEqual(["*", "*", "*", "*"]);
    const minutes = minute!.split(",").map(Number);
    expect(minutes).toHaveLength(6);
    for (let i = 1; i < minutes.length; i++) expect(minutes[i]! - minutes[i - 1]!).toBe(10);
  });
});

describe("MOM §35.4, §35.6 y §35.8: modos, estados y candados", () => {
  it("los modos de la base son INVOICE_MODES, y §35.8 los nombra con sus etiquetas", () => {
    const checks = [...SQL_0257_FLAT.matchAll(/check \(mode in \(([^)]*)\)\)/g)].map((m) => sqlList(m[1]));
    // La 0260 no tiene tablas: los modos de la base son los de la 0257.
    expect(SQL_0260_FLAT).not.toMatch(/check \(mode in/);
    // invoice_issuers, order_invoices e invoice_order_checks, en ese orden.
    expect(checks).toEqual([[...INVOICE_MODES], WRITE_MODES, WRITE_MODES]);
    expect(flat(sub(8))).toContain(
      `Cada RUC tiene tres modos: **${INVOICE_MODE_LABEL.apagado}** (no hace nada), **${INVOICE_MODE_LABEL.simulacion}** (revisa todo, arma la boleta y la guarda sin enviarla) y **${INVOICE_MODE_LABEL.real}**.`,
    );
  });

  it("los estados de la base son INVOICE_STATUSES, y el MOM los nombra todos", () => {
    const check = /check \(status in \(([^)]*)\)\)/.exec(SQL_0257_FLAT);
    expect(sqlList(check?.[1])).toEqual([...INVOICE_STATUSES]);
    for (const status of INVOICE_STATUSES) expect(S35, status).toContain(`\`${status}\``);
    // La simulación es la única fila `simulada`, y viceversa.
    expect(flat(sub(6))).toContain("con modo `simulacion` y estado `simulada`");
    expect(SQL_0257_FLAT).toContain("constraint order_invoices_mode_status check ((mode = 'simulacion') = (status = 'simulada'))");
  });

  it("el comprobante real vivo: el índice único, el turno y el MOM cuentan los mismos estados", () => {
    const indice =
      /create unique index if not exists order_invoices_one_real on order_invoices \(order_id\) where mode = 'real' and status in \(([^)]*)\);/.exec(
        SQL_0257_FLAT,
      );
    expect(sqlList(indice?.[1])).toEqual([...LIVE_REAL_STATUSES]);
    const turno = /mode = 'real' and status in \(([^)]*)\) \) then return jsonb_build_object\('reason', 'ya_tiene'\)/.exec(
      funcion("invoice_claim"),
    );
    expect(sqlList(turno?.[1])).toEqual([...LIVE_REAL_STATUSES]);
    expect(flat(sub(4))).toContain(
      `a lo más un comprobante real vivo: ${lista(LIVE_REAL_STATUSES.map((s) => `\`${s}\``))}. Lo garantiza Postgres, no el código.`,
    );
  });

  it("los estados solo avanzan como dice §35.6", () => {
    const candado = funcion("order_invoices_guard");
    const desdeEmitiendo = /old\.status = 'emitiendo' and new\.status in \(([^)]*)\)/.exec(candado);
    const desdeEnDuda = /old\.status = 'en_duda' and new\.status in \(([^)]*)\)/.exec(candado);
    expect(sqlList(desdeEmitiendo?.[1])).toEqual(["emitida", "error", "en_duda"]);
    expect(sqlList(desdeEnDuda?.[1])).toEqual(["emitida", "error"]);
    const s6 = flat(sub(6));
    expect(s6).toContain(
      `\`emitiendo\` → ${lista(sqlList(desdeEmitiendo?.[1]).map((s) => `\`${s}\``))}; y \`en_duda\` → \`emitida\` (se concilió, o una persona la encontró en SimpleFact y registró su serie) o \`error\` (una persona confirmó que no existe).`,
    );
    expect(candado).toContain("raise exception 'Un comprobante no se borra'");
    // Las dos salidas de una persona desde `en_duda` son las del panel, y cada
    // una escribe el estado que dice el MOM, solo si sigue en duda.
    const ACTIONS = read("app/dashboard/pedidos/invoice-actions.ts");
    const cuerpo = (nombre: string) => {
      const desde = ACTIONS.indexOf(`export async function ${nombre}(`);
      expect(desde, nombre).toBeGreaterThan(0);
      return ACTIONS.slice(desde, ACTIONS.indexOf("\n}\n", desde));
    };
    const confirmar = cuerpo("confirmDoubtfulInvoice");
    expect(confirmar).toMatch(/\.update\(\{\s*status: "emitida",\s*serie,\s*correlative,\s*note: cleanNote,\s*resolved_by: ctx\.userId,\s*resolved_at: [^,]+,\s*\}\)\s*\.eq\("id", invoice\.id\)\s*\.eq\("status", "en_duda"\)/);
    const liberar = cuerpo("releaseDoubtfulInvoice");
    expect(liberar).toMatch(/\.update\(\{\s*status: "error",/);
    expect(liberar).toContain('.eq("status", "en_duda")');
  });

  it("pasar a Real exige token, «Emitir desde» y la prueba del mismo RUC", () => {
    expect(flat(sub(8))).toContain(
      "Para pasar a Real, la base exige token, «Emitir desde» y una prueba de conexión que leyó el mismo RUC declarado.",
    );
    expect(SQL_0257_FLAT).toContain(
      "constraint invoice_issuers_real_ready check ( mode <> 'real' or (token_enc is not null and emit_from is not null and checked_ruc is not null and checked_ruc = ruc) )",
    );
  });

  it("lo que contestó SimpleFact: qué códigos son `error`, cuáles apagan el RUC y cuál corta la pasada", () => {
    const codes = Array.from({ length: 500 }, (_, i) => i + 100);
    const outcome = (http: number) => classifySaleResponse(http, {}, "20556792829");
    const errores = codes.filter((c) => outcome(c).status === "error");
    const stop = (kind: "issuer" | "run") =>
      codes.filter((c) => {
        const o = outcome(c);
        return o.status === "error" && o.stop === kind;
      });

    // Un `error` es un «no» cierto: solo 4xx, y solo los que el MOM enumera.
    expect(errores.every((c) => c >= 400 && c < 500)).toBe(true);
    const s4 = flat(sub(4));
    expect(s4).toContain(`\`error\`: contestó que no, con un 4xx que no deja duda (${lista(errores.map(String))}) y su mensaje: no hay boleta.`);
    // Todo lo demás —sin respuesta, un 5xx, otro código, un 2xx sin la venta—
    // es duda: la boleta puede existir.
    expect(s4).toContain("`en_duda`: no contestó, contestó un 5xx u otro código, o algo que no se entiende.");
    expect(classifySaleResponse(null, null, "20556792829").status).toBe("en_duda");
    for (const c of codes.filter((x) => x >= 500)) expect(outcome(c).status, String(c)).toBe("en_duda");
    expect(outcome(200).status).toBe("en_duda");

    expect(stop("issuer")).toEqual([401, 403, 404, 405]);
    expect(s4).toContain(
      "**Un token rechazado** (401 o 403), o una cuenta que no responde (404 o 405), apaga el RUC con el motivo a la vista",
    );
    expect(stop("run")).toEqual([429]);
    expect(s4).toContain("Tras un 429 (SimpleFact pide esperar) no se emite nada más en esa pasada.");
  });

  it("§35.6: las tablas que escribe, solo para el servidor", () => {
    const filas = sub(6)
      .split("\n")
      .map((l) => /^\| `([^`]+)` \|/.exec(l)?.[1])
      .filter((t): t is string => t !== undefined);
    expect(filas).toEqual(["invoice_issuers", "store_collection_accounts.invoice_issuer_id", "order_invoices", "invoice_order_checks"]);
    // «Sin policy de lectura: solo la lee el servidor.»
    expect(flat(sub(6))).toContain("Sin policy de lectura: solo la lee el servidor");
    expect(SQL_0257).not.toMatch(/create policy/i);
    expect(SQL_0260).not.toMatch(/create policy/i);
    for (const tabla of ["invoice_issuers", "order_invoices", "invoice_order_checks"]) {
      expect(SQL_0257).toContain(`alter table ${tabla} enable row level security;`);
    }
    expect(SQL_0257).toContain("revoke all on invoice_issuers, order_invoices, invoice_order_checks from anon, authenticated;");
    // «Un trigger exige que el RUC sea de la misma organización que la tienda.»
    expect(flat(sub(6))).toContain("Un trigger exige que el RUC sea de la misma organización que la tienda");
    expect(funcion("store_collection_accounts_issuer_org")).toContain(
      "raise exception 'El RUC no es de la organización de la tienda'",
    );
  });
});

describe("MOM §35.7: el permiso", () => {
  it("`invoices.manage` («Boletas y facturas») existe con ese nombre", () => {
    expect(PERMISSIONS).toContain("invoices.manage");
    expect(PERMISSION_LABEL["invoices.manage"]).toBe("Boletas y facturas");
    expect(flat(sub(7))).toContain(`**\`invoices.manage\` («${PERMISSION_LABEL["invoices.manage"]}»)**`);
    expect(flat(sub(2))).toContain(`Ajustes → «${PERMISSION_LABEL["invoices.manage"]}»`);
    // «En Ajustes de la tienda se pide además `stores.manage`.»
    expect(PERMISSIONS).toContain("stores.manage");
  });

  it("solo el owner lo da, y ningún rol lo trae salvo el del owner", () => {
    expect(flat(sub(7))).toContain("**solo el owner lo da** (§16, `ownerOnly`), y ningún rol lo trae salvo el del owner.");
    const entry = GRANTED_ONE_BY_ONE.find((e) => e.permission === "invoices.manage");
    expect(entry, "invoices.manage en GRANTED_ONE_BY_ONE").toBeDefined();
    expect(entry!.ownerOnly).toBe(true);

    expect(permissionsFor(["owner"]).has("invoices.manage")).toBe(true);
    for (const access of ["admin", "vendedora", "viewer", "motorizado"]) {
      expect(permissionsFor([access]).has("invoices.manage"), access).toBe(false);
    }
    const todosLosRoles = FUNCTIONAL_ROLES.map((r) => r.role);
    expect(permissionsFor(["vendedora"], [], todosLosRoles).has("invoices.manage")).toBe(false);
    expect(permissionsFor(["admin"], [], todosLosRoles).has("invoices.manage")).toBe(false);
  });
});

describe("MOM §35.3: cuándo quedó pagado y qué cobró Flow", () => {
  const s3 = flat(sub(3));

  // Lo mínimo para que las reglas lleguen a la condición 8: un pago de un link
  // de Flow (fila 1 de 35.2) a la pasarela de Grupo GF, que cubre el total.
  const DESDE = "2026-10-14T05:00:00.000Z";
  const ANTES = "2026-10-14T04:00:00.000Z";
  const despues = (horas: number) => new Date(Date.parse(DESDE) + horas * 3_600_000).toISOString();
  const GF: InvoiceIssuer = {
    id: "iss-gf",
    orgId: "org-grupo-gf",
    ruc: "20556792829",
    legalName: "GRUPO GF S.A.C.",
    mode: "real",
    emitFrom: DESDE,
    dailyLimit: INVOICE_DAILY_LIMIT_DEFAULT,
    hasToken: true,
    checkedRuc: "20556792829",
  };
  const PASARELA: InvoiceAccount = { id: "acc-flow", label: "Aurela Kenku", aliases: [], phoneLastDigits: null, issuerId: GF.id };
  const pago = (over: Partial<InvoicePayment> = {}): InvoicePayment => ({
    id: "pay-1",
    kind: "total",
    amount: 150,
    validationStatus: "validado",
    registeredAt: despues(1),
    validatedAt: despues(1),
    vision: null,
    flowLinked: true,
    statementDestination: null,
    ...over,
  });
  const hechos = (payments: InvoicePayment[], over: Partial<InvoiceOrderFacts> = {}): InvoiceOrderFacts => ({
    orderId: "ord-1",
    storeId: "store-1",
    orderName: "#KP136181",
    total: 150,
    currency: "PEN",
    cancelledAt: null,
    totalRefunded: 0,
    financialStatus: "pending",
    paymentGateway: "manual",
    orderDate: ANTES,
    customerName: null,
    payments,
    accounts: [PASARELA],
    issuers: [GF],
    existing: { realLive: false, simulated: false, errorBlocked: false },
    ...over,
  });
  /** Cuándo quedó pagado según las reglas, o el motivo por el que no sale. */
  const pagadoEn = (f: InvoiceOrderFacts) => {
    const r = invoiceEligibility(f);
    return r.ok ? r.paidAt : r.reason;
  };

  it("fila 8: cuenta cuándo se REGISTRÓ el último pago (`registered_at`), no cuándo se validó", () => {
    expect(s3).toContain(
      "cuenta cuándo se registró en Kapta el último de sus pagos validados (`registered_at`, que no cambia si el pago se observa y se vuelve a validar; la fecha de validación, `validated_at`, sí), o la fecha del pedido si es prepago web. Un pago validado sin fecha de registro, o un RUC sin fecha de inicio, no emite",
    );
    // Pagado antes de «Emitir desde», observado y vuelto a validar después: es
    // una boleta hacia atrás, y no sale.
    expect(pagadoEn(hechos([pago({ registeredAt: ANTES, validatedAt: despues(3) })]))).toBe("antes_de_inicio");
    // Adelanto y diferencia: cuenta el último REGISTRADO (la diferencia), aunque
    // el adelanto se haya vuelto a validar más tarde.
    expect(
      pagadoEn(
        hechos([
          pago({ id: "ade", kind: "adelanto", amount: 50, registeredAt: despues(1), validatedAt: despues(5) }),
          pago({ id: "dif", kind: "diferencia", amount: 100, registeredAt: despues(2), validatedAt: despues(3) }),
        ]),
      ),
    ).toBe(despues(2));
    // Sin fecha de registro no se sabe cuándo quedó pagado; sin la de validación, sí.
    expect(pagadoEn(hechos([pago({ registeredAt: null })]))).toBe("antes_de_inicio");
    expect(pagadoEn(hechos([pago({ validatedAt: null })]))).toBe(despues(1));
    // Un RUC sin «Emitir desde» no emite.
    expect(pagadoEn(hechos([pago()], { issuers: [{ ...GF, emitFrom: null }] }))).toBe("antes_de_inicio");
    // El prepago web no deja pagos: cuenta la fecha del pedido.
    expect(
      pagadoEn(hechos([], { financialStatus: "paid", paymentGateway: "checkout", orderDate: despues(4) })),
    ).toBe(despues(4));
  });

  it("§35.4 «Ya tiene comprobante»: las reglas saben el RUC del pago cuando el pedido pasa la condición 5", () => {
    expect(flat(sub(4))).toContain(
      "Lo saben cuando el pedido pasa la condición 5 de 35.3. Si se frenó antes —pagos en revisión, un pago sin cuenta, una cuenta sin RUC, RUC mezclados—, no lo saben, y vale el que eligió la persona",
    );
    /** El RUC que las reglas le dan al pedido, salga o no (lo que mira «Ya tiene comprobante»). */
    const rucDelPago = (f: InvoiceOrderFacts) => {
      const r = invoiceEligibility(f);
      // Sin `issuerId` las reglas no lo saben: como lo lee `expectedIssuer`.
      return { reason: r.ok ? null : r.reason, issuerId: r.ok ? r.issuer.id : (r.issuerId ?? null) };
    };
    // Desde la condición 6 lo saben, aunque el pedido no salga (más de S/ 700,
    // antes de «Emitir desde»): «Ya tiene comprobante» lo trae elegido y no
    // acepta otro.
    expect(rucDelPago(hechos([pago({ amount: 850 })], { total: 850 }))).toEqual({
      reason: "monto_mayor_700",
      issuerId: GF.id,
    });
    expect(rucDelPago(hechos([pago({ registeredAt: ANTES })]))).toEqual({ reason: "antes_de_inicio", issuerId: GF.id });
    // Antes, no: no se adivina.
    expect(rucDelPago(hechos([pago({ validationStatus: "en_revision" })]))).toEqual({
      reason: "pagos_en_revision",
      issuerId: null,
    });
    expect(rucDelPago(hechos([pago({ flowLinked: false })]))).toEqual({ reason: "pago_sin_cuenta", issuerId: null });
    expect(rucDelPago(hechos([pago()], { accounts: [{ ...PASARELA, issuerId: null }] }))).toEqual({
      reason: "cuenta_sin_ruc",
      issuerId: null,
    });
  });

  describe("el prepago web: la boleta de Flow cubre solo lo que cobró Flow", () => {
    const FLOW = CHECKOUT_GATEWAYS[0]!;
    const money = (amount: string) => ({ shopMoney: { amount, currencyCode: "PEN" } });
    const tx = (gateway: string | null, amount: string) => ({
      kind: "SALE",
      status: "SUCCESS",
      gateway,
      formattedGateway: null,
      test: false,
      amountSet: money(amount),
    });
    /** Un prepago web de S/ 99.90 (una faja y el envío) que Shopify da por pagado. */
    const pedido = (gatewayNames: string[], transactions: unknown[]) => ({
      id: "gid://shopify/Order/6123456789012",
      name: "#KP136181",
      test: false,
      edited: false,
      cancelledAt: null,
      displayFinancialStatus: "PAID",
      paymentGatewayNames: gatewayNames,
      taxesIncluded: true,
      currencyCode: "PEN",
      totalPriceSet: money("99.9"),
      currentTotalPriceSet: money("99.9"),
      totalRefundedSet: money("0.0"),
      netPaymentSet: money("99.9"),
      totalOutstandingSet: money("0.0"),
      totalTaxSet: money("15.24"),
      totalTipReceivedSet: money("0.0"),
      transactions,
      lineItems: {
        pageInfo: { hasNextPage: false },
        nodes: [
          {
            id: "gid://shopify/LineItem/16401234567",
            title: "Faja Reductora Colombiana",
            variantTitle: "M / Negro",
            sku: "FAJA-M-NEG",
            quantity: 1,
            currentQuantity: 1,
            isGiftCard: false,
            variant: { id: "gid://shopify/ProductVariant/47012345678" },
            originalUnitPriceSet: money("89.9"),
            discountAllocations: [],
          },
        ],
      },
      shippingLines: { nodes: [{ title: "Envío Lima", isRemoved: false, discountedPriceSet: money("10.0") }] },
    });
    const confirma = (gatewayNames: string[], transactions: unknown[]) => {
      const read = mapOrderForInvoice(pedido(gatewayNames, transactions));
      if (!read.ok) throw new Error(`se esperaba una lectura, vino ${read.reason}: ${read.detail ?? ""}`);
      return webPrepaidConfirmed(read);
    };

    it("el MOM lo dice como lo hace el código", () => {
      expect(s3).toContain(
        "que **todas** las pasarelas del pedido sean el checkout de Flow (el nombre de `CHECKOUT_GATEWAYS`, `lib/payment-gateway.ts`, sin contar mayúsculas, tildes ni espacios de más); y que lo cobrado —ventas y capturas aprobadas, no de prueba— haya entrado por Flow y sume el total, sin un céntimo cobrado por otra pasarela (`pago_web_no_confirmado`).",
      );
      expect(s3).toContain(
        "un pedido marcado pagado a mano, o pagado en todo o en parte contraentrega o con tarjeta de regalo, no lleva boleta automática.",
      );
      expect(s3).toContain(
        "Una transacción cuenta como de Flow si su pasarela es ese checkout o dice «flow» como palabra entera; cualquier otra, o ninguna, es de otra pasarela.",
      );
    });

    it("todo por Flow: sí, aunque el nombre venga con otras mayúsculas o sin tilde", () => {
      expect(confirma([FLOW], [tx(FLOW, "99.9")])).toBe(true);
      expect(confirma([FLOW], [tx("flow_cl", "50.0"), tx("Flow", "49.9")])).toBe(true);
      expect(confirma(["  CHECKOUT FLOW | tarjeta, transf., cuotas debito "], [tx("Flow", "99.9")])).toBe(true);
    });

    it("marcado pagado a mano, contraentrega o tarjeta de regalo, en todo o en parte: no", () => {
      expect(confirma(["manual"], [tx("manual", "99.9")])).toBe(false);
      expect(confirma([FLOW, "manual"], [tx(FLOW, "50.0"), tx("manual", "49.9")])).toBe(false);
      expect(confirma([FLOW, "Cash on Delivery (COD)"], [tx(FLOW, "79.9"), tx("Cash on Delivery (COD)", "20.0")])).toBe(
        false,
      );
      // Aunque las pasarelas del pedido digan solo Flow, el dinero de otra pasarela pesa.
      expect(confirma([FLOW], [tx(FLOW, "79.9"), tx("gift_card", "20.0")])).toBe(false);
    });

    it("una transacción sin pasarela, o que no dice «flow» como palabra, es de otra pasarela", () => {
      expect(confirma([FLOW], [tx(null, "99.9")])).toBe(false);
      expect(confirma([FLOW], [tx("overflow", "99.9")])).toBe(false);
    });
  });
});

describe("MOM §35.4: qué mira el barrido (`invoice_candidates`)", () => {
  const s4 = flat(sub(4));
  const SERVER = read("lib/invoicing/server.ts");
  /** El cuerpo de la función, de `create` a su `$$;`: la crea la 0260. */
  const fn = funcion("invoice_candidates");
  const horas = INVOICE_SHOPIFY_RECHECK_MS / 3_600_000;

  it("la lista la da la base, solo al servidor, y el barrido la pide por modo", () => {
    expect(fn).not.toBe("");
    // La crea la 0260: la 0257 que corrió en producción no la tenía.
    expect(SQL_0260_FLAT).toContain(fn);
    expect(SQL_0257).not.toContain("invoice_candidates");
    expect(s4).toContain(
      "Cada 10 minutos, por organización y por cada modo con un RUC encendido, los pedidos que le da la base (`invoice_candidates`, 0260)",
    );
    expect(SERVER).toContain('admin.rpc("invoice_candidates", {');
    const firma = "invoice_candidates(uuid, text, timestamptz, integer, text[], uuid)";
    expect(SQL_0260_FLAT).toContain(`revoke all on function ${firma} from public, anon, authenticated;`);
    expect(SQL_0260_FLAT).toContain(`grant execute on function ${firma} to service_role;`);
    expect(s4).toContain("La lista solo dice qué mirar: deciden `invoiceEligibility` y, al final, `invoice_claim`.");
  });

  it("tienda activa, pagados según el Master, de los últimos 60 días", () => {
    expect(s4).toContain("de una tienda activa; pagados según el Master (`order_master`), por comprobantes o por la pasarela web;");
    expect(fn).toContain("from order_master m join stores s on s.id = m.store_id");
    expect(fn).toContain("and s.status = 'active'");
    expect(fn).toContain(
      "(m.payment_state = 'pago_completo' or (m.payment_gateway = 'checkout' and m.financial_status = 'paid'))",
    );
    expect(s4).toContain("de los últimos 60 días (Shopify no deja leer pedidos más viejos sin `read_all_orders`);");
    expect(fn).toContain("and m.order_created_at >= now() - interval '60 days'");
  });

  it("pagado desde «Emitir desde»: un pago REGISTRADO desde entonces, o el prepago web creado desde entonces", () => {
    expect(s4).toContain(
      "con un pago validado registrado desde el «Emitir desde» más antiguo de los RUC de ese modo o, si es prepago web, creados desde entonces;",
    );
    expect(fn).toContain("p.validation_status = 'validado' and p.registered_at >= p_since");
    // La misma fecha que la condición 8 de §35.3: nunca la de validación.
    expect(fn).not.toContain("validated_at");
    expect(fn).toContain("(m.payment_gateway = 'checkout' and m.financial_status = 'paid' and m.order_created_at >= p_since)");
    expect(SERVER).toContain("p_since: new Date(Math.min(...starts)).toISOString(),");
    expect(s4).toContain("Un modo cuyos RUC no tienen «Emitir desde» no tiene candidatos.");
  });

  it("sin comprobante real vivo ni su simulación, y sin un bloqueo de Shopify de las últimas 6 horas en ese modo", () => {
    expect(s4).toContain(
      `sin comprobante real vivo ni, en simulación, su simulación; en real, sin un \`error\` real que espera a que una persona pida reintentar; y sin un bloqueo de Shopify en ese modo de las últimas ${horas} horas.`,
    );
    const vivos = /i\.mode = 'real' and i\.status in \(([^)]*)\)/.exec(fn);
    expect(sqlList(vivos?.[1])).toEqual([...LIVE_REAL_STATUSES]);
    expect(fn).toContain(
      "(p_mode = 'real' or not exists ( select 1 from order_invoices i where i.order_id = m.order_id and i.mode = 'simulacion' ))",
    );
    expect(horas).toBe(6);
    expect(fn).toContain("c.mode = p_mode");
    expect(fn).toContain(`c.checked_at > now() - interval '${horas} hours'`);
    // Los motivos de Shopify los manda el barrido: la lista vive en un lugar.
    expect(SERVER).toContain("p_blocked: shopifyBlockedReasons(),");
    expect(shopifyBlockedReasons()).toEqual([...SHOPIFY_LEVEL_REASONS].sort());
  });

  it("en real, un `error` sin reintento no ocupa lugar: es lo mismo que el turno rechaza (`error_previo`)", () => {
    expect(s4).toContain(
      "Un `error` sin reintento tampoco: el turno lo rechazaría (`error_previo`), y vuelve a entrar cuando una persona pulsa «Volver a intentar». En simulación sí entra, porque la simulación no mira los errores reales.",
    );
    const sinReintento = "i.mode = 'real' and i.status = 'error' and i.retry_requested_at is null";
    expect(fn).toContain(
      `(p_mode <> 'real' or not exists ( select 1 from order_invoices i where i.order_id = m.order_id and ${sinReintento} ))`,
    );
    // La misma condición con que el turno contesta `error_previo`, y solo en
    // real: en simulación el turno no la mira.
    const turno = funcion("invoice_claim");
    expect(turno).toContain(
      `if exists ( select 1 from order_invoices where order_id = p_order and ${sinReintento.replace(/i\./g, "")} ) then return jsonb_build_object('reason', 'error_previo');`,
    );
    const simulacion = turno.indexOf("if v_iss.mode = 'simulacion' then");
    const otroModo = turno.indexOf(" else ", simulacion);
    expect(turno.indexOf("'error_previo'")).toBeGreaterThan(otroModo);
    expect(otroModo).toBeGreaterThan(simulacion);
  });

  it("una lista llena se anota en el log del cron (`lleno`), sin ponerlo en rojo", () => {
    expect(s4).toContain(
      `**Una lista llena se ve.** Si \`invoice_candidates\` devuelve los ${INVOICE_SWEEP_MAX_CANDIDATES}, la línea del log del cron lo anota por modo (\`"lleno":{"real":true}\`): lo más viejo pendiente de ese modo no se miró en esa pasada. No es un error y no pone el cron en rojo`,
    );
    expect(SERVER).toContain("if (rows.length >= INVOICE_SWEEP_MAX_CANDIDATES) orgReport.lleno[mode] = true;");
    // No toca `errors`: es lo único que pone el cron en rojo.
    const desdeCarga = SERVER.indexOf("async function loadCandidates(");
    const carga = SERVER.slice(desdeCarga, SERVER.indexOf("\n}\n", desdeCarga));
    expect(carga).not.toMatch(/\bfail\(/);
    const ruta = read("app/api/cron/invoices/route.ts");
    expect(ruta).toContain("console.log(`[invoices] ${JSON.stringify(report)}`);");
    expect(ruta).toContain("const failed = report.errors.length > 0;");
  });

  it("a lo más 500 por organización y modo, del más nuevo al más viejo, real primero", () => {
    expect(INVOICE_SWEEP_MAX_CANDIDATES).toBe(500);
    expect(s4).toContain(
      `A lo más ${INVOICE_SWEEP_MAX_CANDIDATES} por organización y modo, del pedido más nuevo al más viejo, y primero el modo real.`,
    );
    expect(SERVER).toContain("p_limit: INVOICE_SWEEP_MAX_CANDIDATES,");
    expect(fn).toContain("order by m.order_created_at desc");
    expect(SERVER).toContain('for (const mode of ["real", "simulacion"] as const) {');
  });

  it("Shopify no se relee antes de 6 horas, ni sin conexión; un corte se reintenta en la pasada siguiente", () => {
    expect(s4).toContain(
      `Un pedido bloqueado por lo que dijo Shopify —incluida una tienda sin conexión con Shopify (\`sin_token_shopify\`)— no se vuelve a leer en Shopify antes de ${horas} horas, bajo ninguno de los dos modos.`,
    );
    expect(SHOPIFY_LEVEL_REASONS.has("sin_token_shopify")).toBe(true);
    expect(s4).toContain("Un corte de Shopify (`lectura_fallida`) se reintenta en la pasada siguiente.");
    expect(SHOPIFY_LEVEL_REASONS.has("lectura_fallida")).toBe(false);
  });

  it("presupuesto: no empieza un pedido nuevo pasados 20 segundos", () => {
    const budget = /const ORDER_BUDGET_MS = ([\d_]+);/.exec(SERVER);
    const segundos = Number(budget?.[1]?.replace(/_/g, "")) / 1000;
    expect(segundos).toBe(20);
    expect(s4).toContain(`No empieza un pedido nuevo pasados ${segundos} segundos de la pasada`);
  });
});

describe("MOM §35.4: lo que queda a medias y el RUC que se apaga solo", () => {
  const s4 = flat(sub(4));
  const SERVER = read("lib/invoicing/server.ts");

  it("un `emitiendo` que ninguna conciliación va a mirar pasa a `en_duda`, con su aviso", () => {
    const minutos = INVOICE_STALE_EMITTING_MS / 60_000;
    expect(minutos).toBe(10);
    expect(s4).toContain(
      `Un \`emitiendo\` sin respuesta (la función se cortó a mitad del envío, o no se pudo guardar lo que contestó) se concilia igual pasados ${minutos} minutos; si no aparece, pasa a \`en_duda\`.`,
    );
    expect(s4).toContain(
      "Uno que ninguna conciliación va a mirar —su RUC ya no está en Real o no tiene token, o es de antes de ayer— pasa a `en_duda` al empezar la pasada siguiente, sin llamar a SimpleFact",
    );
    // El aviso del MOM es el que guarda la base, con la nota de §35.5.
    const id = "6f1c2a3b-0000-4000-8000-000000000000";
    const aviso = invoiceUnreconciledError(id);
    expect(aviso).toBe("Sin respuesta de SimpleFact: búscala por su nota «Kapta 6f1c2a3b» antes de liberarla");
    expect(s4).toContain(`con el aviso «${aviso.replace(invoiceNoteRef(id), "Kapta ‹ref›")}», y lo ve una persona.`);
    expect(INVOICE_UNRECONCILED_BATCH).toBe(100);
    expect(s4).toContain(
      `Pasa aunque ningún RUC esté encendido: a lo más ${INVOICE_UNRECONCILED_BATCH} por pasada, del más viejo.`,
    );
  });

  it("el barrido que apaga un RUC borra su prueba de conexión: Real pide probar de nuevo", () => {
    expect(s4).toContain(
      "Cuando el barrido apaga un RUC por su cuenta (otro RUC en la respuesta, un token rechazado, una cuenta que no responde), borra también su última prueba de conexión y deja el motivo. Para volver a Real hace falta pulsar de nuevo «Probar conexión» y que confirme el RUC (35.8)",
    );
    expect(SERVER).toMatch(/\.update\(\{ mode: "apagado", checked_ruc: null, checked_at: null, check_error: /);
    expect(SQL_0257_FLAT).toContain("checked_ruc is not null and checked_ruc = ruc");
  });

  it("«Ya tiene comprobante»: el RUC se elige, se dice antes y no puede ser otro que el del pago", () => {
    const PANEL = read("components/order-invoice-panel.tsx");
    const ACTIONS = read("app/dashboard/pedidos/invoice-actions.ts");
    expect(s4).toContain(
      "el RUC se elige a mano —viene elegido solo el de la cuenta que recibió el pago, si las reglas lo saben— y antes de registrar el panel dice qué queda: «Se registra como comprobante de ‹razón social› (RUC ‹ruc›), serie ‹serie›. No se puede corregir después.».",
    );
    expect(PANEL).toContain(
      "`Se registra como comprobante de ${issuer.legalName} (RUC ${issuer.ruc}), serie ${serie}. No se puede corregir después.`",
    );
    expect(PANEL).toContain("Elige el RUC");
    expect(s4).toContain("Si las reglas saben a qué RUC entró el pago (35.2), no se registra el comprobante de otro RUC.");
    expect(ACTIONS).toContain("if (expected && expected.id !== issuer.id) {");
    expect(ACTIONS).toContain("registra el comprobante de ese RUC.");
  });

  it("«Ya tiene comprobante»: si el pedido o sus pagos no se pudieron leer, no se registra nada", () => {
    const ACTIONS = read("app/dashboard/pedidos/invoice-actions.ts");
    const aviso = "No se pudo comprobar a qué RUC entró el pago; intenta de nuevo.";
    expect(s4).toContain(
      `Pero si el pedido o sus pagos no se pudieron leer, no se registra nada: «${aviso}». Que no se pudo comprobar no quiere decir que no se sepa, y la fila no se corrige después.`,
    );
    expect(ACTIONS).toContain(`const SIN_COMPROBAR_RUC = "${aviso}";`);
    // Falla cerrada: una lectura que lanza, o que no trae el pedido, no es
    // «no se sabe» (que deja elegir el RUC), y corta antes de escribir.
    const desde = ACTIONS.indexOf("async function expectedIssuer(");
    const esperado = ACTIONS.slice(desde, ACTIONS.indexOf("\n}\n", desde));
    // El fallo se anota en el log (sin datos de la clienta) y se rechaza igual.
    expect(esperado).toMatch(/catch \(cause\) \{[\s\S]*?console\.error\([\s\S]*?\);\s*return \{ ok: false \};\s*\}/);
    expect(esperado).toContain("if (!facts) return { ok: false };");
    const registrar = ACTIONS.slice(ACTIONS.indexOf("export async function registerExternalInvoice("));
    const rechazo = registrar.indexOf("if (!check.ok) return { error: SIN_COMPROBAR_RUC };");
    expect(rechazo).toBeGreaterThan(0);
    expect(rechazo).toBeLessThan(registrar.indexOf('.from("order_invoices").insert('));
    expect(flat(sub(7))).toContain("Si no pudo leer el pedido o sus pagos, no registra ninguno (35.4).");
  });
});

describe("MOM §35.6 y §35.7: lo que no se edita y lo que el panel dice", () => {
  it("§35.6: la única excepción es borrar la cuenta de una persona", () => {
    const quien = ["created_by", "retry_requested_by", "resolved_by"];
    expect(flat(sub(6))).toContain(
      `La única excepción es borrar la cuenta de una persona: la base deja en blanco quién la registró, pidió el reintento o la resolvió (${quien.map((c) => `\`${c}\``).join(", ")}) y nada más de la fila cambia`,
    );
    for (const c of quien) expect(SQL_0257_FLAT, c).toContain(`${c} uuid references auth.users(id) on delete set null`);
    const sin = `array[${quien.map((c) => `'${c}'`).join(", ")}]`;
    // Solo dentro de la cascada: la acción de la llave corre como trigger del
    // sistema, así que el candado la ve un nivel más hondo que un UPDATE directo.
    // La excepción la trae la 0260: la 0257 que corrió en producción no la tenía.
    const candado = funcion("order_invoices_guard");
    expect(SQL_0260_FLAT).toContain(candado);
    expect(SQL_0257).not.toContain("pg_trigger_depth");
    expect(candado).toContain(`if pg_trigger_depth() > 1 and (to_jsonb(new) - ${sin}) = (to_jsonb(old) - ${sin})`);
    expect(flat(sub(6))).toContain(
      "Pasa **solo dentro de esa cascada** (la llave hacia la cuenta, `on delete set null`): poner esas columnas en blanco a mano, sin borrar la cuenta, el candado lo rechaza como cualquier otro cambio, aunque lo intente el servidor.",
    );
    // Y fuera de la excepción, quién registró es parte de «lo enviado».
    expect(candado).toContain("or new.created_by is distinct from old.created_by then raise exception 'Lo enviado de un comprobante no cambia';");
    // La prueba SQL lo ejercita: un UPDATE directo que deja en blanco cada
    // columna falla (y la cascada de borrar la cuenta, en otro bloque, pasa).
    const smoke = read("scripts/sql/invoices_smoke.sql");
    for (const c of quien) {
      expect(smoke, c).toMatch(
        new RegExp(`pg_temp\\.debe_fallar\\(format\\(\\$q\\$update order_invoices set ${c} = null where id = %L\\$q\\$`),
      );
    }
  });

  it("§35.7: una boleta con otro RUC se ve como tal, en el panel y en Ajustes", () => {
    const s7 = flat(sub(7));
    expect(s7).toContain("(`ruc_mismatch`) se ve como «Emitida con otro RUC», en rojo");
    expect(SQL_0257_FLAT).toContain("ruc_mismatch boolean not null default false");
    const PANEL = read("components/order-invoice-panel.tsx");
    expect(PANEL).toContain('badge = { tone: "crit", label: "Emitida con otro RUC" };');
    expect(PANEL).toContain("Revísala en SimpleFact: puede necesitar anularse o una nota de crédito.");
    expect(s7).toContain("con el aviso de revisarla en SimpleFact: puede necesitar anularse o una nota de crédito");
    expect(read("components/invoice-settings-section.tsx")).toContain('<Badge tone="crit">Otro RUC</Badge>');
  });

  it("§35.7: si Shopify lo frena, el panel no dice «Lista para emitirse»", () => {
    const s7 = flat(sub(7));
    const PANEL = read("components/order-invoice-panel.tsx");
    expect(s7).toContain("el panel no dice «Lista para emitirse»");
    expect(PANEL).toContain("Lista para emitirse");
    expect(PANEL).toContain('label: data.review.retry ? "Espera a Shopify" : "Se emite a mano"');
    expect(s7).toContain("dice «Espera a Shopify»");
    expect(s7).toContain(
      "dice «Se emite a mano»: no se emite sola, se emite a mano en SimpleFact y se registra con «Ya tiene comprobante».",
    );
    expect(PANEL).toContain("No se emite sola: se emite a mano en SimpleFact y se registra con «Ya tiene comprobante».");
  });

  it("§35.7: «Espera a Shopify» dice cuándo, como lo hace el barrido", () => {
    const s7 = flat(sub(7));
    const PANEL = read("components/order-invoice-panel.tsx");
    const ACTIONS = read("app/dashboard/pedidos/invoice-actions.ts");
    const sinConexion = "Se vuelve a revisar en unas horas, cuando la tienda tenga conexión con Shopify.";
    expect(s7).toContain(
      `dice «Espera a Shopify» y cuándo, como lo hace el barrido (35.4): un corte de Shopify, en la próxima pasada; una tienda sin conexión, «${sinConexion}», porque ese pedido no se relee antes de ${INVOICE_SHOPIFY_RECHECK_MS / 3_600_000} horas.`,
    );
    // Los motivos de Shopify que se reintentan solos son exactamente los dos que
    // nombra el MOM: el resto de la lista del barrido se emite a mano.
    const manual = /const SHOPIFY_MANUAL_REASONS: ReadonlySet<InvoiceReason> = new Set<InvoiceReason>\(\[([^\]]*)\]\);/.exec(
      ACTIONS,
    );
    expect(manual).not.toBeNull();
    const aMano = new Set([...manual![1]!.matchAll(/"([a-z_0-9]+)"/g)].map((m) => m[1]!));
    const deShopify = [...SHOPIFY_LEVEL_REASONS, "lectura_fallida" as const];
    expect(deShopify.filter((r) => !aMano.has(r)).sort()).toEqual(["lectura_fallida", "sin_token_shopify"]);
    for (const r of aMano) expect(SHOPIFY_LEVEL_REASONS.has(r as never), r).toBe(true);
    // Cuándo: la tienda sin conexión está en la lista de 6 horas del barrido;
    // el corte no, y su propio texto ya dice «la próxima pasada».
    expect(SHOPIFY_LEVEL_REASONS.has("sin_token_shopify")).toBe(true);
    expect(SHOPIFY_LEVEL_REASONS.has("lectura_fallida")).toBe(false);
    expect(INVOICE_REASON_LABEL.lectura_fallida).toContain("se vuelve a intentar en la próxima pasada");
    expect(PANEL).toContain(`"${sinConexion}"`);
    expect(PANEL).toContain(
      'if (review.waitsHours) return review.reason === "sin_token_shopify" ? SHOPIFY_NO_TOKEN_TEXT : SHOPIFY_LATER_TEXT;',
    );
    expect(ACTIONS).toContain("waitsHours: SHOPIFY_LEVEL_REASONS.has(blocked.reason),");
  });

  it("§35.4 y §35.7: un `en_duda` se resuelve con las dos salidas del panel, y lo hace quien tiene `invoices.manage`", () => {
    const s4 = flat(sub(4));
    const s7 = flat(sub(7));
    const PANEL = read("components/order-invoice-panel.tsx");
    const ACTIONS = read("app/dashboard/pedidos/invoice-actions.ts");
    const si = "Sí está en SimpleFact: registrar su serie";
    const no = "No está en SimpleFact: volver a intentar";
    expect(s4).toContain(`Si la encuentra, registra la serie y el número con que salió con «${si}», y pasa a \`emitida\`.`);
    expect(s4).toContain(`Si confirma que no existe, la libera con «${no}». Liberar una que existe es emitir otra.`);
    expect(s7).toContain(`**Resolver un \`en_duda\`** (35.4) ofrece las dos salidas, una al lado de la otra: «${si}» y «${no}».`);
    for (const boton of [si, no]) expect(PANEL, boton).toContain(boton);
    expect(PANEL).toContain("confirmDoubtfulInvoice(live.id, input.serieNumber, input.note)");
    expect(PANEL).toContain("releaseDoubtfulInvoice(live.id, note)");

    // Lo que dice antes de registrar, con la razón social y el RUC de la fila.
    expect(s7).toContain(
      "Antes de registrar, el panel dice qué queda: «Queda como emitida: ‹serie› de ‹razón social› (RUC ‹ruc›). No se puede corregir después.».",
    );
    expect(PANEL).toContain("const quien = row.legalName ? `${row.legalName} (RUC ${row.ruc})` : `RUC ${row.ruc}`;");
    expect(PANEL).toContain("return `Queda como emitida: ${serie} de ${quien}. No se puede corregir después.`;");

    // La letra de la serie es la del tipo que se envió, y la nota es obligatoria.
    expect(s7).toContain(
      "**Registrar su serie** pide la serie y el número con que salió, con la letra de lo que se envió (`B…` si fue boleta, `F…` si fue factura), y una nota de dónde se encontró.",
    );
    expect(ACTIONS).toContain('"Este comprobante es una boleta: su serie empieza con B."');
    expect(ACTIONS).toContain('"Este comprobante es una factura: su serie empieza con F."');
    expect(ACTIONS).toContain('"Escribe dónde la encontraste en SimpleFact: queda junto al comprobante."');

    // Todo lo que §35.7 pone bajo `invoices.manage` lo exige el servidor.
    expect(s7).toContain(
      "registrar un comprobante externo, pedir un reintento y resolver un `en_duda`: registrar su serie si está en SimpleFact, o liberarlo si no está.",
    );
    const cuerpo = (nombre: string) => {
      const desde = ACTIONS.indexOf(`async function ${nombre}(`);
      expect(desde, nombre).toBeGreaterThan(0);
      return ACTIONS.slice(desde, ACTIONS.indexOf("\n}\n", desde));
    };
    expect(cuerpo("authorizeInvoice")).toContain('hasOrgPermission(auth.ctx.orgId, "invoices.manage")');
    for (const accion of ["requestInvoiceRetry", "releaseDoubtfulInvoice", "confirmDoubtfulInvoice"]) {
      expect(cuerpo(accion), accion).toMatch(/^[^]*?const auth = await authorizeInvoice\(invoiceId\);\s*if \("error" in auth\) return/);
    }
    expect(cuerpo("registerExternalInvoice")).toContain('if (!(await hasOrgPermission(ctx.orgId, "invoices.manage"))) return { error: SIN_PERMISO };');
  });

  it("§35.4: Ajustes dice por qué Kapta apagó un RUC", () => {
    const s4 = flat(sub(4));
    const AJUSTES = read("components/invoice-settings-section.tsx");
    expect(s4).toContain(
      "Ajustes dice el motivo en rojo: «Apagado por Kapta: ‹motivo›. Prueba la conexión antes de volver a Real.». Si alguien lo vuelve a encender sin probar, dice «Sin probar. Lo último que falló: ‹motivo›. Prueba la conexión antes de pasar a Real.».",
    );
    expect(AJUSTES).toMatch(
      /if \(why && i\.mode === "apagado"\) \{\s*return \(\s*<span className="text-crit-fg">\s*Apagado por Kapta: \{why\}\. Prueba la conexión antes de volver a Real\.\s*<\/span>/,
    );
    expect(AJUSTES).toContain("Sin probar. Lo último que falló: {why}. Prueba la conexión antes de pasar a Real.");
    // El motivo es el que deja el barrido al apagarlo, sin la prueba de conexión.
    expect(read("lib/invoicing/server.ts")).toMatch(
      /\.update\(\{ mode: "apagado", checked_ruc: null, checked_at: null, check_error: /,
    );
  });
});

describe("MOM §35.8 y §35.9: antes de la 0257 y la 0260, y lo que falta confirmar", () => {
  /**
   * Una base a la que le falta algo: toda tabla y toda función contesta «no
   * existe», nombrando `falta` como lo nombran Postgres y PostgREST.
   */
  function sinLasMigraciones(code: string, falta = "invoice_issuers"): SupabaseClient {
    const message = code.startsWith("PGRST")
      ? `Could not find the table 'public.${falta}' in the schema cache`
      : `relation "public.${falta}" does not exist`;
    const reply = { data: null, error: { code, message } };
    const chain: object = new Proxy(
      {},
      {
        get: (_target, prop) =>
          prop === "then" ? (resolve: (value: unknown) => unknown) => resolve(reply) : () => chain,
      },
    );
    return { from: () => chain, rpc: () => chain } as unknown as SupabaseClient;
  }
  const nada = () => {
    throw new Error("sin las migraciones no se llama afuera");
  };

  it("el barrido no emite ni se pone rojo: `skipped: \"sin_migracion\"`", async () => {
    expect(flat(sub(8))).toContain(
      'Entonces no se emite nada y nada se pone rojo: el barrido responde sin error con `skipped: "sin_migracion"`',
    );
    expect(read("app/api/cron/invoices/route.ts")).toContain('skipped: "sin_migracion"');
    for (const code of ["42P01", "PGRST205"]) {
      for (const dry of [false, true]) {
        const report = await runInvoiceSweep(sinLasMigraciones(code), {
          dry,
          deps: { fetchOrder: nada, createSale: nada, listSales: nada, decryptToken: nada },
        });
        expect(report.skipped, `${code} dry=${dry}`).toBe("sin_migracion");
        expect(report.errors).toEqual([]);
      }
    }
  });

  describe("«falta una migración de comprobantes» es solo lo que crean la 0257 y la 0260", () => {
    const parrafo = flat(sub(8).slice(sub(8).indexOf("Para el barrido, «falta una migración de comprobantes»")));
    const hasta = parrafo.indexOf(". Si lo que falta es otra cosa");
    const la0260 = parrafo.indexOf(" o la 0260 ");
    const deLasMigraciones = codigos(parrafo.slice(0, hasta));
    /** Qué crea cada una, según el MOM: lo nombrado antes de «o la 0260» es de la 0257. */
    const segunElMom: Record<"0257" | "0260", string[]> = {
      "0257": codigos(parrafo.slice(0, la0260)),
      "0260": codigos(parrafo.slice(la0260, hasta)),
    };
    const ajenos = codigos(parrafo.slice(hasta));

    it("el MOM nombra lo mismo que reconoce el código, y cada cosa la crea la migración que dice", () => {
      expect(parrafo).toContain(
        "Para el barrido, «falta una migración de comprobantes» es solo un «no existe» (de tabla o de función) que nombra algo que crean la 0257",
      );
      expect(parrafo).toContain("no es una migración de comprobantes sino una base rota, y el cron se pone rojo (502).");
      expect(la0260).toBeGreaterThan(0);
      expect(la0260).toBeLessThan(hasta);
      expect([...deLasMigraciones].sort()).toEqual(Object.keys(INVOICE_MIGRATION_OBJECTS).sort());
      const sql = { "0257": SQL_0257_FLAT, "0260": SQL_0260_FLAT } as const;
      for (const migracion of ["0257", "0260"] as const) {
        expect(segunElMom[migracion].length, migracion).toBeGreaterThan(0);
        for (const nombre of segunElMom[migracion]) {
          expect(INVOICE_MIGRATION_OBJECTS[nombre as keyof typeof INVOICE_MIGRATION_OBJECTS], nombre).toBe(migracion);
          const creado = [
            `create table if not exists ${nombre} (`,
            `create or replace function ${nombre}(`,
            `add column if not exists ${nombre} `,
          ].some((s) => sql[migracion].includes(s));
          expect(creado, `${nombre} en la ${migracion}`).toBe(true);
        }
      }
      // Lo de otras migraciones que el MOM pone de ejemplo existía antes de la 0257.
      expect(ajenos).toEqual(["orders", "order_payments", "order_master"]);
      for (const nombre of ajenos) {
        expect(SQL_0257_FLAT, nombre).not.toContain(`create table if not exists ${nombre} (`);
        expect(SQL_0260_FLAT, nombre).not.toContain(`create table if not exists ${nombre} (`);
      }
    });

    it("lo que falta de la 0257 o la 0260 deja el barrido en `sin_migracion`; lo demás, en rojo", async () => {
      // Los nombres salen del MOM: sin ese párrafo no hay nada que probar.
      expect(deLasMigraciones.length).toBeGreaterThanOrEqual(6);
      expect(ajenos.length).toBeGreaterThanOrEqual(3);
      const deps = { fetchOrder: nada, createSale: nada, listSales: nada, decryptToken: nada };
      for (const code of ["42P01", "PGRST205"]) {
        for (const nombre of deLasMigraciones) {
          const report = await runInvoiceSweep(sinLasMigraciones(code, nombre), { deps });
          expect(report.skipped, `${code} ${nombre}`).toBe("sin_migracion");
          expect(report.errors, `${code} ${nombre}`).toEqual([]);
        }
        for (const nombre of ajenos) {
          const report = await runInvoiceSweep(sinLasMigraciones(code, nombre), { deps });
          expect(report.skipped, `${code} ${nombre}`).toBeUndefined();
          // `errors` no vacío es lo que pone el cron en 502.
          expect(report.errors.length, `${code} ${nombre}`).toBeGreaterThan(0);
        }
      }
      // Un nombre que solo empieza igual no es de una migración de comprobantes.
      expect(isInvoiceMigrationMissing({ code: "42P01", message: 'relation "public.order_invoices_old" does not exist' })).toBe(
        false,
      );
    });

    it("DEPLOY.md lo dice igual", () => {
      const deploy = flat(section(read("DEPLOY.md"), "### 14-10-2026 · Comprobantes SimpleFact por RUC (MOM §35)", "\n### "));
      expect(deploy).toContain(
        "Solo cuenta como `sin_migracion` lo que crean la 0257 y la 0260: si lo que falta es otra tabla o función (`orders`, `order_payments`, `order_master`…), el cron responde 502 con el error en `errors`",
      );
    });
  });

  it("§35.8: sin la 0260 el panel y Ajustes se ven, pero el barrido no simula ni emite", () => {
    const s8 = flat(sub(8));
    expect(s8).toContain(
      "Sin la 0260, el panel y Ajustes se ven, pero el barrido no tiene la lista de pedidos por revisar (`invoice_candidates`) y no simula ni emite nada.",
    );
    expect(s8).toContain(
      "La 0257 es la que corrió en producción el 14-10-2026 y no se reescribe: lo que cambia después va en una migración nueva.",
    );
    // El panel y Ajustes no leen nada de la 0260: solo el barrido la llama.
    for (const archivo of [
      "app/dashboard/pedidos/invoice-actions.ts",
      "app/dashboard/[storeId]/settings/invoice-actions.ts",
      "app/dashboard/[storeId]/settings/page.tsx",
      "components/order-invoice-panel.tsx",
      "components/invoice-settings-section.tsx",
    ]) {
      expect(read(archivo), archivo).not.toContain("invoice_candidates");
    }
  });

  it("DEPLOY.md: la 0257 ya corrió en producción, y la 0260 va antes del código", () => {
    const seccion = flat(section(read("DEPLOY.md"), "### 14-10-2026 · Comprobantes SimpleFact por RUC (MOM §35)", "\n### "));
    expect(seccion).toContain(
      "**Migración `0257_invoices.sql`.** **Ya aplicada en producción el 14-10-2026**: no se vuelve a pegar ni se edita.",
    );
    const paso0260 = seccion.indexOf(
      "**Migración `0260_invoices_hardening.sql`**, a mano, sobre la 0257 y ANTES de que el código con `invoice_candidates` llegue a `main`",
    );
    expect(paso0260).toBeGreaterThan(seccion.indexOf("**Migración `0257_invoices.sql`.**"));
    expect(paso0260).toBeLessThan(seccion.indexOf("**Desplegar.**"));
    expect(seccion).toContain(
      "**Si el código llega antes, el barrido dice `sin_migracion` y no simula ni emite nada hasta aplicarla**",
    );
    // Las comprobaciones, solo de lectura, con las firmas de verdad.
    const candidatos = "invoice_candidates(uuid, text, timestamptz, integer, text[], uuid)";
    const turno = "invoice_claim(uuid, uuid, uuid, uuid, numeric, timestamptz, text, jsonb, jsonb)";
    expect(seccion).toContain(`select to_regprocedure('public.${candidatos}') is not null;`);
    expect(seccion).toContain(
      "select pg_get_functiondef('public.order_invoices_guard()'::regprocedure) like '%pg_trigger_depth()%';",
    );
    expect(seccion).toContain(`pg_get_functiondef('public.${turno}'::regprocedure) like '%pagos_en_revision%'`);
    expect(seccion).toContain(
      "pg_get_functiondef('public.invoice_issuers_touch()'::regprocedure) like '%check_error := null%'",
    );
    // Lo que buscan esas consultas está en la 0260, y no en la 0257 que corrió:
    // dan `true` solo si la 0260 se aplicó.
    expect(funcion("order_invoices_guard")).toContain("pg_trigger_depth()");
    expect(funcion("invoice_claim")).toContain("pagos_en_revision");
    expect(funcion("invoice_issuers_touch")).toContain("check_error := null");
    for (const huella of ["pg_trigger_depth()", "pagos_en_revision", "check_error := null", "invoice_candidates"]) {
      expect(SQL_0260, huella).toContain(huella);
      expect(SQL_0257, huella).not.toContain(huella);
    }
    expect(SQL_0260_FLAT).toContain(`grant execute on function ${turno} to service_role;`);
  });

  it("DEPLOY.md dice lo mismo: 200 con `sin_migracion`, y verifica las dos funciones", () => {
    const deploy = read("DEPLOY.md");
    const titulo = "### 14-10-2026 · Comprobantes SimpleFact por RUC (MOM §35)";
    const seccion = flat(section(deploy, titulo, "\n### "));
    expect(seccion).toContain(
      'no se emite nada y el cron no se pone rojo: cada pasada responde 200 con `"skipped":"sin_migracion"`',
    );
    expect(seccion).not.toContain("502 («No se pudieron leer los RUC»)");
    expect(seccion).toContain("las funciones `invoice_claim` (el turno) e `invoice_candidates` (qué pedidos mira el barrido)");
    const firma = "invoice_candidates(uuid, text, timestamptz, integer, text[], uuid)";
    expect(seccion).toContain(`'public.${firma}', 'execute'`);
    expect(SQL_0260_FLAT).toContain(`grant execute on function ${firma} to service_role;`);
    // Los prepagos web por Flow se revisan en la simulación (§35.9).
    expect(seccion).toContain("**Los prepagos web por Flow tienen que salir** (MOM §35.9)");
    // Un `en_duda` se resuelve con las dos salidas del panel (§35.4, §35.7), y
    // liberar uno que existe es emitir otro.
    expect(seccion).toContain(
      "**Un `en_duda` se busca en SimpleFact por su nota «Kapta ‹ref›» antes de tocarlo**, y se resuelve en el panel «Comprobante» del pedido (pide `invoices.manage`):",
    );
    expect(seccion).toContain("**Si está**, «Sí está en SimpleFact: registrar su serie»");
    expect(seccion).toContain("**Si no está**, «No está en SimpleFact: volver a intentar»");
    expect(seccion).toContain("**Liberar una que existe es emitir otra**");
    // Lo que se lee en el log y en Ajustes (§35.4).
    expect(seccion).toContain(
      `\`"lleno":{"real":true}\` (o \`"simulacion"\`) dice que \`invoice_candidates\` devolvió los ${INVOICE_SWEEP_MAX_CANDIDATES} pedidos de ese modo`,
    );
    expect(seccion).toContain("Ajustes lo dice en rojo: «Apagado por Kapta: ‹motivo›. Prueba la conexión antes de volver a Real.».");
  });

  it("§35.9: los prepagos web por Flow se confirman en simulación antes de Real", () => {
    expect(flat(sub(9))).toContain(
      "Si todos salen con `pago_web_no_confirmado`, el texto es otro y se ajusta la regla (`lib/invoicing/shopify-order.ts`) antes de encender.",
    );
    expect(flat(sub(8))).toContain("y que los prepagos web por Flow salen (35.9).");
    // Lo que se confirma es el texto que la regla mira en cada transacción.
    const query = read("lib/invoicing/shopify-order.ts");
    expect(query).toMatch(/transactions[^}]*\bgateway\b[^}]*\bformattedGateway\b/s);
  });
});

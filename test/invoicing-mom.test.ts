// Los comprobantes por RUC (MOM §35) están escritos en prosa, y la regla que de
// verdad corre vive en sitios que nadie compila juntos: las reglas puras
// (lib/invoicing/rules.ts), la 0257, la 0260, la 0261 y la 0262 (lo que la base
// acepta y lo que el turno vuelve a revisar), los permisos, el cron y «Emitir
// esta boleta» (el modo Manual, owner 15-10-2026). Ninguno falla solo si se separa del
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
  INVOICE_RELEASE_MIN_AGE_MS,
  INVOICE_RELEASE_UNKNOWN_TEXT,
  INVOICE_STATUSES,
  LIVE_REAL_STATUSES,
  WALKIN_CUSTOMER,
  buildSalePayload,
  classifySaleResponse,
  creditNoteWarning,
  invoiceEligibility,
  invoiceNote,
  invoiceNoteRef,
  invoiceReleaseAvailableAt,
  invoiceReleaseBlock,
  invoiceSweepMode,
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
  INVOICE_CLAIM_MODE_MIGRATION,
  INVOICE_MIGRATION_OBJECTS,
  INVOICE_SHOPIFY_RECHECK_MS,
  INVOICE_STALE_EMITTING_MS,
  INVOICE_SWEEP_MAX_CANDIDATES,
  INVOICE_UNRECONCILED_BATCH,
  InvoiceMigrationMissingError,
  SHOPIFY_LEVEL_REASONS,
  invoiceEmitAllowedHere,
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
 * (los arreglos de la revisión adversaria), la 0261 dos de ellas otra vez y
 * los CHECK del modo (el modo «Manual», 15-10-2026), y la 0262 el turno otra
 * vez (que la empresa recibió el pago, 15-10-2026): lo que dice una función se
 * lee en su última versión, con `funcion`.
 */
const SQL_0257 = read("db/migrations/0257_invoices.sql");
const SQL_0257_FLAT = flat(SQL_0257);
const SQL_0260 = read("db/migrations/0260_invoices_hardening.sql");
const SQL_0260_FLAT = flat(SQL_0260);
const SQL_0261 = read("db/migrations/0261_invoices_manual.sql");
const SQL_0261_FLAT = flat(SQL_0261);
const SQL_0262 = read("db/migrations/0262_invoices_claim_coverage.sql");
const SQL_0262_FLAT = flat(SQL_0262);
/** Lo que la 0260 vuelve a escribir (o crea), y nada más. */
const FUNCIONES_0260 = ["invoice_issuers_touch", "order_invoices_guard", "invoice_claim", "invoice_candidates"];
/** Lo que la 0261 vuelve a escribir de la 0260, y nada más. */
const FUNCIONES_0261 = ["invoice_issuers_touch", "invoice_claim"];
/** Lo que la 0262 vuelve a escribir de la 0261: solo el turno. */
const FUNCIONES_0262 = ["invoice_claim"];
/** Las firmas del turno: la de la 0257 y la 0260, que la 0261 borra, y la de la 0261. */
const FIRMA_TURNO_9 = "invoice_claim(uuid, uuid, uuid, uuid, numeric, timestamptz, text, jsonb, jsonb)";
const FIRMA_TURNO_11 = "invoice_claim(uuid, uuid, uuid, uuid, numeric, timestamptz, text, jsonb, jsonb, text, uuid)";

/**
 * La versión vigente de una función: su último `create or replace` en la 0257,
 * la 0260, la 0261 y la 0262, en ese orden, hasta su `$$;`, en una línea. ""
 * si no está.
 */
function funcion(nombre: string): string {
  const todo = flat(`${SQL_0257}\n${SQL_0260}\n${SQL_0261}\n${SQL_0262}`);
  const desde = todo.lastIndexOf(`create or replace function ${nombre}(`);
  return desde < 0 ? "" : todo.slice(desde, todo.indexOf("$$;", desde) + 3);
}

/**
 * Como `funcion`, sin los comentarios `--` de dentro: lo que corre, para comparar
 * un bloque entero aunque lleve un comentario en medio.
 */
function funcionQueCorre(nombre: string): string {
  const sinComentarios = (sql: string) => sql.replace(/--[^\n]*/g, "");
  const todo = flat([SQL_0257, SQL_0260, SQL_0261, SQL_0262].map(sinComentarios).join("\n"));
  const desde = todo.lastIndexOf(`create or replace function ${nombre}(`);
  return desde < 0 ? "" : todo.slice(desde, todo.indexOf("$$;", desde) + 3);
}

/** La migración (en una línea) que escribe la versión vigente de una función. */
function ultimaQueEscribe(nombre: string): string {
  if (FUNCIONES_0262.includes(nombre)) return SQL_0262_FLAT;
  if (FUNCIONES_0261.includes(nombre)) return SQL_0261_FLAT;
  return SQL_0260_FLAT;
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

/** El cuerpo de una función de un archivo, desde su firma hasta su `}` de columna 0. */
function cuerpoDe(texto: string, firma: string): string {
  const desde = texto.indexOf(firma);
  expect(desde, firma).toBeGreaterThan(0);
  return texto.slice(desde, texto.indexOf("\n}\n", desde));
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
/**
 * Los modos de un comprobante (`order_invoices.mode`): los que escribe el turno.
 * Manual no es uno: su barrido escribe simuladas y su botón, reales.
 */
const WRITE_MODES = [...new Set(INVOICE_MODES.map(invoiceSweepMode).filter((m) => m !== null))];

describe("MOM §35: la sección existe y dice su estado", () => {
  it("encabezado exacto, y nada de §35 colgando dentro de otra sección", () => {
    expect(MOM).toContain(HEADING);
    expect(MOM.replace(S35, "")).not.toMatch(/^#{3,4} 35\./m);
  });

  it("nace apagado: «Ningún RUC emite», y la 0257 lo siembra así", () => {
    const desde = S35.indexOf("Estado:");
    expect(desde).toBeGreaterThan(0);
    const estado = flat(S35.slice(desde, S35.indexOf("\n\n", desde)));
    expect(estado.startsWith("Estado: construido, y ningún RUC emite todavía.")).toBe(true);
    // Las tres migraciones, y lo que trae cada una.
    expect(estado).toContain(
      "Existen las migraciones 0257 (empresas emisoras, cuenta → RUC, comprobantes y el candado de emisión) y 0260 (los arreglos de la revisión adversaria sobre la 0257: el turno que vuelve a revisar los pagos, la excepción de borrar la cuenta de una persona, el token nuevo que borra el motivo de la prueba anterior y los pedidos por revisar)",
    );
    expect(estado).toContain(
      "las dos ya corridas en producción; la 0261 (el modo «Manual» y el turno que dice qué fila pide y quién la pidió, 15-10-2026), y la 0262 (el turno que vuelve a revisar que la empresa recibió el pago, 15-10-2026), que se aplican a mano, en ese orden, antes de su código (35.8).",
    );
    expect(estado).toContain("con su «Emitir esta boleta» (35.7), que solo emite en producción.");
    // «Nada emite solo» tampoco por la 0262: no escribe ningún RUC ni ninguna fila.
    expect(SQL_0262_FLAT).not.toMatch(/\b(?:insert into|update|delete from) invoice_issuers\b/);
    expect(estado).toContain("**Ningún RUC emite**");
    expect(estado).toContain(`GRUPO GF S.A.C. nace dado de alta, en «${INVOICE_MODE_LABEL.apagado}» y sin token`);
    // El orden de encendido, con Manual entre la simulación y lo automático.
    expect(estado).toContain(
      "Se enciende primero en simulación, después en manual —las primeras boletas reales, una a una— y recién entonces en real",
    );
    // «Nada pasa a Manual solo»: la 0261 no escribe ningún RUC.
    expect(SQL_0261_FLAT).not.toMatch(/\b(?:insert into|update|delete from) invoice_issuers\b/);
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
        "db/migrations/0261_invoices_manual.sql",
        "db/migrations/0262_invoices_claim_coverage.sql",
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
        "Es la que corrió en producción el 14-10-2026, y no se reescribe: lo que cambió después va en la 0260, la 0261 y la 0262.",
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
      // Cada una, en su versión vigente, es la de la 0260 —o la de la 0261, que
      // vuelve a escribir dos, o la de la 0262, que vuelve a escribir el
      // turno—; y la 0260 no tiene otra.
      const creadas = [...SQL_0260.matchAll(/^create or replace function (\w+)\(/gm)].map((m) => m[1]);
      expect(creadas).toEqual(FUNCIONES_0260);
      for (const nombre of FUNCIONES_0260) {
        expect(r0260, nombre).toContain(`\`${nombre}\``);
        expect(funcion(nombre), nombre).not.toBe("");
        expect(ultimaQueEscribe(nombre), nombre).toContain(funcion(nombre));
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

    it("la 0261 trae el modo «Manual»: los dos CHECK, el trigger y el turno que nombra, y nada más", () => {
      const r0261 = renglon("db/migrations/0261_invoices_manual.sql");
      expect(r0261).toContain(
        "el CHECK del modo (`invoice_issuers_mode_check`, ahora con nombre) y el de Real (`invoice_issuers_real_ready`), que pide lo mismo a Manual;",
      );
      expect(r0261).toContain(
        "la función del trigger `invoice_issuers_touch` (lo que baja Real a Simulación baja también Manual) y `invoice_claim` (el turno) con `p_mode` y `p_created_by`, que reemplaza la firma de nueve argumentos. No toca filas.",
      );
      // Las dos funciones, y ninguna más; la vigente de cada una es la suya,
      // salvo el turno, que la 0262 vuelve a escribir.
      const creadas = [...SQL_0261.matchAll(/^create or replace function (\w+)\(/gm)].map((m) => m[1]);
      expect(creadas).toEqual(FUNCIONES_0261);
      for (const nombre of FUNCIONES_0261) expect(ultimaQueEscribe(nombre), nombre).toContain(funcion(nombre));
      expect(SQL_0261_FLAT).toContain("create or replace function invoice_claim(");
      // Los dos CHECK, con su nombre.
      for (const check of ["invoice_issuers_mode_check", "invoice_issuers_real_ready"]) {
        expect(r0261, check).toContain(`\`${check}\``);
        expect(SQL_0261_FLAT, check).toContain(`alter table invoice_issuers add constraint ${check} check (`);
      }
      // La firma de nueve se borra ANTES de crear la de once: con las dos, una
      // llamada por nombre con los nueve de siempre no sabría a cuál ir.
      const borra = SQL_0261_FLAT.indexOf(`drop function if exists ${FIRMA_TURNO_9};`);
      expect(borra).toBeGreaterThan(0);
      expect(borra).toBeLessThan(SQL_0261_FLAT.indexOf("create or replace function invoice_claim("));
      // El turno, solo para el servidor.
      expect([...SQL_0261.matchAll(/^(revoke all on function|grant execute on function) (\w+)\(/gm)].map((m) => `${m[1]} ${m[2]}`)).toEqual([
        "revoke all on function invoice_issuers_touch",
        "revoke all on function invoice_claim",
        "grant execute on function invoice_claim",
      ]);
      expect(SQL_0261_FLAT).toContain(`revoke all on function ${FIRMA_TURNO_11} from public, anon, authenticated;`);
      expect(SQL_0261_FLAT).toContain(`grant execute on function ${FIRMA_TURNO_11} to service_role;`);
      // «No toca filas»: en la columna 0 no hay escrituras de datos.
      expect(SQL_0261).not.toMatch(/^(?:insert|update|delete|truncate)\b/im);
      // La cabecera, como las otras: qué pasaba, y que se aplica a mano.
      expect(SQL_0261_FLAT).toContain("-- QUÉ PASABA.");
      expect(SQL_0261_FLAT).toContain("-- Se aplica a mano ANTES del código (DEPLOY.md). Es idempotente.");
    });

    it("la 0262 vuelve a escribir solo el turno, con la firma de la 0261, y se detiene sin ella", () => {
      const r0262 = renglon("db/migrations/0262_invoices_claim_coverage.sql");
      expect(r0262).toContain(
        "el turno que vuelve a revisar que la empresa recibió el pago, sobre la 0261: solo `invoice_claim`, con `create or replace` y la misma firma de once argumentos, que revisa la condición 3 de 35.3 con los pagos y el pedido guardados (`sin_pago_completo`, `prepago_con_comprobantes`), que cada pago de la base del comprobante siga validado, y bloquea los pagos del pedido mientras dura. Se detiene sin la 0261 delante. No toca filas.",
      );
      // Solo el turno, y el vigente es el suyo.
      const creadas = [...SQL_0262.matchAll(/^create or replace function (\w+)\(/gm)].map((m) => m[1]);
      expect(creadas).toEqual(FUNCIONES_0262);
      expect(SQL_0262_FLAT).toContain(funcion("invoice_claim"));
      // La misma firma, con los mismos nombres y valores por defecto, y sin
      // borrar nada: con otra firma nacería un segundo turno al lado, y la
      // llamada por nombre del código dejaría de saber a cuál ir.
      const firma = (sql: string) => {
        const desde = sql.indexOf("create or replace function invoice_claim(");
        return sql.slice(desde, sql.indexOf(") returns jsonb", desde));
      };
      expect(firma(SQL_0262_FLAT)).not.toBe("");
      expect(firma(SQL_0262_FLAT)).toBe(firma(SQL_0261_FLAT));
      expect(SQL_0262).not.toMatch(/^\s*drop /im);
      // Los permisos, los de la 0261: solo para el servidor.
      expect([...SQL_0262.matchAll(/^(revoke all on function|grant execute on function) (\w+)\(/gm)].map((m) => `${m[1]} ${m[2]}`)).toEqual([
        "revoke all on function invoice_claim",
        "grant execute on function invoice_claim",
      ]);
      expect(SQL_0262_FLAT).toContain(`revoke all on function ${FIRMA_TURNO_11} from public, anon, authenticated;`);
      expect(SQL_0262_FLAT).toContain(`grant execute on function ${FIRMA_TURNO_11} to service_role;`);
      // Va después de la 0261: con el turno de nueve, o sin el de once, se
      // detiene antes de crear nada. Sin esto, una 0261 corrida después
      // reemplazaría este turno por el suyo, sin la revisión, sin que nadie lo note.
      const guarda = SQL_0262_FLAT.indexOf(
        `if to_regprocedure('public.${FIRMA_TURNO_9}') is not null or to_regprocedure('public.${FIRMA_TURNO_11}') is null then raise exception 'La 0262 va después de la 0261: aplica primero db/migrations/0261_invoices_manual.sql.';`,
      );
      expect(guarda).toBeGreaterThan(0);
      expect(guarda).toBeLessThan(SQL_0262_FLAT.indexOf("create or replace function invoice_claim("));
      // «No toca filas»: en la columna 0, solo la guarda, la función y sus permisos.
      expect(SQL_0262).not.toMatch(/^(?:insert|update|delete|truncate|alter|drop|comment|create (?!or replace function ))/im);
      // La cabecera, como las otras.
      expect(SQL_0262_FLAT).toContain("-- QUÉ PASABA.");
      expect(SQL_0262_FLAT).toContain("-- Se aplica a mano ANTES del código (DEPLOY.md). Es idempotente.");
      // El repaso de todas las migraciones la corre después de la 0261.
      const apply = read("db/apply.sql");
      expect(apply.indexOf("migrations/0261_invoices_manual.sql")).toBeGreaterThan(0);
      expect(apply.indexOf("migrations/0262_invoices_claim_coverage.sql")).toBeGreaterThan(
        apply.indexOf("migrations/0261_invoices_manual.sql"),
      );
    });

    it("«Emitir esta boleta» está donde dice: `emitInvoiceNow` y `emitInvoiceAction`", () => {
      expect(renglon("lib/invoicing/server.ts")).toContain(
        "el barrido, la conciliación, `emitInvoiceNow` («Emitir esta boleta»: la misma emisión real del barrido, para un pedido, que compara lo que la persona confirmó) e `invoiceEmitNowReadiness` / `loadInvoiceEmitNowOffers` (cuándo se ofrece el botón, en el panel y en Ajustes), y `invoiceEmitAllowedHere` (solo producción emite).",
      );
      expect(read("lib/invoicing/server.ts")).toContain("export async function emitInvoiceNow(");
      expect(read("lib/invoicing/server.ts")).toContain("export function invoiceEmitNowReadiness(");
      expect(read("lib/invoicing/server.ts")).toContain("export async function loadInvoiceEmitNowOffers(");
      expect(read("lib/invoicing/server.ts")).toContain("export function invoiceEmitAllowedHere(): boolean {");
      expect(renglon("lib/invoicing/rules.ts")).toContain(
        "y cuándo se puede liberar un `en_duda` (`invoiceReleaseAvailableAt` e `invoiceReleaseBlock`, con `INVOICE_RELEASE_MIN_AGE_MS`).",
      );
      for (const nombre of [
        "export function invoiceReleaseAvailableAt(",
        "export function invoiceReleaseBlock(",
        "export const INVOICE_RELEASE_MIN_AGE_MS =",
      ]) {
        expect(read("lib/invoicing/rules.ts"), nombre).toContain(nombre);
      }
      expect(flat(impl)).toContain(
        "`app/dashboard/pedidos/invoice-actions.ts` (con `emitInvoiceAction`, lo que corre al pulsar «Emitir esta boleta») y `components/order-invoice-panel.tsx`",
      );
      expect(read("app/dashboard/pedidos/invoice-actions.ts")).toContain("export async function emitInvoiceAction(");
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
    const nombrados = [
      ...new Set(
        codigos(s3.slice(desde, hasta)).filter(
          (c) => c !== "invoice_claim" && c !== "registered_at" && c !== "p_created_by" && c !== "p_basis",
        ),
      ),
    ];
    expect(nombrados).toEqual([
      "sin_conexion",
      "tope",
      "modo_distinto",
      "pagos_en_revision",
      "antes_de_inicio",
      // La condición 3, otra vez en la base (0262).
      "sin_pago_completo",
      "prepago_con_comprobantes",
    ]);
    for (const code of nombrados) expect(delTurno, code).toContain(code);
  });

  it("el turno vuelve a revisar la condición 3 con lo guardado (0262), en el orden de la tabla", () => {
    const turno = flat(s3.slice(s3.indexOf("Recién entonces se pide el turno"), s3.indexOf("**Falla cerrada.**")));
    expect(turno).toContain(
      "que la empresa haya recibido el pago (0262, abajo), el modo, la conexión, el monto, que no haya otro comprobante y el tope del día",
    );
    expect(turno).toContain("**Que la empresa recibió el pago tampoco se lo cree** (0262).");
    expect(turno).toContain(
      "Sin prepago, tiene que haber pagos validados y su suma tiene que cubrir el total que se va a emitir, al céntimo (`sin_pago_completo`); y si el pedido guardado es un prepago web con pagos validados, `prepago_con_comprobantes`, como en las reglas.",
    );
    expect(turno).toContain(
      "Con prepago, no puede quedar ningún pago vivo (`prepago_con_comprobantes`) y el pedido guardado tiene que ser de verdad un prepago web: pagado, por el checkout y sin nada reembolsado (`sin_pago_completo`).",
    );
    expect(turno).toContain(
      "En los dos caminos, cada pago que nombra la base del comprobante tiene que seguir validado y ser de ese pedido (`sin_pago_completo`)",
    );
    expect(turno).toContain(
      "Van en el orden de la tabla, antes que el RUC, el monto y el tope: un pedido que dejó de estar pagado contesta `sin_pago_completo` aunque su RUC esté apagado.",
    );
    const fn = funcion("invoice_claim");
    // Lo validado sale de la misma lectura que la fecha de pago.
    expect(fn).toContain(
      "select count(*), max(registered_at), coalesce(sum(amount), 0) into v_live, v_paid, v_validated from order_payments where order_id = p_order and validation_status = 'validado';",
    );
    // El camino lo dice la base del comprobante; un prepago web, como
    // `isWebPrepaid` (lib/order-paid.ts): pagado, por el checkout, sin
    // reembolsos. Nada se deduce: un dato nulo no es prepago.
    expect(fn).toContain("v_prepaid := coalesce((p_basis->>'prepaid')::boolean, false);");
    expect(fn).toContain(
      "v_web := coalesce(lower(v_order.financial_status) = 'paid', false) and coalesce(v_order.payment_gateway = 'checkout', false) and coalesce(v_order.total_refunded, 0) = 0;",
    );
    const prepago = read("lib/order-paid.ts");
    expect(prepago).toContain('if ((facts.financialStatus ?? "").trim().toLowerCase() !== "paid") return false;');
    expect(prepago).toContain('return facts.paymentGateway === "checkout";');
    // Con prepago: ningún pago vivo, y de verdad un prepago web. Sin prepago:
    // no un prepago web con pagos, y lo validado cubre el total. Lo que corre,
    // sin los comentarios de dentro.
    expect(funcionQueCorre("invoice_claim")).toContain(
      "if v_prepaid then if exists ( select 1 from order_payments where order_id = p_order and validation_status is distinct from 'rechazado' ) then return jsonb_build_object('reason', 'prepago_con_comprobantes'); end if; if not v_web then return jsonb_build_object('reason', 'sin_pago_completo'); end if; else if v_web and v_live > 0 then return jsonb_build_object('reason', 'prepago_con_comprobantes'); end if; if v_live = 0 or v_validated < p_total then return jsonb_build_object('reason', 'sin_pago_completo'); end if; end if;",
    );
    // En los dos: cada pago de la base sigue validado y es de este pedido.
    expect(fn).toContain(
      "where b.pago->>'id' is not null and not exists ( select 1 from order_payments op where op.order_id = p_order and op.validation_status = 'validado' and op.id::text = b.pago->>'id' ) ) then return jsonb_build_object('reason', 'sin_pago_completo');",
    );
    // El orden de la tabla: después de la condición 2, antes del RUC, el monto y el tope.
    const ultima = Math.max(fn.lastIndexOf("'sin_pago_completo'"), fn.lastIndexOf("'prepago_con_comprobantes'"));
    expect(fn.indexOf("'pagos_en_revision'")).toBeLessThan(fn.indexOf("'prepago_con_comprobantes'"));
    for (const despues of ["pg_advisory_xact_lock", "'ruc_apagado'", "'modo_distinto'", "'monto_cero'", "'tope'"]) {
      expect(ultima, despues).toBeLessThan(fn.indexOf(despues));
    }
    expect(INVOICE_REASONS.indexOf("pagos_en_revision")).toBeLessThan(INVOICE_REASONS.indexOf("sin_pago_completo"));
    expect(INVOICE_REASONS.indexOf("prepago_con_comprobantes")).toBeLessThan(INVOICE_REASONS.indexOf("ruc_apagado"));
    // Son del pedido, no del RUC: el barrido sigue con los demás pedidos.
    expect(turno).toContain("Son motivos del pedido y no del RUC: el barrido sigue con los demás pedidos de ese RUC");
    const delRuc = /const ISSUER_WIDE_CLAIM_REASONS: ReadonlySet<InvoiceReason> = new Set<InvoiceReason>\(\[([^\]]*)\]\);/.exec(
      read("lib/invoicing/server.ts"),
    );
    expect(delRuc).not.toBeNull();
    for (const code of ["sin_pago_completo", "prepago_con_comprobantes"]) expect(delRuc![1], code).not.toContain(code);
  });

  it("quien pide el turno dice qué fila pide (0261): el MOM, la base, el barrido y el botón dicen lo mismo", () => {
    const turno = flat(s3.slice(s3.indexOf("Recién entonces se pide el turno"), s3.indexOf("**Falla cerrada.**")));
    expect(turno).toContain(
      "**Quien pide el turno dice qué fila pide** (0261). Sin decirlo, la del modo del RUC: real en Real, y simulada en Simulación y en Manual. El barrido pide la simulada de un RUC en Manual, y «Emitir esta boleta», la real. Una fila real solo la da un RUC en Real, o uno en Manual si se dice quién la pide (`p_created_by`), y una simulada, uno en Simulación o en Manual; si el RUC ya no está en ese modo —el owner lo cambió mientras tanto—, no da el turno (`modo_distinto`). Lo que el turno revisa depende de la fila pedida: la conexión y el error sin reintento, solo para una real.",
    );
    const fn = funcion("invoice_claim");
    // La fila, con el modo del RUC leído bajo su candado.
    expect(fn).toContain(
      "v_mode := case when p_mode is null then case when v_iss.mode = 'real' then 'real' else 'simulacion' end when p_mode = 'real' and v_iss.mode = 'real' then 'real' when p_mode = 'real' and v_iss.mode = 'manual' and p_created_by is not null then 'real' when p_mode = 'simulacion' and v_iss.mode in ('simulacion', 'manual') then 'simulacion' end; if v_mode is null then return jsonb_build_object('reason', 'modo_distinto');",
    );
    expect(fn.indexOf("pg_advisory_xact_lock")).toBeLessThan(fn.indexOf("v_mode := case"));
    // Justo después de `ruc_apagado`, como en las reglas del botón (§35.3).
    expect(fn.indexOf("'ruc_apagado'")).toBeLessThan(fn.indexOf("'modo_distinto'"));
    expect(fn.indexOf("'modo_distinto'")).toBeLessThan(fn.indexOf("'monto_cero'"));
    // La conexión y el error sin reintento, solo para una fila real.
    const simulada = fn.indexOf("if v_mode = 'simulacion' then");
    const real = fn.indexOf(" else ", simulada);
    expect(simulada).toBeGreaterThan(0);
    for (const reason of ["'sin_conexion'", "'error_previo'"]) expect(fn.indexOf(reason), reason).toBeGreaterThan(real);
    // Los argumentos nuevos tienen valor por defecto: el código que ya corre
    // pide el turno con los nueve de siempre, por nombre, y hace lo de antes.
    expect(fn).toContain("p_request jsonb, p_mode text default null, p_created_by uuid default null ) returns jsonb");
    // El barrido: simulada para un RUC en Manual; sin `p_mode` en los otros.
    const SERVER = read("lib/invoicing/server.ts");
    expect(SERVER).toContain('const askedMode: InvoiceWriteMode | null = issuer.issuerMode === "manual" ? "simulacion" : null;');
    expect(SERVER).toContain("...(extra.mode ? { p_mode: extra.mode } : {}),");
    // El botón: la real, con quién pulsó.
    expect(SERVER).toContain('const args = claimArgs(facts, elig, prepared, { mode: "real", createdBy: input.userId });');
    expect(INVOICE_REASON_LABEL.modo_distinto).toBe("El RUC no está en ese modo.");
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
    // El turno vigente es el de la 0262, que rehace el de la 0261 y éste el de
    // la 0260: la 0257 que corrió no lo revisaba.
    const fn = funcion("invoice_claim");
    expect(SQL_0262_FLAT).toContain(fn);
    expect(SQL_0257_FLAT).not.toContain("'pagos_en_revision'");
    // Un pago vivo que no está validado (`posible_duplicado` incluido, y uno sin
    // estado) no da turno: la misma condición 2 de las reglas.
    expect(fn).toContain(
      "if exists ( select 1 from order_payments where order_id = p_order and validation_status is distinct from 'rechazado' and validation_status is distinct from 'validado' ) then return jsonb_build_object('reason', 'pagos_en_revision');",
    );
    // La fecha: el `registered_at` del último validado, nunca `validated_at`;
    // sin validados, la fecha del pedido, la misma que usan las reglas.
    expect(fn).toContain(
      "select count(*), max(registered_at), coalesce(sum(amount), 0) into v_live, v_paid, v_validated from order_payments where order_id = p_order and validation_status = 'validado';",
    );
    expect(fn).not.toContain("validated_at");
    expect(fn).toContain("if v_live = 0 then v_paid := coalesce(v_order.processed_at, v_order.created_at);");
    expect(read("lib/invoicing/server.ts")).toContain("orderDate: o.processed_at ?? o.created_at,");
    // Las dos fechas, y sin una de ellas no hay turno.
    expect(fn).toContain(
      "if v_iss.emit_from is null or p_paid_at is null or p_paid_at < v_iss.emit_from or v_paid is null or v_paid < v_iss.emit_from then return jsonb_build_object('reason', 'antes_de_inicio');",
    );
    // «En los dos modos»: antes de que el turno se separe por la fila pedida.
    const porModo = fn.indexOf("if v_mode = 'simulacion' then");
    expect(porModo).toBeGreaterThan(0);
    expect(fn.indexOf("'pagos_en_revision'")).toBeLessThan(porModo);
    expect(fn.indexOf("'antes_de_inicio'")).toBeLessThan(porModo);
  });

  it("todo motivo que nombra el MOM tiene su texto en INVOICE_REASON_LABEL", () => {
    // En §35.3 todo código entre comillas invertidas es un motivo, salvo los
    // nombres de la base (columnas y argumentos del turno) y el estado `error`
    // de la condición 10.
    const noSonMotivos = new Set(["invoice_claim", "registered_at", "validated_at", "error", "p_created_by", "p_basis"]);
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

describe("MOM §35: las cifras son las del código y las de la base (0257, 0260 y 0261)", () => {
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

  it("el tope cuenta lo que el MOM dice, en el modo pedido, desde el inicio del día de Lima", () => {
    // `v_mode` es la fila que se pide (0261), no el modo del RUC: en Manual, las
    // simuladas del barrido y las reales del botón tienen cada una su tope.
    const cuenta =
      /select count\(\*\) into v_count from order_invoices where issuer_id = p_issuer and mode = v_mode and status in \(([^)]*)\) and created_at >= \(date_trunc\('day', now\(\) at time zone 'America\/Lima'\) at time zone 'America\/Lima'\)/.exec(
        funcion("invoice_claim"),
      );
    expect(cuenta).not.toBeNull();
    // Lo emitido, lo que se está emitiendo y lo en duda; en simulación, lo
    // simulado. Un `error` no es boleta y una `externa` no la emitió Kapta.
    expect(sqlList(cuenta![1])).toEqual(["simulada", "emitiendo", "emitida", "en_duda"]);
    expect(flat(sub(4))).toContain(
      "Cuenta lo emitido, lo que se está emitiendo y lo que está en duda; en simulación, lo simulado. Cuenta solo las filas del modo que se pide (0261): en Manual, las simuladas del barrido y las reales de «Emitir esta boleta» tienen cada una el tope entero, y una simulación no le quita lugar a una boleta real, ni al revés.",
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
    // La 0260 no tiene tablas.
    expect(SQL_0260_FLAT).not.toMatch(/check \(mode in/);
    // invoice_issuers, order_invoices e invoice_order_checks, en ese orden. Los
    // de los comprobantes y las revisiones son los de una fila (WRITE_MODES).
    expect(checks.slice(1)).toEqual([WRITE_MODES, WRITE_MODES]);
    expect(WRITE_MODES).toEqual(["simulacion", "real"]);
    // El de los RUC lo rehace la 0261, con nombre y con «Manual»: son
    // INVOICE_MODES, y la 0257 los tenía todos menos ese.
    const deLaBase = /add constraint invoice_issuers_mode_check check \(mode in \(([^)]*)\)\)/.exec(SQL_0261_FLAT);
    expect(sqlList(deLaBase?.[1])).toEqual([...INVOICE_MODES]);
    expect(checks[0]).toEqual(INVOICE_MODES.filter((m) => m !== "manual"));
    expect(invoiceSweepMode("manual")).toBe("simulacion");
    expect(flat(sub(8))).toContain(
      `Cada RUC tiene cuatro modos: **${INVOICE_MODE_LABEL.apagado}** (no hace nada), **${INVOICE_MODE_LABEL.simulacion}** (revisa todo, arma la boleta y la guarda sin enviarla), **${INVOICE_MODE_LABEL.manual}** (el barrido simula como en Simulación, y una persona emite cada boleta real con «Emitir esta boleta», 35.7) y **${INVOICE_MODE_LABEL.real}** (el barrido emite solo).`,
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

  it("pasar a Manual o a Real exige token, «Emitir desde» y la prueba del mismo RUC", () => {
    expect(flat(sub(8))).toContain(
      "Para pasar a Manual o a Real, la base exige token, «Emitir desde» y una prueba de conexión que leyó el mismo RUC declarado: Manual también manda boletas a SUNAT.",
    );
    // La 0257 lo pedía para Real; la 0261 lo rehace para los dos.
    expect(SQL_0257_FLAT).toContain(
      "constraint invoice_issuers_real_ready check ( mode <> 'real' or (token_enc is not null and emit_from is not null and checked_ruc is not null and checked_ruc = ruc) )",
    );
    expect(SQL_0261_FLAT).toContain(
      "alter table invoice_issuers add constraint invoice_issuers_real_ready check ( mode not in ('real', 'manual') or (token_enc is not null and emit_from is not null and checked_ruc is not null and checked_ruc = ruc) );",
    );
    // Y lo que baja un RUC en Real a Simulación baja igual uno en Manual.
    expect(flat(sub(8))).toContain(
      "Lo que baja un RUC en Real a Simulación —un token, un subdominio o un RUC nuevo, una prueba repetida que no confirma el RUC (35.4)— baja igual uno en Manual, y lo que lo apaga solo, también.",
    );
    const touch = funcion("invoice_issuers_touch");
    expect(SQL_0261_FLAT).toContain(touch);
    // Sin los comentarios de dentro: lo que corre.
    const corre = touch.replace(/-- .*?(?=new\.)/g, "");
    expect(corre).toContain(
      "or new.ruc is distinct from old.ruc ) then new.checked_at := null; new.checked_ruc := null; new.check_error := null; if new.mode in ('real', 'manual') then new.mode := 'simulacion'; end if; end if;",
    );
    expect(touch).toContain(
      "if tg_op = 'UPDATE' and old.mode in ('real', 'manual') and new.mode = old.mode and new.checked_ruc is distinct from new.ruc then new.mode := 'simulacion'; end if;",
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

  it("0262: lo que el turno lee de la base del comprobante es lo que arman las reglas (`prepaid` y el `id` de cada pago)", () => {
    // El turno elige el camino con `p_basis->>'prepaid'` y revisa cada
    // `p_basis->'payments'[*]->>'id'`. Si las reglas dejaran de mandar esas
    // llaves con ese nombre, un prepago web contaría como «sin prepago» (y no
    // saldría nunca) y los pagos no se revisarían: la base no lo diría.
    const fn = funcion("invoice_claim");
    for (const lee of ["p_basis->>'prepaid'", "p_basis->'payments'", "b.pago->>'id'"]) expect(fn, lee).toContain(lee);
    expect(read("lib/invoicing/server.ts")).toContain("p_basis: elig.basis,");
    // Como lo manda supabase-js: JSON, con las llaves por su nombre.
    const json = (r: ReturnType<typeof invoiceEligibility>) => {
      if (!r.ok) throw new Error(`se esperaba un pedido que sale, vino ${r.reason}`);
      return JSON.parse(JSON.stringify(r.basis)) as { prepaid: unknown; payments: Array<{ id: unknown }> };
    };
    const conPagos = json(
      invoiceEligibility(
        hechos([pago({ id: "ade", amount: 50 }), pago({ id: "dif", amount: 100, registeredAt: despues(2) })]),
      ),
    );
    expect(conPagos.prepaid).toBe(false);
    expect(conPagos.payments.map((p) => p.id)).toEqual(["ade", "dif"]);
    // El prepago web no tiene pagos: su id va nulo, y el turno no lo busca.
    const web = json(
      invoiceEligibility(hechos([], { financialStatus: "paid", paymentGateway: "checkout", orderDate: despues(4) })),
    );
    expect(web.prepaid).toBe(true);
    expect(web.payments.map((p) => p.id)).toEqual([null]);
    expect(fn).toContain("where b.pago->>'id' is not null and not exists");
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
    const simulacion = turno.indexOf("if v_mode = 'simulacion' then");
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
      "Uno que ninguna conciliación va a mirar —su RUC ya no está en Real ni en Manual, o no tiene token, o es de antes de ayer— pasa a `en_duda` al empezar la pasada siguiente, sin llamar a SimpleFact",
    );
    // «Ninguna conciliación»: la concilian los RUC en Real y en Manual (las
    // boletas que emitió una persona también pueden quedar en duda).
    expect(s4).toContain(
      "Concilia los RUC en Real y en Manual: en Manual el barrido no emite, pero las boletas que emitió una persona pueden quedar en duda igual.",
    );
    expect(SERVER).toContain('const RECONCILE_MODES: ReadonlySet<string> = new Set<InvoiceEnabledMode>(["manual", "real"]);');
    expect(SERVER).toContain("reconciled = new Set(modes.filter((r) => RECONCILE_MODES.has(r.mode) && hasToken.has(r.id)).map((r) => r.id));");
    expect(SERVER).toContain("if (!RECONCILE_MODES.has(issuer.issuerMode) || (issuer.stopped && NO_RECONCILE.has(issuer.stopped))) continue;");
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

  it("los pagos, quietos mientras dura el turno (0262); un rechazo posterior se ve como nota de crédito", () => {
    expect(s4).toContain(
      "**Los pagos, quietos mientras dura el turno** (0262). El turno bloquea los pagos del pedido (`for share`) antes de revisarlos, hasta que termina.",
    );
    const fn = funcion("invoice_claim");
    const bloqueo = fn.indexOf("perform 1 from order_payments where order_id = p_order for share;");
    expect(bloqueo).toBeGreaterThan(0);
    // Antes de mirar los pagos, y antes de la fila.
    expect(bloqueo).toBeLessThan(fn.indexOf("'pagos_en_revision'"));
    expect(bloqueo).toBeLessThan(fn.indexOf("insert into order_invoices"));
    // Lo que ve quien rechaza después: el aviso de §35.9, con la frase del MOM.
    const aviso = creditNoteWarning({
      status: "emitida",
      mode: "real",
      basisPaymentIds: ["pay-1"],
      validatedPaymentIds: [],
      cancelled: false,
      refunded: false,
    });
    expect(aviso).toBe("Un pago del comprobante ya no está validado: revisa si corresponde una nota de crédito.");
    expect(s4).toContain(`lo emitido no se toca, y el panel avisa «${aviso}» (35.9).`);
  });

  it("liberar un `en_duda` espera 30 minutos desde que quedó en duda; registrar su serie, no", () => {
    const s7 = flat(sub(7));
    const minutos = INVOICE_RELEASE_MIN_AGE_MS / 60_000;
    expect(minutos).toBe(30);
    expect(s4).toContain(`**Liberar espera ${minutos} minutos desde que quedó en duda** (15-10-2026).`);
    // El reloj: `updated_at` (cuando pasó a `en_duda`), con `created_at` de
    // piso, redondeado hacia arriba al minuto.
    const enDuda = { createdAt: "2026-10-15T19:59:50.000Z", updatedAt: "2026-10-15T20:00:30.000Z" };
    const desde = invoiceReleaseAvailableAt(enDuda);
    expect(desde).toBe("2026-10-15T20:31:00.000Z");
    expect(
      invoiceReleaseAvailableAt({ createdAt: "2026-10-15T20:10:00.000Z", updatedAt: "2026-10-15T20:00:00.000Z" }),
    ).toBe("2026-10-15T20:40:00.000Z");
    expect(s4).toContain("El reloj es `updated_at`: el candado de la base lo pone en cada cambio que deja pasar");
    expect(funcion("order_invoices_guard")).toContain("new.updated_at := now();");
    expect(s4).toContain("`created_at` queda de piso.");
    // Un minuto antes, la frase del MOM con la hora de Lima; a esa hora, ya.
    const espera = invoiceReleaseBlock(enDuda, new Date(Date.parse(desde!) - 1));
    expect(espera).toBe(
      "Espera hasta las 15:31 (hora de Lima): SimpleFact puede tardar en mostrar una boleta que sí recibió. Mientras tanto Kapta la sigue buscando.",
    );
    expect(s4).toContain(`Antes de esa hora el servidor no la libera: «${espera!.replace("15:31", "‹HH:MM›")}».`);
    expect(invoiceReleaseBlock(enDuda, new Date(desde!))).toBeNull();
    expect(s4).toContain("La hora va redondeada hacia arriba al minuto: a las ‹HH:MM› ya se puede.");
    // Sin saber desde cuándo, no (falla cerrada).
    expect(invoiceReleaseBlock({ createdAt: enDuda.createdAt, updatedAt: null }, new Date("2030-01-01T00:00:00Z"))).toBe(
      INVOICE_RELEASE_UNKNOWN_TEXT,
    );
    expect(s4).toContain(`Si no se sabe desde cuándo está en duda, no se libera: «${INVOICE_RELEASE_UNKNOWN_TEXT}».`);
    // El servidor: liberar lo mira antes de escribir; registrar su serie, no.
    const ACTIONS = read("app/dashboard/pedidos/invoice-actions.ts");
    const cuerpo = (nombre: string) => {
      const i = ACTIONS.indexOf(`export async function ${nombre}(`);
      expect(i, nombre).toBeGreaterThan(0);
      return ACTIONS.slice(i, ACTIONS.indexOf("\n}\n", i));
    };
    const liberar = cuerpo("releaseDoubtfulInvoice");
    const mira = liberar.indexOf(
      "const wait = invoiceReleaseBlock({ createdAt: invoice.created_at, updatedAt: invoice.updated_at }, new Date());",
    );
    expect(mira).toBeGreaterThan(0);
    expect(liberar.indexOf("if (wait) return { error: wait };")).toBeGreaterThan(mira);
    expect(liberar.indexOf("if (wait) return { error: wait };")).toBeLessThan(liberar.indexOf(".update("));
    expect(cuerpo("confirmDoubtfulInvoice")).not.toContain("invoiceReleaseBlock");
    expect(s4).toContain("Registrar su serie no espera: registrar una boleta que existe no emite otra.");
    // El panel: deshabilitado hasta esa hora, con la frase del MOM.
    const PANEL = read("components/order-invoice-panel.tsx");
    expect(s7).toContain(
      "y solo pasados los 30 minutos (35.4): hasta entonces «No está en SimpleFact: volver a intentar» está deshabilitado y el panel dice «Podrás liberarla desde las ‹HH:MM› (hora de Lima): SimpleFact puede tardar en mostrar una boleta que sí recibió.»; a esa hora se habilita solo, sin releer el panel.",
    );
    expect(PANEL).toContain(
      "return `Podrás liberarla desde las ${hora} (hora de Lima): SimpleFact puede tardar en mostrar una boleta que sí recibió.`;",
    );
    expect(PANEL).toContain("disabled={pending || releaseWait !== null}");
    expect(PANEL).toContain("if (!Number.isFinite(at) || !hora) return INVOICE_RELEASE_UNKNOWN_TEXT;");
    expect(s7).toContain("«Sí está en SimpleFact: registrar su serie» no espera.");
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
      `La única excepción es borrar la cuenta de una persona: la base deja en blanco quién la emitió o la registró, pidió el reintento o la resolvió (${quien.map((c) => `\`${c}\``).join(", ")}) y nada más de la fila cambia`,
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
    // «Emitir esta boleta», también: el permiso antes de leer con el service
    // role y antes de emitir.
    expect(s7).toContain(
      "asignar cuentas, emitir un pedido con «Emitir esta boleta» cuando su RUC está en Manual, registrar un comprobante externo",
    );
    const emitir = cuerpo("emitInvoiceAction");
    const permiso = emitir.indexOf('if (!(await hasOrgPermission(ctx.orgId, "invoices.manage"))) return { error: SIN_PERMISO };');
    expect(permiso).toBeGreaterThan(emitir.indexOf("const auth = await authorizeOrder(orderId);"));
    expect(permiso).toBeLessThan(emitir.indexOf("createAdminSupabase()"));
    expect(permiso).toBeLessThan(emitir.indexOf("emitInvoiceNow("));
  });

  it("§35.4: Ajustes dice por qué Kapta apagó un RUC", () => {
    const s4 = flat(sub(4));
    const AJUSTES = read("components/invoice-settings-section.tsx");
    expect(s4).toContain(
      "Ajustes dice el motivo en rojo: «Apagado por Kapta: ‹motivo›. Prueba la conexión antes de volver a Real o a Manual.». Si alguien lo vuelve a encender sin probar, dice «Sin probar. Lo último que falló: ‹motivo›. Prueba la conexión antes de pasar a Real.».",
    );
    expect(AJUSTES).toMatch(
      /if \(why && i\.mode === "apagado"\) \{\s*return \(\s*<span className="text-crit-fg">\s*Apagado por Kapta: \{why\}\. Prueba la conexión antes de volver a Real o a Manual\.\s*<\/span>/,
    );
    expect(AJUSTES).toContain("Sin probar. Lo último que falló: {why}. Prueba la conexión antes de pasar a Real.");
    // El motivo es el que deja el barrido al apagarlo, sin la prueba de conexión.
    expect(read("lib/invoicing/server.ts")).toMatch(
      /\.update\(\{ mode: "apagado", checked_ruc: null, checked_at: null, check_error: /,
    );
  });
});

describe("MOM §35.1, §35.3, §35.6 y §35.7: el modo Manual y «Emitir esta boleta» (owner, 15-10-2026)", () => {
  const PANEL = read("components/order-invoice-panel.tsx");
  const ACTIONS = read("app/dashboard/pedidos/invoice-actions.ts");
  const SERVER = read("lib/invoicing/server.ts");
  const s7 = flat(sub(7));

  /** El cuerpo de una función exportada de un archivo, hasta su `}` de columna 0. */
  const cuerpo = (texto: string, firma: string) => {
    const desde = texto.indexOf(firma);
    expect(desde, firma).toBeGreaterThan(0);
    return texto.slice(desde, texto.indexOf("\n}\n", desde));
  };

  it("§35.1: la decisión del owner, palabra por palabra", () => {
    expect(flat(sub(1))).toContain(
      "**Un paso a mano antes de lo automático (owner, 15-10-2026).** Entre la simulación y lo automático, el owner eligió: «Nuevo modo «Manual»: el barrido solo simula y tú pulsas «Emitir» pedido por pedido en el panel (solo el owner o quien tenga el permiso), con los mismos candados. Las primeras boletas reales salen una a una y las revisas en SimpleFact antes de pasar a automático.»",
    );
    expect(INVOICE_MODE_LABEL.manual).toBe("Manual");
    expect(INVOICE_MODES).toEqual(["apagado", "simulacion", "manual", "real"]);
  });

  describe("§35.3: un RUC en Manual se evalúa de dos maneras", () => {
    const DESDE = "2026-10-15T05:00:00.000Z";
    const PAGADO = "2026-10-15T06:00:00.000Z";
    const MANUAL: InvoiceIssuer = {
      id: "iss-gf",
      orgId: "org-grupo-gf",
      ruc: "20556792829",
      legalName: "GRUPO GF S.A.C.",
      mode: "manual",
      emitFrom: DESDE,
      dailyLimit: INVOICE_DAILY_LIMIT_DEFAULT,
      hasToken: true,
      checkedRuc: "20556792829",
    };
    const PASARELA: InvoiceAccount = { id: "acc-flow", label: "Aurela Kenku", aliases: [], phoneLastDigits: null, issuerId: MANUAL.id };
    const hechos = (over: Partial<InvoiceOrderFacts> = {}, issuer: Partial<InvoiceIssuer> = {}): InvoiceOrderFacts => ({
      orderId: "ord-1",
      storeId: "store-1",
      orderName: "#KP136181",
      total: 150,
      currency: "PEN",
      cancelledAt: null,
      totalRefunded: 0,
      financialStatus: "pending",
      paymentGateway: "manual",
      orderDate: DESDE,
      customerName: null,
      payments: [
        {
          id: "pay-1",
          kind: "total",
          amount: 150,
          validationStatus: "validado",
          registeredAt: PAGADO,
          validatedAt: PAGADO,
          vision: null,
          flowLinked: true,
          statementDestination: null,
        },
      ],
      accounts: [PASARELA],
      issuers: [{ ...MANUAL, ...issuer }],
      existing: { realLive: false, simulated: false, errorBlocked: false },
      ...over,
    });
    /** El modo en que sale, o el motivo por el que no. */
    const sale = (f: InvoiceOrderFacts, emitNow?: boolean) => {
      const r = emitNow ? invoiceEligibility(f, { emitNow }) : invoiceEligibility(f);
      return r.ok ? r.mode : r.reason;
    };

    it("el MOM lo dice", () => {
      expect(flat(sub(3))).toContain(
        "**Un RUC en Manual** (35.8) se evalúa de dos maneras. El barrido y el panel lo evalúan como uno en Simulación: en la condición 9 cuenta su simulación y la 10 no se mira, porque ahí el barrido no emite. «Emitir esta boleta» (35.7) evalúa el pedido como una emisión real (`invoiceEligibility` con `emitNow`): en la 9 cuenta solo lo real —una simulación no frena—, la 10 se mira, y también la conexión del RUC (`sin_conexion`). Y justo después de la condición 7, el RUC tiene que estar en Manual o en Real (`modo_distinto`); el botón, además, solo emite en Manual (35.7).",
      );
    });

    it("el barrido (sin `emitNow`) lo evalúa como Simulación: nunca sale real", () => {
      expect(sale(hechos())).toBe("simulacion");
      const simulado = { realLive: false, simulated: true, errorBlocked: false };
      expect(sale(hechos({ existing: simulado }))).toBe("ya_simulado");
      // La 10 y la conexión no se miran: ahí el barrido no emite.
      expect(sale(hechos({ existing: { realLive: false, simulated: false, errorBlocked: true } }))).toBe("simulacion");
      expect(sale(hechos({}, { hasToken: false, checkedRuc: null }))).toBe("simulacion");
    });

    it("«Emitir esta boleta» (`emitNow`) lo evalúa como una emisión real", () => {
      expect(sale(hechos(), true)).toBe("real");
      // Una simulación no frena; lo real, sí.
      expect(sale(hechos({ existing: { realLive: false, simulated: true, errorBlocked: false } }), true)).toBe("real");
      expect(sale(hechos({ existing: { realLive: true, simulated: true, errorBlocked: false } }), true)).toBe("ya_tiene");
      // La 10 y la conexión, sí.
      expect(sale(hechos({ existing: { realLive: false, simulated: false, errorBlocked: true } }), true)).toBe("error_previo");
      expect(sale(hechos({}, { hasToken: false }), true)).toBe("sin_conexion");
      expect(sale(hechos({}, { checkedRuc: "20000000001" }), true)).toBe("sin_conexion");
    });

    it("con `emitNow`, el RUC tiene que estar en Manual o en Real, justo después de la condición 7", () => {
      expect(sale(hechos({}, { mode: "simulacion" }), true)).toBe("modo_distinto");
      expect(sale(hechos({}, { mode: "apagado" }), true)).toBe("ruc_apagado");
      // Las reglas dejan Real; el botón no (lo rechaza `emitInvoiceAction`).
      expect(sale(hechos({}, { mode: "real" }), true)).toBe("real");
      // Después de la 6 y antes de la 8.
      expect(sale(hechos({ total: 850, payments: [{ ...hechos().payments[0]!, amount: 850 }] }, { mode: "simulacion" }), true)).toBe(
        "monto_mayor_700",
      );
      expect(sale(hechos({}, { mode: "simulacion", emitFrom: null }), true)).toBe("modo_distinto");
      expect(INVOICE_REASONS.indexOf("modo_distinto")).toBeGreaterThan(INVOICE_REASONS.indexOf("error_previo"));
    });
  });

  it("§35.4: «Emitir desde» se mueve también al pasar de Manual a Real", () => {
    expect(flat(sub(4))).toContain(
      "Pasar de Manual a Real también es cambiar de modo: lo que quedó pagado en Manual y nadie emitió con «Emitir esta boleta» no sale en Real. Se emite antes de cambiar, o a mano en SimpleFact y se registra con «Ya tiene comprobante».",
    );
    expect(flat(sub(8))).toContain("«Emitir desde» se mueve al momento del cambio: lo pagado en Manual que nadie emitió no sale (35.4).");
    expect(funcion("invoice_issuers_touch")).toContain(
      "if new.mode <> 'apagado' and (tg_op = 'INSERT' or new.mode is distinct from old.mode) and new.emit_from < now() then new.emit_from := now(); end if;",
    );
  });

  it("§35.4: un RUC en Manual se barre como Simulación y se concilia como Real", () => {
    expect(flat(sub(4))).toContain(
      "**Un RUC en Manual se barre como uno en Simulación** y se concilia como uno en Real: entra en la lista de simulación, el barrido arma y guarda su simulada, y nunca le pide a SimpleFact una venta; sus boletas reales las emite una persona (35.7). Si el RUC cambia de modo entre la lista y el turno, el turno contesta `modo_distinto` y ese RUC no sigue ni concilia en esa pasada. En la línea del log del cron, su `mode` es `manual`.",
    );
    expect(invoiceSweepMode("manual")).toBe("simulacion");
    expect(invoiceSweepMode("simulacion")).toBe("simulacion");
    expect(invoiceSweepMode("real")).toBe("real");
    expect(invoiceSweepMode("apagado")).toBeNull();
    expect(SERVER).toContain('const SWEEP_MODES: readonly InvoiceEnabledMode[] = ["simulacion", "manual", "real"];');
    // `modo_distinto` detiene el RUC y no concilia.
    expect(cuerpo(SERVER, "const ISSUER_WIDE_CLAIM_REASONS")).toContain('"modo_distinto",');
    expect(SERVER).toContain('const NO_RECONCILE = new Set<string>([STOP.apagado, STOP.espera, STOP.sinToken, "sin_conexion", "modo_distinto"]);');
    // El reporte lleva el modo del RUC.
    expect(SERVER).toContain("report: emptyIssuerReport({ id: row.id, ruc: row.ruc, mode: issuerMode }),");
  });

  it("§35.6: `created_by` es quien pulsó; el barrido no pone a nadie", () => {
    expect(flat(sub(6))).toContain(
      "**Quién la pidió** (`created_by`). En una fila real, es quien pulsó «Emitir esta boleta» con el RUC en Manual (35.7): el turno la escribe al reservarla, con quien le pasa el servidor (0261). En una externa, quien la registró. Una fila del barrido —simulada o real— va sin nadie: la pidió Kapta.",
    );
    expect(flat(sub(6))).toContain("quién la emitió con «Emitir esta boleta» o la registró como externa (`created_by`) y quién pidió reintentar");
    const turno = funcion("invoice_claim");
    expect(turno).toMatch(/insert into order_invoices \( [^)]*\bcreated_by \) values \( [^;]*\bp_created_by \);/);
    // El barrido nunca manda `createdBy`; el botón, siempre, y sin quién no pide el turno.
    expect(SERVER.match(/createdBy:/g)).toHaveLength(1);
    expect(SERVER).toContain("...(extra.createdBy ? { p_created_by: extra.createdBy } : {}),");
    const emitir = cuerpo(SERVER, "async function emitNow(");
    expect(emitir.indexOf('return blocked("turno_fallido", "No se sabe quién emite: no se pidió el turno.");')).toBeLessThan(
      emitir.indexOf('admin.rpc("invoice_claim"'),
    );
    expect(cuerpo(ACTIONS, "export async function emitInvoiceAction(")).toMatch(
      /result = await emitInvoiceNow\(admin, \{\s*orderId: ctx\.orderId,\s*userId: ctx\.userId,/,
    );
  });

  it("§35.7: solo en Manual hay botón, y el servidor lo vuelve a exigir", () => {
    expect(s7).toContain(
      "**Emitir a mano es solo de Manual (owner, 15-10-2026; 35.1).** En Real emite solo el barrido y no hay botón «Emitir»; en Simulación y en Apagado no se emite.",
    );
    expect(s7).not.toContain("Emitir lo hace solo el barrido");
    // El panel: solo con el RUC del pedido en Manual.
    const ofrece = cuerpo(ACTIONS, "function emitNowOf(");
    expect(ofrece).toContain("if (!canManage || !storeActive) return none;");
    expect(ofrece).toContain("const ready = invoiceEmitNowReadiness({ facts, invoices, checks, storeActive });");
    // La misma decisión para el drawer y para Ajustes (§35.7).
    const decide = cuerpo(SERVER, "export function invoiceEmitNowReadiness(");
    expect(decide).toContain("if (!storeActive) return no();");
    expect(decide).toContain("const elig = invoiceEligibility(facts, { emitNow: true });");
    expect(decide).toContain('if (elig.issuer.mode !== "manual") return no();');
    expect(decide).toContain("if (emitNowShopifyBlock(checks, invoices)) return no();");
    // El servidor, al pulsar: Real se rechaza, y lo confirmado tiene que ser lo
    // que sale. Lo compara `emitInvoiceNow` con SU lectura —la misma con que
    // arma la boleta y pide el turno—, antes del token, de Shopify y del turno.
    // Antes lo comparaba la acción con una lectura propia, y entre las dos el
    // pedido podía cambiar: salía una boleta que nadie confirmó.
    const emitir = cuerpo(ACTIONS, "export async function emitInvoiceAction(");
    expect(emitir).toMatch(
      /emitInvoiceNow\(admin, \{\s*orderId: ctx\.orderId,\s*userId: ctx\.userId,\s*manualOnly: true,\s*expected: \{ issuerId: shownIssuer, totalCents: shownCents \},\s*\}\)/,
    );
    // Una sola lectura: la acción no lee el pedido por su cuenta.
    for (const lectura of ["loadInvoiceOrderFacts(", "invoiceEligibility(", "elig."]) {
      expect(emitir, lectura).not.toContain(lectura);
    }
    expect(s7).toContain(
      "La acción no lee el pedido por su cuenta: antes comparaba con una lectura propia, `emitInvoiceNow` volvía a leer sin comparar, y entre las dos el pedido podía cambiar y salir una boleta que nadie confirmó.",
    );
    const boton = cuerpo(SERVER, "async function emitNow(");
    const reglas = boton.indexOf("const elig = invoiceEligibility(facts, { emitNow: true });");
    const soloManual = boton.indexOf('if (input.manualOnly && issuer.mode !== "manual") {');
    const loConfirmado = boton.indexOf(
      'if (input.expected && !sameAsExpected(elig, input.expected)) return blocked("pedido_cambio");',
    );
    expect(reglas).toBeGreaterThan(0);
    expect(soloManual).toBeGreaterThan(reglas);
    expect(loConfirmado).toBeGreaterThan(soloManual);
    for (const despues of ["loadIssuerConn(", "prepareSale(", 'admin.rpc("invoice_claim"']) {
      expect(loConfirmado, despues).toBeLessThan(boton.indexOf(despues));
    }
    expect(boton).toContain("a mano solo se emite en «Manual».");
    expect(s7).toContain("(en Real lo rechaza: «…a mano solo se emite en «Manual»»)");
    expect(s7).toContain(
      "con ESA lectura —la misma con que arma la boleta y pide el turno— y antes del token, de Shopify y del turno, que el RUC sigue en Manual",
    );
    // El mismo RUC y el mismo total al céntimo.
    const igual = cuerpo(SERVER, "function sameAsExpected(");
    expect(igual).toContain("expected.issuerId === elig.issuer.id &&");
    expect(igual).toContain("expected.totalCents === elig.totalCents");
    const cambio = "El pedido cambió desde que lo abriste (el RUC o el total): vuelve a abrirlo y revisa la boleta antes de emitirla.";
    expect(INVOICE_REASON_LABEL.pedido_cambio).toBe(cambio);
    expect(ACTIONS).toContain("const EMIT_CAMBIO = INVOICE_REASON_LABEL.pedido_cambio;");
    expect(s7).toContain(`Si el pedido cambió desde que lo abrió, no emite (\`pedido_cambio\`): «${cambio}».`);
    // El badge.
    expect(s7).toContain("El badge dice «Lista para emitir».");
    expect(PANEL).toContain('badge = { tone: "info", label: "Lista para emitir" };');
  });

  it("§35.7: solo producción emite; una vista previa no ofrece el botón y lo dice", () => {
    expect(s7).toContain(
      "**Solo en producción** (`invoiceEmitAllowedHere`: `VERCEL_ENV` es `production`; sin él, en local, tampoco). Una vista previa de Vercel comparte con producción la base y la llave de cifrado",
    );
    expect(INVOICE_REASON_LABEL.no_produccion).toBe("Emitir solo funciona en producción: este despliegue es una vista previa.");
    expect(s7).toContain(`a quien gestiona le dice «${INVOICE_REASON_LABEL.no_produccion}» (\`no_produccion\`).`);
    // Solo `production`, tal cual: lo demás, o nada, no emite (falla cerrada).
    const antes = process.env.VERCEL_ENV;
    try {
      for (const [env, emite] of [
        [undefined, false],
        ["", false],
        ["preview", false],
        ["development", false],
        ["Production", false],
        [" production", false],
        ["production", true],
      ] as const) {
        if (env === undefined) delete process.env.VERCEL_ENV;
        else process.env.VERCEL_ENV = env;
        expect(invoiceEmitAllowedHere(), String(env)).toBe(emite);
      }
    } finally {
      if (antes === undefined) delete process.env.VERCEL_ENV;
      else process.env.VERCEL_ENV = antes;
    }
    // La acción, antes de leer nada; `emitInvoiceNow`, primero que todo; las
    // ofertas del panel y de Ajustes, sin leer nada.
    const accion = cuerpo(ACTIONS, "export async function emitInvoiceAction(");
    const corta = accion.indexOf("if (!invoiceEmitAllowedHere()) return { error: INVOICE_REASON_LABEL.no_produccion };");
    expect(corta).toBeGreaterThan(0);
    expect(corta).toBeLessThan(accion.indexOf("authorizeOrder("));
    expect(s7).toContain("La acción lo rechaza antes de leer nada, y `emitInvoiceNow` lo vuelve a pedir, primero que todo");
    const boton = cuerpo(SERVER, "async function emitNow(");
    const primero = boton.indexOf('if (!invoiceEmitAllowedHere()) return blocked("no_produccion");');
    expect(primero).toBeGreaterThan(0);
    expect(primero).toBeLessThan(boton.indexOf("await "));
    const ofertas = cuerpo(SERVER, "export async function loadInvoiceEmitNowOffers(");
    expect(ofertas.indexOf("if (!invoiceEmitAllowedHere()) return out;")).toBeGreaterThan(0);
    expect(ofertas.indexOf("if (!invoiceEmitAllowedHere()) return out;")).toBeLessThan(ofertas.indexOf("await "));
    // El panel: sin botón, y donde lo habría, el motivo.
    expect(cuerpo(ACTIONS, "function emitNowOf(")).toContain(
      'if (!canEmitNow) return { emitNow: null, emitNowBlocked: { reason: "no_produccion", detail: null } };',
    );
    expect(PANEL).toContain("data.emitNow !== null && data.canEmitNow === true");
    // Ajustes: sin «Emitir», y con un RUC en Manual, la misma frase.
    expect(s7).toContain("Ajustes no ofrece «Emitir» y, con un RUC en Manual, lo dice con la misma frase.");
    expect(read("app/dashboard/[storeId]/settings/page.tsx")).toContain(
      "if (emitHere && newestSimulated.size && (rows ?? []).some((r) => r.mode === \"manual\")) {",
    );
    const AJUSTES = read("components/invoice-settings-section.tsx");
    expect(AJUSTES).toContain("«Emitir» no está disponible: {INVOICE_REASON_LABEL.no_produccion}");
    expect(AJUSTES).toMatch(/canEmit &&\s*emitHere &&\s*!!offer &&/);
    // El barrido ya no emitía fuera de producción.
    expect(read("app/api/cron/invoices/route.ts")).toContain('if (process.env.VERCEL_ENV !== "production" && !dry) {');
  });

  it("§35.7: en Ajustes, lo que contestó «Emitir» se queda a la vista después del refresco", () => {
    expect(s7).toContain("**En Ajustes, la respuesta se queda a la vista** (15-10-2026).");
    expect(s7).toContain(
      "se guarda por pedido en la lista y no en el botón: queda en la fila donde se pulsó; si esa fila salió de las 20, en la más nueva de su pedido; y si no queda ninguna de su pedido, o la lista no se pudo leer, arriba, con el enlace al pedido.",
    );
    const AJUSTES = read("components/invoice-settings-section.tsx");
    // Vive en la lista, por pedido, y la lista se monta siempre, también sin filas.
    expect(AJUSTES).toContain("const [outcomes, setOutcomes] = useState<RecentEmitOutcomes>({});");
    expect(AJUSTES).toContain(
      "<RecentList rows={data.recent} issuers={issuers ?? []} canEmit={data.canManage} emitHere={data.emitHere} />",
    );
    expect(AJUSTES).toContain(
      "const host = rows.find((r) => r.id === outcome.rowId) ?? rows.find((r) => r.orderId === outcome.orderId);",
    );
    // Con una respuesta a la vista, ese pedido no vuelve a tener «Emitir»; en
    // vuelo, no sale otro del mismo pedido.
    expect(s7).toContain("Con una respuesta a la vista, ese pedido no vuelve a tener «Emitir»: para intentar otra vez se abre el pedido.");
    expect(AJUSTES).toContain("!outcomes[r.orderId];");
    expect(s7).toContain("Mientras un «Emitir» está en vuelo, no sale otro del mismo pedido, aunque el refresco vuelva a montar el botón.");
    expect(AJUSTES).toContain("if (inFlight.current.has(orderId)) return;");
    // Una respuesta que no dice nada no se pinta en blanco.
    const perdida =
      "No se pudo completar la acción. Antes de intentar de nuevo, abre el pedido: si quedó «Emitiendo» o «En duda», búscala en SimpleFact.";
    expect(s7).toContain(`Una respuesta que no dice nada se lee como «${perdida}».`);
    expect(AJUSTES).toContain(`"${perdida}"`);
    expect(AJUSTES).toContain("if (!res?.error && !res?.notice) res = { error: EMIT_LOST };");
  });

  it("§35.7: lo que dice antes de emitir, y un envío a la vez", () => {
    expect(s7).toContain(
      "**Qué dice antes.** Pide confirmar: «Se emite una boleta de S/ ‹total› a CLIENTES VARIOS con el RUC ‹ruc› (‹razón social›). Va a SUNAT y no se puede borrar.», con «Sí, emitir» y «Cancelar».",
    );
    expect(PANEL).toContain(
      "return `Se emite una boleta de ${soles(emit.total)} a CLIENTES VARIOS con el RUC ${emit.ruc} (${emit.legalName}). Va a SUNAT y no se puede borrar.`;",
    );
    expect(PANEL).toMatch(/function soles\(value: number\): string \{\s*return `S\/ \$\{/);
    expect(PANEL).toContain('{busy ? "Emitiendo…" : "Sí, emitir"}');
    expect(PANEL).toContain("export async function sendOnce<T>(lock: { current: boolean }, send: () => Promise<T>): Promise<T | null> {");
  });

  it("§35.7: la emisión es la del barrido, con el mismo código", () => {
    expect(s7).toContain(
      "Después, `emitInvoiceNow`: exactamente la emisión real del barrido, con el mismo código.",
    );
    // Las piezas compartidas: el barrido y el botón llaman a las mismas.
    const barrido = cuerpo(SERVER, "async function sweepOrg(");
    const boton = cuerpo(SERVER, "async function emitNow(");
    for (const pieza of ["prepareSale(", "claimArgs(", "sendClaimedSale(", "turnOffReason("]) {
      expect(barrido, pieza).toContain(pieza);
      expect(boton, pieza).toContain(pieza);
    }
    expect(boton).toContain("invoiceEligibility(facts, { emitNow: true })");
    // El token antes del turno, y SimpleFact solo con un turno real.
    expect(boton.indexOf("loadIssuerConn(")).toBeLessThan(boton.indexOf('admin.rpc("invoice_claim"'));
    expect(boton.indexOf('answer.mode !== "real"')).toBeLessThan(boton.indexOf("sendClaimedSale("));
  });

  it("§35.7: lo que contesta, con sus frases", () => {
    expect(s7).toContain(
      "`en_duda`, «SimpleFact no respondió: queda En duda; búscala por su nota «Kapta ‹ref›» antes de nada.», y la concilia el barrido como cualquier `en_duda` (35.4)",
    );
    expect(ACTIONS).toContain(
      "`SimpleFact no respondió: queda En duda; búscala por su nota «${invoiceNoteRef(result.invoiceId)}» antes de nada.`",
    );
    // Lo que el turno rechaza (0262 incluida) vuelve como su motivo, sin
    // reservar ni enviar nada.
    expect(s7).toContain(
      "Si el turno encuentra que el pago ya no cubre el total, o que un pago de la base del comprobante dejó de estar validado (0262, 35.3), contesta ese motivo (`sin_pago_completo`, `prepago_con_comprobantes`) y no sale nada.",
    );
    const boton = cuerpo(SERVER, "async function emitNow(");
    expect(boton).toContain("if (isReason(answer.reason)) return blocked(answer.reason);");
    expect(boton.indexOf("if (isReason(answer.reason)) return blocked(answer.reason);")).toBeLessThan(
      boton.indexOf("state.claimed = prepared.invoiceId;"),
    );
    for (const code of ["sin_pago_completo", "prepago_con_comprobantes"] as const) {
      expect(INVOICE_REASONS, code).toContain(code);
      expect(INVOICE_REASON_LABEL[code].trim(), code).not.toBe("");
    }
    expect(s7).toContain("Volver a pulsar después de una duda da «Ya tiene comprobante.»: no hay segundo envío.");
    expect(INVOICE_REASON_LABEL.ya_tiene).toBe("Ya tiene comprobante.");
    expect(s7).toContain(
      "Si algo falla después de reservar el turno, la fila queda en `emitiendo` y contesta en duda: se concilia, nunca se repite.",
    );
    const nunca = cuerpo(SERVER, "export async function emitInvoiceNow(");
    expect(nunca).toMatch(/if \(state\.claimed\) \{\s*return \{\s*ok: true,\s*status: "en_duda",/);
  });

  it("§35.7: con el RUC en Manual el panel no promete «Lista para emitirse»", () => {
    expect(s7).toContain(
      "dice «Lista para simularse en la próxima pasada (RUC ‹ruc›, modo Manual)» y «En Manual el barrido solo simula: la boleta real la emite, pedido por pedido, quien tiene «Boletas y facturas».».",
    );
    expect(PANEL).toContain("Lista para simularse en la próxima pasada (RUC {review.ruc}, modo {INVOICE_MODE_LABEL.manual}).");
    expect(PANEL).toContain(
      '"En Manual el barrido solo simula: la boleta real la emite, pedido por pedido, quien tiene «Boletas y facturas».";',
    );
  });

  it("§35.8: Manual va entre Simulación y Real en el orden de encendido", () => {
    const s8 = flat(sub(8));
    enOrden(s8, [
      "2. Pone el RUC en Simulación",
      "3. Confirma con el contador",
      "4. Pasa a Manual, con «Emitir desde» del momento del cambio, y con la 0262 ya aplicada (abajo).",
      "Emite las primeras boletas reales una a una con «Emitir esta boleta» y revisa cada una en SimpleFact antes de la siguiente",
      "5. Pasa a Real: desde entonces el barrido emite solo y no hay botón.",
    ]);
  });

  it("§35.8: antes de la 0261, Ajustes no deja Manual y el barrido sigue igual", () => {
    const s8 = flat(sub(8));
    const ajustes = "La base todavía no admite el modo Manual: falta aplicar la migración 0261.";
    expect(s8).toContain(`Ajustes no deja pasar un RUC a Manual y lo dice, «${ajustes}».`);
    expect(read("app/dashboard/[storeId]/settings/invoice-actions.ts")).toContain(`return "${ajustes}";`);
    // Sin la 0261 la base no conoce el modo: `invoice_issuers_mode_check` es el
    // CHECK de la 0257 (sin nombre, Postgres le puso ese), y la 0261 lo rehace.
    expect(SQL_0257_FLAT).toContain("mode text not null default 'apagado' check (mode in ('apagado', 'simulacion', 'real'))");
    // El mensaje del botón sin la 0261 es el de la base que falta.
    const falta = "Falta aplicar la migración 0261 de comprobantes (invoice_claim con p_mode y p_created_by).";
    expect(s8).toContain(`«Emitir esta boleta» dice «${falta}»`);
    expect(INVOICE_CLAIM_MODE_MIGRATION).toBe("0261");
    expect(new InvoiceMigrationMissingError("invoice_claim con p_mode y p_created_by", "invoice_claim", "0261").message).toBe(falta);
    expect(SERVER).toContain('const CLAIM_0261_PARAMS = ["p_mode", "p_created_by"] as const;');
    expect(SERVER).toContain('new InvoiceMigrationMissingError(`invoice_claim con ${sent.join(" y ")}`, "invoice_claim", INVOICE_CLAIM_MODE_MIGRATION)');
    // Y el código anterior con la 0261: los nueve de siempre, por nombre.
    expect(s8).toContain(
      "ese código pide el turno con los nueve argumentos de siempre, por nombre, y los dos nuevos quedan en su valor por defecto (nulo): el turno hace lo de antes.",
    );
  });

  it("§35.8: la 0262 va después de la 0261 y antes de la primera boleta real; sin ella nada se pone rojo", () => {
    const s8 = flat(sub(8));
    expect(s8).toContain(
      "**Antes de la 0262.** También se aplica a mano, después de la 0261 y antes de la primera boleta real —con «Emitir esta boleta» o con un RUC en Real— (DEPLOY.md).",
    );
    expect(s8).toContain(
      "si llega antes, nada se pone rojo y todo sigue como con la 0261 —el barrido simula y, en Real, emite; el botón emite—, pero el turno no vuelve a revisar que la empresa recibió el pago (35.3)",
    );
    // «Nada se pone rojo»: la misma firma, así que el código la llama igual con
    // la 0261 o con la 0262, y nada la echa en falta (`sin_migracion` es de la
    // 0257, la 0260 y la 0261).
    expect(s8).toContain("No cambia la firma del turno: es la de once argumentos de la 0261, con `create or replace`");
    expect(INVOICE_CLAIM_MODE_MIGRATION).toBe("0261");
    expect(funcion("invoice_claim")).toContain("p_mode text default null, p_created_by uuid default null ) returns jsonb");
    expect(SQL_0261_FLAT).toContain("p_mode text default null, p_created_by uuid default null ) returns jsonb");
    expect(s8).toContain(
      "Va después de la 0261: sin ella —sigue el turno de nueve argumentos, o falta el de once— se detiene sin cambiar nada. Si después alguien vuelve a correr la 0261, el turno queda otra vez sin esta revisión hasta volver a correr la 0262.",
    );
    // El encendido: Manual, con la 0262 ya aplicada.
    expect(s8).toContain("4. Pasa a Manual, con «Emitir desde» del momento del cambio, y con la 0262 ya aplicada (abajo).");
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
    expect(seccion).toContain("Ajustes lo dice en rojo: «Apagado por Kapta: ‹motivo›. Prueba la conexión antes de volver a Real o a Manual.».");
  });

  it("DEPLOY.md: la 0261 va después de la 0260 y antes del código, y se comprueba con la firma de once", () => {
    const seccion = flat(section(read("DEPLOY.md"), "### 14-10-2026 · Comprobantes SimpleFact por RUC (MOM §35)", "\n### "));
    expect(seccion).toContain(
      "### 14-10-2026 · Comprobantes SimpleFact por RUC (MOM §35) — needs migrations 0257, 0260, 0261 and 0262",
    );
    // Lo que hay en producción, y que la 0260 no se vuelve a pegar.
    expect(seccion).toContain(
      "**Producción al 15-10-2026**: la 0257 y la 0260 aplicadas, GRUPO GF S.A.C. en «Simulación» con el token probado y ningún comprobante.",
    );
    expect(seccion).toContain("**Ya aplicada en producción**: no se vuelve a pegar ni se edita. En una base nueva:");
    const paso0260 = seccion.indexOf("**Migración `0260_invoices_hardening.sql`**");
    const paso0261 = seccion.indexOf(
      "**Migración `0261_invoices_manual.sql`**, a mano, sobre la 0260 y ANTES de que el código con «Manual» (el que pide el turno con `p_mode` y `p_created_by`) llegue a `main`",
    );
    expect(paso0261).toBeGreaterThan(paso0260);
    expect(paso0261).toBeLessThan(seccion.indexOf("**Desplegar.**"));
    // Las dos direcciones: la 0261 con el código de hoy, y el código antes que la 0261.
    expect(seccion).toContain(
      "**Se puede aplicar ya, con el código que hoy está en producción**: ese código pide el turno con los nueve argumentos de siempre, por nombre, y los dos nuevos quedan en nulo —el turno hace lo de antes—",
    );
    expect(funcion("invoice_claim")).toContain("p_mode text default null, p_created_by uuid default null");
    expect(seccion).toContain("**Si el código llega antes que la 0261, no se emite nada de más y nada se pone rojo**");
    expect(seccion).toContain("(«La base todavía no admite el modo Manual: falta aplicar la migración 0261.»)");
    expect(seccion).toContain(
      "«Emitir esta boleta» contesta «Falta aplicar la migración 0261 de comprobantes (invoice_claim con p_mode y p_created_by).»",
    );
    // El barrido de Simulación y de Real no manda `p_mode`: sigue con el turno de la 0260.
    expect(seccion).toContain("el barrido de Simulación y de Real pide el turno como siempre, sin `p_mode`, contra el de la 0260, y sigue igual.");
    expect(read("lib/invoicing/server.ts")).toContain(
      'const askedMode: InvoiceWriteMode | null = issuer.issuerMode === "manual" ? "simulacion" : null;',
    );
    // Las comprobaciones, solo de lectura, con las firmas de verdad: dan lo
    // esperado solo si la 0261 se aplicó.
    expect(seccion).toContain(
      `select to_regprocedure('public.${FIRMA_TURNO_11}') is not null, to_regprocedure('public.${FIRMA_TURNO_9}') is null;`,
    );
    expect(SQL_0261_FLAT).toContain(`drop function if exists ${FIRMA_TURNO_9};`);
    expect(SQL_0261_FLAT).toContain(`grant execute on function ${FIRMA_TURNO_11} to service_role;`);
    expect(seccion).toContain(`select pg_get_functiondef('public.${FIRMA_TURNO_11}'::regprocedure) like '%modo_distinto%';`);
    expect(funcion("invoice_claim")).toContain("'modo_distinto'");
    expect(SQL_0260).not.toContain("modo_distinto");
    expect(seccion).toContain(
      "pg_get_functiondef('public.invoice_issuers_touch()'::regprocedure) like '%(''real'', ''manual'')%'",
    );
    expect(funcion("invoice_issuers_touch")).toContain("('real', 'manual')");
    expect(SQL_0260).not.toContain("'manual'");
    expect(seccion).toContain(
      "conname in ('invoice_issuers_mode_check', 'invoice_issuers_real_ready') order by 1;` — dos filas, y las dos nombran `'manual'`;",
    );
    expect(seccion).toContain(`select has_function_privilege('authenticated', 'public.${FIRMA_TURNO_11}', 'execute');`);
    // La comprobación de la 0260 con la firma de nueve deja de servir después.
    expect(seccion).toContain(
      "La del turno, con la firma de nueve argumentos, sirve solo antes de la 0261: después esa firma no existe y la consulta falla («does not exist»)",
    );
    // El encendido: Simulación → Manual → Real, después de las migraciones.
    enOrden(seccion, [
      "3. **Migración `0261_invoices_manual.sql`**",
      "4. **Migración `0262_invoices_claim_coverage.sql`**",
      "5. **Desplegar.**",
      "7. **Simulación.**",
      "9. **Manual: las primeras boletas reales, una a una** (MOM §35.7).",
      "Revisar cada boleta en SimpleFact **antes de emitir la siguiente**",
      "10. **Real.** Pasar el RUC a «Real»: desde entonces el barrido emite solo y el botón desaparece.",
      "11. **Pasada en seco, a mano.**",
    ]);
    expect(seccion).toContain("→ Real (pasos 7, 9 y 10).");
    expect(seccion).toContain("La 0261 y la 0262 son nuevas y van en los pasos 3 y 4, en ese orden y antes del código.");
    expect(seccion).toContain("**lo pagado durante Manual que nadie emitió con el botón no sale en Real**");
    // En Manual toda boleta real la pidió una persona (§35.6).
    expect(seccion).toContain("created_by is not null as con_quien");
    // Un `en_duda` se resuelve como en el paso 9 (el de Manual), no en otro.
    expect(seccion).toContain("cada `en_duda` conciliado solo o resuelto como en el paso 9.");
    expect(seccion).toContain("su nota y se resuelve en el panel como en el paso 9.");
    expect(seccion).toContain("`\"skipped\":\"sin_ruc_encendido\"`: sirve desde el paso 7.");
  });

  it("DEPLOY.md: la 0262 va después de la 0261 y antes de la primera boleta real, y se comprueba", () => {
    const seccion = flat(section(read("DEPLOY.md"), "### 14-10-2026 · Comprobantes SimpleFact por RUC (MOM §35)", "\n### "));
    const paso0261 = seccion.indexOf("3. **Migración `0261_invoices_manual.sql`**");
    const paso0262 = seccion.indexOf(
      "4. **Migración `0262_invoices_claim_coverage.sql`**, a mano, DESPUÉS de la 0261 y ANTES de la primera boleta real: antes de pulsar «Emitir esta boleta» y antes de pasar un RUC a «Real».",
    );
    expect(paso0261).toBeGreaterThan(0);
    expect(paso0262).toBeGreaterThan(paso0261);
    expect(paso0262).toBeLessThan(seccion.indexOf("5. **Desplegar.**"));
    // En una transacción, y parando al primer error.
    expect(seccion).toContain(
      '`psql -1 -v ON_ERROR_STOP=1 "$DATABASE_URL" -f db/migrations/0262_invoices_claim_coverage.sql`',
    );
    // La guarda, con la frase de la migración.
    const guarda = "La 0262 va después de la 0261: aplica primero db/migrations/0261_invoices_manual.sql.";
    expect(SQL_0262_FLAT).toContain(`raise exception '${guarda}';`);
    expect(seccion).toContain(`se detiene con «${guarda}» y no cambia nada.`);
    expect(seccion).toContain("**Si alguien vuelve a correr la 0261 después, hay que volver a correr la 0262**");
    // Con el código de hoy: lo que el turno lee de `p_basis`, ese código ya lo manda.
    expect(seccion).toContain(
      "ese código pide el turno con los nueve argumentos por nombre y ya manda en `p_basis` si es prepago web y el id de cada pago, que es lo que el turno revisa: lo bien pagado sigue dando su fila.",
    );
    // Si el código llega antes: nada lo avisa, y no se emite nada real hasta aplicarla.
    expect(seccion).toContain("**Si el código llega antes que la 0262, nada se pone rojo y nada lo avisa**");
    expect(seccion).toContain(
      "Por eso no se pulsa «Emitir esta boleta» ni se pasa un RUC a «Real» hasta aplicarla",
    );
    // Las comprobaciones, con la firma de verdad, y que distinguen la 0262 de la 0261.
    expect(seccion).toContain(
      `select pg_get_functiondef('public.${FIRMA_TURNO_11}'::regprocedure) like '%sin_pago_completo%';\` tiene que dar \`true\` (y lo mismo con \`like '%for share%'\`); con solo la 0261, da \`false\`;`,
    );
    for (const huella of ["sin_pago_completo", "for share"]) {
      expect(funcion("invoice_claim"), huella).toContain(huella);
      for (const [n, sql] of [["0257", SQL_0257], ["0260", SQL_0260], ["0261", SQL_0261]] as const) {
        expect(sql, `${n}: ${huella}`).not.toContain(huella);
      }
    }
    expect(seccion).toContain(
      "select count(*) from pg_proc where proname = 'invoice_claim' and pronamespace = 'public'::regnamespace;` tiene que dar `1`: un solo turno;",
    );
    const paso = seccion.slice(paso0262, seccion.indexOf("5. **Desplegar.**"));
    expect(paso).toContain(`select has_function_privilege('authenticated', 'public.${FIRMA_TURNO_11}', 'execute');`);
    // «Antes de subir»: verify-db la corre sobre la 0261.
    expect(seccion).toContain("la 0261 sobre las dos y la 0262 sobre la 0261) y `next build`.");
    expect(read("scripts/sql/invoices_smoke.sql")).toContain("0262_invoices_claim_coverage.sql");
  });

  it("DEPLOY.md: «Emitir» solo en producción, y liberar un `en_duda` espera", () => {
    const seccion = flat(section(read("DEPLOY.md"), "### 14-10-2026 · Comprobantes SimpleFact por RUC (MOM §35)", "\n### "));
    expect(seccion).toContain(
      "Lo que solo pasa en producción —el barrido que emite y «Emitir esta boleta»— lo decide `VERCEL_ENV`, que pone Vercel.",
    );
    const desplegar = seccion.slice(seccion.indexOf("5. **Desplegar.**"), seccion.indexOf("6. **El token"));
    expect(desplegar).toContain(
      `En una vista previa el panel no tiene el botón y, donde lo habría, dice «${INVOICE_REASON_LABEL.no_produccion}»; Ajustes no ofrece «Emitir» y, con un RUC en «Manual», dice lo mismo; y la acción lo rechaza antes de leer nada.`,
    );
    const manual = seccion.slice(seccion.indexOf("9. **Manual:"), seccion.indexOf("10. **Real.**"));
    expect(manual).toContain("Antes, la 0262 aplicada (paso 4). Para emitir, en producción —una vista previa no emite (paso 5)—");
    expect(manual).toContain(
      `«No está en SimpleFact: volver a intentar», con lo que se revisó, y solo pasados ${INVOICE_RELEASE_MIN_AGE_MS / 60_000} minutos desde que quedó en duda`,
    );
    expect(manual).toContain("«Podrás liberarla desde las ‹HH:MM› (hora de Lima)…»), y el servidor tampoco la libera; «Sí está…» no espera.");
    expect(manual).toContain(
      "En Ajustes, lo que contesta se queda a la vista después del refresco de la página, y ese pedido no vuelve a tener «Emitir»",
    );
  });

  it("DEPLOY.md: antes de volver al código anterior, ninguna fila real queda en `emitiendo` ni en `en_duda`", () => {
    const seccion = flat(section(read("DEPLOY.md"), "### 14-10-2026 · Comprobantes SimpleFact por RUC (MOM §35)", "\n### "));
    const marcha = seccion.slice(seccion.indexOf("**Marcha atrás.**"), seccion.indexOf("**Qué mirar después.**"));
    expect(marcha.length).toBeGreaterThan(0);
    // Lo de antes prometía algo que el código anterior no hace: pasar a
    // `en_duda` un `emitiendo` que nadie concilia lo hace este código, no aquél.
    expect(marcha).not.toContain("y sus `emitiendo` pasan a `en_duda` al empezar una pasada");
    expect(marcha).toContain(
      "**Antes de volver al código anterior** (el de `main` antes de estos commits, 0f7c79c6): ese código no conoce «Manual» y lo trata como «Apagado»; solo concilia los RUC en «Real»; no pasa a `en_duda` un `emitiendo` que nadie concilia; y su panel no tiene «Sí está en SimpleFact: registrar su serie».",
    );
    const minutos = INVOICE_STALE_EMITTING_MS / 60_000;
    enOrden(marcha, [
      "1. Bajar a «Simulación» todo RUC en «Manual»",
      `2. Esperar una pasada de este código que empiece al menos ${minutos} minutos después del último «Emitir esta boleta»`,
      "pasa a `en_duda` cada `emitiendo` sin respuesta, sin llamar a SimpleFact (`sin_respuesta`).",
      "3. Resolver a mano cada `en_duda`, como en el paso 9",
      `«No está en SimpleFact: volver a intentar», pasados los ${INVOICE_RELEASE_MIN_AGE_MS / 60_000} minutos.`,
      "4. Comprobar, solo lectura, `select count(*) from order_invoices where mode = 'real' and status in ('emitiendo', 'en_duda');` — tiene que dar `0`. Recién entonces volver al código anterior.",
    ]);
    // Lo que el punto 2 espera es lo que hace este código: aunque el RUC no
    // esté encendido, y solo con los de más de 10 minutos.
    const SERVER = read("lib/invoicing/server.ts");
    expect(SERVER).toContain("if (!dry) await settleUnreconciledEmitting(ctx);");
    expect(cuerpoDe(SERVER, "async function settleUnreconciledEmitting(")).toContain(
      "const staleBefore = new Date(now.getTime() - INVOICE_STALE_EMITTING_MS).toISOString();",
    );
    expect(SERVER).toContain('const RECONCILE_MODES: ReadonlySet<string> = new Set<InvoiceEnabledMode>(["manual", "real"]);');
    // Y el punto 3: este código tiene las dos salidas.
    expect(read("app/dashboard/pedidos/invoice-actions.ts")).toContain("export async function confirmDoubtfulInvoice(");
    // Las migraciones se quedan: el código anterior las acepta.
    expect(marcha).toContain(
      "La 0262 tampoco: el código anterior manda en `p_basis` si es prepago web y el id de cada pago, y lo bien pagado sigue dando su fila.",
    );
  });

  it("§35.9: los prepagos web por Flow se confirman en simulación antes de Manual", () => {
    expect(flat(sub(9))).toContain(
      "Antes de pasar a Manual hay que ver en las simuladas que los prepagos web por Flow salen.",
    );
    expect(flat(sub(9))).toContain(
      "Si todos salen con `pago_web_no_confirmado`, el texto es otro y se ajusta la regla (`lib/invoicing/shopify-order.ts`) antes de encender.",
    );
    expect(flat(sub(8))).toContain("y que los prepagos web por Flow salen (35.9).");
    // Lo que se confirma es el texto que la regla mira en cada transacción.
    const query = read("lib/invoicing/shopify-order.ts");
    expect(query).toMatch(/transactions[^}]*\bgateway\b[^}]*\bformattedGateway\b/s);
  });
});

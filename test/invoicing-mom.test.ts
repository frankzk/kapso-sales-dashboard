// Los comprobantes por RUC (MOM §35) están escritos en prosa, y la regla que de
// verdad corre vive en sitios que nadie compila juntos: las reglas puras
// (lib/invoicing/rules.ts), la 0257 (lo que la base acepta y lo que el turno
// vuelve a revisar), los permisos y el cron. Ninguno falla solo si se separa del
// MOM: un motivo que el panel no sabe decir, un tope que el MOM promete y la
// base no guarda, un estado «vivo» que el índice único no cuenta, un 4xx que el
// MOM da por «no hay boleta» y el código trata como duda. Y una boleta de más
// ante SUNAT no se borra. Estas pruebas atan cada cifra y cada nombre del MOM
// al código que de verdad corre.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
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
  invoiceNote,
  isValidRuc,
  normalizeSubdomain,
  rucFromSimplefactText,
  simplefactBaseUrl,
} from "@/lib/invoicing/rules";
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
const SQL = read("db/migrations/0257_invoices.sql");
const SQL_FLAT = flat(SQL);

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
    expect(estado).toContain("**Ningún RUC emite**");
    expect(estado).toContain(`GRUPO GF S.A.C. nace dado de alta, en «${INVOICE_MODE_LABEL.apagado}» y sin token`);
    // «Apagado y sin token» no lo dice el código del barrido sino la base: el
    // modo nace en apagado y la semilla no escribe ni el modo ni el token.
    expect(SQL_FLAT).toContain("mode text not null default 'apagado'");
    const semilla = /insert into invoice_issuers \(([^)]*)\)/.exec(SQL_FLAT);
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

    it("las tablas, la columna y el turno que nombra están en la 0257", () => {
      const flatImpl = flat(impl);
      for (const tabla of ["invoice_issuers", "order_invoices", "invoice_order_checks"]) {
        expect(flatImpl).toContain(`\`${tabla}\``);
        expect(SQL).toContain(`create table if not exists ${tabla} (`);
      }
      expect(flatImpl).toContain("`store_collection_accounts.invoice_issuer_id` con su trigger");
      expect(SQL_FLAT).toContain("alter table store_collection_accounts add column if not exists invoice_issuer_id");
      expect(flatImpl).toContain("la función `invoice_claim`");
      expect(SQL).toContain("create or replace function invoice_claim(");
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
  const delTurno = [...SQL.matchAll(/'reason', '([a-z_0-9]+)'/g)].map((m) => m[1]!);

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
    const nombrados = codigos(s3.slice(desde, hasta)).filter((c) => c !== "invoice_claim");
    expect(nombrados).toEqual(["sin_conexion", "tope"]);
    for (const code of nombrados) expect(delTurno, code).toContain(code);
  });

  it("todo motivo que nombra el MOM tiene su texto en INVOICE_REASON_LABEL", () => {
    // En §35.3 todo código entre comillas invertidas es un motivo, salvo dos
    // nombres de la base y el estado `error` de la condición 10.
    const noSonMotivos = new Set(["invoice_claim", "validated_at", "error"]);
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

describe("MOM §35: las cifras son las del código y las de la 0257", () => {
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
    expect(SQL).toContain(`if p_total > ${BOLETA_MAX_CENTS / 100} then`);
  });

  it("tope diario: 40 por defecto, de 1 a 300, por día de Lima", () => {
    expect([INVOICE_DAILY_LIMIT_DEFAULT, INVOICE_DAILY_LIMIT_MIN, INVOICE_DAILY_LIMIT_MAX]).toEqual([40, 1, 300]);
    const s4 = flat(sub(4));
    expect(s4).toContain(
      `**Tope diario por RUC** (\`daily_limit\`): ${INVOICE_DAILY_LIMIT_DEFAULT} por defecto, de ${INVOICE_DAILY_LIMIT_MIN} a ${INVOICE_DAILY_LIMIT_MAX}, por día de Lima.`,
    );
    expect(SQL_FLAT).toContain(
      `daily_limit integer not null default ${INVOICE_DAILY_LIMIT_DEFAULT} check (daily_limit between ${INVOICE_DAILY_LIMIT_MIN} and ${INVOICE_DAILY_LIMIT_MAX})`,
    );
  });

  it("el tope cuenta lo que el MOM dice, en su modo, desde el inicio del día de Lima", () => {
    const cuenta =
      /select count\(\*\) into v_count from order_invoices where issuer_id = p_issuer and mode = v_iss\.mode and status in \(([^)]*)\) and created_at >= \(date_trunc\('day', now\(\) at time zone 'America\/Lima'\) at time zone 'America\/Lima'\)/.exec(
        SQL_FLAT,
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
    expect(SQL_FLAT).toContain(`invoice_type text not null default '${BOLETA_TYPE}' check (invoice_type in ('01', '${BOLETA_TYPE}'))`);

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
    const rucDeLaBase = /ruc text not null check \(ruc ~ '([^']+)'\)/.exec(SQL_FLAT);
    expect(rucDeLaBase).not.toBeNull();
    expect(new RegExp(rucDeLaBase![1]!).test("20556792829")).toBe(true);

    expect(SQL_FLAT).toContain("values (v_org.org_id, '20556792829', 'GRUPO GF S.A.C.', 'grupogf')");
    expect(SQL_FLAT).toContain("(a.phone_last_digits = '309' and lower(a.label) = lower('Grupo GF S.A.C.'))");
    expect(SQL_FLAT).toContain("(a.phone_last_digits is null and lower(a.label) = lower('Aurela Kenku'))");
    // Solo la primera vez: lo que el owner reasignó no se pisa.
    expect(SQL_FLAT).toContain("and a.invoice_issuer_id is null");
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
    const checks = [...SQL_FLAT.matchAll(/check \(mode in \(([^)]*)\)\)/g)].map((m) => sqlList(m[1]));
    // invoice_issuers, order_invoices e invoice_order_checks, en ese orden.
    expect(checks).toEqual([[...INVOICE_MODES], WRITE_MODES, WRITE_MODES]);
    expect(flat(sub(8))).toContain(
      `Cada RUC tiene tres modos: **${INVOICE_MODE_LABEL.apagado}** (no hace nada), **${INVOICE_MODE_LABEL.simulacion}** (revisa todo, arma la boleta y la guarda sin enviarla) y **${INVOICE_MODE_LABEL.real}**.`,
    );
  });

  it("los estados de la base son INVOICE_STATUSES, y el MOM los nombra todos", () => {
    const check = /check \(status in \(([^)]*)\)\)/.exec(SQL_FLAT);
    expect(sqlList(check?.[1])).toEqual([...INVOICE_STATUSES]);
    for (const status of INVOICE_STATUSES) expect(S35, status).toContain(`\`${status}\``);
    // La simulación es la única fila `simulada`, y viceversa.
    expect(flat(sub(6))).toContain("con modo `simulacion` y estado `simulada`");
    expect(SQL_FLAT).toContain("constraint order_invoices_mode_status check ((mode = 'simulacion') = (status = 'simulada'))");
  });

  it("el comprobante real vivo: el índice único, el turno y el MOM cuentan los mismos estados", () => {
    const indice =
      /create unique index if not exists order_invoices_one_real on order_invoices \(order_id\) where mode = 'real' and status in \(([^)]*)\);/.exec(
        SQL_FLAT,
      );
    expect(sqlList(indice?.[1])).toEqual([...LIVE_REAL_STATUSES]);
    const turno = /mode = 'real' and status in \(([^)]*)\) \) then return jsonb_build_object\('reason', 'ya_tiene'\)/.exec(
      SQL_FLAT,
    );
    expect(sqlList(turno?.[1])).toEqual([...LIVE_REAL_STATUSES]);
    expect(flat(sub(4))).toContain(
      `a lo más un comprobante real vivo: ${lista(LIVE_REAL_STATUSES.map((s) => `\`${s}\``))}. Lo garantiza Postgres, no el código.`,
    );
  });

  it("los estados solo avanzan como dice §35.6", () => {
    const desdeEmitiendo = /old\.status = 'emitiendo' and new\.status in \(([^)]*)\)/.exec(SQL_FLAT);
    const desdeEnDuda = /old\.status = 'en_duda' and new\.status in \(([^)]*)\)/.exec(SQL_FLAT);
    expect(sqlList(desdeEmitiendo?.[1])).toEqual(["emitida", "error", "en_duda"]);
    expect(sqlList(desdeEnDuda?.[1])).toEqual(["emitida", "error"]);
    const s6 = flat(sub(6));
    expect(s6).toContain(
      `\`emitiendo\` → ${lista(sqlList(desdeEmitiendo?.[1]).map((s) => `\`${s}\``))}; y \`en_duda\` → \`emitida\` (se concilió) o \`error\` (una persona confirmó que no existe).`,
    );
    expect(SQL).toContain("raise exception 'Un comprobante no se borra'");
  });

  it("pasar a Real exige token, «Emitir desde» y la prueba del mismo RUC", () => {
    expect(flat(sub(8))).toContain(
      "Para pasar a Real, la base exige token, «Emitir desde» y una prueba de conexión que leyó el mismo RUC declarado.",
    );
    expect(SQL_FLAT).toContain(
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
    expect(SQL).not.toMatch(/create policy/i);
    for (const tabla of ["invoice_issuers", "order_invoices", "invoice_order_checks"]) {
      expect(SQL).toContain(`alter table ${tabla} enable row level security;`);
    }
    expect(SQL).toContain("revoke all on invoice_issuers, order_invoices, invoice_order_checks from anon, authenticated;");
    // «Un trigger exige que el RUC sea de la misma organización que la tienda.»
    expect(flat(sub(6))).toContain("Un trigger exige que el RUC sea de la misma organización que la tienda");
    expect(SQL).toContain("raise exception 'El RUC no es de la organización de la tienda'");
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

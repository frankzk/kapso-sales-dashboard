// El acta del manifiesto de devolución, en PDF y en Excel (owner, 04-11-2026:
// «opcional [la foto], pero que se genere hasta un pdf y excel para
// descargarlo»). Lo que se fija aquí: el acta lleva #pedido, salida, día de la
// caja, lo reportado, el resultado, los totales y las firmas, y NADA del
// cliente —ni nombre, ni teléfono, ni dirección— aunque la línea los traiga.
// Y la descarga es una ruta autenticada con el permiso de Almacén.

import { readFileSync } from "node:fs";
import { inflateSync } from "node:zlib";
import ExcelJS from "exceljs";
import { describe, expect, it } from "vitest";
import { bucketReturnManifest, buildReturnManifestActa, type ReturnManifestActa, type ReturnManifestLine } from "@/lib/return-manifest";
import {
  actaFilename,
  actaHeaderLines,
  actaTotalsLines,
  buildReturnManifestActaPdf,
  buildReturnManifestActaWorkbook,
} from "@/lib/exports/return-manifest-acta";

const PII = { customerName: "Rosa Díaz Quispe", customerPhone: "51999888777", address: "Av. Siempre Viva 742", district: "Miraflores" };

const line = (over: Partial<ReturnManifestLine> = {}): ReturnManifestLine => ({
  id: "l1",
  shipmentId: "s1",
  storeId: "st",
  orderId: "o1",
  orderName: "#KP101",
  outputCode: "KP101-S01",
  scannedCode: "KP101-S01",
  sourceRiderName: "Alexis",
  sourceRouteDate: "2026-11-01",
  reportedStatus: "no_entregado",
  reportedReason: "no_contesta",
  expected: true,
  outcome: "received",
  flags: [],
  receiptOutcome: "por_asignar",
  message: null,
  note: null,
  scanCount: 1,
  scannedAt: "2026-11-04T15:00:00Z",
  removedAt: null,
  removalReason: null,
  ...over,
});

/** Una línea que trae datos del cliente colados: el acta no debe usarlos. */
const leaky = (over: Partial<ReturnManifestLine>) => ({ ...line(over), ...PII }) as ReturnManifestLine;

function acta(): ReturnManifestActa {
  const buckets = bucketReturnManifest({
    state: "closed",
    expected: [],
    lines: [
      leaky({}),
      leaky({ id: "l2", shipmentId: "s2", orderName: "#KP102", outputCode: "KP102-S01", expected: false, flags: ["sin_reporte"], reportedStatus: "no_entregado", reportedReason: "otro" }),
      leaky({ id: "l3", shipmentId: "s3", orderName: "#KP103", outputCode: "KP103-S01", expected: false, outcome: "held", flags: ["reportada_entregada"], receiptOutcome: null, reportedStatus: "entregado", reportedReason: null }),
      leaky({ id: "l4", shipmentId: "s4", orderName: "#KP104", outputCode: "KP104-S01", receiptOutcome: "a_inventario_anulado" }),
      leaky({ id: "m1", shipmentId: "s5", orderName: "#KP105", outputCode: "KP105-S01", outcome: "missing", receiptOutcome: null, sourceRouteDate: "2026-10-28" }),
    ],
    arrivedOn: "2026-11-04",
    cadenceDays: 3,
    // Lo que el cierre contó dentro de plazo: no se lista, pero «esperados» lo cuenta.
    pendingAtClose: { conElMotorizado: 2, reprogramado: 1 },
  });
  return buildReturnManifestActa({
    header: {
      label: "Devolución · Alexis · 04/11",
      courierLabel: "Grupo GF",
      riderFirstName: "Alexis",
      arrivedOn: "2026-11-04",
      handedOverBy: "Alexis",
      receivedBy: "Yelitza",
      openedAt: "2026-11-04T14:00:00Z",
      closedAt: "2026-11-04T16:30:00Z",
      state: "closed",
      declaredCount: 5,
      note: "Trajo todo en una bolsa",
    },
    buckets,
  });
}

/** El texto de un PDF de pdf-lib: sus streams van comprimidos y el texto, en hex. */
function pdfText(bytes: Uint8Array): string {
  const raw = Buffer.from(bytes).toString("latin1");
  const chunks: string[] = [raw];
  const re = /stream\r?\n/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw))) {
    const start = m.index + m[0].length;
    const end = raw.indexOf("endstream", start);
    if (end < 0) break;
    try {
      chunks.push(inflateSync(Buffer.from(raw.slice(start, end), "latin1")).toString("latin1"));
    } catch {
      // No era un stream comprimido.
    }
  }
  const all = chunks.join("\n");
  // `<234B50313031> Tj` → «#KP101».
  const decoded = all.replace(/<([0-9A-Fa-f\s]+)>/g, (_, hex: string) => Buffer.from(hex.replace(/\s+/g, ""), "hex").toString("latin1"));
  return `${all}\n${decoded}`;
}

describe("el acta: lo que lleva", () => {
  const a = acta();

  it("cada fila es #pedido, salida, día de la caja, reportado y resultado; ningún campo más", () => {
    for (const row of a.rows) expect(Object.keys(row).sort()).toEqual(["boxDay", "n", "orderName", "outputCode", "reported", "result"]);
    expect(a.rows.map((r) => r.orderName)).toEqual(["#KP101", "#KP104", "#KP102", "#KP103", "#KP105"]);
    expect(a.rows.find((r) => r.orderName === "#KP103")).toMatchObject({ reported: "Entregado", result: "Observación · no recibida · Reportada entregada · incidencia" });
    expect(a.rows.find((r) => r.orderName === "#KP104")?.result).toBe("Recibido · a inventario (anulado)");
    expect(a.rows.find((r) => r.orderName === "#KP105")).toMatchObject({ boxDay: "28/10", result: "Falta" });
  });

  it("la cabecera y los totales: courier, motorizado, Entregó / Recibió, declaró frente a llegaron", () => {
    expect(Object.fromEntries(actaHeaderLines(a))).toMatchObject({ Courier: "Grupo GF", Motorizado: "Alexis", "Llegó el": "04/11", Entregó: "Alexis", Recibió: "Yelitza", Estado: "Cerrado" });
    const totals = Object.fromEntries(actaTotalsLines(a).map(([k, v]) => [k.trim(), v]));
    expect(totals).toMatchObject({ Llegaron: "4", Recibidos: "3", "a inventario (anulados)": "1", "Con observación": "1", Faltan: "1", Declaró: "5", "Diferencia declaró - llegaron": "1" });
    // «Recibidos X de Y esperados» no cambia al cerrar: 2 llegaron + 1 falta + 3 seguían en plazo.
    expect(totals).toMatchObject({ Esperados: "6", "recibidos de lo esperado": "2", "siguen con el motorizado (en plazo)": "3" });
    expect(a.signatures).toEqual(["Entregó", "Recibió"]);
  });

  it("nada del cliente en el acta, aunque la línea lo traiga", () => {
    const text = JSON.stringify(a);
    for (const v of Object.values(PII)) expect(text).not.toContain(v);
  });
});

describe("el acta en PDF (pdf-lib, como lib/labels)", () => {
  it("es un PDF con la tabla, los totales y las firmas, y sin datos del cliente", async () => {
    const bytes = await buildReturnManifestActaPdf(acta());
    expect(Buffer.from(bytes.slice(0, 5)).toString()).toBe("%PDF-");
    const text = pdfText(bytes);
    for (const want of ["#KP101", "KP105-S01", "Falta", "Totales", "Entreg", "Recibi", "Yelitza"]) expect(text).toContain(want);
    for (const v of Object.values(PII)) expect(text).not.toContain(v);
  });

  it("muchas cajas: parte en páginas sin perder filas", async () => {
    const base = acta();
    const many: ReturnManifestActa = { ...base, rows: Array.from({ length: 120 }, (_, i) => ({ ...base.rows[0]!, n: i + 1, orderName: `#KP${1000 + i}` })) };
    const bytes = await buildReturnManifestActaPdf(many);
    const text = pdfText(bytes);
    expect(text).toContain("#KP1000");
    expect(text).toContain("#KP1119");
  });
});

describe("el acta en Excel (exceljs, como lib/exports/urpi-manifest)", () => {
  it("una hoja «Acta» con las columnas del acta, los totales y las firmas; sin datos del cliente", async () => {
    const buf = await buildReturnManifestActaWorkbook(acta());
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buf as unknown as ArrayBuffer);
    const ws = wb.getWorksheet("Acta");
    expect(ws).toBeTruthy();
    const rows: string[][] = [];
    ws!.eachRow((row) => {
      const cells: string[] = [];
      row.eachCell({ includeEmpty: false }, (cell) => cells.push(String(cell.value ?? "")));
      rows.push(cells);
    });
    expect(rows).toContainEqual(["#", "Pedido", "Salida", "Caja del", "Reportado", "Resultado"]);
    expect(rows).toContainEqual(["1", "#KP101", "KP101-S01", "01/11", "No entregado · No contesta", "Recibido · vuelve a por asignar"]);
    expect(rows.flat()).toContain("Entregó");
    expect(rows.flat()).toContain("Recibió");
    const all = rows.flat().join(" | ");
    for (const v of Object.values(PII)) expect(all).not.toContain(v);
  });

  it("el nombre del archivo, sin acentos ni espacios", () => {
    expect(actaFilename(acta(), "xlsx")).toBe("acta-devolucion-alexis-04-11.xlsx");
    expect(actaFilename(acta(), "pdf")).toBe("acta-devolucion-alexis-04-11.pdf");
  });
});

describe("la descarga: autenticada, con el permiso de Almacén y la organización del manifiesto", () => {
  const read = (path: string) => readFileSync(path, "utf8");
  const route = read("app/api/pedidos/devoluciones/manifiestos/[id]/acta/route.ts");
  const access = read("lib/return-manifest-access.ts");

  it("la ruta exige sesión y lee el acta por el cargador que comprueba permiso y organización", () => {
    expect(route).toContain('return NextResponse.json({ error: "No autenticado." }, { status: 401 });');
    expect(route).toContain("const acta = await getReturnManifestActa(id);");
    expect(route).toContain('from "@/lib/exports/return-manifest-acta"');
    expect(route).toContain('"cache-control": "private, no-store"');
    // getReturnManifestActa → getReturnManifestDetail → returnManifestAccess(org_id) con warehouse.prepare.
    expect(access).toContain("const access = await returnManifestAccess(row.org_id);");
    expect(access).toContain("if (!(await hasOrgPermission(orgId, RETURN_MANIFEST_PERMISSION)))");
  });

  it("las líneas se hidratan sin columnas del cliente", () => {
    const select = /from\("shipments"\)\.select\("([^"]+)"\)/g;
    const columns = [...access.matchAll(select)].flatMap((m) => m[1]!.split(","));
    expect(columns.length).toBeGreaterThan(0);
    for (const c of columns) expect(c).not.toMatch(/customer|phone|address|district|reference/);
  });
});

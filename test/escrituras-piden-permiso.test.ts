// Ver un pedido o un envío no es poder tocarlo (MOM §16, 13-10-2026). Cuatro
// puertas escribían con solo pasar RLS —o sea, también para alguien de solo
// lectura—, y «Registrar devolución» pasaba un entregado a devuelto sin la
// facultad de corregir cierres. Lo que se fija aquí: cada escritura de Repro
// Provincia pide `master.edit`, el borrador de Shalom también, y las dos
// puertas al estado de un pedido cerrado preguntan lo mismo. Y desde el
// 15-10-2026, el estado a mano pide además `master.set_status` (owner y admin).

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { closedStatusChangeError } from "@/lib/order-status";

const read = (rel: string) => readFileSync(resolve(process.cwd(), rel), "utf8");

/** Cuerpo de cada `export async function` del archivo, hasta su `}` final. */
function exportedBodies(src: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const match of src.matchAll(/\nexport async function (\w+)\(/g)) {
    const end = src.indexOf("\n}\n", match.index!);
    out.set(match[1]!, src.slice(match.index!, end < 0 ? src.length : end + 2));
  }
  return out;
}

describe("un pedido cerrado solo lo cambia quien corrige cierres", () => {
  it("abierto: cualquier destino, sin motivo", () => {
    expect(closedStatusChangeError("en_proceso", "devuelto", false, "")).toBeNull();
    expect(closedStatusChangeError("pendiente", "entregado", false, "")).toBeNull();
  });

  it("cerrado y al mismo estado: no es un cambio", () => {
    expect(closedStatusChangeError("devuelto", "devuelto", false, "")).toBeNull();
  });

  it("cerrado a otro estado: pide el permiso y después el motivo", () => {
    expect(closedStatusChangeError("entregado", "devuelto", false, "volvió")).toBe(
      "Este pedido ya está entregado; solo quien puede «Corregir pedidos cerrados» lo cambia.",
    );
    expect(closedStatusChangeError("anulado", "en_proceso", true, "  ")).toBe(
      "Describe el motivo del cambio: quedará en el historial.",
    );
    expect(closedStatusChangeError("anulado", "en_proceso", true, "la clienta volvió a confirmar")).toBeNull();
  });

  it("«Cambiar estado» y «Registrar devolución» usan la misma regla", () => {
    const bodies = exportedBodies(read("app/dashboard/pedidos/actions.ts"));
    expect(bodies.get("setOrderStatus")).toContain("closedStatusChangeError(ctx.row.general_status, target,");
    const devolucion = bodies.get("registerReturn")!;
    expect(devolucion).toContain('closedStatusChangeError(ctx.row.general_status, "devuelto",');
    // Antes de escribir el evento, no después.
    expect(devolucion.indexOf("closedStatusChangeError(")).toBeLessThan(devolucion.indexOf('kind: "returned"'));
  });
});

describe("el estado a mano es de owner y admin (MOM §16, 15-10-2026)", () => {
  const src = read("app/dashboard/pedidos/actions.ts");
  const bodies = exportedBodies(src);

  it("«Cambiar estado» pregunta `master.set_status` en la organización del pedido, antes de escribir", () => {
    const body = bodies.get("setOrderStatus")!;
    const gate = body.indexOf("if (!(await canSetStatusIn(ctx))) return { error: SET_STATUS_DENIED };");
    expect(gate).toBeGreaterThan(body.indexOf("await authorizeOrder(orderId)"));
    expect(gate).toBeLessThan(body.indexOf("createAdminSupabase()"));
    expect(gate).toBeLessThan(body.indexOf('kind: "status_override"'));
    // `master.edit` y la regla de pedidos cerrados siguen como estaban.
    expect(body).toContain('perms.can("master.edit")');
    expect(body).toContain('closedStatusChangeError(ctx.row.general_status, target, perms.can("master.override_status"), reason)');
    // Por organización, no la unión de todas las de la persona.
    expect(src).toMatch(/async function canSetStatusIn\(ctx: OrderContext\)[\s\S]*?hasOrgPermission\(orgId, "master\.set_status"\)/);
  });

  it("el lote corta antes de intentar ninguno y pasa por la misma puerta", () => {
    const body = bodies.get("applyOrderStatusBulk")!;
    expect(body).toContain('if (!perms.can("master.set_status")) {');
    expect(body).toContain("await setOrderStatus(orderId, {");
  });

  it("toda acción del Master que escribe un `status_override` pide el permiso, salvo las que son otra cosa", () => {
    // «Registrar devolución» escribe el override de `devuelto` solo con despacho
    // y guía que lo respalden: es la devolución (§13), con su regla de cierres,
    // y se queda en «Gestionar pedidos» por decisión del dueño.
    const OTRA_COSA = new Set(["registerReturn"]);
    const sinPuerta = [...bodies]
      .filter(([name, body]) => !OTRA_COSA.has(name) && body.includes('kind: "status_override"'))
      .filter(([, body]) => !body.includes("canSetStatusIn(ctx)"))
      .map(([name]) => name);
    expect(sinPuerta).toEqual([]);
  });
});

describe("Repro Provincia: escribir pide master.edit", () => {
  const src = read("app/dashboard/envios/actions.ts");
  const bodies = exportedBodies(src);
  const WRITES = /\.(insert|update|upsert|delete)\(|\.rpc\(|discardRecovery\(|syncMasterForShipment\(/;
  // Las que ya piden un permiso más preciso (stock, novedades Swayp).
  const OWN_PERMISSION = /hasOrgPermission\(|orgsWithPermission\(|perms\.can\("/;
  // Soltar la reserva solo suelta la PROPIA (`.eq("claimed_by", userId)`): no
  // se le pone puerta para que un cambio de rol nunca deje una reserva colgada.
  const SIN_PUERTA = new Set(["releaseShipment"]);

  it("la puerta es master.edit", () => {
    expect(src).toMatch(/async function canManageShipments\(\): Promise<boolean> \{\n\s+return \(await getMasterPermissions\(\)\)\.can\("master\.edit"\);/);
  });

  it("toda acción que escribe la pide antes de nada", () => {
    expect(bodies.get("releaseShipment")).toContain('.eq("claimed_by", ctx.userId)');
    const sinPuerta = [...bodies]
      .filter(([name, body]) => !SIN_PUERTA.has(name) && WRITES.test(body) && !OWN_PERMISSION.test(body))
      .filter(([, body]) => {
        const gate = body.indexOf("if (!(await canManageShipments())) return { error: READ_ONLY_SHIPMENTS };");
        const firstRead = body.search(/authorizeShipment\(|createServerSupabase\(|createAdminSupabase\(/);
        return gate < 0 || (firstRead >= 0 && gate > firstRead);
      })
      .map(([name]) => name);
    expect(sinPuerta).toEqual([]);
  });

  it("incluye las cuatro que se encontraron abiertas", () => {
    for (const name of ["registerRecoveryCall", "createDirectFenixGuide", "previewDirectFenixGuide", "claimShipment"]) {
      expect(bodies.get(name), name).toContain("canManageShipments()");
    }
  });
});

describe("borrador de Shalom", () => {
  it("guardar DNI y agencia pide master.edit antes de leer el pedido", () => {
    const body = exportedBodies(read("app/dashboard/pedidos/shalom-actions.ts")).get("saveShalomOrderDraft")!;
    const gate = body.indexOf('perms.can("master.edit")');
    expect(gate).toBeGreaterThan(0);
    expect(gate).toBeLessThan(body.indexOf("await authorize(orderId)"));
  });
});

describe("MOM §16", () => {
  it("documenta que ver no es tocar", () => {
    const mom = read("docs/mom/master-pedidos-v1.md").replace(/\s+/g, " ");
    expect(mom).toContain("**Ver no es tocar (13-10-2026).**");
    expect(mom).toContain("«Tu rol no permite gestionar envíos.»");
    expect(mom).toContain("`closedStatusChangeError`");
  });
});

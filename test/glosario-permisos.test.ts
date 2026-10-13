// Glosario de Equipo (MOM §16, 13-10-2026). El dueño no entendía qué hacía
// cada permiso: «Registrar comprobantes» no decía que era subir el Yape, tres
// se llamaban «liquidaciones» y las explicaciones solo salían al pasar el
// ratón. Lo que se fija aquí: cada permiso tiene nombre, explicación y un área;
// los nombres aprobados no cambian sin querer; y la explicación de por qué una
// persona puede algo no contradice lo que de verdad puede.

import { describe, expect, it } from "vitest";
import {
  ACCESS_HELP,
  ACCESS_LABEL,
  FUNCTIONAL_ROLES,
  GRANTED_ONE_BY_ONE,
  PERMISSIONS,
  PERMISSION_AREAS,
  PERMISSION_HELP,
  PERMISSION_LABEL,
  explainPermissions,
  groupByArea,
  permissionsFor,
  type Permission,
} from "@/lib/permissions";
import { ROLES } from "@/lib/team";

describe("cada permiso tiene nombre, explicación y área", () => {
  it("está en un área y solo en una", () => {
    const seen = PERMISSION_AREAS.flatMap((area) => [...area.permissions]);
    expect([...seen].sort()).toEqual([...PERMISSIONS].sort());
    expect(new Set(seen).size).toBe(seen.length);
  });

  it("nombre único y explicación de una línea que termina en punto", () => {
    const labels = PERMISSIONS.map((permission) => PERMISSION_LABEL[permission]);
    expect(new Set(labels).size).toBe(labels.length);
    for (const permission of PERMISSIONS) {
      const help = PERMISSION_HELP[permission];
      expect(help, permission).toMatch(/\.$/);
      expect(help.length, permission).toBeLessThanOrEqual(130);
      expect(help, permission).not.toContain("\n");
    }
  });

  it("los nombres que aprobó el dueño", () => {
    expect(PERMISSION_LABEL).toMatchObject({
      "master.edit": "Gestionar pedidos",
      "master.override_status": "Corregir pedidos cerrados",
      "shalom.register_payment": "Subir comprobantes",
      "payments.validate": "Validar pagos",
      "shalom.reveal_pickup_key": "Ver la clave de recojo",
      "shalom.view_pickup_key": "Registrar claves de recojo",
      "tanders.review_payment": "Aprobar cobros de Tanders rechazados",
      "closure.finance": "Conciliar el dinero del pedido",
      "closure.finalize": "Cerrar o reabrir pedidos",
      "settlements.manage": "Subir liquidaciones de motorizados",
      "settlements.close": "Cerrar liquidaciones de motorizados",
      "sheets.edit": "Cuadrar hojas de couriers",
      "dispatch.manage": "Despachar",
      "data.export": "Descargar la base de pedidos",
    } satisfies Partial<Record<Permission, string>>);
  });

  it("las casillas de «uno por uno» usan el mismo nombre que el glosario", () => {
    for (const entry of GRANTED_ONE_BY_ONE) expect(entry.label).toBe(PERMISSION_LABEL[entry.permission]);
  });

  it("cada acceso tiene nombre y explicación", () => {
    for (const role of [...ROLES, "motorizado"]) {
      expect(ACCESS_LABEL[role], role).toBeTruthy();
      expect(ACCESS_HELP[role], role).toBeTruthy();
    }
    expect(ACCESS_LABEL.viewer).toBe("Solo lectura");
  });

  it("cada rol dice para quién es", () => {
    for (const entry of FUNCTIONAL_ROLES) expect(entry.description, entry.role).toMatch(/^Para quien /);
  });
});

describe("agrupar por área", () => {
  it("respeta el orden de las áreas y deja fuera las vacías", () => {
    const groups = groupByArea([{ permission: "settlements.close" as Permission }, { permission: "master.edit" as Permission }]);
    expect(groups.map((group) => group.label)).toEqual(["Pedidos", "Liquidaciones"]);
  });
});

describe("de dónde le viene cada permiso a una persona", () => {
  const sources = (result: ReturnType<typeof explainPermissions>, permission: Permission) =>
    result.granted.find((item) => item.permission === permission)?.sources;

  it("una vendedora con roles: cada permiso dice qué rol lo trae, nunca «vendedora»", () => {
    const result = explainPermissions(["vendedora"], [], ["asesora", "despacho"]);
    expect(sources(result, "master.edit")).toEqual([
      { kind: "function", role: "asesora" },
      { kind: "function", role: "despacho" },
    ]);
    expect(sources(result, "orders.create")).toEqual([{ kind: "function", role: "asesora" }]);
    expect(result.granted.every((item) => item.sources.every((source) => source.kind !== "access"))).toBe(true);
  });

  it("lo dado uno por uno se nota, también con el nombre antiguo de validar", () => {
    const result = explainPermissions(["vendedora"], [{ permission: "payments.validate", granted: true }], ["asesora"]);
    expect(sources(result, "payments.validate")).toEqual([{ kind: "grant" }]);
    const legacy = explainPermissions(["vendedora"], [{ permission: "shalom.validate_payment", granted: true }]);
    expect(sources(legacy, "payments.validate")).toEqual([{ kind: "grant" }]);
  });

  it("el dueño: todo por su acceso, y la alerta además dada uno por uno", () => {
    const result = explainPermissions(["owner"], [{ permission: "alerts.repeated_voucher", granted: true }], ["administracion"]);
    expect(sources(result, "closure.refund")).toEqual([{ kind: "access", role: "owner" }]);
    expect(sources(result, "alerts.repeated_voucher")).toEqual([{ kind: "access", role: "owner" }, { kind: "grant" }]);
    expect(sources(result, "team.manage")).toEqual([
      { kind: "access", role: "owner" },
      { kind: "function", role: "administracion" },
    ]);
  });

  it("lo quitado a mano sale aparte y no entre lo que puede", () => {
    const result = explainPermissions(["vendedora"], [{ permission: "closure.return", granted: false }]);
    expect(result.revoked).toEqual(["closure.return"]);
    expect(sources(result, "closure.return")).toBeUndefined();
  });

  it("solo lectura: nada", () => {
    expect(explainPermissions(["viewer"])).toEqual({ granted: [], revoked: [] });
  });

  it("nunca contradice lo que la persona puede hacer", () => {
    const cases: [string[], { permission: string; granted: boolean }[], string[]][] = [
      [["admin"], [], []],
      [["vendedora"], [], []],
      [["vendedora"], [{ permission: "logistics.manage", granted: true }], ["despacho", "liquidaciones", "supervision", "cobranza"]],
      [["owner"], [{ permission: "payments.validate", granted: false }], []],
      [["viewer"], [{ permission: "data.export", granted: true }], []],
    ];
    for (const [roles, grants, functions] of cases) {
      const result = explainPermissions(roles, grants, functions);
      expect(result.granted.map((item) => item.permission)).toEqual(PERMISSIONS.filter((p) => permissionsFor(roles, grants, functions).has(p)));
      for (const item of result.granted) expect(item.sources.length, `${roles}/${item.permission}`).toBeGreaterThan(0);
    }
  });
});

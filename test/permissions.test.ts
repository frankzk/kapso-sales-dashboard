import { describe, expect, it } from "vitest";
import {
  hasPermission,
  isPermission,
  isReadOnly,
  permissionsFor,
  roleLabel,
} from "@/lib/permissions";

describe("permissionsFor", () => {
  it("owner y admin administran el sistema, pero solo owner confirma reembolsos", () => {
    for (const role of ["owner", "admin"]) {
      const p = permissionsFor([role]);
      expect(p.has("master.edit")).toBe(true);
      expect(p.has("shalom.view_pickup_key")).toBe(true);
      expect(p.has("shalom.reveal_pickup_key")).toBe(true);
      expect(p.has("shalom.override_payment_validation")).toBe(true);
      expect(p.has("costs.manage")).toBe(true);
      expect(p.has("closure.finance")).toBe(true);
    }
    expect(permissionsFor(["owner"]).has("closure.refund")).toBe(true);
    expect(permissionsFor(["admin"]).has("closure.refund")).toBe(false);
  });

  it("viewer no tiene NINGÚN permiso de escritura (§16)", () => {
    const p = permissionsFor(["viewer"]);
    expect(p.size).toBe(0);
    expect(isReadOnly(["viewer"])).toBe(true);
  });

  it("vendedora opera pero no valida pagos ni ve la clave", () => {
    const p = permissionsFor(["vendedora"]);
    expect(p.has("master.edit")).toBe(true);
    expect(p.has("shalom.register_payment")).toBe(true);
    expect(p.has("shalom.validate_payment")).toBe(false);
    expect(p.has("shalom.view_pickup_key")).toBe(false);
    expect(p.has("shalom.reveal_pickup_key")).toBe(true);
    expect(p.has("warehouse.prepare")).toBe(true);
    expect(p.has("dispatch.manage")).toBe(true);
    expect(p.has("dispatch.pickup")).toBe(true);
    expect(p.has("closure.return")).toBe(true);
    expect(p.has("closure.inventory")).toBe(true);
    expect(p.has("closure.finance")).toBe(false);
    expect(p.has("closure.refund")).toBe(false);
    expect(isReadOnly(["vendedora"])).toBe(false);
  });

  it("un usuario sin roles no edita nada", () => {
    expect(permissionsFor([]).size).toBe(0);
    expect(isReadOnly([])).toBe(true);
  });

  it("varios roles se acumulan: gana el más permisivo", () => {
    const p = permissionsFor(["viewer", "admin"]);
    expect(p.has("shalom.view_pickup_key")).toBe(true);
  });
});

describe("concesiones explícitas", () => {
  it("una concesión añade un permiso que el rol no da", () => {
    const p = permissionsFor(["vendedora"], [{ permission: "shalom.view_pickup_key" }]);
    expect(p.has("shalom.view_pickup_key")).toBe(true);
  });

  it("una revocación gana sobre el rol", () => {
    const p = permissionsFor(["admin"], [{ permission: "shalom.view_pickup_key", granted: false }]);
    expect(p.has("shalom.view_pickup_key")).toBe(false);
    // El resto de permisos del rol se conservan.
    expect(p.has("master.edit")).toBe(true);
  });

  it("revocar master.edit deja al usuario en solo lectura", () => {
    expect(isReadOnly(["admin"], [{ permission: "master.edit", granted: false }])).toBe(true);
  });

  it("un permiso desconocido se ignora en vez de romper", () => {
    const p = permissionsFor(["viewer"], [{ permission: "no.existe" }]);
    expect(p.size).toBe(0);
    expect(isPermission("no.existe")).toBe(false);
  });
});

describe("hasPermission / roleLabel", () => {
  it("hasPermission respeta rol y concesiones", () => {
    expect(hasPermission(["viewer"], "master.edit")).toBe(false);
    expect(hasPermission(["viewer"], "master.edit", [{ permission: "master.edit" }])).toBe(true);
  });

  it("roleLabel describe el rol dominante", () => {
    expect(roleLabel(["owner"])).toBe("Administrador");
    expect(roleLabel(["admin", "viewer"])).toBe("Administrador");
    expect(roleLabel(["vendedora"])).toBe("Vendedora");
    expect(roleLabel(["viewer"])).toBe("Solo lectura");
    expect(roleLabel([])).toBe("Equipo");
  });
});

describe("permisos de Aliclik", () => {
  it("owner y admin pueden crear, cancelar y gestionar el catálogo", () => {
    for (const role of ["owner", "admin"]) {
      const perms = permissionsFor([role]);
      expect(perms.has("aliclik.create_guide")).toBe(true);
      expect(perms.has("aliclik.cancel_guide")).toBe(true);
      expect(perms.has("aliclik.manage_catalog")).toBe(true);
    }
  });

  it("vendedora crea guías pero NO cancela ni toca el catálogo", () => {
    const perms = permissionsFor(["vendedora"]);
    // Crear guías es su trabajo.
    expect(perms.has("aliclik.create_guide")).toBe(true);
    // Cancelar tiene ventana y el catálogo es dato maestro compartido.
    expect(perms.has("aliclik.cancel_guide")).toBe(false);
    expect(perms.has("aliclik.manage_catalog")).toBe(false);
  });

  it("viewer no crea guías", () => {
    expect(permissionsFor(["viewer"]).has("aliclik.create_guide")).toBe(false);
  });

  it("se le puede revocar a una vendedora concreta sin tocar su rol", () => {
    const perms = permissionsFor(["vendedora"], [
      { permission: "aliclik.create_guide", granted: false },
    ]);
    expect(perms.has("aliclik.create_guide")).toBe(false);
    expect(perms.has("master.edit")).toBe(true);
  });
});

describe("riders.manage (registro de motorizados)", () => {
  it("lo tienen owner y admin, no vendedora/motorizado/viewer", () => {
    expect(permissionsFor(["owner"]).has("riders.manage")).toBe(true);
    expect(permissionsFor(["admin"]).has("riders.manage")).toBe(true);
    expect(permissionsFor(["vendedora"]).has("riders.manage")).toBe(false);
    expect(permissionsFor(["motorizado"]).has("riders.manage")).toBe(false);
    expect(permissionsFor(["viewer"]).has("riders.manage")).toBe(false);
  });
  it("es un permiso válido del catálogo", () => {
    expect(isPermission("riders.manage")).toBe(true);
  });
});

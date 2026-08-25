import { describe, expect, it } from "vitest";
import {
  GRANTED_ONE_BY_ONE,
  PERMISSIONS,
  hasPermission,
  isGrantedOneByOne,
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
      // Los dos permisos financieros van juntos y siguen la misma regla: el
      // owner los conserva por continuidad, el admin los recibe persona por
      // persona desde Equipo. Corregir un pago —moverlo a otro pedido o forzar
      // su estado— es de la misma familia que darlo por bueno, y venía incluido
      // en el rol `admin`, que son catorce personas.
      expect(p.has("shalom.override_payment_validation")).toBe(role === "owner");
      expect(p.has("payments.validate")).toBe(role === "owner");
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
    expect(p.has("payments.validate")).toBe(false);
    expect(p.has("shalom.view_pickup_key")).toBe(false);
    expect(p.has("shalom.reveal_pickup_key")).toBe(true);
    expect(p.has("warehouse.prepare")).toBe(true);
    expect(p.has("dispatch.manage")).toBe(true);
    expect(p.has("dispatch.pickup")).toBe(true);
    // Recuperar una devolución es gestión de venta: la misma persona que
    // llamaría a esa clienta es la que manda el mensaje.
    expect(p.has("recovery.contact")).toBe(true);
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

describe("los permisos de concesión individual salen de UNA lista", () => {
  // POR QUÉ. `payments.validate` ya se concedía persona por persona, pero la
  // regla vivía en un comentario y en tres `.in([...])` escritos a mano: la
  // consulta de Equipo, la de sus acciones y el `upsert`. Con esa forma de
  // hacerlo, `shalom.override_payment_validation` se quedó dentro del rol
  // `admin` —catorce personas— sin que nadie lo hubiera decidido.
  it("ninguno viene con el rol admin", () => {
    for (const entry of GRANTED_ONE_BY_ONE) {
      expect(permissionsFor(["admin"]).has(entry.permission), entry.permission).toBe(false);
    }
  });

  it("y el owner los conserva todos, por continuidad", () => {
    for (const entry of GRANTED_ONE_BY_ONE) {
      expect(permissionsFor(["owner"]).has(entry.permission), entry.permission).toBe(true);
    }
  });

  it("una concesión individual los da a quien sea", () => {
    for (const entry of GRANTED_ONE_BY_ONE) {
      expect(
        permissionsFor(["admin"], [{ permission: entry.permission, granted: true }]).has(
          entry.permission,
        ),
        entry.permission,
      ).toBe(true);
    }
  });

  it("corregir pagos es uno de ellos", () => {
    // La razón de todo el cambio: mover dinero de un pedido a otro es de la
    // misma familia que darlo por bueno.
    expect(GRANTED_ONE_BY_ONE.map((g) => g.permission)).toContain(
      "shalom.override_payment_validation",
    );
    expect(isGrantedOneByOne("shalom.override_payment_validation")).toBe(true);
    expect(isGrantedOneByOne("master.edit")).toBe(false);
  });

  it("todos son permisos que existen de verdad", () => {
    // Un nombre mal escrito acá dibujaría una casilla en Equipo que no concede
    // nada, y nadie lo notaría hasta que alguien no pudiera hacer su trabajo.
    for (const entry of GRANTED_ONE_BY_ONE) {
      expect(PERMISSIONS, entry.permission).toContain(entry.permission);
    }
  });
});

describe("concesiones explícitas", () => {
  it("una concesión añade un permiso que el rol no da", () => {
    const p = permissionsFor(["vendedora"], [{ permission: "shalom.view_pickup_key" }]);
    expect(p.has("shalom.view_pickup_key")).toBe(true);
  });

  it("solo el owner la conserva por continuidad; el resto exige concesión individual", () => {
    expect(permissionsFor(["owner"]).has("payments.validate")).toBe(true);
    expect(permissionsFor(["admin"]).has("payments.validate")).toBe(false);
    expect(
      permissionsFor(["vendedora"], [{ permission: "payments.validate", granted: true }]).has(
        "payments.validate",
      ),
    ).toBe(true);
    expect(
      permissionsFor(["owner"], [{ permission: "payments.validate", granted: false }]).has(
        "payments.validate",
      ),
    ).toBe(false);
  });

  it("conserva una concesión histórica hasta que exista el permiso nuevo", () => {
    expect(
      permissionsFor(["vendedora"], [
        { permission: "shalom.validate_payment", granted: true },
      ]).has("payments.validate"),
    ).toBe(true);
    expect(
      permissionsFor(["vendedora"], [
        { permission: "shalom.validate_payment", granted: true },
        { permission: "payments.validate", granted: false },
      ]).has("payments.validate"),
    ).toBe(false);
  });

  it("una revocación histórica de Shalom no oculta la nueva bandeja al owner", () => {
    expect(
      permissionsFor(["owner"], [
        { permission: "shalom.validate_payment", granted: false },
      ]).has("payments.validate"),
    ).toBe(true);
    expect(
      permissionsFor(["owner"], [
        { permission: "shalom.validate_payment", granted: false },
        { permission: "payments.validate", granted: false },
      ]).has("payments.validate"),
    ).toBe(false);
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

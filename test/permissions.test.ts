import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  FUNCTIONAL_ROLES,
  GRANTED_ONE_BY_ONE,
  PERMISSIONS,
  PERMISSION_AREAS,
  PERMISSION_HELP,
  PERMISSION_LABEL,
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
  it("ninguno viene con el rol admin, salvo los marcados `withAdminRole`", () => {
    for (const entry of GRANTED_ONE_BY_ONE) {
      const withAdmin = "withAdminRole" in entry && entry.withAdminRole === true;
      expect(permissionsFor(["admin"]).has(entry.permission), entry.permission).toBe(withAdmin);
    }
    // Hoy las excepciones son exportar y anular pedidos de WooCommerce (que
    // owner y admin ya tenían): los financieros siguen fuera del rol.
    expect(
      GRANTED_ONE_BY_ONE.filter((e) => "withAdminRole" in e && e.withAdminRole).map((e) => e.permission),
    ).toEqual(["data.export", "orders.cancel_woo"]);
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

  it("la vendedora resuelve novedades de Swayp: es gestión de venta", () => {
    const perms = permissionsFor(["vendedora"]);
    expect(perms.has("swayp.solve_novelty")).toBe(true);
    // Devolver al remitente exige ADEMÁS closure.return, que también tiene: la
    // prueba fija que hoy nadie pierde capacidad por haber separado los dos.
    expect(perms.has("closure.return")).toBe(true);
  });

  it("viewer no resuelve novedades", () => {
    expect(permissionsFor(["viewer"]).has("swayp.solve_novelty")).toBe(false);
  });

  it("quitarle closure.return a alguien también le cierra la devolución por novedad", () => {
    // El motivo de haber reutilizado closure.return en vez de inventar un
    // permiso nuevo: revocarlo cierra TODAS las puertas a la devolución, no
    // solo la del expediente.
    const perms = permissionsFor(["vendedora"], [{ permission: "closure.return", granted: false }]);
    expect(perms.has("closure.return")).toBe(false);
    // Y sigue pudiendo reintentar o reprogramar, que no cierran nada.
    expect(perms.has("swayp.solve_novelty")).toBe(true);
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

describe("logistics.manage (Grupo GF Courier)", () => {
  it("es individual para Daysi y no viene incluido en admin o vendedora", () => {
    expect(permissionsFor(["owner"]).has("logistics.manage")).toBe(true);
    expect(permissionsFor(["admin"]).has("logistics.manage")).toBe(false);
    expect(permissionsFor(["vendedora"]).has("logistics.manage")).toBe(false);
    expect(permissionsFor(["vendedora"], [{ permission: "logistics.manage", granted: true }]).has("logistics.manage")).toBe(true);
  });

  it("aparece entre los permisos concedibles desde Equipo", () => {
    expect(GRANTED_ONE_BY_ONE.some((entry) => entry.permission === "logistics.manage")).toBe(true);
  });
});

// Exportar el Master, los pedidos o el resumen diario (08-10-2026): una
// descarga es la base de clientes entera. Owner y admin la traen; una
// vendedora solo con la casilla de Equipo.
describe("data.export", () => {
  it("la traen owner y admin, no la vendedora ni el viewer", () => {
    expect(permissionsFor(["owner"]).has("data.export")).toBe(true);
    expect(permissionsFor(["admin"]).has("data.export")).toBe(true);
    expect(permissionsFor(["vendedora"]).has("data.export")).toBe(false);
    expect(permissionsFor(["viewer"]).has("data.export")).toBe(false);
  });

  it("a una vendedora de confianza se le concede en Equipo", () => {
    expect(permissionsFor(["vendedora"], [{ permission: "data.export", granted: true }]).has("data.export")).toBe(true);
    expect(GRANTED_ONE_BY_ONE.some((e) => e.permission === "data.export")).toBe(true);
  });

  it("y a un admin se le puede quitar", () => {
    expect(permissionsFor(["admin"], [{ permission: "data.export", granted: false }]).has("data.export")).toBe(false);
  });
});

// Comprobantes electrónicos por RUC (MOM §35.7, 14-10-2026). Configurar un RUC,
// darle cuentas o registrar una boleta hecha a mano decide qué empresa paga el
// impuesto de qué venta, y una boleta enviada a SUNAT no se borra: es dinero,
// lo da solo el dueño y ningún rol lo trae salvo el suyo.
describe("invoices.manage (Boletas y facturas)", () => {
  const entry = GRANTED_ONE_BY_ONE.find((g) => g.permission === "invoices.manage");

  it("se da uno por uno, solo el dueño, y el rol admin no lo trae", () => {
    expect(isPermission("invoices.manage")).toBe(true);
    expect(isGrantedOneByOne("invoices.manage")).toBe(true);
    expect(entry).toBeDefined();
    expect(entry!.ownerOnly).toBe(true);
    const withAdminRole = GRANTED_ONE_BY_ONE.filter((g) => "withAdminRole" in g && g.withAdminRole).map((g) => g.permission);
    expect(withAdminRole).not.toContain("invoices.manage");
    // Sin nadie con el permiso, nadie podría apagar un RUC que sigue emitiendo.
    expect(entry!.lastOneMatters).toBe(true);
  });

  it("lo tiene el owner; admin, vendedora, viewer y motorizado no", () => {
    expect(permissionsFor(["owner"]).has("invoices.manage")).toBe(true);
    for (const role of ["admin", "vendedora", "viewer", "motorizado"]) {
      expect(permissionsFor([role]).has("invoices.manage"), role).toBe(false);
    }
  });

  it("ningún rol por función lo trae, ni todos juntos", () => {
    for (const fn of FUNCTIONAL_ROLES) {
      expect((fn.permissions as readonly string[]).includes("invoices.manage"), fn.role).toBe(false);
    }
    const all = FUNCTIONAL_ROLES.map((fn) => fn.role);
    expect(permissionsFor(["vendedora"], [], all).has("invoices.manage")).toBe(false);
    expect(permissionsFor(["admin"], [], all).has("invoices.manage")).toBe(false);
  });

  it("se concede a una persona y se le puede quitar al owner", () => {
    expect(permissionsFor(["admin"], [{ permission: "invoices.manage", granted: true }]).has("invoices.manage")).toBe(true);
    expect(permissionsFor(["owner"], [{ permission: "invoices.manage", granted: false }]).has("invoices.manage")).toBe(false);
  });

  it("tiene nombre, explicación y área en Equipo", () => {
    expect(PERMISSION_LABEL["invoices.manage"]).toBe("Boletas y facturas");
    expect(entry!.label).toBe("Boletas y facturas");
    const help = PERMISSION_HELP["invoices.manage"];
    expect(help).toMatch(/SimpleFact/);
    expect(help).toMatch(/\.$/);
    expect(help.length).toBeLessThanOrEqual(130);
    expect(entry!.description).toBe(help);
    const areas = PERMISSION_AREAS.filter((area) => (area.permissions as readonly string[]).includes("invoices.manage"));
    expect(areas.map((area) => area.key)).toEqual(["pagos"]);
  });

  it("el MOM dice lo mismo que el código", () => {
    const mom = readFileSync(resolve(process.cwd(), "docs/mom/master-pedidos-v1.md"), "utf8").replace(/\s+/g, " ");
    expect(mom).toContain("**`invoices.manage` («Boletas y facturas»)**");
    expect(mom).toContain("**solo el owner lo da** (§16, `ownerOnly`)");
  });
});

// «Solo quienes tienen acceso de Admin pueden realizar esa acción» (decisión
// del dueño, 15-10-2026, MOM §16): cambiar a mano el estado de un pedido. Iba
// dentro de «Gestionar pedidos», que tienen la vendedora y los siete roles.
describe("master.set_status (Registrar estado a mano)", () => {
  it("lo tienen owner y admin por su acceso", () => {
    expect(isPermission("master.set_status")).toBe(true);
    expect(permissionsFor(["owner"]).has("master.set_status")).toBe(true);
    expect(permissionsFor(["admin"]).has("master.set_status")).toBe(true);
  });

  it("vendedora, solo lectura y motorizado no, aunque la vendedora gestione pedidos", () => {
    for (const role of ["vendedora", "viewer", "motorizado"]) {
      expect(permissionsFor([role]).has("master.set_status"), role).toBe(false);
    }
    expect(permissionsFor(["vendedora"]).has("master.edit")).toBe(true);
  });

  it("ningún rol por función lo trae: ni solo, ni todos juntos, ni Supervisión que corrige cierres", () => {
    for (const fn of FUNCTIONAL_ROLES) {
      expect((fn.permissions as readonly string[]).includes("master.set_status"), fn.role).toBe(false);
      const alone = permissionsFor(["vendedora"], [], [fn.role]);
      expect(alone.has("master.edit"), fn.role).toBe(true);
      expect(alone.has("master.set_status"), fn.role).toBe(false);
    }
    const all = FUNCTIONAL_ROLES.map((fn) => fn.role);
    expect(permissionsFor(["vendedora"], [], all).has("master.set_status")).toBe(false);
    expect(permissionsFor(["viewer"], [], all).has("master.set_status")).toBe(false);
    const supervision = permissionsFor(["vendedora"], [], ["supervision"]);
    expect(supervision.has("master.override_status")).toBe(true);
    expect(supervision.has("master.set_status")).toBe(false);
  });

  it("va con el acceso, no se concede uno por uno", () => {
    expect(isGrantedOneByOne("master.set_status")).toBe(false);
    expect(GRANTED_ONE_BY_ONE.map((g) => g.permission)).not.toContain("master.set_status");
  });

  it("una revocación puntual se lo quita a un admin, como cualquier permiso", () => {
    expect(permissionsFor(["admin"], [{ permission: "master.set_status", granted: false }]).has("master.set_status")).toBe(false);
  });

  it("tiene nombre, explicación y área en Equipo", () => {
    expect(PERMISSION_LABEL["master.set_status"]).toBe("Registrar estado a mano");
    const help = PERMISSION_HELP["master.set_status"];
    expect(help).toContain("«Gestión manual»");
    expect(help).toContain("Solo dueño y admin.");
    expect(help.length).toBeLessThanOrEqual(130);
    const areas = PERMISSION_AREAS.filter((area) => (area.permissions as readonly string[]).includes("master.set_status"));
    expect(areas.map((area) => area.key)).toEqual(["pedidos"]);
    // «Gestionar pedidos» ya no promete cambiar el estado.
    expect(PERMISSION_HELP["master.edit"]).not.toMatch(/estado/);
  });
});

// Roles que se acumulan (MOM §16, 12-10-2026, migración 0250). Una persona
// tiene un acceso (`memberships.role`) y, encima, varios roles por función cuyos
// permisos se suman. Lo que se fija aquí: cómo se suman, qué no puede traer
// ningún rol, que la base y el código digan lo mismo, y que no vuelva a
// aparecer un «¿es owner o admin?» escrito a mano.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  FUNCTIONAL_ROLES,
  GRANTED_ONE_BY_ONE,
  PERMISSIONS,
  PERMISSION_LABEL,
  isFunctionalRole,
  permissionsFor,
  type Permission,
} from "@/lib/permissions";
import { canSetFunctionRole, type MemberLite } from "@/lib/team";
import { navItems } from "@/components/sidebar";

const bundle = (role: string) => FUNCTIONAL_ROLES.find((entry) => entry.role === role)!.permissions as readonly Permission[];

describe("cómo se suman", () => {
  it("una vendedora con roles recibe SOLO lo de sus roles", () => {
    const almacen = permissionsFor(["vendedora"], [], ["almacen"]);
    expect([...almacen].sort()).toEqual([...bundle("almacen")].sort());
    // Lo que la vendedora traía y Almacén no usa, se va.
    expect(almacen.has("orders.create")).toBe(false);
    expect(almacen.has("recovery.contact")).toBe(false);
  });

  it("dos roles suman los dos", () => {
    const p = permissionsFor(["vendedora"], [], ["asesora", "liquidaciones"]);
    for (const perm of [...bundle("asesora"), ...bundle("liquidaciones")]) expect(p.has(perm)).toBe(true);
    expect(p.has("dispatch.manage")).toBe(false);
  });

  it("sin roles, la vendedora es la de siempre", () => {
    expect(permissionsFor(["vendedora"], [], [])).toEqual(permissionsFor(["vendedora"]));
  });

  it("owner y admin no cambian: ya lo tienen todo, y además los permisos nuevos", () => {
    for (const role of ["owner", "admin"]) {
      const p = permissionsFor([role]);
      for (const perm of ["team.manage", "stores.manage", "stock.manage", "reports.view"] as const) expect(p.has(perm)).toBe(true);
      expect(permissionsFor([role], [], ["almacen"])).toEqual(p);
    }
    const vendedora = permissionsFor(["vendedora"]);
    for (const perm of ["team.manage", "stores.manage", "stock.manage", "reports.view"] as const) expect(vendedora.has(perm)).toBe(false);
  });

  it("una revocación puntual sigue ganando sobre el rol", () => {
    const p = permissionsFor(["vendedora"], [{ permission: "settlements.close", granted: false }], ["liquidaciones"]);
    expect(p.has("settlements.close")).toBe(false);
    expect(p.has("settlements.manage")).toBe(true);
  });

  it("un rol desconocido no da nada", () => {
    expect(permissionsFor(["viewer"], [], ["superadmin"]).size).toBe(0);
    expect(isFunctionalRole("superadmin")).toBe(false);
  });
});

describe("lo que ningún rol puede traer", () => {
  it("los permisos de dinero o datos que da el dueño uno por uno, ni reembolsos", () => {
    const forbidden = new Set<string>([
      ...GRANTED_ONE_BY_ONE.filter((entry) => entry.ownerOnly).map((entry) => entry.permission),
      "closure.refund",
      "shalom.validate_payment",
    ]);
    for (const entry of FUNCTIONAL_ROLES) {
      for (const perm of entry.permissions) expect(forbidden.has(perm), `${entry.role} trae ${perm}`).toBe(false);
    }
  });

  it("cada permiso tiene su nombre en Equipo, sin repetir", () => {
    const labels = PERMISSIONS.map((p) => PERMISSION_LABEL[p]);
    expect(labels.every(Boolean)).toBe(true);
    expect(new Set(labels).size).toBe(labels.length);
  });
});

describe("la base y el código dicen lo mismo", () => {
  const sql = readFileSync(resolve(process.cwd(), "db/migrations/0250_membership_roles.sql"), "utf8");

  it("los roles que acepta la tabla son los de FUNCTIONAL_ROLES", () => {
    const check = /role in \(([^)]+)\)/.exec(sql)![1]!;
    const inSql = [...check.matchAll(/'(\w+)'/g)].map((m) => m[1]).sort();
    expect(inSql).toEqual(FUNCTIONAL_ROLES.map((entry) => entry.role).sort());
  });

  it("rider_pay_allowed da cada permiso a los mismos roles que el código", () => {
    const pairs = [...sql.matchAll(/p_permission = '([\w.]+)' and r\.role = '(\w+)'/g)].map((m) => [m[1]!, m[2]!]);
    for (const perm of ["routes.manage", "settlements.close", "costs.manage"] as const) {
      const inSql = pairs.filter(([p]) => p === perm).map(([, role]) => role).sort();
      const inTs = FUNCTIONAL_ROLES.filter((entry) => (entry.permissions as readonly string[]).includes(perm)).map((entry) => entry.role).sort();
      expect(inSql, perm).toEqual(inTs);
    }
  });
});

describe("quién asigna roles", () => {
  const members: MemberLite[] = [
    { user_id: "o1", role: "owner" },
    { user_id: "a1", role: "admin" },
    { user_id: "s1", role: "vendedora" },
  ];
  it("solo el dueño", () => {
    expect(canSetFunctionRole(members, "s1", "almacen", "owner")).toEqual({ ok: true });
    expect(canSetFunctionRole(members, "s1", "almacen", "admin")).toEqual({ ok: false, reason: "Solo el dueño asigna roles." });
    expect(canSetFunctionRole(members, "ghost", "almacen", "owner").ok).toBe(false);
    expect(canSetFunctionRole(members, "s1", "superadmin", "owner")).toEqual({ ok: false, reason: "Rol inválido." });
  });
});

describe("el menú", () => {
  const hrefs = (items: { href: string }[]) => items.map((item) => item.href);

  it("owner y admin ven lo de siempre", () => {
    expect(hrefs(navItems(false, true, true))).toEqual([
      "/dashboard",
      "/dashboard/leads",
      "/dashboard/pedidos",
      "/dashboard/pagos",
      "/dashboard/envios",
      "/dashboard/envios/recuperacion",
      "/dashboard/envios/aliclik",
      "/dashboard/leads/anuncios",
      "/dashboard/productividad",
      "/dashboard/stores",
      "/dashboard/costos",
      "/dashboard/courier",
      "/dashboard/urpi",
      "/dashboard/olva",
      "/dashboard/team",
      "/dashboard/stores/new",
    ]);
  });

  it("Supervisión entra al panel completo y ve solo lo suyo", () => {
    const items = navItems(false, false, false, { reports: true, catalog: false, mapAds: false, stores: false, costs: false, team: false });
    expect(hrefs(items)).toEqual([
      "/dashboard",
      "/dashboard/leads",
      "/dashboard/pedidos",
      "/dashboard/envios",
      "/dashboard/envios/recuperacion",
      "/dashboard/productividad",
    ]);
    expect(items.find((item) => item.href === "/dashboard/productividad")!.label).toBe("Productividad");
  });

  it("la vendedora sin roles, igual que antes", () => {
    expect(hrefs(navItems(true, false, false))).toEqual([
      "/dashboard/leads",
      "/dashboard/pedidos",
      "/dashboard/envios",
      "/dashboard/envios/recuperacion",
      "/dashboard/productividad",
    ]);
  });
});

describe("ningún «¿es owner o admin?» escrito a mano", () => {
  // Solo quedan donde el rol de acceso ES la regla: las guardas de Equipo
  // (quién reparte poder, lib/team.ts y su pantalla), la entrada a Equipo, la
  // etiqueta del panel y la vista del motorizado.
  const allowed = new Set([
    "lib/team.ts",
    "lib/permissions.ts",
    "components/team.tsx",
    "app/dashboard/team/actions.ts",
    "app/dashboard/layout.tsx",
  ]);
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (/\.(ts|tsx)$/.test(name)) files.push(path);
    }
  };
  for (const dir of ["app", "lib", "components"]) walk(resolve(process.cwd(), dir));

  it("fuera de esos sitios, se pide un permiso", () => {
    const offenders = files
      .map((path) => path.slice(process.cwd().length + 1))
      .filter((rel) => !allowed.has(rel))
      .filter((rel) => /(===|!==)\s*"admin"|\["owner",\s*"admin"\]/.test(readFileSync(resolve(process.cwd(), rel), "utf8")));
    expect(offenders).toEqual([]);
  });
});

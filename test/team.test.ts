import { describe, it, expect } from "vitest";
import {
  ownerCount,
  canRemoveMember,
  canSetRole,
  canAddMember,
  canSetPaymentValidator,
  invitableRoles,
  type MemberLite,
} from "@/lib/team";
import { GRANTED_ONE_BY_ONE } from "@/lib/permissions";

const members: MemberLite[] = [
  { user_id: "o1", role: "owner" },
  { user_id: "o2", role: "owner" },
  { user_id: "a1", role: "admin" },
  { user_id: "a2", role: "admin" },
  { user_id: "v1", role: "viewer" },
  { user_id: "s1", role: "vendedora" },
];
const soleOwner: MemberLite[] = [
  { user_id: "o1", role: "owner" },
  { user_id: "v1", role: "viewer" },
];

describe("team guards", () => {
  it("counts owners", () => {
    expect(ownerCount(members)).toBe(2);
    expect(ownerCount(soleOwner)).toBe(1);
  });

  describe("canRemoveMember", () => {
    it("blocks removing the last owner", () => {
      expect(canRemoveMember(soleOwner, "o1", "owner").ok).toBe(false);
    });
    it("allows removing an owner when others remain", () => {
      expect(canRemoveMember(members, "o1", "owner").ok).toBe(true);
    });
    it("admins cannot remove owners", () => {
      expect(canRemoveMember(members, "o1", "admin").ok).toBe(false);
    });
    it("admins can remove viewers and vendedoras", () => {
      expect(canRemoveMember(members, "v1", "admin").ok).toBe(true);
      expect(canRemoveMember(members, "s1", "admin").ok).toBe(true);
    });
    it("only the owner removes an admin (MOM §16, 12-10-2026)", () => {
      expect(canRemoveMember(members, "a2", "admin")).toEqual({ ok: false, reason: "Solo el dueño puede quitar a un admin." });
      expect(canRemoveMember(members, "a2", "owner").ok).toBe(true);
    });
    it("rejects non-members", () => {
      expect(canRemoveMember(members, "ghost", "owner").ok).toBe(false);
    });
  });

  describe("canSetRole", () => {
    it("blocks demoting the last owner", () => {
      expect(canSetRole(soleOwner, "o1", "admin", "owner").ok).toBe(false);
    });
    it("allows demoting an owner when others remain", () => {
      expect(canSetRole(members, "o1", "admin", "owner").ok).toBe(true);
    });
    it("only owners may grant the owner role", () => {
      expect(canSetRole(members, "v1", "owner", "admin").ok).toBe(false);
      expect(canSetRole(members, "v1", "owner", "owner").ok).toBe(true);
    });
    it("only owners may modify an existing owner", () => {
      expect(canSetRole(members, "o1", "viewer", "admin").ok).toBe(false);
    });
    it("solo el dueño cambia roles: un admin ya no asciende ni baja a nadie (12-10-2026)", () => {
      expect(canSetRole(members, "v1", "admin", "admin")).toEqual({ ok: false, reason: "Solo el dueño cambia roles." });
      expect(canSetRole(members, "s1", "viewer", "admin").ok).toBe(false);
      expect(canSetRole(members, "a2", "vendedora", "admin").ok).toBe(false);
      expect(canSetRole(members, "v1", "admin", "owner").ok).toBe(true);
    });
    it("dejar el mismo rol no es un cambio", () => {
      expect(canSetRole(members, "s1", "vendedora", "admin").ok).toBe(true);
    });
    it("rejects invalid roles", () => {
      expect(canSetRole(members, "v1", "superuser", "owner").ok).toBe(false);
    });
  });

  describe("canAddMember", () => {
    it("admins cannot add an owner", () => {
      expect(canAddMember("owner", "admin").ok).toBe(false);
    });
    it("owners can add any role; admins only viewer and vendedora", () => {
      expect(canAddMember("owner", "owner").ok).toBe(true);
      expect(canAddMember("admin", "owner").ok).toBe(true);
      expect(canAddMember("viewer", "admin").ok).toBe(true);
      expect(canAddMember("vendedora", "admin").ok).toBe(true);
      // Invitar un admin es repartir poder: solo el dueño (12-10-2026).
      expect(canAddMember("admin", "admin")).toEqual({ ok: false, reason: "Solo el dueño puede invitar a alguien como admin." });
    });
    it("el desplegable de invitar muestra solo lo que se puede elegir", () => {
      expect(invitableRoles("owner")).toEqual(["owner", "admin", "viewer", "vendedora"]);
      expect(invitableRoles("admin")).toEqual(["viewer", "vendedora"]);
    });
  });

  describe("canSetPaymentValidator", () => {
    it("permite autorizar a cualquier miembro", () => {
      expect(canSetPaymentValidator(members, "v1", true, "admin", ["a1"])).toEqual({ ok: true });
    });
    it("impide dejar la organización sin validador", () => {
      const result = canSetPaymentValidator(members, "a1", false, "admin", ["a1"]);
      expect(result.ok).toBe(false);
      expect(result.reason).toContain("al menos una");
    });
    it("permite retirar un validador cuando queda otro", () => {
      expect(canSetPaymentValidator(members, "a1", false, "admin", ["a1", "o1"]).ok).toBe(true);
    });
    it("un admin no modifica el permiso de un owner", () => {
      expect(canSetPaymentValidator(members, "o1", true, "admin", ["a1"]).ok).toBe(false);
      expect(canSetPaymentValidator(members, "o1", true, "owner", ["a1"]).ok).toBe(true);
    });
    it("dinero y datos: solo el dueño los da o los quita, también a sí mismo (12-10-2026)", () => {
      // El caso real: una admin se concedió «Corregir pagos».
      expect(canSetPaymentValidator(members, "a1", true, "admin", [], null, "Corregir pagos")).toEqual({
        ok: false,
        reason: "Solo el dueño puede dar o quitar «Corregir pagos».",
      });
      // Y tampoco se lo da a otra persona, ni se lo quita.
      expect(canSetPaymentValidator(members, "s1", true, "admin", ["a1"], "validar pagos", "Validar pagos").ok).toBe(false);
      expect(canSetPaymentValidator(members, "a2", false, "admin", ["a1", "a2"], "validar pagos", "Validar pagos").ok).toBe(false);
      expect(canSetPaymentValidator(members, "s1", true, "owner", ["a1"], "validar pagos", "Validar pagos").ok).toBe(true);
    });
    it("lo operativo lo sigue concediendo un admin", () => {
      expect(canSetPaymentValidator(members, "s1", true, "admin", [], null, null).ok).toBe(true);
    });
  });

  describe("qué permiso es solo del dueño", () => {
    it("los de dinero y datos sí; reportar entregas no", () => {
      const ownerOnly = GRANTED_ONE_BY_ONE.filter((entry) => entry.ownerOnly).map((entry) => entry.permission);
      expect(ownerOnly.sort()).toEqual(
        [
          "alerts.repeated_voucher",
          "data.export",
          "invoices.manage",
          "logistics.manage",
          "payments.validate",
          "shalom.override_payment_validation",
        ].sort(),
      );
      expect(GRANTED_ONE_BY_ONE.find((entry) => entry.permission === "routes.report_others")!.ownerOnly).toBe(false);
    });
    it("«Boletas y facturas» (MOM §35.7): un admin no lo da ni se lo da; el dueño sí", () => {
      const entry = GRANTED_ONE_BY_ONE.find((g) => g.permission === "invoices.manage")!;
      // Lo que la acción de Equipo le pasa al guardia (`entry.ownerOnly ? entry.label : null`).
      const ownerOnlyLabel = entry.ownerOnly ? entry.label : null;
      const lastLabel = entry.lastOneMatters ? entry.label : null;
      expect(canSetPaymentValidator(members, "a1", true, "admin", ["o1"], lastLabel, ownerOnlyLabel)).toEqual({
        ok: false,
        reason: "Solo el dueño puede dar o quitar «Boletas y facturas».",
      });
      expect(canSetPaymentValidator(members, "s1", true, "admin", ["o1"], lastLabel, ownerOnlyLabel).ok).toBe(false);
      expect(canSetPaymentValidator(members, "s1", true, "owner", ["o1"], lastLabel, ownerOnlyLabel).ok).toBe(true);
      // Sin nadie, el barrido sigue emitiendo y nadie puede apagar un RUC.
      expect(canSetPaymentValidator(members, "o1", false, "owner", ["o1"], lastLabel, ownerOnlyLabel)).toEqual({
        ok: false,
        reason: "Debe quedar al menos una persona autorizada para boletas y facturas.",
      });
      expect(canSetPaymentValidator(members, "o1", false, "owner", ["o1", "s1"], lastLabel, ownerOnlyLabel).ok).toBe(true);
    });
    it("la acción de Equipo pasa la marca al guardia", async () => {
      const { readFileSync } = await import("node:fs");
      const actions = readFileSync("app/dashboard/team/actions.ts", "utf8");
      expect(actions).toContain("entry.ownerOnly ? entry.label : null");
    });
  });
});

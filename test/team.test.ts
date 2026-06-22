import { describe, it, expect } from "vitest";
import {
  ownerCount,
  canRemoveMember,
  canSetRole,
  canAddMember,
  type MemberLite,
} from "@/lib/team";

const members: MemberLite[] = [
  { user_id: "o1", role: "owner" },
  { user_id: "o2", role: "owner" },
  { user_id: "a1", role: "admin" },
  { user_id: "v1", role: "viewer" },
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
    it("admins can remove viewers", () => {
      expect(canRemoveMember(members, "v1", "admin").ok).toBe(true);
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
    it("admins can promote a viewer to admin", () => {
      expect(canSetRole(members, "v1", "admin", "admin").ok).toBe(true);
    });
    it("rejects invalid roles", () => {
      expect(canSetRole(members, "v1", "superuser", "owner").ok).toBe(false);
    });
  });

  describe("canAddMember", () => {
    it("admins cannot add an owner", () => {
      expect(canAddMember("owner", "admin").ok).toBe(false);
    });
    it("owners can add any role; admins can add viewer/admin", () => {
      expect(canAddMember("owner", "owner").ok).toBe(true);
      expect(canAddMember("viewer", "admin").ok).toBe(true);
      expect(canAddMember("admin", "admin").ok).toBe(true);
    });
  });
});

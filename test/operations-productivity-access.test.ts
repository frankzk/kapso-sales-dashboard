import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
const m = vi.hoisted(() => ({
  stores: vi.fn(),
  user: vi.fn(),
  permission: vi.fn(),
  rpc: vi.fn(),
  names: vi.fn(),
  roster: vi.fn(),
  member: vi.fn(),
}));
vi.mock("@/lib/access", () => ({
  getAccessibleStores: m.stores,
  getCurrentUser: m.user,
}));
vi.mock("@/lib/permissions-access", () => ({ hasOrgPermission: m.permission }));
vi.mock("@/lib/db", () => ({
  createAdminSupabase: () => ({ rpc: m.rpc }),
  createServerSupabase: async () => ({
    from: () => ({
      select: () => ({ eq: () => ({ eq: () => ({ maybeSingle: m.member }) }) }),
    }),
  }),
}));
vi.mock("@/lib/agent-names", () => ({ resolveAgentNames: m.names }));
vi.mock("@/lib/advisor-schedules", () => ({ getOrgVendedoraIds: m.roster }));
vi.mock("@/lib/productivity", () => ({
  localRangeBoundsIso: () => ({
    startIso: "2026-11-12T05:00:00.000Z",
    endIso: "2026-11-13T04:59:59.999Z",
  }),
}));
import { getOperationsProductivity } from "@/lib/operations-productivity-access";
const input = {
  range: { from: "2026-11-12", to: "2026-11-12" },
  section: "resumen" as const,
  store: null,
  tz: "America/Lima",
};
const data = () => ({
  people: [],
  totals: {
    actions: 0,
    orders: 0,
    leads: 0,
    people: 0,
    unclassifiedContacts: 0,
  },
  asOf: "2026-11-12T15:00Z",
});
beforeEach(() => {
  vi.clearAllMocks();
  m.stores.mockResolvedValue([
    { id: "s1", org_id: "o1" },
    { id: "s2", org_id: "o2" },
  ]);
  m.user.mockResolvedValue({ id: "verified-user" });
  m.permission.mockResolvedValue(true);
  m.rpc.mockImplementation(async () => ({ data: data() }));
  m.names.mockResolvedValue({
    "verified-user": "asesora",
    idle: "sin-actividad",
  });
  m.roster.mockResolvedValue(["idle"]);
  m.member.mockResolvedValue({ data: { role: "vendedora" } });
});
describe("operations report authorization", () => {
  it("derives accessible stores and shows idle staff only to report managers", async () => {
    const result = await getOperationsProductivity(input);
    expect(result.solo).toBe(false);
    expect(result.data.people[0]?.name).toBe("sin-actividad");
    expect(m.rpc).toHaveBeenCalledWith(
      "operations_productivity",
      expect.objectContaining({ p_stores: ["s1", "s2"], p_actor: null }),
    );
  });
  it("keeps an advisor limited to herself on every tab and does not read the team roster", async () => {
    m.permission.mockResolvedValue(false);
    const result = await getOperationsProductivity({
      ...input,
      section: "diferencia",
    });
    expect(result.solo).toBe(true);
    expect(m.rpc).toHaveBeenCalledWith(
      "operations_productivity",
      expect.objectContaining({
        p_actor: "verified-user",
        p_section: "diferencia",
      }),
    );
    expect(m.roster).not.toHaveBeenCalled();
    expect(result.data.people.map((p) => p.userId)).toEqual(["verified-user"]);
  });
  it("does not use a report role in one organization to expose another organization", async () => {
    m.permission.mockImplementation(async (org: string) => org === "o1");
    await getOperationsProductivity(input);
    expect(m.rpc.mock.calls[0]?.[1].p_actor).toBe("verified-user");
  });
  it("rejects an inaccessible store before making a privileged read", async () => {
    await expect(
      getOperationsProductivity({ ...input, store: "foreign" }),
    ).rejects.toThrow("acceso");
    expect(m.rpc).not.toHaveBeenCalled();
  });
  it("filters a selected accessible store server-side", async () => {
    await getOperationsProductivity({ ...input, store: "s2" });
    expect(m.rpc.mock.calls[0]?.[1].p_stores).toEqual(["s2"]);
    expect(m.permission).toHaveBeenCalledTimes(1);
  });
  it("requires a verified session and fails closed on database errors", async () => {
    m.user.mockResolvedValue(null);
    await expect(getOperationsProductivity(input)).rejects.toThrow("sesión");
    expect(m.rpc).not.toHaveBeenCalled();
    m.user.mockResolvedValue({ id: "verified-user" });
    m.rpc.mockResolvedValue({ error: { message: "private database details" } });
    await expect(getOperationsProductivity(input)).rejects.toThrow(
      "No se pudo leer",
    );
  });
});

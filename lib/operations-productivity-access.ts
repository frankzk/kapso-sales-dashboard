import "server-only";
import { getAccessibleStores, getCurrentUser, type DateRange } from "./access";
import { hasOrgPermission } from "./permissions-access";
import { createAdminSupabase, createServerSupabase } from "./db";
import { resolveAgentNames } from "./agent-names";
import { localRangeBoundsIso } from "./productivity";
import type {
  OperationsData,
  ProductivitySection,
} from "./operations-productivity";
import { getOrgVendedoraIds } from "./advisor-schedules";

/** All scope and identity are derived here. No browser-supplied actor/store list.
 * A report manager in one org never gains team visibility in a second org. */
export async function getOperationsProductivity(input: {
  range: DateRange;
  section: ProductivitySection;
  store: string | null;
  tz: string;
}) {
  const [stores, user] = await Promise.all([
    getAccessibleStores(),
    getCurrentUser(),
  ]);
  if (!user) throw new Error("Tu sesión terminó. Vuelve a ingresar.");
  const scoped = input.store
    ? stores.filter((s) => s.id === input.store)
    : stores;
  if (!scoped.length) throw new Error("No tienes acceso a estas tiendas.");
  const sb = await createServerSupabase();
  const orgs = [...new Set(scoped.map((s) => s.org_id))];
  const checks = await Promise.all(
    orgs.map(async (org) => {
      if (await hasOrgPermission(org, "reports.view")) return true;
      // Read-only membership keeps its existing report visibility.
      const membership = await sb
        .from("memberships")
        .select("role")
        .eq("org_id", org)
        .eq("user_id", user.id)
        .maybeSingle();
      return !membership.error && membership.data?.role === "viewer";
    }),
  );
  const solo = !checks.every(Boolean);
  const admin = createAdminSupabase();
  const bounds = localRangeBoundsIso(
    input.range.from,
    input.range.to,
    input.tz,
  );
  const { data, error } = await admin.rpc("operations_productivity", {
    p_stores: scoped.map((s) => s.id),
    p_start: bounds.startIso,
    p_end: bounds.endIso,
    p_section: input.section,
    p_actor: solo ? user.id : null,
    p_tz: input.tz,
  });
  if (error || !data)
    throw new Error(
      "No se pudo leer la actividad operativa. Intenta nuevamente.",
    );
  const board = data as OperationsData;
  let roster = [user.id];
  if (!solo) {
    const [legacy, functional] = await Promise.all([
      getOrgVendedoraIds(admin, orgs),
      admin.from("membership_roles").select("user_id").in("org_id", orgs),
    ]);
    if (functional.error)
      throw new Error("No se pudo leer el equipo de estas tiendas.");
    // An advisor may have admin access plus the Asesora functional role.
    // Do not lose her zero-activity row merely because she is not vendedora.
    roster = [
      ...new Set([
        ...legacy,
        ...(functional.data ?? []).map((row) => row.user_id as string),
      ]),
    ];
  }
  const seen = new Set(board.people.map((p) => p.userId));
  for (const id of roster)
    if (!seen.has(id))
      board.people.push({
        userId: id,
        name: "",
        actions: 0,
        objects: 0,
        orders: 0,
        leads: 0,
        hours: 0,
        lastAt: "",
        unclassifiedContacts: 0,
        counts: {},
        areas: {},
        heat: {},
        recent: [],
      });
  const names = await resolveAgentNames(
    board.people.map((p) => p.userId),
    admin,
  );
  return {
    solo,
    data: {
      ...board,
      people: board.people.map((p) => ({
        ...p,
        name: names[p.userId] ?? "Usuario",
        recent: p.recent ?? [],
      })),
    },
  };
}

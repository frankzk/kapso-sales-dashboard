import { createServerSupabase } from "@/lib/db";
import { getCurrentUser } from "@/lib/access";
import { getMasterPermissions, hasOrgPermission } from "@/lib/permissions-access";

/** RLS limits visibility; explicit ownership prevents an admin's deliver role
 * from becoming permission to report for every rider. The grant is org-scoped. */
export async function routeReportAccess(routeId: string) {
  const user = await getCurrentUser();
  if (!user) return null;
  const sb = await createServerSupabase();
  const { data: route } = await sb.from("delivery_routes")
    .select("id,org_id,rider_id,status").eq("id", routeId).maybeSingle();
  if (!route || route.status !== "en_curso") return null;
  const { data: rider } = await sb.from("riders")
    .select("id,user_id,full_name").eq("id", route.rider_id).maybeSingle();
  if (!rider) return null;
  const own = rider.user_id === user.id;
  const allowed = own
    ? (await getMasterPermissions()).can("routes.deliver")
    : await hasOrgPermission(route.org_id, "routes.report_others");
  if (!allowed) return null;
  return { userId: user.id, actorLabel: user.email ?? user.id, delegated: !own, riderName: String(rider.full_name), routeId: route.id };
}

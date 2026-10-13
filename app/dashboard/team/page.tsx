import { redirect } from "next/navigation";
import { createServerSupabase, createAdminSupabase } from "@/lib/db";
import { EmptyState } from "@/components/ui";
import { TeamManager, type TeamMember, type RiderRow } from "@/components/team";
import type { Role } from "@/lib/types";
import { GRANTED_ONE_BY_ONE, PERMISSIONS, PERMISSION_LABEL, permissionsFor } from "@/lib/permissions";
import { hasOrgPermission } from "@/lib/permissions-access";
import { getAdvisorSchedules } from "@/lib/advisor-schedules";

export const dynamic = "force-dynamic";

export default async function TeamPage({
  searchParams,
}: {
  searchParams: Promise<{ org?: string; tab?: string; user?: string }>;
}) {
  const sp = await searchParams;
  const sb = await createServerSupabase();
  const {
    data: { user },
  } = await sb.auth.getUser();

  // Organizations where the current user is owner/admin (can manage the team).
  // Scope to the current user's own memberships: RLS lets an owner/admin read
  // every membership row in their org, so without this filter each org would
  // repeat once per admin. Dedupe by org id as a further guard against duplicate
  // membership rows.
  const { data: memberships } = await sb
    .from("memberships")
    .select("org_id, role, organizations(name)")
    .eq("user_id", user?.id ?? "");
  // Donde la persona gestiona el equipo: owner/admin, o «Administración» (MOM §16).
  const manages = await Promise.all(
    (memberships ?? []).map((m: any) => hasOrgPermission(m.org_id as string, "team.manage")),
  );
  const adminOrgs = Array.from(
    new Map(
      (memberships ?? [])
        .filter((_: any, i: number) => manages[i])
        .map((m: any) => [
          m.org_id as string,
          { id: m.org_id as string, name: (m.organizations?.name as string) ?? m.org_id, role: m.role as Role },
        ]),
    ).values(),
  );

  if (!adminOrgs.length) {
    // Sin equipo que gestionar: la vendedora vuelve a su pantalla, como antes.
    if ((memberships ?? []).every((m: any) => m.role === "vendedora")) redirect("/dashboard/leads");
    return (
      <EmptyState title="No administras ninguna organización">
        Pide a un owner/admin que te dé el rol correspondiente, o crea una organización al conectar
        una tienda.
      </EmptyState>
    );
  }

  const selected = adminOrgs.find((o) => o.id === sp.org) ?? adminOrgs[0]!;
  const admin = createAdminSupabase();

  const [{ data: memberRows }, { data: storeRows }, { data: riderRows }, { data: permissionRows }, schedules] = await Promise.all([
    admin.from("memberships").select("user_id, role").eq("org_id", selected.id),
    admin.from("stores").select("id, name").eq("org_id", selected.id).order("name"),
    admin
      .from("riders")
      .select("id, store_id, courier, full_name, doc_number, phone, active, note, user_id")
      .eq("org_id", selected.id)
      .order("active", { ascending: false })
      .order("full_name"),
    // Todas las concesiones, no solo las de casilla: con ellas se arma la lista
    // de permisos efectivos de cada persona.
    admin.from("user_permissions").select("user_id, permission, granted").eq("org_id", selected.id),
    getAdvisorSchedules(admin, [selected.id]),
  ]);
  // Roles acumulables (0250). Sin la tabla todavía, ninguno.
  const { data: functionRows } = await admin.from("membership_roles").select("user_id, role").eq("org_id", selected.id);
  const functionsByUser = new Map<string, string[]>();
  for (const row of (functionRows as { user_id: string; role: string }[] | null) ?? []) {
    functionsByUser.set(row.user_id, [...(functionsByUser.get(row.user_id) ?? []), row.role]);
  }

  const stores = (storeRows as { id: string; name: string }[]) ?? [];
  const storeIds = stores.map((s) => s.id);

  const { data: accessRows } = storeIds.length
    ? await admin.from("user_store_access").select("user_id, store_id").in("store_id", storeIds)
    : { data: [] as { user_id: string; store_id: string }[] };

  // Resolve emails for the member ids via the auth admin API.
  const emailById = new Map<string, string>();
  for (let page = 1; page <= 20; page++) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 200 });
    if (error || !data) break;
    for (const u of data.users) emailById.set(u.id, u.email ?? u.id);
    if (data.users.length < 200) break;
  }

  const accessByUser = new Map<string, string[]>();
  for (const a of (accessRows as { user_id: string; store_id: string }[]) ?? []) {
    const arr = accessByUser.get(a.user_id) ?? [];
    arr.push(a.store_id);
    accessByUser.set(a.user_id, arr);
  }

  const paymentPermissionByUser = new Map<string, { permission: string; granted: boolean }[]>();
  for (const row of
    (permissionRows as { user_id: string; permission: string; granted: boolean }[]) ?? []) {
    const current = paymentPermissionByUser.get(row.user_id) ?? [];
    current.push({ permission: row.permission, granted: row.granted });
    paymentPermissionByUser.set(row.user_id, current);
  }

  const members: TeamMember[] = ((memberRows as { user_id: string; role: Role }[]) ?? [])
    .map((m) => {
      const functions = functionsByUser.get(m.user_id) ?? [];
      const effective = permissionsFor([m.role], paymentPermissionByUser.get(m.user_id) ?? [], functions);
      return {
        user_id: m.user_id,
        email: emailById.get(m.user_id) ?? m.user_id,
        role: m.role,
        stores: accessByUser.get(m.user_id) ?? [],
        functions,
        // En el orden de la lista de permisos, con el nombre que se lee en Equipo.
        effective: PERMISSIONS.filter((p) => effective.has(p)).map((p) => PERMISSION_LABEL[p]),
        // Un mapa y no un booleano por permiso: cada vez que se añada uno a
        // GRANTED_ONE_BY_ONE aparece solo, sin tocar el tipo ni esta consulta.
        grants: Object.fromEntries(GRANTED_ONE_BY_ONE.map((entry) => [entry.permission, effective.has(entry.permission)])),
      };
    })
    .sort((a, b) => a.email.localeCompare(b.email));

  const riders: RiderRow[] = (
    (riderRows as Omit<RiderRow, "user_email">[]) ?? []
  ).map((r) => ({
    ...r,
    user_email: r.user_id ? (emailById.get(r.user_id) ?? r.user_id) : null,
  }));

  return (
    <TeamManager
      org={{ id: selected.id, name: selected.name }}
      orgs={adminOrgs.map((o) => ({ id: o.id, name: o.name }))}
      myRole={selected.role}
      currentUserId={user?.id ?? ""}
      stores={stores}
      members={members}
      riders={riders}
      schedules={Object.fromEntries(schedules)}
      initialTab={sp.tab === "horarios" || sp.tab === "motorizados" ? sp.tab : "usuarios"}
      initialScheduleUserId={sp.tab === "horarios" ? (sp.user ?? null) : null}
    />
  );
}

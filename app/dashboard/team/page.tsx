import { redirect } from "next/navigation";
import { createServerSupabase, createAdminSupabase } from "@/lib/db";
import { getUserRoleSummary } from "@/lib/access";
import { EmptyState } from "@/components/ui";
import { TeamManager, type TeamMember, type RiderRow } from "@/components/team";
import type { Role } from "@/lib/types";

export const dynamic = "force-dynamic";

export default async function TeamPage({
  searchParams,
}: {
  searchParams: Promise<{ org?: string }>;
}) {
  if ((await getUserRoleSummary()).isVendedoraOnly) redirect("/dashboard/leads");
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
  const adminOrgs = Array.from(
    new Map(
      (memberships ?? [])
        .filter((m: any) => m.role === "owner" || m.role === "admin")
        .map((m: any) => [
          m.org_id as string,
          { id: m.org_id as string, name: (m.organizations?.name as string) ?? m.org_id, role: m.role as Role },
        ]),
    ).values(),
  );

  if (!adminOrgs.length) {
    return (
      <EmptyState title="No administras ninguna organización">
        Pide a un owner/admin que te dé el rol correspondiente, o crea una organización al conectar
        una tienda.
      </EmptyState>
    );
  }

  const selected = adminOrgs.find((o) => o.id === sp.org) ?? adminOrgs[0]!;
  const admin = createAdminSupabase();

  const [{ data: memberRows }, { data: storeRows }, { data: riderRows }] = await Promise.all([
    admin.from("memberships").select("user_id, role").eq("org_id", selected.id),
    admin.from("stores").select("id, name").eq("org_id", selected.id).order("name"),
    admin
      .from("riders")
      .select("id, store_id, courier, full_name, doc_number, phone, active, note, user_id")
      .eq("org_id", selected.id)
      .order("active", { ascending: false })
      .order("full_name"),
  ]);

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

  const members: TeamMember[] = ((memberRows as { user_id: string; role: Role }[]) ?? [])
    .map((m) => ({
      user_id: m.user_id,
      email: emailById.get(m.user_id) ?? m.user_id,
      role: m.role,
      stores: accessByUser.get(m.user_id) ?? [],
    }))
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
    />
  );
}

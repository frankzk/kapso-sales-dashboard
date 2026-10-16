import { redirect } from "next/navigation";
import { getAccessibleStores, getCurrentUser, getUserRoleSummary } from "@/lib/access";
import { signOut } from "./actions";
import { DashboardShell } from "@/components/dashboard-shell";
import { OrderDrawerHost } from "@/components/order-drawer-host";
import { canValidatePaymentsAnywhere } from "@/lib/payment-review-access";
import { getMasterPermissions } from "@/lib/permissions-access";
import { createAdminSupabase } from "@/lib/db";
import { countOlvaCotejoPending } from "@/lib/olva/cotejo-pending";

export const dynamic = "force-dynamic";

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const [{ isVendedoraOnly, isRiderOnly, roles }, user, canValidatePayments, permissions, stores] = await Promise.all([
    getUserRoleSummary(),
    getCurrentUser(),
    canValidatePaymentsAnywhere(),
    getMasterPermissions(),
    getAccessibleStores(),
  ]);
  // El motorizado entra al panel por costumbre o por un enlace viejo: se le
  // manda a su ruta en vez de enseñarle un panel al que RLS le vaciaría entero.
  // Solo motorizado: su módulo es /reparto, la ruta del día con el vocabulario
  // de su cuaderno (MOM §29.12, §30.9). El panel no es suyo.
  if (isRiderOnly) redirect("/reparto");
  const canManageLogistics =
    permissions.can("logistics.manage") ||
    permissions.can("routes.manage") ||
    permissions.can("dispatch.manage") ||
    permissions.can("dispatch.pickup");
  // «Repro Lima» es de quien llama a los clientes o despacha
  // (`repro_lima.manage`, MOM §9.5). La página y cada acción lo vuelven a pedir.
  const canReproLima = permissions.can("repro_lima.manage");
  // Lo que espera a una persona en «Cotejar Olva» (MOM §12). Un fallo aquí no
  // puede tumbar el panel entero: sin número, el menú sigue funcionando.
  const olvaPending = canManageLogistics
    ? await countOlvaCotejoPending(createAdminSupabase(), [...new Set(stores.map((s) => s.org_id))]).catch(() => 0)
    : 0;
  // El menú por permisos (MOM §16): owner y admin los tienen todos. Quien solo
  // mira (viewer) conserva el Consolidado que siempre vio.
  const viewerOnly = roles.length > 0 && roles.every((r) => r === "viewer");
  const navAccess = {
    reports: permissions.can("reports.view") || viewerOnly,
    catalog: permissions.can("aliclik.manage_catalog"),
    mapAds: permissions.can("leads.map_ads"),
    stores: permissions.can("stores.manage"),
    costs: permissions.can("costs.manage"),
    team: permissions.can("team.manage"),
  };
  const roleLabel = isVendedoraOnly
    ? "Vendedora"
    : roles.includes("owner") || roles.includes("admin")
      ? "Administrador"
      : "Equipo";

  return (
    <DashboardShell
      isVendedoraOnly={isVendedoraOnly}
      signOut={signOut}
      userEmail={user?.email ?? null}
      roleLabel={roleLabel}
      yapeAlertsEnabled={roles.includes("vendedora")}
      canValidatePayments={canValidatePayments}
      canManageLogistics={canManageLogistics}
      canReproLima={canReproLima}
      navAccess={navAccess}
      badges={olvaPending > 0 ? { "/dashboard/olva": olvaPending } : undefined}
    >
      {children}
      {/* La ficha del pedido para todo el panel (MOM §25): se abre con
          `?ficha=<pedido>` desde despacho, rutas, courier, pagos o
          Liquidaciones 2, con los MISMOS permisos que en el Master
          (app/dashboard/pedidos/page.tsx). En el Master no actúa. */}
      <OrderDrawerHost
        stores={stores.map((s) => ({ id: s.id, name: s.name, shopify_domain: s.shopify_domain ?? null }))}
        canEdit={!permissions.readOnly}
        canOverride={permissions.can("master.override_status")}
        canCreateGuide={permissions.can("aliclik.create_guide")}
        canCreateTandersGuide={permissions.can("tanders.create_guide")}
        canCreateShalomGuide={permissions.can("shalom.create_guide")}
        closurePermissions={{
          canReturn: permissions.can("closure.return"),
          canInventory: permissions.can("closure.inventory"),
          canFinance: permissions.can("closure.finance"),
          canFinalize: permissions.can("closure.finalize"),
          canRefund: permissions.can("closure.refund"),
          canReopen: permissions.can("master.override_status") && permissions.can("closure.finalize"),
          canManageCosts: permissions.can("costs.manage"),
        }}
      />
    </DashboardShell>
  );
}

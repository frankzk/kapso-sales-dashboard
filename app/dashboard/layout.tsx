import { redirect } from "next/navigation";
import { getAccessibleStores, getCurrentUser, getUserRoleSummary } from "@/lib/access";
import { signOut } from "./actions";
import { DashboardShell } from "@/components/dashboard-shell";
import { OrderDrawerHost } from "@/components/order-drawer-host";
import { canValidatePaymentsAnywhere } from "@/lib/payment-review-access";
import { getMasterPermissions } from "@/lib/permissions-access";

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
      canManageLogistics={permissions.can("logistics.manage") || permissions.can("routes.manage") || permissions.can("dispatch.manage") || permissions.can("dispatch.pickup")}
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
        }}
      />
    </DashboardShell>
  );
}

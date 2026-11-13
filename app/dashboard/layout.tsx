import { redirect } from "next/navigation";
import { getAccessibleStores, getCurrentUser, getUserRoleSummary } from "@/lib/access";
import { signOut } from "./actions";
import { DashboardShell } from "@/components/dashboard-shell";
import { OrderDrawerHost } from "@/components/order-drawer-host";
import { AnuraPhoneProvider } from "@/components/anura-phone";
import { canValidatePaymentsAnywhere } from "@/lib/payment-review-access";
import { getMasterPermissions } from "@/lib/permissions-access";
import { createAdminSupabase } from "@/lib/db";
import { countOlvaCotejoPending } from "@/lib/olva/cotejo-pending";
import { countPorRetornar } from "@/lib/pago-diferencia-access";

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
  // Despacho entra a ver «Reintentos Aliclik» (`repro_lima.retries`, 03-11-2026).
  const canReproLima = permissions.can("repro_lima.manage") || permissions.can("repro_lima.retries");
  // Lo que espera a una persona en «Cotejar Olva» (MOM §12), que vive en «Pago
  // de diferencia» (MOM §44) y la ve todo el que ve pedidos: el número va en
  // esa entrada del menú. Un fallo aquí no puede tumbar el panel entero: sin
  // número, el menú sigue funcionando.
  // Y los urgentes por llamar, «Por retornar» (owner, 13-11-2026: «que te
  // lance los urgentes por llamar cuando se acercan al plazo»): la agencia
  // está por devolverlos. El número del menú suma los dos.
  const [olvaPending, porRetornarCount] = stores.length
    ? await Promise.all([
        countOlvaCotejoPending(createAdminSupabase(), [...new Set(stores.map((s) => s.org_id))]).catch(() => 0),
        countPorRetornar(createAdminSupabase(), stores.map((s) => s.id)).catch(() => 0),
      ])
    : [0, 0];
  const pagoDiferenciaBadge = olvaPending + porRetornarCount;
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
    history: permissions.can("data.export"),
    automations: permissions.can("automations.manage"),
  };
  const roleLabel = isVendedoraOnly
    ? "Vendedora"
    : roles.includes("owner") || roles.includes("admin")
      ? "Administrador"
      : "Equipo";

  // El teléfono de Kapta de «Llamar con Anura» (MOM §8.7) vive AQUÍ, una vez
  // por pestaña, y no en la ficha: cerrar la ficha o cambiar de pantalla no
  // corta la llamada. Lo usan la ficha del pedido (Master y ficha global) y la
  // «Llamada de prueba» de Ajustes, que están todas bajo este layout.
  return (
    <AnuraPhoneProvider>
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
        badges={pagoDiferenciaBadge > 0 ? { "/dashboard/pedidos/pago-diferencia": pagoDiferenciaBadge } : undefined}
      >
        {children}
        {/* La ficha del pedido para todo el panel (MOM §25): se abre con
            `?ficha=<pedido>` desde despacho, rutas, courier, pagos o
            Liquidaciones 2, con los MISMOS permisos que en el Master
            (app/dashboard/pedidos/page.tsx). En el Master no actúa. */}
        <OrderDrawerHost
          stores={stores.map((s) => ({
            id: s.id,
            name: s.name,
            shopify_domain: s.shopify_domain ?? null,
            woo_site_url: s.woo_site_url ?? null,
          }))}
          canEdit={!permissions.readOnly}
          canOverride={permissions.can("master.override_status")}
          canSetStatus={permissions.can("master.set_status")}
          canCancelWoo={permissions.can("orders.cancel_woo")}
          canEditCustomerName={permissions.can("orders.create")}
          canCreateGuide={permissions.can("aliclik.create_guide")}
          canCreateTandersGuide={permissions.can("tanders.create_guide")}
          canCreateShalomGuide={permissions.can("shalom.create_guide")}
          // La pestaña «Repro Lima» de la ficha: quien llama a los clientes de
          // Lima (MOM §9.5). «Reintentos Aliclik» solo (`repro_lima.retries`) no atiende.
          canAttendReproLima={permissions.can("repro_lima.manage")}
          closurePermissions={{
            canReturn: permissions.can("closure.return"),
            canInventory: permissions.can("closure.inventory"),
            canFinance: permissions.can("closure.finance"),
            canFinalize: permissions.can("closure.finalize"),
            canRefund: permissions.can("closure.refund"),
            canReopen: permissions.can("master.override_status") && permissions.can("closure.finalize"),
            canManageCosts: permissions.can("costs.manage"),
            canManageLogistics: permissions.can("logistics.manage"),
          }}
        />
      </DashboardShell>
    </AnuraPhoneProvider>
  );
}

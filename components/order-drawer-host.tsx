"use client";

// La ficha del pedido, montada una sola vez para todo el panel (MOM §25).
//
// Vive en app/dashboard/layout.tsx y mira la URL: cuando hay `?ficha=<pedido>`
// abre `OrderDrawer` encima de la pantalla que sea —despacho, rutas, courier,
// validación de pagos, Liquidaciones 2— con los mismos permisos que en el
// Master. En el Master de Pedidos no hace nada: esa pantalla sigue abriendo su
// propia ficha con `?abrir=`, y montar dos sería enseñar dos paneles iguales.
//
// Cerrar reemplaza la URL (no apila historial) y conserva el resto de la
// query, así la persona vuelve exactamente a donde estaba. Las acciones de la
// ficha recargan su detalle y refrescan la pantalla de atrás con
// `router.refresh()`, para que la cola o la hoja reflejen lo que se hizo.

import { Suspense, useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { OrderDrawer } from "@/components/order-drawer";
import {
  closeOrderDrawerHref,
  masterOrderHref,
  orderDrawerHref,
  readOrderDrawerRequest,
  workspaceForDrawerSection,
} from "@/lib/order-drawer-href";
import {
  clearReproLimaAdvance,
  REPRO_ADVANCE_CONFIRM_MS,
  REPRO_ADVANCE_REFRESH_MS,
  reproAdvancePin,
  reproLimaAdvance,
  reproLimaRefreshOwed,
  reproLimaRefreshPaid,
  subscribeReproLimaAdvance,
} from "@/lib/repro-lima-queue";
import { reportClientPerformanceMetric } from "@/lib/client-performance";

export interface OrderDrawerHostStore {
  id: string;
  name: string;
  shopify_domain: string | null;
  /** `stores.woo_site_url`: el enlace de un pedido de WooCommerce (MOM §38.12). */
  woo_site_url?: string | null;
}

export interface OrderDrawerHostProps {
  stores: OrderDrawerHostStore[];
  canEdit: boolean;
  canOverride: boolean;
  /** «Registrar estado» a mano (`master.set_status`): owner y admin, MOM §16. */
  canSetStatus: boolean;
  /** «Anular pedido» de WooCommerce (`orders.cancel_woo`, MOM §38.15). */
  canCancelWoo: boolean;
  canEditCustomerName?: boolean;
  canCreateGuide: boolean;
  canCreateTandersGuide: boolean;
  canCreateShalomGuide: boolean;
  /** GF Courier en la Mesa de ruta (MOM §29.17). */
  canCreateGfGuide?: boolean;
  canCancelGfGuide?: boolean;
  /** «Atender» de Repro Lima en la ficha (`repro_lima.manage`, MOM §9.5): la pestaña «Repro Lima». */
  canAttendReproLima?: boolean;
  closurePermissions: {
    canReturn: boolean;
    canInventory: boolean;
    canFinance: boolean;
    canFinalize: boolean;
    canRefund: boolean;
    canReopen: boolean;
    canManageCosts: boolean;
    canManageLogistics: boolean;
  };
}

export function OrderDrawerHost(props: OrderDrawerHostProps) {
  // `useSearchParams` exige un límite de Suspense por si alguna ruta se
  // prerrenderiza; la ficha no tiene nada que enseñar mientras tanto.
  return (
    <Suspense fallback={null}>
      <OrderDrawerHostInner {...props} />
    </Suspense>
  );
}

function OrderDrawerHostInner({ stores, ...permissions }: OrderDrawerHostProps) {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const router = useRouter();
  const search = searchParams.toString();
  const request = readOrderDrawerRequest({ pathname, search });

  // Se cierra con `replaceState` y no con `router.replace`: cambiar la query
  // con el router vuelve a pedir la página al servidor. Next sincroniza
  // `useSearchParams` con la History API, así que la ficha desaparece igual.
  const close = useCallback(() => {
    // Cerrar es decidir otra cosa: la guarda del paso al siguiente se suelta.
    clearReproLimaAdvance();
    window.history.replaceState(null, "", closeOrderDrawerHref({ pathname, search }));
  }, [pathname, search]);

  // «GUARDAR Y PASAR AL SIGUIENTE» SE QUEDA EN EL SIGUIENTE (25-11-2026, la
  // usuaria principal: «aún se queda en el mismo pedido», con video). Si después
  // de pasar la URL vuelve al pedido recién guardado (el navegador termina de
  // aplicar lo del guardado y la repone), la ficha sigue enseñando el siguiente
  // y la URL se corrige en el acto. Antes se reabría el guardado, en «Operar».
  const advance = useSyncExternalStore(subscribeReproLimaAdvance, reproLimaAdvance, () => null);
  const pinnedTo = reproAdvancePin(advance, request?.orderId, Date.now());
  useEffect(() => {
    if (!pinnedTo) return;
    // Si la barra ya dice el siguiente, es solo que `useSearchParams` todavía no
    // se enteró del cambio: no hay nada que corregir ni que contar.
    const bar = readOrderDrawerRequest({ pathname: window.location.pathname, search: window.location.search });
    if (bar?.orderId === pinnedTo) return;
    reportClientPerformanceMetric("repro:next-reverted", 0);
    window.history.replaceState(null, "", orderDrawerHref(pinnedTo, "reprolima", { pathname, search }));
  }, [pinnedTo, pathname, search]);
  // Ir atrás, o abrir otro pedido, también es decidir otra cosa.
  useEffect(() => {
    const onPop = () => clearReproLimaAdvance();
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);
  const shownOrderId = request?.orderId ?? null;
  useEffect(() => {
    if (advance && shownOrderId && shownOrderId !== advance.from && shownOrderId !== advance.to) clearReproLimaAdvance();
  }, [advance, shownOrderId]);

  // QUE EL NAVEGADOR APRENDA LA URL DEL SIGUIENTE. El cambio de URL ocurre con
  // el guardado todavía aplicándose y el router de Next no se la queda; con el
  // guardado ya asentado se le repite, y entonces sí (`REPRO_ADVANCE_CONFIRM_MS`).
  useEffect(() => {
    if (!advance || shownOrderId !== advance.to) return;
    const to = advance.to;
    const timer = window.setTimeout(() => {
      const now = readOrderDrawerRequest({ pathname: window.location.pathname, search: window.location.search });
      if (now?.orderId !== to) return;
      window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}`);
    }, Math.max(0, advance.at + REPRO_ADVANCE_CONFIRM_MS - Date.now()));
    return () => window.clearTimeout(timer);
  }, [advance, shownOrderId]);

  // LA LISTA, DE FONDO. Al pasar al siguiente el guardado no trae la pantalla
  // (`deferRefresh`): se pide una vez, un momento después, con la ficha
  // siguiente ya abierta. Pedirla en el mismo instante que el cambio de URL
  // hace que el navegador recargue la página entera.
  const refreshOwedAt = useSyncExternalStore(subscribeReproLimaAdvance, reproLimaRefreshOwed, () => null);
  useEffect(() => {
    if (refreshOwedAt === null) return;
    const timer = window.setTimeout(() => {
      reproLimaRefreshPaid();
      router.refresh();
    }, Math.max(0, refreshOwedAt + REPRO_ADVANCE_REFRESH_MS - Date.now()));
    return () => window.clearTimeout(timer);
  }, [refreshOwedAt, router]);

  // `router.refresh()` en el mismo tick que el pushState de un enlace hacía
  // que Next pisara la URL nueva con la vieja; diferido no compite.
  const [refreshTick, setRefreshTick] = useState(0);
  useEffect(() => {
    if (refreshTick) router.refresh();
  }, [refreshTick, router]);

  if (!request) return null;

  const storeName = (id: string) => stores.find((s) => s.id === id)?.name ?? "Tienda";
  const storeDomain = (id: string) => stores.find((s) => s.id === id)?.shopify_domain ?? null;
  const storeWooSite = (id: string) => stores.find((s) => s.id === id)?.woo_site_url ?? null;

  return (
    <OrderDrawer
      key={pinnedTo ?? request.orderId}
      orderId={pinnedTo ?? request.orderId}
      canEdit={permissions.canEdit}
      canOverride={permissions.canOverride}
      canSetStatus={permissions.canSetStatus}
      canCancelWoo={permissions.canCancelWoo}
      canEditCustomerName={permissions.canEditCustomerName}
      canCreateGuide={permissions.canCreateGuide}
      canCreateTandersGuide={permissions.canCreateTandersGuide}
      canCreateGfGuide={permissions.canCreateGfGuide}
      canCancelGfGuide={permissions.canCancelGfGuide}
      canCreateShalomGuide={permissions.canCreateShalomGuide}
      canAttendReproLima={permissions.canAttendReproLima}
      closurePermissions={permissions.closurePermissions}
      storeName={storeName}
      storeDomain={storeDomain}
      storeWooSite={storeWooSite}
      onClose={close}
      onSaved={() => setRefreshTick((n) => n + 1)}
      initialWorkspace={workspaceForDrawerSection(pinnedTo ? "reprolima" : request.section)}
      masterHref={masterOrderHref(pinnedTo ?? request.orderId, pinnedTo ? "reprolima" : request.section)}
    />
  );
}

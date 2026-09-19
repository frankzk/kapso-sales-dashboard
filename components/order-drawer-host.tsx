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

import { Suspense, useCallback, useEffect, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { OrderDrawer } from "@/components/order-drawer";
import {
  closeOrderDrawerHref,
  masterOrderHref,
  readOrderDrawerRequest,
  workspaceForDrawerSection,
} from "@/lib/order-drawer-href";

export interface OrderDrawerHostStore {
  id: string;
  name: string;
  shopify_domain: string | null;
}

export interface OrderDrawerHostProps {
  stores: OrderDrawerHostStore[];
  canEdit: boolean;
  canOverride: boolean;
  canCreateGuide: boolean;
  canCreateTandersGuide: boolean;
  canCreateShalomGuide: boolean;
  closurePermissions: {
    canReturn: boolean;
    canInventory: boolean;
    canFinance: boolean;
    canFinalize: boolean;
    canRefund: boolean;
    canReopen: boolean;
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
    window.history.replaceState(null, "", closeOrderDrawerHref({ pathname, search }));
  }, [pathname, search]);

  // `router.refresh()` en el mismo tick que el pushState de un enlace hacía
  // que Next pisara la URL nueva con la vieja; diferido no compite.
  const [refreshTick, setRefreshTick] = useState(0);
  useEffect(() => {
    if (refreshTick) router.refresh();
  }, [refreshTick, router]);

  if (!request) return null;

  const storeName = (id: string) => stores.find((s) => s.id === id)?.name ?? "Tienda";
  const storeDomain = (id: string) => stores.find((s) => s.id === id)?.shopify_domain ?? null;

  return (
    <OrderDrawer
      key={request.orderId}
      orderId={request.orderId}
      canEdit={permissions.canEdit}
      canOverride={permissions.canOverride}
      canCreateGuide={permissions.canCreateGuide}
      canCreateTandersGuide={permissions.canCreateTandersGuide}
      canCreateShalomGuide={permissions.canCreateShalomGuide}
      closurePermissions={permissions.closurePermissions}
      storeName={storeName}
      storeDomain={storeDomain}
      onClose={close}
      onSaved={() => setRefreshTick((n) => n + 1)}
      initialWorkspace={workspaceForDrawerSection(request.section)}
      masterHref={masterOrderHref(request.orderId, request.section)}
    />
  );
}

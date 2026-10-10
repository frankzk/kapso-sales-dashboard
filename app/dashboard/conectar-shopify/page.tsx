import { cookies } from "next/headers";
import { createAdminSupabase, createServerSupabase } from "@/lib/db";
import {
  PENDING_INSTALL_COOKIE,
  pendingInstallUsable,
  storeNameFromShop,
} from "@/lib/shopify-client-app";
import { ClaimShopifyInstallForm } from "@/components/claim-shopify-install-form";
import { CreateOrgForm } from "@/components/forms";

export const dynamic = "force-dynamic";

// Paso final de la instalación de la app de clientes (MOM §29.15.1): Shopify
// ya autorizó y el token espera cifrado; el dueño elige en qué organización
// vive su tienda. Nunca se escribe el dominio a mano.

const ERRORS: Record<string, string> = {
  "app-no-configurada": "La app de Shopify para tiendas cliente todavía no está configurada en Kapta.",
  "parametros-invalidos": "Shopify devolvió datos incompletos. Vuelve a abrir la app desde el admin de tu Shopify.",
  "state-invalido":
    "La instalación empezó en otro navegador o tardó demasiado. Vuelve a abrir la app desde el admin de tu Shopify, en este navegador.",
  "hmac-invalido": "No se pudo verificar que la respuesta venga de Shopify.",
  "intercambio-fallo": "Shopify no entregó el acceso. Vuelve a intentarlo.",
  "lectura-fallo": "No se pudo leer Kapta. Vuelve a intentarlo.",
  "guardado-fallo": "No se pudo guardar la conexión. Vuelve a intentarlo.",
  "tienda-con-app-interna":
    "Esta tienda ya está conectada a Kapta con la app de Grupo GF. No hace falta instalar esta app.",
};

export default async function ConectarShopifyPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const errorCode = typeof sp.error === "string" ? sp.error : null;
  const error = errorCode ? (ERRORS[errorCode] ?? "No se pudo conectar la tienda.") : null;

  const installId = (await cookies()).get(PENDING_INSTALL_COOKIE)?.value ?? null;
  const admin = createAdminSupabase();
  const pending = installId
    ? ((
        await admin
          .from("shopify_pending_installs")
          .select("id, shop_domain, expires_at, claimed_at")
          .eq("id", installId)
          .maybeSingle()
      ).data as { id: string; shop_domain: string; expires_at: string; claimed_at: string | null } | null)
    : null;
  const usable = pending != null && pendingInstallUsable(pending, new Date());

  const sb = await createServerSupabase();
  const {
    data: { user },
  } = await sb.auth.getUser();
  const { data: memberships } = user
    ? await sb
        .from("memberships")
        .select("org_id, organizations(name)")
        .eq("user_id", user.id)
        .in("role", ["owner", "admin"])
    : { data: [] };
  const orgs = ((memberships ?? []) as unknown as { org_id: string; organizations: { name: string } | null }[]).map(
    (m) => ({ id: m.org_id, name: m.organizations?.name ?? m.org_id }),
  );

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold text-slate-900">Conectar tu tienda de Shopify</h1>
        <p className="mt-1 text-sm text-slate-500">
          Shopify ya autorizó a Kapta. Elige la organización donde quedará tu tienda.
        </p>
      </div>

      {error && <p className="rounded-xl bg-red-50 px-4 py-3 text-sm text-red-700">{error}</p>}

      {!usable ? (
        <p className="max-w-xl rounded-xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-600">
          No hay una instalación en curso en este navegador, o ya venció. Abre la app de Kapta desde el admin de tu
          tienda en Shopify para empezar de nuevo.
        </p>
      ) : orgs.length === 0 ? (
        <div className="space-y-4 rounded-xl border border-slate-200 bg-slate-50 p-5">
          <div>
            <p className="text-sm font-semibold text-slate-800">Primero crea tu organización</p>
            <p className="mt-1 text-sm text-slate-500">
              Es el espacio de tu empresa en Kapta: tú eres el dueño y solo tú, y quien invites, verán sus datos.
            </p>
          </div>
          <CreateOrgForm next="/dashboard/conectar-shopify" />
        </div>
      ) : (
        <div className="space-y-4">
          <p className="text-sm text-slate-700">
            Tienda de Shopify: <span className="font-medium">{pending!.shop_domain}</span>
          </p>
          <ClaimShopifyInstallForm orgs={orgs} defaultName={storeNameFromShop(pending!.shop_domain)} />
        </div>
      )}
    </div>
  );
}

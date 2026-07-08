import Link from "next/link";
import { redirect } from "next/navigation";
import { createServerSupabase } from "@/lib/db";
import { AuthForm } from "@/components/auth-form";

export const dynamic = "force-dynamic";
export const metadata = { title: "Crea tu cuenta · Kapso Sales" };

export default async function SignupPage() {
  // Already signed in → straight to the dashboard (which routes to onboarding
  // if they have no store yet).
  const sb = await createServerSupabase();
  const {
    data: { user },
  } = await sb.auth.getUser();
  if (user) redirect("/dashboard");

  return (
    <main className="flex min-h-screen items-center justify-center p-6">
      <div className="grid w-full max-w-4xl overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm md:grid-cols-2">
        {/* Pitch */}
        <div className="hidden flex-col justify-between gap-8 bg-slate-900 p-8 text-slate-100 md:flex">
          <div>
            <p className="text-sm font-semibold tracking-wide text-brand-300 uppercase">
              Kapso Sales
            </p>
            <h2 className="mt-3 text-2xl font-semibold leading-snug">
              El panel de ventas de tu tienda Shopify + bot de WhatsApp.
            </h2>
            <p className="mt-3 text-sm text-slate-300">
              Ingresos, embudo de conversión, leads y operación — todo en un solo lugar,
              actualizado solo desde tu Shopify y tu Kapso.
            </p>
          </div>
          <ul className="space-y-3 text-sm text-slate-200">
            <li className="flex gap-2">
              <span aria-hidden>🔒</span> Tu data queda <strong>aislada</strong>: nadie más ve tus
              tiendas ni tus clientes.
            </li>
            <li className="flex gap-2">
              <span aria-hidden>⚡</span> Conectas tu tienda en minutos con tus propias credenciales.
            </li>
            <li className="flex gap-2">
              <span aria-hidden>📊</span> Ventas, conversión y leads de WhatsApp, por tienda y
              consolidado.
            </li>
          </ul>
        </div>

        {/* Auth */}
        <div className="p-8">
          <h1 className="text-xl font-semibold text-slate-900">Crea tu cuenta</h1>
          <p className="mt-1 text-sm text-slate-500">
            Regístrate y conecta tu tienda. Es tu espacio: tú eres el dueño.
          </p>
          <AuthForm mode="signup" />
          <p className="mt-4 text-center text-xs text-slate-400">
            Al continuar aceptas conectar tu tienda con tus propias credenciales, que se guardan
            cifradas.
          </p>
        </div>
      </div>
      <Link href="/login" className="sr-only">
        Iniciar sesión
      </Link>
    </main>
  );
}

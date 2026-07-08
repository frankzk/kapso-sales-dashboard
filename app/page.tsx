import Link from "next/link";
import { redirect } from "next/navigation";
import { createServerSupabase } from "@/lib/db";

export const dynamic = "force-dynamic";

// Public landing. Signed-in users go straight to the dashboard; everyone else
// sees the pitch with clear "create account" / "sign in" entry points.
export default async function Home() {
  const sb = await createServerSupabase();
  const {
    data: { user },
  } = await sb.auth.getUser();
  if (user) redirect("/dashboard");

  return (
    <main className="flex min-h-screen flex-col">
      <header className="flex items-center justify-between px-6 py-5">
        <span className="text-sm font-semibold text-slate-900">Kapso Sales</span>
        <Link
          href="/login"
          className="text-sm font-medium text-slate-600 hover:text-slate-900"
        >
          Iniciar sesión
        </Link>
      </header>

      <section className="mx-auto flex w-full max-w-3xl flex-1 flex-col items-center justify-center px-6 py-16 text-center">
        <p className="text-xs font-semibold tracking-wide text-brand-600 uppercase">
          Ventas · WhatsApp · Shopify
        </p>
        <h1 className="mt-4 text-3xl font-semibold leading-tight text-slate-900 sm:text-4xl">
          El panel de ventas de tu tienda Shopify y tu bot de WhatsApp.
        </h1>
        <p className="mt-4 max-w-xl text-base text-slate-600">
          Ingresos, embudo de conversión, leads y operación — en un solo lugar, alimentado
          automáticamente desde tu Shopify y tu Kapso. Tu data queda aislada: solo tú la ves.
        </p>

        <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
          <Link
            href="/signup"
            className="rounded-lg bg-brand-600 px-5 py-3 text-sm font-semibold text-white shadow-sm transition hover:bg-brand-700"
          >
            Crea tu cuenta
          </Link>
          <Link
            href="/login"
            className="rounded-lg border border-slate-300 bg-white px-5 py-3 text-sm font-semibold text-slate-700 transition hover:bg-slate-50"
          >
            Ya tengo cuenta
          </Link>
        </div>

        <div className="mt-12 grid w-full gap-4 text-left sm:grid-cols-3">
          {[
            ["🔒", "Data aislada", "Cada dueño ve solo sus tiendas y sus clientes. Nada se cruza."],
            ["⚡", "Conectas en minutos", "Tu Shopify y tu Kapso con tus propias credenciales, cifradas."],
            ["📊", "Métricas que importan", "Ventas, conversión y leads de WhatsApp, por tienda y consolidado."],
          ].map(([icon, title, body]) => (
            <div key={title} className="rounded-xl border border-slate-200 bg-white p-4">
              <div className="text-xl" aria-hidden>
                {icon}
              </div>
              <p className="mt-2 text-sm font-semibold text-slate-900">{title}</p>
              <p className="mt-1 text-xs text-slate-500">{body}</p>
            </div>
          ))}
        </div>
      </section>

      <footer className="px-6 py-6 text-center text-xs text-slate-400">
        Kapso Sales — panel de ventas multi-tienda.
      </footer>
    </main>
  );
}

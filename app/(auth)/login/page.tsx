import { AuthForm } from "@/components/auth-form";

export const metadata = { title: "Iniciar sesión · Kapso Sales" };

export default function LoginPage() {
  return (
    <main className="flex min-h-screen items-center justify-center p-6">
      <div className="w-full max-w-sm rounded-2xl border border-slate-200 bg-white p-8 shadow-sm">
        <h1 className="text-xl font-semibold text-slate-900">Kapso Sales</h1>
        <p className="mt-1 text-sm text-slate-500">
          Panel de ventas multi-tienda para tus bots de WhatsApp.
        </p>
        <AuthForm mode="login" />
      </div>
    </main>
  );
}

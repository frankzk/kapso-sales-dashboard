"use client";

import Link from "next/link";
import { useState } from "react";
import { createBrowserSupabase } from "@/lib/supabase-browser";

/** Map raw Supabase auth errors to clear, non-technical Spanish guidance. */
function friendlyAuthError(message: string, mode: AuthMode): string {
  const m = message.toLowerCase();
  if (m.includes("signups not allowed") || m.includes("signup is disabled")) {
    return mode === "signup"
      ? "El registro está temporalmente cerrado. Escríbele al administrador para que lo habilite."
      : "Tu cuenta todavía no está habilitada. Si eres dueño de una tienda nueva, usa «Crear cuenta».";
  }
  if (m.includes("rate limit")) {
    return "Demasiados intentos por ahora. Espera unos minutos o entra con Google (no necesita correo).";
  }
  if (m.includes("redirect") && m.includes("mismatch")) {
    return "El acceso con Google todavía no está configurado del todo. Avisa al administrador.";
  }
  return message;
}

function GoogleIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true">
      <path
        fill="#4285F4"
        d="M17.64 9.2c0-.637-.057-1.251-.164-1.84H9v3.481h4.844a4.14 4.14 0 0 1-1.796 2.716v2.259h2.908c1.702-1.567 2.684-3.875 2.684-6.615z"
      />
      <path
        fill="#34A853"
        d="M9 18c2.43 0 4.467-.806 5.956-2.18l-2.908-2.259c-.806.54-1.837.86-3.048.86-2.344 0-4.328-1.584-5.036-3.711H.957v2.332A8.997 8.997 0 0 0 9 18z"
      />
      <path
        fill="#FBBC05"
        d="M3.964 10.71A5.41 5.41 0 0 1 3.682 9c0-.593.102-1.17.282-1.71V4.958H.957A8.997 8.997 0 0 0 0 9c0 1.452.348 2.827.957 4.042l3.007-2.332z"
      />
      <path
        fill="#EA4335"
        d="M9 3.58c1.321 0 2.508.454 3.44 1.345l2.582-2.58C13.463.891 11.426 0 9 0A8.997 8.997 0 0 0 .957 4.958L3.964 7.29C4.672 5.163 6.656 3.58 9 3.58z"
      />
    </svg>
  );
}

export type AuthMode = "login" | "signup";

const COPY = {
  login: {
    google: "Continuar con Google",
    googleHint: "Recomendado — entras al instante con tu Gmail.",
    submit: "Enviar enlace mágico",
    submitting: "Enviando…",
    crossPrompt: "¿Primera vez?",
    crossCta: "Crea tu cuenta",
    crossHref: "/signup",
  },
  signup: {
    google: "Crear cuenta con Google",
    googleHint: "Lo más rápido — tu cuenta queda lista al instante.",
    submit: "Crear cuenta por correo",
    submitting: "Enviando…",
    crossPrompt: "¿Ya tienes cuenta?",
    crossCta: "Inicia sesión",
    crossHref: "/login",
  },
} as const;

/** Shared Google + magic-link auth UI. Supabase auto-provisions a new user on
 *  first OAuth/OTP, so "login" and "signup" run the same calls — only the copy
 *  and the cross-link differ. */
export function AuthForm({ mode }: { mode: AuthMode }) {
  const c = COPY[mode];
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const origin = typeof window !== "undefined" ? window.location.origin : "";

  async function signInWithGoogle() {
    setErr(null);
    const supabase = createBrowserSupabase();
    const { error } = await supabase.auth.signInWithOAuth({
      provider: "google",
      options: { redirectTo: `${origin}/auth/callback` },
    });
    if (error) setErr(friendlyAuthError(error.message, mode));
  }

  async function sendMagicLink(e: React.FormEvent) {
    e.preventDefault();
    setErr(null);
    setBusy(true);
    const supabase = createBrowserSupabase();
    const { error } = await supabase.auth.signInWithOtp({
      email,
      options: { emailRedirectTo: `${origin}/auth/callback` },
    });
    setBusy(false);
    if (error) setErr(friendlyAuthError(error.message, mode));
    else setSent(true);
  }

  return (
    <>
      <button
        onClick={signInWithGoogle}
        className="mt-6 flex w-full items-center justify-center gap-2.5 rounded-lg border border-slate-300 bg-white px-4 py-3 text-sm font-semibold text-slate-700 shadow-sm transition hover:bg-slate-50"
      >
        <GoogleIcon />
        {c.google}
      </button>
      <p className="mt-2 text-center text-xs text-slate-400">{c.googleHint}</p>

      <div className="my-5 flex items-center gap-3 text-xs text-slate-400">
        <span className="h-px flex-1 bg-slate-200" /> o por correo{" "}
        <span className="h-px flex-1 bg-slate-200" />
      </div>

      {sent ? (
        <div className="rounded-lg bg-brand-50 px-4 py-3 text-sm text-brand-700">
          <p>
            Te enviamos un enlace a <strong>{email}</strong>. Revisa tu correo (y la carpeta de
            spam).
          </p>
          <button
            type="button"
            onClick={() => {
              setSent(false);
              setErr(null);
            }}
            className="mt-2 text-xs font-medium text-brand-700 underline"
          >
            ¿No te llegó? Prueba de nuevo o usa Google
          </button>
        </div>
      ) : (
        <form onSubmit={sendMagicLink} className="space-y-3">
          <input
            type="email"
            required
            placeholder="tu@correo.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="w-full rounded-lg border border-slate-300 px-3 py-2.5 text-sm outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100"
          />
          <button
            type="submit"
            disabled={busy}
            className="w-full rounded-lg bg-brand-600 px-4 py-2.5 text-sm font-medium text-white transition hover:bg-brand-700 disabled:opacity-60"
          >
            {busy ? c.submitting : c.submit}
          </button>
        </form>
      )}

      {err && (
        <div className="mt-4 rounded-lg border border-red-200 bg-red-50 px-3 py-2.5 text-sm text-red-700">
          {err}
        </div>
      )}

      <p className="mt-5 text-center text-xs text-slate-500">
        {c.crossPrompt}{" "}
        <Link href={c.crossHref} className="font-medium text-brand-700 underline">
          {c.crossCta}
        </Link>
      </p>
    </>
  );
}

import { NextResponse, type NextRequest } from "next/server";
import { createServerClient } from "@supabase/ssr";

const OAUTH_AUTHORIZE_PATH = "/oauth/authorize";
const OAUTH_RETURN_COOKIE = "kapta_oauth_return";

// Refreshes the Supabase auth session on every request and guards /dashboard.
// API routes (webhooks, cron) are excluded via the matcher below.
// (Next 16 renamed the "middleware" file convention to "proxy".)
export async function proxy(request: NextRequest) {
  let response = NextResponse.next({ request });

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value));
          response = NextResponse.next({ request });
          cookiesToSet.forEach(({ name, value, options }) =>
            response.cookies.set(name, value, options),
          );
        },
      },
    },
  );

  // `getUser()` always makes a round trip to Supabase Auth. Proxy runs for
  // every dashboard/RSC navigation, so that check was adding network latency
  // before Next could even start rendering the destination. `getClaims()` is
  // the Supabase-recommended SSR guard: it validates asymmetric JWTs locally
  // with the cached JWKS (and still falls back safely for symmetric projects).
  const { data: claimsData } = await supabase.auth.getClaims();
  const isAuthenticated = !!claimsData?.claims?.sub;

  const path = request.nextUrl.pathname;

  // OAuth de agentes de IA (MOM §42.8): la página de permiso necesita sesión.
  // Sin ella va al login, y la página con su query se guarda en una cookie
  // corta para volver después de entrar por cualquier camino (Google, enlace o
  // clave), sin tocar las URLs de vuelta del login.
  if (path === OAUTH_AUTHORIZE_PATH && !isAuthenticated) {
    const url = request.nextUrl.clone();
    url.pathname = "/login";
    url.search = "";
    const redirect = NextResponse.redirect(url);
    const back = `${path}${request.nextUrl.search}`;
    if (back.length <= 4000) {
      redirect.cookies.set(OAUTH_RETURN_COOKIE, back, { httpOnly: true, sameSite: "lax", secure: true, path: "/", maxAge: 900 });
    }
    return redirect;
  }
  const oauthReturn = request.cookies.get(OAUTH_RETURN_COOKIE)?.value;
  if (isAuthenticated && oauthReturn && path === "/dashboard" && oauthReturn.startsWith(`${OAUTH_AUTHORIZE_PATH}?`)) {
    const url = request.nextUrl.clone();
    const [pathname, query] = [OAUTH_AUTHORIZE_PATH, oauthReturn.slice(OAUTH_AUTHORIZE_PATH.length)];
    url.pathname = pathname;
    url.search = query;
    const redirect = NextResponse.redirect(url);
    redirect.cookies.delete(OAUTH_RETURN_COOKIE);
    return redirect;
  }

  if (path.startsWith("/dashboard") && !isAuthenticated) {
    const url = request.nextUrl.clone();
    url.pathname = "/login";
    url.searchParams.set("redirectedFrom", path);
    return NextResponse.redirect(url);
  }
  // Un usuario cuyo único rol es motorizado no tiene panel: su módulo es
  // /reparto. El layout del dashboard también lo redirige; esto lo corta antes
  // de renderizar nada. Una consulta pequeña a memberships bajo RLS.
  if (path.startsWith("/dashboard") && isAuthenticated) {
    const { data: memberships } = await supabase.from("memberships").select("role");
    const roles = ((memberships as { role: string }[] | null) ?? []).map((m) => m.role);
    if (roles.length > 0 && roles.every((r) => r === "motorizado")) {
      const url = request.nextUrl.clone();
      url.pathname = "/reparto";
      url.search = "";
      return NextResponse.redirect(url);
    }
  }
  if ((path === "/login" || path === "/signup") && isAuthenticated) {
    const url = request.nextUrl.clone();
    url.pathname = "/dashboard";
    url.search = "";
    return NextResponse.redirect(url);
  }

  return response;
}

export const config = {
  matcher: [
    // `.well-known`: los metadatos OAuth del conector de IA son públicos (MOM §42.8).
    "/((?!api|\\.well-known|_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)",
  ],
};

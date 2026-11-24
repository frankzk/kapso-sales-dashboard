// La versión de Kapta que tiene abierta la pestaña y la que está publicada (owner, 24-11-2026: «puede ser, pero un
// aviso muy amigable»). Vercel mantiene cada pestaña en la versión con la que se abrió: el 23-11 una pestaña de antes
// de los arreglos siguió diciendo «La guía ya salió con un motorizado» con el arreglo ya publicado. El aviso
// (components/new-version-notice.tsx) invita a recargar; nunca recarga solo.

/** La versión publicada: el commit de esta compilación. Vacío fuera de Vercel (desarrollo): sin aviso. */
export function publishedBuild(env: Record<string, string | undefined> = process.env): string {
  return (env.VERCEL_GIT_COMMIT_SHA ?? "").trim();
}

/** ¿La versión publicada es otra que la de esta pestaña? Sin una de las dos, no se avisa. */
export function isNewerBuild(tab: string | null | undefined, published: string | null | undefined): boolean {
  const a = (tab ?? "").trim(), b = (published ?? "").trim();
  return Boolean(a && b && a !== b);
}

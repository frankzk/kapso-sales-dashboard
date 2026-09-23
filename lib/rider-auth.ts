// Acceso de motorizados con usuario y contraseña. Puro y testeado
// (test/rider-auth.test.ts); lo usan el formulario de login y
// scripts/rider-user.ts. El runbook está en docs/runbooks/motorizados-acceso.md.
//
// POR QUÉ UN DOMINIO INTERNO. Supabase Auth identifica a cada persona por un
// correo, y un motorizado no siempre tiene uno (o no quiere usar el suyo para
// el trabajo). Se le da un usuario corto («roy») que el sistema convierte en
// `roy@motorizados.kapta.local`: un correo sintético que nunca recibe nada
// (el dominio `.local` no es enrutable) y que cumple el requisito de Auth. Si
// el motorizado sí tiene Gmail, sigue pudiendo entrar con Google: son dos
// puertas al mismo usuario solo si el correo coincide, así que en la práctica
// un motorizado usa una u otra.

export const RIDER_EMAIL_DOMAIN = "motorizados.kapta.local";

/**
 * «roy» → «roy@motorizados.kapta.local»; un correo real se respeta tal cual.
 * Minúsculas, sin espacios, y solo caracteres seguros en la parte local.
 * Devuelve null si el usuario queda vacío o trae caracteres raros.
 */
export function riderUsernameToEmail(raw: string): string | null {
  const v = raw.trim().toLowerCase();
  if (!v) return null;
  if (v.includes("@")) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v) ? v : null;
  }
  if (!/^[a-z0-9][a-z0-9._-]{1,30}$/.test(v)) return null;
  return `${v}@${RIDER_EMAIL_DOMAIN}`;
}

/** Lo contrario: `roy@motorizados.kapta.local` → «roy»; un correo real se devuelve entero. */
export function riderEmailToUsername(email: string): string {
  const v = email.trim().toLowerCase();
  const suffix = `@${RIDER_EMAIL_DOMAIN}`;
  return v.endsWith(suffix) ? v.slice(0, -suffix.length) : v;
}

export function isRiderInternalEmail(email: string | null | undefined): boolean {
  return Boolean(email && email.toLowerCase().endsWith(`@${RIDER_EMAIL_DOMAIN}`));
}

// Alfabeto sin caracteres que se confunden al dictar o escribir en un
// teléfono: sin 0/O, 1/l/I, ni símbolos. 10 caracteres ≈ 51 bits.
const PASSWORD_ALPHABET = "abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789";

/**
 * Contraseña legible de `length` caracteres (10 por defecto), con al menos una
 * minúscula, una mayúscula y un dígito para pasar cualquier política mínima.
 * `random` es inyectable para las pruebas; por defecto usa crypto.
 */
export function generateRiderPassword(length = 10, random: (max: number) => number = cryptoRandomInt): string {
  if (length < 6) throw new Error("La contraseña necesita al menos 6 caracteres.");
  for (let attempt = 0; attempt < 50; attempt++) {
    let out = "";
    for (let i = 0; i < length; i++) out += PASSWORD_ALPHABET[random(PASSWORD_ALPHABET.length)];
    if (/[a-z]/.test(out) && /[A-Z]/.test(out) && /\d/.test(out)) return out;
  }
  // Con un generador sano esto no ocurre; con uno degenerado se fuerza.
  return "aB2" + Array.from({ length: length - 3 }, () => PASSWORD_ALPHABET[random(PASSWORD_ALPHABET.length)]).join("");
}

function cryptoRandomInt(max: number): number {
  const buf = new Uint32Array(1);
  const limit = Math.floor(0xffffffff / max) * max;
  let x: number;
  do {
    crypto.getRandomValues(buf);
    x = buf[0]!;
  } while (x >= limit);
  return x % max;
}

/** Mensajes en español para los errores de `signInWithPassword`. */
export function friendlyPasswordError(message: string): string {
  const m = message.toLowerCase();
  if (m.includes("invalid login credentials") || m.includes("invalid_credentials")) {
    return "Usuario o contraseña incorrectos. Si no la recuerdas, pídele al coordinador que te la cambie.";
  }
  if (m.includes("email not confirmed")) {
    return "Tu usuario todavía no está activado. Avisa al coordinador.";
  }
  if (m.includes("banned") || m.includes("user is disabled")) {
    return "Tu usuario está desactivado. Habla con el coordinador.";
  }
  if (m.includes("rate limit") || m.includes("too many")) {
    return "Demasiados intentos. Espera unos minutos y vuelve a probar.";
  }
  return message;
}

/**
 * Gestión del acceso de motorizados (usuario y contraseña). Pensado para que
 * lo ejecute una persona o un agente de IA siguiendo
 * docs/runbooks/motorizados-acceso.md.
 *
 *   pnpm tsx scripts/rider-user.ts create <nombre-ficha> [--usuario roy] [--org <org_id>]
 *   pnpm tsx scripts/rider-user.ts reset-password <usuario>
 *   pnpm tsx scripts/rider-user.ts set-password <usuario> <clave>
 *   pnpm tsx scripts/rider-user.ts attach <nombre-ficha> <usuario>
 *   pnpm tsx scripts/rider-user.ts detach <nombre-ficha>
 *   pnpm tsx scripts/rider-user.ts disable <usuario>
 *   pnpm tsx scripts/rider-user.ts enable <usuario>
 *   pnpm tsx scripts/rider-user.ts list
 *
 * <usuario> es el nombre corto («roy») o un correo completo. Lee .env /
 * .env.local (NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY). Las
 * contraseñas se imprimen UNA sola vez: no se guardan en ningún sitio.
 *
 * Modelo (0064, 0066, 0179): ficha `riders` ↔ usuario Auth por
 * `riders.user_id`; el rol de membresía `motorizado` en la organización le da
 * solo `routes.deliver`; la RLS acota sus lecturas a su hoja cuando ese es
 * su único rol. Nunca se borran usuarios con historial: se desactivan.
 */
import { existsSync, readFileSync } from "node:fs";

function loadEnv() {
  for (const file of [".env.local", ".env"]) {
    if (!existsSync(file)) continue;
    for (const line of readFileSync(file, "utf8").split("\n")) {
      const m = /^\s*([A-Z0-9_]+)\s*=\s*"?([^"]*)"?\s*$/.exec(line);
      if (m && !process.env[m[1]!]) process.env[m[1]!] = m[2];
    }
  }
}

type Admin = ReturnType<typeof import("@/lib/db")["createAdminSupabase"]>;

function arg(flags: string[], name: string): string | null {
  const i = flags.indexOf(name);
  return i >= 0 ? (flags[i + 1] ?? null) : null;
}

async function findUserByEmail(admin: Admin, email: string) {
  for (let page = 1; page < 50; page++) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 200 });
    if (error) throw new Error(`No se pudo listar usuarios: ${error.message}`);
    const hit = data.users.find((u) => u.email?.toLowerCase() === email);
    if (hit) return hit;
    if (data.users.length < 200) break;
  }
  return null;
}

async function findRider(admin: Admin, name: string, orgId: string | null) {
  let q = admin.from("riders").select("id,full_name,user_id,org_id,active").ilike("full_name", name);
  if (orgId) q = q.eq("org_id", orgId);
  const { data, error } = await q;
  if (error) throw new Error(`No se pudo leer la ficha: ${error.message}`);
  const rows = (data ?? []) as { id: string; full_name: string; user_id: string | null; org_id: string; active: boolean }[];
  if (!rows.length) throw new Error(`No existe la ficha de motorizado «${name}». Créala primero en Liquidaciones → Motorizados.`);
  if (rows.length > 1) throw new Error(`Hay ${rows.length} fichas llamadas «${name}»: indica --org <org_id>.`);
  return rows[0]!;
}

async function resolveEmail(raw: string): Promise<string> {
  const { riderUsernameToEmail } = await import("@/lib/rider-auth");
  const email = riderUsernameToEmail(raw);
  if (!email) throw new Error(`Usuario no válido: «${raw}». Usa letras, números, punto o guion (mín. 2), o un correo.`);
  return email;
}

async function ensureMembership(admin: Admin, userId: string, orgId: string) {
  const { data: existing } = await admin.from("memberships").select("role").eq("user_id", userId).eq("org_id", orgId).maybeSingle();
  if (existing) {
    if (existing.role !== "motorizado") {
      throw new Error(`El usuario ya es «${existing.role}» en esa organización. Un motorizado no debe tener otro rol: usa otro usuario.`);
    }
    return "ya existía";
  }
  const { error } = await admin.from("memberships").insert({ user_id: userId, org_id: orgId, role: "motorizado" });
  if (error) throw new Error(`No se pudo crear la membresía: ${error.message}`);
  return "creada";
}

async function main() {
  loadEnv();
  const [cmd, ...rest] = process.argv.slice(2);
  const positional = rest.filter((a, i) => !a.startsWith("--") && !(i > 0 && rest[i - 1]!.startsWith("--")));
  const { createAdminSupabase } = await import("@/lib/db");
  const { generateRiderPassword, riderEmailToUsername } = await import("@/lib/rider-auth");
  const admin = createAdminSupabase();

  switch (cmd) {
    case "create": {
      const name = positional[0];
      if (!name) throw new Error("uso: create <nombre-ficha> [--usuario roy] [--org <org_id>]");
      const orgId = arg(rest, "--org");
      const rider = await findRider(admin, name, orgId);
      const username = arg(rest, "--usuario") ?? name.toLowerCase().replace(/[^a-z0-9]+/g, ".").replace(/^\.|\.$/g, "");
      const email = await resolveEmail(username);
      let user = await findUserByEmail(admin, email);
      let password: string | null = null;
      if (user) {
        console.log(`El usuario ${email} ya existía (${user.id}); no se cambia su contraseña.`);
      } else {
        password = generateRiderPassword();
        const { data, error } = await admin.auth.admin.createUser({
          email,
          password,
          email_confirm: true,
          user_metadata: { role: "motorizado", rider: rider.full_name, rider_id: rider.id },
        });
        if (error || !data.user) throw new Error(`No se pudo crear el usuario: ${error?.message}`);
        user = data.user;
      }
      const membership = await ensureMembership(admin, user.id, rider.org_id);
      // Atar la ficha: si estaba atada a OTRO usuario (p. ej. el owner en
      // pruebas), se desata de ese y se ata al motorizado.
      if (rider.user_id && rider.user_id !== user.id) {
        console.log(`La ficha estaba atada a ${rider.user_id}; se desata y se ata a ${user.id}.`);
      }
      const { error: attachErr } = await admin.from("riders").update({ user_id: user.id, updated_at: new Date().toISOString() }).eq("id", rider.id);
      if (attachErr) throw new Error(`No se pudo atar la ficha: ${attachErr.message}`);
      console.log(`✔ Ficha «${rider.full_name}» atada al usuario ${email} (${user.id}); membresía motorizado ${membership}.`);
      if (password) {
        console.log("");
        console.log("  USUARIO:    " + riderEmailToUsername(email));
        console.log("  CONTRASEÑA: " + password);
        console.log("");
        console.log("  Se muestra una sola vez. Entrégala en mano; para cambiarla: reset-password.");
      }
      return;
    }
    case "reset-password":
    case "set-password": {
      const raw = positional[0];
      if (!raw) throw new Error(`uso: ${cmd} <usuario>${cmd === "set-password" ? " <clave>" : ""}`);
      const email = await resolveEmail(raw);
      const user = await findUserByEmail(admin, email);
      if (!user) throw new Error(`No existe el usuario ${email}.`);
      const password = cmd === "set-password" ? positional[1] : generateRiderPassword();
      if (!password || password.length < 6) throw new Error("La contraseña necesita al menos 6 caracteres.");
      const { error } = await admin.auth.admin.updateUserById(user.id, { password });
      if (error) throw new Error(`No se pudo cambiar la contraseña: ${error.message}`);
      console.log(`✔ Contraseña cambiada para ${riderEmailToUsername(email)}.`);
      if (cmd === "reset-password") console.log("  CONTRASEÑA: " + password + "\n  Se muestra una sola vez.");
      return;
    }
    case "attach": {
      const [name, raw] = positional;
      if (!name || !raw) throw new Error("uso: attach <nombre-ficha> <usuario>");
      const rider = await findRider(admin, name, arg(rest, "--org"));
      const email = await resolveEmail(raw);
      const user = await findUserByEmail(admin, email);
      if (!user) throw new Error(`No existe el usuario ${email}. Créalo con create.`);
      await ensureMembership(admin, user.id, rider.org_id);
      const { error } = await admin.from("riders").update({ user_id: user.id, updated_at: new Date().toISOString() }).eq("id", rider.id);
      if (error) throw new Error(error.message);
      console.log(`✔ Ficha «${rider.full_name}» atada a ${email}.`);
      return;
    }
    case "detach": {
      const name = positional[0];
      if (!name) throw new Error("uso: detach <nombre-ficha>");
      const rider = await findRider(admin, name, arg(rest, "--org"));
      if (!rider.user_id) {
        console.log(`La ficha «${rider.full_name}» no tenía usuario.`);
        return;
      }
      const { error } = await admin.from("riders").update({ user_id: null, updated_at: new Date().toISOString() }).eq("id", rider.id);
      if (error) throw new Error(error.message);
      console.log(`✔ Ficha «${rider.full_name}» desatada de ${rider.user_id}. El usuario sigue existiendo (desactívalo con disable si ya no reparte).`);
      return;
    }
    case "disable":
    case "enable": {
      const raw = positional[0];
      if (!raw) throw new Error(`uso: ${cmd} <usuario>`);
      const email = await resolveEmail(raw);
      const user = await findUserByEmail(admin, email);
      if (!user) throw new Error(`No existe el usuario ${email}.`);
      // ban_duration «none» reactiva; un plazo muy largo desactiva sin borrar.
      const { error } = await admin.auth.admin.updateUserById(user.id, { ban_duration: cmd === "disable" ? "876000h" : "none" });
      if (error) throw new Error(error.message);
      console.log(`✔ Usuario ${riderEmailToUsername(email)} ${cmd === "disable" ? "desactivado (no puede entrar; su historial se conserva)" : "reactivado"}.`);
      return;
    }
    case "list": {
      const { data: riders, error } = await admin.from("riders").select("id,full_name,user_id,org_id,active,courier").order("full_name");
      if (error) throw new Error(error.message);
      const rows = (riders ?? []) as { id: string; full_name: string; user_id: string | null; org_id: string; active: boolean; courier: string | null }[];
      const ids = rows.map((r) => r.user_id).filter((x): x is string => Boolean(x));
      const users = new Map<string, { email: string | null; banned: boolean }>();
      for (const id of ids) {
        const { data } = await admin.auth.admin.getUserById(id);
        if (data.user) users.set(id, { email: data.user.email ?? null, banned: Boolean((data.user as { banned_until?: string | null }).banned_until) });
      }
      const { data: memberships } = await admin.from("memberships").select("user_id,role").in("user_id", ids.length ? ids : ["00000000-0000-0000-0000-000000000000"]);
      const roles = new Map<string, string[]>();
      for (const m of (memberships ?? []) as { user_id: string; role: string }[]) roles.set(m.user_id, [...(roles.get(m.user_id) ?? []), m.role]);
      console.log("ficha | activa | courier | usuario | roles | estado");
      for (const r of rows) {
        const u = r.user_id ? users.get(r.user_id) : null;
        const who = u?.email ? riderEmailToUsername(u.email) : r.user_id ? `(usuario ${r.user_id} sin correo)` : "— sin usuario —";
        const rs = r.user_id ? (roles.get(r.user_id) ?? []).join(",") || "sin membresía" : "";
        const state = u ? (u.banned ? "desactivado" : "activo") : "";
        console.log(`${r.full_name} | ${r.active ? "sí" : "no"} | ${r.courier ?? "propio"} | ${who} | ${rs} | ${state}`);
      }
      return;
    }
    default:
      console.error("comandos: create | reset-password | set-password | attach | detach | disable | enable | list (ver cabecera del archivo)");
      process.exit(1);
  }
}

main().catch((e) => {
  console.error("✖", e instanceof Error ? e.message : e);
  process.exit(1);
});

#!/usr/bin/env node
// Genera db/apply.sql y db/apply_bundled.sql desde db/migrations/ + supabase/policies.sql.
//
// Los dos archivos son la MISMA lista en dos formatos: `apply.sql` la recorre
// con \ir para psql, y `apply_bundled.sql` la concatena entera para pegarla en
// el SQL Editor de Supabase, que no sabe de \ir ni de rutas.
//
// Existe porque la cabecera del bundle decía "(generated)" y no había nada que
// lo generara: se mantenía a mano y llevaba meses derivando. Le faltaban las
// migraciones 0005-0007, 0042-0057 y 0062-0069 — más de la mitad del esquema —
// y nadie se enteró porque nada lo comprobaba. Ahora `--check` lo comprueba en
// CI y falla el build antes de que vuelva a pasar.
//
//   node scripts/gen-apply.mjs           reescribe los dos archivos
//   node scripts/gen-apply.mjs --check   falla si están desactualizados
//
// El ORDEN no es alfabético del todo: las policies van después de la 0003 y
// antes de la 0004, porque definen auth_store_ids() y de la 0004 en adelante
// hay migraciones que la usan. Es el mismo orden que aplica verify-db.sh.

import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const MIGRATIONS_DIR = join(ROOT, "db", "migrations");
const POLICIES = join(ROOT, "supabase", "policies.sql");

/** Las policies se intercalan justo después de esta migración. */
const POLICIES_AFTER = "0003";

/** Las piezas en el orden real de aplicación. */
function pieces() {
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();

  const numbers = files.map((f) => f.slice(0, 4));
  const duplicates = numbers.filter((n, i) => numbers.indexOf(n) !== i);
  if (duplicates.length) {
    // Dos migraciones con el mismo número se ordenan por su nombre y no por su
    // intención: funciona por casualidad hasta que el orden importa.
    throw new Error(`Migraciones con número repetido: ${[...new Set(duplicates)].join(", ")}`);
  }

  const out = [];
  for (const file of files) {
    out.push({ label: file.slice(0, 4), path: join(MIGRATIONS_DIR, file), rel: `migrations/${file}`, name: file });
    if (file.startsWith(POLICIES_AFTER + "_")) {
      out.push({ label: "policies", path: POLICIES, rel: "../supabase/policies.sql", name: "policies.sql" });
    }
  }
  if (!out.some((p) => p.label === "policies")) {
    throw new Error(`No existe la migración ${POLICIES_AFTER}_*, que es donde se intercalan las policies.`);
  }
  return out;
}

function renderApply(parts) {
  const lines = [
    "-- apply.sql — esquema completo + RLS, en orden, en un solo comando (generado).",
    "--   psql \"$DATABASE_URL\" -f db/apply.sql",
    "-- (las rutas de \\ir son relativas a este archivo)",
    "--",
    "-- NO EDITAR A MANO: lo regenera `node scripts/gen-apply.mjs`.",
  ];
  for (const p of parts) {
    lines.push(`\\echo 'Applying ${p.name}'`, `\\ir ${p.rel}`);
  }
  lines.push("\\echo 'Done.'", "");
  return lines.join("\n");
}

function renderBundled(parts) {
  const chunks = [
    "-- apply_bundled.sql — esquema completo + RLS para el SQL Editor de Supabase (generado).",
    "-- Pegar en Supabase → SQL Editor → Run. (psql: db/apply.sql)",
    "--",
    "-- NO EDITAR A MANO: lo regenera `node scripts/gen-apply.mjs`.",
    "",
  ];
  for (const p of parts) {
    chunks.push(`-- ---- ${p.label} ----`);
    chunks.push(readFileSync(p.path, "utf8").replace(/\s*$/, ""));
    chunks.push("");
  }
  return chunks.join("\n");
}

let parts;
try {
  parts = pieces();
} catch (err) {
  console.error(`❌ ${err.message}`);
  process.exit(1);
}

const targets = [
  { path: join(ROOT, "db", "apply.sql"), body: renderApply(parts) },
  { path: join(ROOT, "db", "apply_bundled.sql"), body: renderBundled(parts) },
];

if (process.argv.includes("--check")) {
  const stale = targets.filter((t) => {
    try {
      return readFileSync(t.path, "utf8") !== t.body;
    } catch {
      return true;
    }
  });
  if (stale.length) {
    console.error("❌ desactualizado: " + stale.map((t) => t.path.slice(ROOT.length + 1)).join(", "));
    console.error("   corre `node scripts/gen-apply.mjs` y confirma el resultado.");
    process.exit(1);
  }
  console.log(`✅ db/apply.sql y db/apply_bundled.sql al día (${parts.length} piezas)`);
} else {
  for (const t of targets) writeFileSync(t.path, t.body);
  console.log(`✅ regenerados desde ${parts.length} piezas (${parts.at(-1).name} la última)`);
}

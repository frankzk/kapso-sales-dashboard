#!/usr/bin/env node
// Isolated PostgreSQL/WASM verification. Never reads app .env or connects to a
// database server. Requires PGlite installed separately from the application:
//   npm install --prefix ../.performance-tools @electric-sql/pglite
//   node scripts/verify-master-scaling.mjs --smoke
// PGLITE_MODULE may name the local dist/index.js file, as a path or file: URL.
//
// The default command checks the entire fresh schema. --smoke also runs the
// self-contained Master mutation/backfill/RLS smoke; bulk benchmarks import
// createMigratedDatabase(197) and applySqlFile() from this module separately.

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const MIGRATIONS = join(ROOT, "db", "migrations");
const DEFAULT_MODULE = resolve(ROOT, "..", ".performance-tools", "node_modules", "@electric-sql", "pglite", "dist", "index.js");

function localModuleUrl() {
  const configured = process.env.PGLITE_MODULE;
  if (configured?.startsWith("file:")) return new URL(configured);
  if (configured && /^[a-z][a-z\d+.-]*:\/\//i.test(configured)) {
    throw new Error("PGLITE_MODULE must be a local file path or file: URL");
  }
  return pathToFileURL(configured ? resolve(configured) : DEFAULT_MODULE);
}

function sourceName(file) {
  return relative(ROOT, file).replaceAll("\\", "/");
}

function compactError(error, file) {
  // PGlite attaches the submitted SQL to errors. Never print the whole error
  // object/stack; reports retain only a bounded message, SQLSTATE and filename.
  const message = String(error?.message ?? error).replace(/\s+/g, " ").slice(0, 400);
  const result = new Error(message);
  result.code = typeof error?.code === "string" ? error.code : "VERIFY_ERROR";
  result.file = error?.file && error.file.startsWith("scripts/") ? error.file : sourceName(file);
  return result;
}

/** Expand the two psql directives used by the self-contained smoke.
 * Includes are local repository files, resolved relative to the including SQL.
 * Unknown psql commands fail instead of silently skipping an assertion. */
export function readTestSql(file, ancestry = []) {
  const absolute = isAbsolute(file) ? resolve(file) : resolve(ROOT, file);
  const rel = relative(ROOT, absolute);
  if (rel.startsWith("..") || isAbsolute(rel)) throw new Error("SQL include must remain inside the repository");
  if (ancestry.includes(absolute)) throw new Error(`Circular SQL include: ${sourceName(absolute)}`);
  const variables = new Map();
  return readFileSync(absolute, "utf8").split(/\r?\n/).map((line) => {
    const directive = line.match(/^\s*\\(\S+)(?:\s+(.*))?$/);
    if (!directive) return line.replace(/(?<!:):([a-z_]+)\b/g, (token, name) => variables.get(name) ?? token);
    const [, command, raw = ""] = directive;
    if (command === "echo") return "-- psql echo omitted by isolated runner";
    if (command === "set" && raw.trim() === "ON_ERROR_STOP on") return "-- query errors already stop the isolated runner";
    if (command === "set") {
      const value = raw.match(/^([a-z_]+)\s+'''([a-f0-9-]{36})'''$/);
      if (!value) throw new Error(`Unsupported psql variable in ${sourceName(absolute)}`);
      variables.set(value[1], `'${value[2]}'`);
      return "-- fixture UUID variable";
    }
    if (command === "ir") {
      const target = raw.trim().replace(/^(['"])(.*)\1$/, "$2");
      if (!target || /[\r\n]/.test(target)) throw new Error(`Invalid SQL include in ${sourceName(absolute)}`);
      return readTestSql(resolve(dirname(absolute), target), [...ancestry, absolute]);
    }
    throw new Error(`Unsupported psql command \\${command} in ${sourceName(absolute)}`);
  }).join("\n");
}

/** Execute repository SQL in a caller-owned, isolated PGlite instance. */
export async function applySqlFile(pg, file) {
  const absolute = isAbsolute(file) ? resolve(file) : resolve(ROOT, file);
  try {
    await pg.exec(readTestSql(absolute));
  } catch (error) {
    throw compactError(error, absolute);
  }
}

/** Fresh in-memory PostgreSQL with the real migration chain and RLS policies.
 * policies.sql follows 0003, matching verify-db.sh / gen-apply.mjs ordering.
 * through=197 is useful for an actual pre-0198 baseline; no synthetic schema
 * or production credentials are used. Caller must await pg.close(). */
export async function createMigratedDatabase(through = Number.POSITIVE_INFINITY) {
  if (through !== Number.POSITIVE_INFINITY && (!Number.isInteger(through) || through < 3)) {
    throw new Error("through must be an integer >=3, or omitted for the entire migration chain");
  }
  const moduleUrl = localModuleUrl();
  if (!existsSync(fileURLToPath(moduleUrl))) {
    throw new Error("PGlite runtime not found; install it in ../.performance-tools or set PGLITE_MODULE to its local dist/index.js");
  }
  const [{ PGlite }, { pgcrypto }, { pg_trgm }] = await Promise.all([
    import(moduleUrl.href),
    import(new URL("./contrib/pgcrypto.js", moduleUrl).href),
    import(new URL("./contrib/pg_trgm.js", moduleUrl).href),
  ]);
  const pg = new PGlite({ extensions: { pgcrypto, pg_trgm }, debug: 0 });
  try {
    await pg.waitReady;
    await applySqlFile(pg, "scripts/sql/test_prelude.sql");
    const files = readdirSync(MIGRATIONS).filter((name) => /^\d{4}_.+\.sql$/.test(name)).sort();
    const numbers = files.map((name) => Number(name.slice(0, 4)));
    if (new Set(numbers).size !== numbers.length) throw new Error("Duplicate migration numbers in db/migrations");
    if (!numbers.includes(3)) throw new Error("Missing migration 0003: cannot establish policy ordering");
    for (const name of files) {
      if (Number(name.slice(0, 4)) > through) continue;
      await applySqlFile(pg, join(MIGRATIONS, name));
      if (name.startsWith("0003_")) await applySqlFile(pg, "supabase/policies.sql");
    }
    return pg;
  } catch (error) {
    await pg.close().catch(() => {});
    throw error;
  }
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes("--help")) {
    console.log("Usage: node scripts/verify-master-scaling.mjs [--smoke]\nDefault: verify all migrations in isolated in-memory PostgreSQL.\n--smoke: also verify Master aggregates, reapplication, rollback and RLS.");
    return;
  }
  if (args.some((arg) => arg !== "--smoke")) throw new Error("Unknown argument; use --help");
  const started = performance.now();
  console.log("[master-scaling] Applying all migrations and RLS policies to isolated PGlite");
  const pg = await createMigratedDatabase();
  try {
    const { rows } = await pg.query("select extname from pg_extension where extname in ('pgcrypto','pg_trgm') order by extname");
    if (rows.length !== 2) throw new Error("Required pgcrypto/pg_trgm extensions were not installed");
    console.log("[master-scaling] Fresh migration chain and extensions OK");
    if (args.includes("--smoke")) {
      await applySqlFile(pg, "scripts/sql/master_read_scaling_smoke.sql");
      console.log("[master-scaling] Mutation/backfill/reapply/rollback/RLS smoke OK");
    }
    console.log(JSON.stringify({ ok: true, isolated: true, smoke: args.includes("--smoke"), durationMs: Math.round(performance.now() - started) }));
  } finally {
    await pg.close();
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().catch((error) => {
    console.error(JSON.stringify({ ok: false, code: error?.code ?? "VERIFY_ERROR", file: error?.file ?? null, message: String(error?.message ?? error).replace(/\s+/g, " ").slice(0, 400) }));
    process.exitCode = 1;
  });
}

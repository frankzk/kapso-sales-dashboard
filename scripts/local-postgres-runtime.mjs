#!/usr/bin/env node
// Portable PostgreSQL for isolated multi-session tests on this Windows host.
// Dependencies live in ../.performance-tools, never the application's package.
// No .env, production connection URL, Windows service or prior-cluster deletion.
//   node scripts/local-postgres-runtime.mjs  # start, verify extensions, stop

import { spawn } from "node:child_process";
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const TOOLS = resolve(ROOT, "..", ".performance-tools");
const RUNS = join(TOOLS, "pg-runs");
const LOOPBACK = "127.0.0.1";
const pause = (ms) => new Promise((done) => setTimeout(done, ms));

function shortError(error) {
  return String(error?.message ?? error).replace(/\s+/g, " ").slice(0, 350);
}

function binaryEnvironment(binDirectory) {
  // initdb/postgres must not inherit PGHOST, PGOPTIONS, PGPASSWORD, etc.
  const env = {};
  for (const key of ["SystemRoot", "SYSTEMROOT", "WINDIR", "TEMP", "TMP", "COMSPEC", "PATHEXT"]) {
    if (process.env[key]) env[key] = process.env[key];
  }
  const systemRoot = env.SystemRoot ?? env.SYSTEMROOT ?? env.WINDIR ?? "C:\\Windows";
  env.PATH = [binDirectory, join(systemRoot, "System32"), systemRoot].join(";");
  env.LANG = "C";
  return env;
}

async function freePort() {
  const probe = createServer();
  await new Promise((done, fail) => {
    probe.once("error", fail);
    probe.listen(0, LOOPBACK, done);
  });
  const address = probe.address();
  await new Promise((done, fail) => probe.close((error) => error ? fail(error) : done()));
  if (!address || typeof address === "string") throw new Error("Unable to reserve an IPv4 test port");
  return address.port;
}

function runBinary(binary, args, { environment, logPath, timeoutMs = 45_000 }) {
  return new Promise((done, fail) => {
    const log = openSync(logPath, "a");
    const child = spawn(binary, args, {
      cwd: dirname(binary), env: environment, windowsHide: true, shell: false,
      stdio: ["ignore", log, log],
    });
    closeSync(log);
    const timer = setTimeout(() => {
      child.kill();
      fail(new Error(`${binary.split(/[\\/]/).at(-1)} exceeded its local test timeout; see ${logPath}`));
    }, timeoutMs);
    child.once("error", (error) => { clearTimeout(timer); fail(error); });
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      if (code === 0) done();
      else fail(new Error(`${binary.split(/[\\/]/).at(-1)} failed (exit ${code ?? signal}); see ${logPath}`));
    });
  });
}

/** Start a brand-new real PostgreSQL cluster, bound only to 127.0.0.1.
 * connect() creates an independent connected pg Client; caller should end it.
 * stop() is idempotent, closes remaining sessions and preserves cluster/logs.
 * Only application_name can be supplied; host/port/URL credentials cannot. */
export async function startLocalPostgres({ major = 16 } = {}) {
  if (![16, 18].includes(major)) throw new Error("Supported isolated PostgreSQL majors: 16, 18");
  const PACKAGE = major === 16
    ? join(TOOLS, "node_modules", "kapso-postgres-16")
    : join(TOOLS, "node_modules", "@embedded-postgres", "windows-x64");
  if (process.platform !== "win32" || process.arch !== "x64") {
    throw new Error("This portable runtime uses the installed Windows x64 PostgreSQL package");
  }
  const manifest = JSON.parse(readFileSync(join(PACKAGE, "package.json"), "utf8"));
  const [{ initdb, postgres, pg_ctl }, pgModule] = await Promise.all([
    import(pathToFileURL(join(PACKAGE, "dist", "index.js")).href),
    import(pathToFileURL(join(TOOLS, "node_modules", "pg", "esm", "index.mjs")).href),
  ]);
  const Client = pgModule.Client ?? pgModule.default?.Client;
  if (!Client || ![initdb, postgres, pg_ctl].every((path) => existsSync(path))) {
    throw new Error("Portable PostgreSQL binaries or pg Client are missing from .performance-tools");
  }
  // The inspected package postinstall only recreates these local symlinks.
  // This Windows package ships an empty list, so no install script is needed.
  const links = JSON.parse(readFileSync(join(PACKAGE, "native", "pg-symlinks.json"), "utf8"));
  if (!Array.isArray(links) || links.length) {
    throw new Error("Package symlink manifest changed; inspect it before hydrating links");
  }
  mkdirSync(RUNS, { recursive: true });
  const directory = mkdtempSync(join(RUNS, "concurrency-"));
  const dataDirectory = join(directory, "data");
  const logPath = join(directory, "postgres.log");
  const controlLog = join(directory, "control.log");
  const environment = binaryEnvironment(dirname(postgres));
  const port = await freePort();
  const clients = new Set();
  let server;
  let serverFailure;
  let exited = false;
  let stopped = false;
  let stopPromise;

  const makeClient = (database, applicationName, timeout = 10_000) => new Client({
    host: LOOPBACK, port, database, user: "postgres",
    // Truthy function suppresses pg's PGPASSWORD/pgpass fallback. The isolated
    // loopback cluster uses trust auth; this synthetic password is never sent.
    password: () => "isolated-local-test",
    ssl: false, sslnegotiation: "postgres", connectionTimeoutMillis: timeout,
    application_name: applicationName,
    client_encoding: "UTF8", options: "-c client_min_messages=warning",
  });

  const connect = async (database = "postgres", options = {}) => {
    if (stopped) throw new Error("Local PostgreSQL runtime is stopped");
    if (typeof database !== "string" || !/^[a-zA-Z_][a-zA-Z0-9_]{0,62}$/.test(database)) {
      throw new Error("Use a simple local database name, never a connection URL");
    }
    if (!options || typeof options !== "object" || Array.isArray(options)
      || Object.keys(options).some((key) => key !== "application_name")) {
      throw new Error("connect options only support application_name");
    }
    const applicationName = options.application_name ?? "kapso-local-concurrency";
    if (typeof applicationName !== "string" || applicationName.length > 63 || /[\r\n\0]/.test(applicationName)) {
      throw new Error("application_name must be a short plain string");
    }
    const client = makeClient(database, applicationName);
    client.on("error", () => {}); // errors surface through query/connect; no fatal unhandled shutdown event
    try {
      await client.connect();
      const { rows } = await client.query("select current_setting('data_directory') as directory");
      if (resolve(rows[0].directory).toLowerCase() !== resolve(dataDirectory).toLowerCase()) {
        throw new Error("Local port belongs to a different PostgreSQL cluster");
      }
      clients.add(client);
      client.once("end", () => clients.delete(client));
      return client;
    } catch (error) {
      await client.end().catch(() => {});
      throw error;
    }
  };

  const stop = () => {
    if (stopPromise) return stopPromise;
    stopped = true;
    stopPromise = (async () => {
      // Fast shutdown rolls back active test sessions. It cannot touch any
      // cluster other than the unique -D directory created in this invocation.
      if (server && !exited) {
        await runBinary(pg_ctl, ["-D", dataDirectory, "-m", "fast", "-w", "-t", "30", "stop"],
          { environment, logPath: controlLog, timeoutMs: 35_000 });
      }
      await Promise.allSettled([...clients].map((client) => client.end()));
      writeFileSync(join(directory, "stopped.json"), JSON.stringify({ stoppedAt: new Date().toISOString(), port }, null, 2));
    })();
    return stopPromise;
  };

  try {
    await runBinary(initdb, ["-D", dataDirectory, "-U", "postgres", "-A", "trust", "--encoding=UTF8", "--locale=C"],
      { environment, logPath: join(directory, "initdb.log") });
    const log = openSync(logPath, "a");
    server = spawn(postgres, [
      "-D", dataDirectory, "-p", String(port), "-c", `listen_addresses=${LOOPBACK}`,
      "-c", "unix_socket_directories=", "-c", "max_connections=64", "-c", "shared_buffers=64MB",
      "-c", "log_statement=none", "-c", "log_min_error_statement=panic",
    ], { cwd: dirname(postgres), env: environment, windowsHide: true, shell: false, stdio: ["ignore", log, log] });
    closeSync(log);
    server.once("error", (error) => { serverFailure = error; exited = true; });
    server.once("exit", (code, signal) => {
      exited = true;
      if (!stopped && !serverFailure) serverFailure = new Error(`Local postgres exited (${code ?? signal}); see ${logPath}`);
    });
    const deadline = Date.now() + 40_000;
    let ready = false;
    while (Date.now() < deadline) {
      if (serverFailure) throw serverFailure;
      const probe = makeClient("postgres", "kapso-local-startup", 750);
      probe.on("error", () => {});
      try {
        await probe.connect();
        ready = true;
      } catch {
        // Local process startup only; never retry a remote host.
      } finally {
        await probe.end().catch(() => {});
      }
      if (ready) break;
      await pause(150);
    }
    if (!ready) throw new Error(`Local postgres did not become ready; see ${logPath}`);
    const initial = await connect("postgres", { application_name: "kapso-local-runtime-check" });
    let version;
    try {
      ({ rows: [{ version }] } = await initial.query("select version() as version"));
      const { rows: [{ server_major }] } = await initial.query("select current_setting('server_version_num')::int / 10000 as server_major");
      if (server_major !== major) throw new Error("Portable package server version does not match requested major");
      await initial.query("create extension if not exists pgcrypto; create extension if not exists pg_trgm");
      const { rows } = await initial.query("select extname from pg_extension where extname in ('pgcrypto','pg_trgm') order by extname");
      if (rows.length !== 2) throw new Error("Required local PostgreSQL extensions were not installed");
    } finally {
      await initial.end();
    }
    writeFileSync(join(directory, "runtime.json"), JSON.stringify({
      version, packageVersion: manifest.version, host: LOOPBACK, port, directory, dataDirectory,
      startedAt: new Date().toISOString(), runtimePackage: relative(TOOLS, PACKAGE),
    }, null, 2));
    return { connect, stop, port, directory, version, packageVersion: manifest.version };
  } catch (error) {
    await stop().catch(() => {});
    const failure = new Error(shortError(error));
    failure.code = error?.code ?? "LOCAL_POSTGRES_ERROR";
    failure.directory = directory;
    throw failure;
  }
}

async function main() {
  const runtime = await startLocalPostgres();
  try {
    console.log(JSON.stringify({ ok: true, localOnly: true, version: runtime.version,
      packageVersion: runtime.packageVersion, port: runtime.port, directory: runtime.directory,
      extensions: ["pgcrypto", "pg_trgm"] }));
  } finally {
    await runtime.stop();
    console.log("Local PostgreSQL stopped; cluster and logs preserved.");
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().catch((error) => {
    console.error(JSON.stringify({ ok: false, code: error?.code ?? "LOCAL_POSTGRES_ERROR",
      directory: error?.directory ?? null, message: shortError(error) }));
    process.exitCode = 1;
  });
}

// Una base en memoria con lo que usa «Llamar con Anura» (lib/anura/*): el
// encadenado de supabase-js (select/insert/update/upsert/delete con eq, in,
// lt, lte, gt, gte, like, is, not, order, limit, maybeSingle), los tres índices únicos de
// `anura_calls` (cdrid; una viva por persona, 0310; una viva por anexo, 0313), las tablas
// SIP de la 0311, las líneas compartidas y «Puede llamar con Anura» de la 0313 y Storage.
// Sin red.

type Row = Record<string, any>;

const KNOWN = [
  "anura_calls",
  "anura_extensions",
  "anura_webhook_events",
  "anura_sip_settings",
  "anura_sip_credentials",
  "order_events",
  "order_master",
  "stores",
  "memberships",
  "anura_callers",
  "user_permissions",
  "membership_roles",
] as const;
export type FakeTables = { [table: string]: Row[] } & Record<(typeof KNOWN)[number], Row[]>;

export interface FakeDb {
  tables: FakeTables;
  uploads: { bucket: string; path: string; bytes: number; contentType?: string }[];
  client: any;
}

function value(row: Row, col: string): unknown {
  const m = /^(\w+)->>(\w+)$/.exec(col);
  if (m) {
    const v = row[m[1]!]?.[m[2]!];
    return v === undefined || v === null ? null : String(v);
  }
  return row[col];
}

/** El índice único que rompería la fila, o null. Con su nombre, como lo dice Postgres. */
function uniqueViolation(table: string, rows: Row[], candidate: Row, selfId?: string): string | null {
  if (table === "anura_calls") {
    const others = rows.filter((r) => r.id !== selfId);
    if (candidate.anura_call_id && others.some((r) => r.org_id === candidate.org_id && r.anura_call_id === candidate.anura_call_id)) return "anura_calls_cdr_uniq";
    const outLive = (r: Row) => (r.status_rank ?? 0) < 100 && (r.mode === "pedido" || r.mode === "prueba");
    const live = (r: Row) => outLive(r) && r.user_id;
    if (live(candidate) && others.some((r) => live(r) && r.user_id === candidate.user_id)) return "anura_calls_one_active_per_user";
    const onLine = (r: Row) => outLive(r) && r.extension;
    if (onLine(candidate) && others.some((r) => onLine(r) && r.org_id === candidate.org_id && r.extension === candidate.extension)) {
      return "anura_calls_one_active_per_extension";
    }
  }
  if (table === "anura_extensions") {
    const others = rows.filter((r) => r.id !== selfId);
    if (others.some((r) => r.org_id === candidate.org_id && r.extension === candidate.extension)) return "anura_extensions_extension_uniq";
    // Una línea compartida no tiene dueña (user_id null): los null no chocan.
    if (candidate.user_id && others.some((r) => r.org_id === candidate.org_id && r.user_id === candidate.user_id)) return "anura_extensions_user_uniq";
  }
  if (table === "anura_callers") {
    const others = rows.filter((r) => r.id !== selfId);
    if (others.some((r) => r.org_id === candidate.org_id && r.user_id === candidate.user_id)) return "anura_callers_user_uniq";
  }
  return null;
}

const duplicate = (index: string) => ({ data: null, error: { code: "23505", message: `duplicate key value violates unique constraint "${index}"` } });

const DEFAULTS: Record<string, () => Row> = {
  anura_calls: () => ({
    status: "solicitada",
    status_rank: 0,
    closed_by_timeout: false,
    recording_status: "sin_grabacion",
    recording_attempts: 0,
    recording_path: null,
    recording_expires_at: null,
    anura_call_id: null,
    user_id: null,
    store_id: null,
    order_id: null,
    started_at: null,
    answered_at: null,
    ended_at: null,
    last_event_at: null,
    bill_seconds: null,
    failure_reason: null,
    requested_at: new Date().toISOString(),
    reserved_at: null,
    dialed_at: null,
  }),
  anura_extensions: () => ({ active: true, pool: false, user_id: null }),
  anura_callers: () => ({ enabled: true }),
  anura_sip_settings: () => ({ ws_url: "wss://sipwss.anura.pe", sip_port: 55090, sip_domain: null, updated_at: new Date().toISOString() }),
  anura_sip_credentials: () => ({ rejected_at: null, rejected_reason: null, saved_at: new Date().toISOString() }),
};

let seq = 0;
function newId(): string {
  seq += 1;
  return `00000000-0000-4000-8000-${String(seq).padStart(12, "0")}`;
}

export interface FakeDbOptions {
  /** Usa estas tablas tal cual (para un cliente «RLS» sobre la misma base). */
  shared?: FakeTables;
  /** Lo que el cliente puede LEER (simula RLS). */
  visible?: (table: string, row: Row) => boolean;
}

export function createFakeDb(initial: Record<string, Row[]> = {}, opts: FakeDbOptions = {}): FakeDb {
  const tables = (opts.shared ?? {}) as FakeTables;
  if (!opts.shared) {
    for (const k of KNOWN) tables[k] = [];
    for (const [k, v] of Object.entries(initial)) tables[k] = v.map((r) => ({ ...r }));
  }
  const uploads: FakeDb["uploads"] = [];

  const from = (table: string) => {
    const filters: ((r: Row) => boolean)[] = [];
    let op: "select" | "insert" | "update" | "delete" | "upsert" = "select";
    let payload: any = null;
    let onConflict: string[] = [];
    let wantRows = op === "select";
    let single = false;
    let limit: number | null = null;
    let orderBy: { col: string; asc: boolean } | null = null;

    const rows = () => (tables[table] ??= []);
    const matches = (r: Row) => filters.every((f) => f(r));

    const run = (): { data: any; error: any } => {
      const list = rows();
      if (op === "insert") {
        const items = (Array.isArray(payload) ? payload : [payload]).map((p: Row) => ({ id: p.id ?? newId(), ...(DEFAULTS[table]?.() ?? {}), ...p }));
        for (const item of items) {
          const clash = uniqueViolation(table, list, item);
          if (clash) return duplicate(clash);
        }
        list.push(...items);
        return { data: wantRows ? items.map((r: Row) => ({ ...r })) : null, error: null };
      }
      if (op === "upsert") {
        const p = payload as Row;
        const existing = list.find((r) => onConflict.every((c) => r[c] === p[c]));
        if (existing) {
          const next = { ...existing, ...p };
          const clash = uniqueViolation(table, list, next, existing.id);
          if (clash) return duplicate(clash);
          Object.assign(existing, p);
          return { data: wantRows ? [{ ...existing }] : null, error: null };
        }
        const item = { id: newId(), ...(DEFAULTS[table]?.() ?? {}), ...p };
        const clash = uniqueViolation(table, list, item);
        if (clash) return duplicate(clash);
        list.push(item);
        return { data: wantRows ? [{ ...item }] : null, error: null };
      }
      if (op === "update") {
        const hit = list.filter(matches);
        for (const r of hit) {
          const next = { ...r, ...payload };
          const clash = uniqueViolation(table, list, next, r.id);
          if (clash) return duplicate(clash);
        }
        for (const r of hit) Object.assign(r, payload);
        return { data: wantRows ? hit.map((r) => ({ ...r })) : null, error: null };
      }
      if (op === "delete") {
        const hit = list.filter(matches);
        tables[table] = list.filter((r) => !matches(r));
        return { data: wantRows ? hit.map((r) => ({ ...r })) : null, error: null };
      }
      let out = list.filter((r) => matches(r) && (!opts.visible || opts.visible(table, r))).map((r) => ({ ...r }));
      if (orderBy) {
        const { col, asc } = orderBy;
        out.sort((a, b) => (a[col] === b[col] ? 0 : (a[col] > b[col] ? 1 : -1) * (asc ? 1 : -1)));
      }
      if (limit !== null) out = out.slice(0, limit);
      if (single) return { data: out[0] ?? null, error: null };
      return { data: out, error: null };
    };

    const q: any = {
      select: () => {
        wantRows = true;
        return q;
      },
      insert: (p: any) => {
        op = "insert";
        payload = p;
        wantRows = false;
        return q;
      },
      upsert: (p: any, opts?: { onConflict?: string }) => {
        op = "upsert";
        payload = p;
        onConflict = (opts?.onConflict ?? "id").split(",").map((s) => s.trim());
        wantRows = false;
        return q;
      },
      update: (p: any) => {
        op = "update";
        payload = p;
        wantRows = false;
        return q;
      },
      delete: () => {
        op = "delete";
        wantRows = false;
        return q;
      },
      eq: (col: string, v: unknown) => {
        filters.push((r) => value(r, col) === v || (typeof v !== "string" && value(r, col) === v));
        return q;
      },
      in: (col: string, vs: unknown[]) => {
        filters.push((r) => vs.includes(value(r, col)));
        return q;
      },
      lt: (col: string, v: any) => {
        filters.push((r) => value(r, col) !== null && value(r, col) !== undefined && (value(r, col) as any) < v);
        return q;
      },
      gte: (col: string, v: any) => {
        filters.push((r) => value(r, col) !== null && value(r, col) !== undefined && (value(r, col) as any) >= v);
        return q;
      },
      lte: (col: string, v: any) => {
        filters.push((r) => value(r, col) !== null && value(r, col) !== undefined && (value(r, col) as any) <= v);
        return q;
      },
      gt: (col: string, v: any) => {
        filters.push((r) => value(r, col) !== null && value(r, col) !== undefined && (value(r, col) as any) > v);
        return q;
      },
      like: (col: string, pattern: string) => {
        const re = new RegExp(`^${pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/%/g, ".*").replace(/_/g, ".")}$`, "s");
        filters.push((r) => typeof value(r, col) === "string" && re.test(value(r, col) as string));
        return q;
      },
      is: (col: string, v: unknown) => {
        filters.push((r) => (value(r, col) ?? null) === v);
        return q;
      },
      not: (col: string, operator: string, v: unknown) => {
        if (operator === "is" && v === null) filters.push((r) => value(r, col) !== null && value(r, col) !== undefined);
        return q;
      },
      order: (col: string, opts?: { ascending?: boolean }) => {
        orderBy = { col, asc: opts?.ascending ?? true };
        return q;
      },
      limit: (n: number) => {
        limit = n;
        return q;
      },
      maybeSingle: () => {
        single = true;
        return q;
      },
      single: () => {
        single = true;
        return q;
      },
      then: (ok: any, ko: any) => Promise.resolve(run()).then(ok, ko),
    };
    return q;
  };

  const storage = {
    createBucket: async () => ({ data: null, error: null }),
    from: (bucket: string) => ({
      upload: async (path: string, bytes: Uint8Array, opts?: { contentType?: string }) => {
        uploads.push({ bucket, path, bytes: bytes.byteLength, contentType: opts?.contentType });
        return { data: { path }, error: null };
      },
      createSignedUrl: async (path: string, seconds: number) => ({
        data: { signedUrl: `https://storage.test/${bucket}/${path}?expires=${seconds}` },
        error: null,
      }),
    }),
  };

  const client = {
    from,
    storage,
    auth: { admin: { getUserById: async (id: string) => ({ data: { user: { email: `persona-${id.slice(-4)}@kapta.test` } } }) } },
  };
  return { tables, uploads, client };
}

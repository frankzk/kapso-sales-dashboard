import { describe, expect, it } from "vitest";
import {
  PUSH_BATCH,
  PUSH_MIN_BATCH,
  ageLabel,
  formatCoverageMessage,
  pendingCoverageLeads,
  recordCoveragePush,
  type PendingLead,
} from "@/lib/coverage-push";
import { ACTIVE_EXPERIMENT } from "@/lib/lead-experiment";

type Fila = Record<string, unknown>;

/**
 * Una base de mentira con la superficie que usa la entrega: `select` encadenado
 * con `.eq/.in/.order/.limit` y un `insert`.
 *
 * Los filtros se aplican de verdad —no se ignoran— porque justamente lo que hay
 * que probar es a QUIÉN deja fuera cada uno: un fake permisivo dejaría pasar la
 * regresión de volver a mandar un lead ya empujado.
 */
function fakeAdmin(tablas: Record<string, Fila[]>) {
  const inserts: { tabla: string; filas: Fila[] }[] = [];
  let insertError: { code: string } | null = null;
  const admin = {
    from(tabla: string) {
      let filas = [...(tablas[tabla] ?? [])];
      const q: any = {
        select: () => q,
        eq: (col: string, v: unknown) => {
          filas = filas.filter((f) => f[col] === v);
          return q;
        },
        in: (col: string, vs: unknown[]) => {
          filas = filas.filter((f) => vs.includes(f[col]));
          return q;
        },
        order: (col: string, o?: { ascending?: boolean }) => {
          const dir = o?.ascending === false ? -1 : 1;
          filas.sort((a, b) => (String(a[col] ?? "") < String(b[col] ?? "") ? -dir : dir));
          return q;
        },
        limit: (n: number) => {
          filas = filas.slice(0, n);
          return q;
        },
        insert: (nuevas: Fila[]) => {
          if (!insertError) inserts.push({ tabla, filas: nuevas });
          return Promise.resolve({ error: insertError, data: null });
        },
        then: (res: (v: { data: Fila[]; error: null }) => unknown) =>
          res({ data: filas, error: null }),
      };
      return q;
    },
  };
  return {
    admin: admin as never,
    inserts,
    failInsert: (code: string) => {
      insertError = { code };
    },
  };
}

const T0 = Date.parse("2026-09-08T15:00:00.000Z");
const hace = (h: number) => new Date(T0 - h * 3_600_000).toISOString();

/** Un lead del brazo de tratamiento, elegible y sin tocar. */
function mundo(over: { pushes?: Fila[]; calls?: Fila[]; leads?: Fila[] } = {}) {
  return fakeAdmin({
    lead_experiments: [
      { lead_id: "L1", arm: "tratamiento", store_id: "S", experiment: ACTIVE_EXPERIMENT, assigned_at: hace(3) },
      { lead_id: "L2", arm: "tratamiento", store_id: "S", experiment: ACTIVE_EXPERIMENT, assigned_at: hace(2) },
      { lead_id: "C1", arm: "control", store_id: "S", experiment: ACTIVE_EXPERIMENT, assigned_at: hace(2) },
    ],
    leads: over.leads ?? [
      { id: "L1", name: "Ana", phone: "51900000001", first_seen_at: hace(3), status: "nuevo" },
      { id: "L2", name: "Beto", phone: "51900000002", first_seen_at: hace(2), status: "nuevo" },
      { id: "C1", name: "Caro", phone: "51900000003", first_seen_at: hace(2), status: "nuevo" },
    ],
    lead_calls: over.calls ?? [],
    lead_coverage_pushes: over.pushes ?? [],
  });
}

describe("ageLabel", () => {
  it("minutos por debajo de la hora, horas hasta dos días, días después", () => {
    expect(ageLabel(hace(0.5), T0)).toBe("30 min");
    expect(ageLabel(hace(3), T0)).toBe("3 h");
    expect(ageLabel(hace(47), T0)).toBe("47 h");
    expect(ageLabel(hace(72), T0)).toBe("3 d");
  });

  it("nunca dice «0 min»: un lead recién entrado tiene edad, no cero", () => {
    expect(ageLabel(hace(0), T0)).toBe("1 min");
    expect(ageLabel(hace(0.001), T0)).toBe("1 min");
  });

  it("sin fecha usable devuelve vacío en vez de «NaN»", () => {
    expect(ageLabel(null, T0)).toBe("");
    expect(ageLabel(undefined, T0)).toBe("");
    expect(ageLabel("roto", T0)).toBe("");
  });

  // Un reloj que va atrás (o una fecha del futuro por un desfase de ingreso) no
  // puede imprimir una edad negativa en la lista de trabajo.
  it("una fecha futura no imprime edad negativa", () => {
    expect(ageLabel(new Date(T0 + 3_600_000).toISOString(), T0)).toBe("1 min");
  });
});

describe("formatCoverageMessage", () => {
  const leads: PendingLead[] = [
    { id: "a1", name: "Ana", phone: "51900000001", first_seen_at: hace(3) },
    { id: "b2", name: null, phone: "51900000002", first_seen_at: hace(1.5) },
  ];

  it("una línea por lead, con enlace a la ficha", () => {
    const txt = formatCoverageMessage("Kenku", leads, "https://kapta.app", T0);
    expect(txt).toContain("Ana · 3 h");
    expect(txt).toContain("https://kapta.app/dashboard/leads?open=a1");
    expect(txt).toContain("https://kapta.app/dashboard/leads?open=b2");
    expect(txt).toContain("2 leads por llamar");
  });

  // EL ENLACE NO ES COMODIDAD. Si la asesora marca desde su móvil sin pasar por
  // Kapta no queda fila en `lead_calls`, y el análisis cuenta ese lead como NO
  // llamado: el experimento mediría cero cumplimiento con el trabajo hecho.
  it("todos los leads llevan enlace, no solo el primero", () => {
    const txt = formatCoverageMessage("Kenku", leads, "https://kapta.app", T0);
    expect(txt.match(/\/dashboard\/leads\?open=/g)).toHaveLength(leads.length);
    expect(txt).toContain("quede registrada la gestión");
  });

  it("sin nombre cae al teléfono en vez de dejar la línea coja", () => {
    const txt = formatCoverageMessage("Kenku", leads, "https://kapta.app", T0);
    expect(txt).toContain("51900000002");
  });

  // NO PUEDE DECIR QUE ES UNA PRUEBA. Es la lección de v1: marcar un lead como
  // experimento hizo que se llamara MENOS (23,5% contra 34,3%, p ≈ 0,04). El
  // mensaje pide llamar, y ya.
  it("no menciona el experimento por ningún lado", () => {
    const txt = formatCoverageMessage("Kenku", leads, "https://kapta.app", T0).toLowerCase();
    for (const palabra of ["prueba", "experimento", "test", "🧪", "medir", "midiendo", "control"]) {
      expect(txt).not.toContain(palabra);
    }
  });

  // Se manda con `parse_mode: "HTML"` y los nombres los escribe el cliente por
  // WhatsApp. Un `<` sin escapar no rompe su línea: Telegram devuelve 400 y NO
  // MANDA NADA, así que un solo nombre raro dejaría la tanda entera sin llamar
  // — y el experimento contaría esa cobertura como incumplimiento.
  it("escapa el HTML de lo que viene de la base", () => {
    const txt = formatCoverageMessage(
      "Kenku & Co",
      [{ id: "x", name: "<b>Ana</b> & Co", phone: null, first_seen_at: hace(1) }],
      "https://kapta.app",
      T0,
    );
    expect(txt).not.toContain("<b>");
    expect(txt).toContain("&lt;b&gt;");
    expect(txt).toContain("Kenku &amp; Co");
  });

  it("el singular no dice «1 leads»", () => {
    const txt = formatCoverageMessage("Kenku", [leads[0]!], "https://kapta.app", T0);
    expect(txt).toContain("1 lead por llamar");
    expect(txt).not.toContain("1 leads");
  });
});

describe("pendingCoverageLeads", () => {
  it("solo el brazo de tratamiento: el control no recibe nada", async () => {
    const { admin } = mundo();
    const out = await pendingCoverageLeads(admin, "S");
    expect(out.map((l) => l.id)).toEqual(["L1", "L2"]);
  });

  // Si un lead ya llamado volviera a salir, la lista traería trabajo hecho y se
  // leería por encima — que es como muere un canal.
  it("no manda al que ya recibió un toque humano", async () => {
    const { admin } = mundo({ calls: [{ lead_id: "L1", kind: "call" }] });
    const out = await pendingCoverageLeads(admin, "S");
    expect(out.map((l) => l.id)).toEqual(["L2"]);
  });

  // El 51,3% de `lead_calls` es `kind='system'` —drip, winback, secuencias de
  // carrito—. Contarlo como llamada dejaría FUERA del envío justo a los leads
  // que nadie ha tocado, y el tratamiento no se administraría a nadie.
  it("un drip no es una llamada", async () => {
    const { admin } = mundo({ calls: [{ lead_id: "L1", kind: "system" }] });
    const out = await pendingCoverageLeads(admin, "S");
    expect(out.map((l) => l.id)).toEqual(["L1", "L2"]);
  });

  // Sin esto un lead que nadie llama vuelve a salir cada dos horas para siempre:
  // no es insistir, es enseñar a ignorar el canal.
  it("no repite al que ya salió en una lista", async () => {
    const { admin } = mundo({
      pushes: [{ lead_id: "L1", experiment: ACTIVE_EXPERIMENT, store_id: "S" }],
    });
    const out = await pendingCoverageLeads(admin, "S");
    expect(out.map((l) => l.id)).toEqual(["L2"]);
  });

  // El registro de otro experimento no puede silenciar a este.
  it("el empujón de otro experimento no cuenta", async () => {
    const { admin } = mundo({
      pushes: [{ lead_id: "L1", experiment: "otro_exp", store_id: "S" }],
    });
    const out = await pendingCoverageLeads(admin, "S");
    expect(out.map((l) => l.id)).toEqual(["L1", "L2"]);
  });

  // Un lead cerrado —vendido, cancelado, lista negra— no se llama por mucho que
  // le tocara el tratamiento. Seguirá contando como NO llamado en el análisis, y
  // eso es lo correcto: el tratamiento no se pudo administrar.
  it("no manda al que ya está cerrado", async () => {
    const { admin } = mundo({
      leads: [
        { id: "L1", name: "Ana", phone: "1", first_seen_at: hace(3), status: "cancelado" },
        { id: "L2", name: "Beto", phone: "2", first_seen_at: hace(2), status: "nuevo" },
      ],
    });
    const out = await pendingCoverageLeads(admin, "S");
    expect(out.map((l) => l.id)).toEqual(["L2"]);
  });

  it("los más antiguos primero, y como mucho una tanda", async () => {
    const { admin } = mundo();
    const out = await pendingCoverageLeads(admin, "S", 1);
    expect(out.map((l) => l.id)).toEqual(["L1"]);
    expect(PUSH_BATCH).toBeGreaterThanOrEqual(PUSH_MIN_BATCH);
  });

  it("sin nadie asignado no consulta de más ni revienta", async () => {
    const { admin } = fakeAdmin({ lead_experiments: [], leads: [], lead_calls: [] });
    expect(await pendingCoverageLeads(admin, "S")).toEqual([]);
  });

  // LA VENTANA MIRA A LOS RECIENTES, y de esto depende que el envío siga vivo
  // dentro de un mes. Los ya empujados se descartan en memoria pero siguen
  // ocupando sitio en los 400 que se piden: si se pidieran los MÁS ANTIGUOS, a
  // los ~8 días (~51 tratados/día) los 400 huecos serían todos leads ya
  // entregados y los nuevos no entrarían jamás. El envío se apagaría solo, sin
  // error y sin que nadie lo note, y el experimento se quedaría otra vez sin
  // tratamiento. Con 401 asignados y 400 ya empujados, el que falta es el nuevo.
  it("el lead nuevo entra aunque haya 400 entregados por delante", async () => {
    const viejos = Array.from({ length: 400 }, (_, i) => ({
      lead_id: `V${String(i).padStart(3, "0")}`,
      arm: "tratamiento",
      store_id: "S",
      experiment: ACTIVE_EXPERIMENT,
      assigned_at: new Date(T0 - (400 - i) * 3_600_000).toISOString(),
    }));
    const { admin } = fakeAdmin({
      lead_experiments: [
        ...viejos,
        {
          lead_id: "NUEVO",
          arm: "tratamiento",
          store_id: "S",
          experiment: ACTIVE_EXPERIMENT,
          assigned_at: new Date(T0).toISOString(),
        },
      ],
      leads: [
        ...viejos.map((v) => ({
          id: v.lead_id,
          name: v.lead_id,
          phone: "1",
          first_seen_at: v.assigned_at,
          status: "nuevo",
        })),
        { id: "NUEVO", name: "Nuevo", phone: "9", first_seen_at: hace(0.2), status: "nuevo" },
      ],
      lead_calls: [],
      lead_coverage_pushes: viejos.map((v) => ({
        lead_id: v.lead_id,
        experiment: ACTIVE_EXPERIMENT,
        store_id: "S",
      })),
    });
    const out = await pendingCoverageLeads(admin, "S");
    expect(out.map((l) => l.id)).toEqual(["NUEVO"]);
  });
});

describe("recordCoveragePush", () => {
  it("apunta lead, tienda y experimento", async () => {
    const { admin, inserts } = mundo();
    const n = await recordCoveragePush(admin, "S", ["L1", "L2"]);
    expect(n).toBe(2);
    expect(inserts[0]!.tabla).toBe("lead_coverage_pushes");
    expect(inserts[0]!.filas).toEqual([
      { lead_id: "L1", store_id: "S", experiment: ACTIVE_EXPERIMENT },
      { lead_id: "L2", store_id: "S", experiment: ACTIVE_EXPERIMENT },
    ]);
  });

  // 23505 = choque con la PK, o sea que otra pasada ya lo apuntó. No es un fallo
  // sino la garantía de "una sola vez" funcionando.
  it("un choque de PK no es un error", async () => {
    const { admin, failInsert } = mundo();
    failInsert("23505");
    expect(await recordCoveragePush(admin, "S", ["L1"])).toBe(2 - 1);
  });

  it("otro error sí cuenta como no apuntado", async () => {
    const { admin, failInsert } = mundo();
    failInsert("42501");
    expect(await recordCoveragePush(admin, "S", ["L1"])).toBe(0);
  });

  it("sin leads no escribe nada", async () => {
    const { admin, inserts } = mundo();
    expect(await recordCoveragePush(admin, "S", [])).toBe(0);
    expect(inserts).toHaveLength(0);
  });
});

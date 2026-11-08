// «Llamar con Anura», fase 1: la ficha y Ajustes › Telefonía Anura (MOM §8.7).
// Se fija el cableado (qué llama cada pantalla y qué NO enseña) y, sobre todo,
// la FRONTERA del bundle del cliente: un módulo server-only importado en valor
// desde algo que entra al navegador rompe `next build` en Vercel (pasó el
// 04-11-2026 con lib/agent-names.ts) y ni tsc ni vitest lo ven.

import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  ANURA_PANEL_STEPS,
  ANURA_START_ERROR_TITLE,
  anuraCallForEntry,
  anuraEndedFollowUp,
  anuraEndedLine,
  anuraRecordingNote,
  anuraStartErrorTitle,
} from "@/lib/anura/ui";
import { CLICK2DIAL_ERROR_TEXT } from "@/lib/anura/click2dial";
import { anuraReachedHistory } from "@/lib/anura/events";
import { timelineFact, timelineOriginLabel } from "@/lib/order-timeline-fact";

const ROOT = path.resolve(__dirname, "..");
const read = (file: string) => readFileSync(path.join(ROOT, file), "utf8");

// ---------------------------------------------------------------------------
// La frontera del cliente
// ---------------------------------------------------------------------------

/** Las importaciones EN VALOR de un archivo (sin `import type` ni `export type`). */
function valueImports(src: string): string[] {
  const out: string[] = [];
  const stmt = /(?:^|\n)\s*(import|export)\s+([\s\S]*?)\s+from\s+["']([^"']+)["']/g;
  for (const m of src.matchAll(stmt)) {
    const clause = m[2]!.trim();
    if (/^type\s/.test(clause)) continue;
    if (m[1] === "export" && !/^[{*]/.test(clause)) continue;
    // `import { type A, type B }`: solo tipos.
    const braces = clause.match(/^\{([\s\S]*)\}$/);
    if (braces && braces[1]!.split(",").map((s) => s.trim()).filter(Boolean).every((s) => s.startsWith("type "))) continue;
    out.push(m[3]!);
  }
  for (const m of src.matchAll(/(?:^|\n)\s*import\s+["']([^"']+)["']/g)) out.push(m[1]!);
  for (const m of src.matchAll(/\bimport\(\s*["']([^"']+)["']\s*\)/g)) out.push(m[1]!);
  return out;
}

function resolveLocal(from: string, spec: string): string | null {
  let base: string;
  if (spec.startsWith("@/")) base = path.join(ROOT, spec.slice(2));
  else if (spec.startsWith(".")) base = path.resolve(path.dirname(from), spec);
  else return null;
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, path.join(base, "index.ts"), path.join(base, "index.tsx")]) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  return null;
}

const isServerActionFile = (src: string) => /^\s*(?:\/\/[^\n]*\n|\s)*["']use server["']/.test(src);

/**
 * Lo que llega al bundle del navegador desde `entry`: se siguen las
 * importaciones en valor; un archivo `"use server"` es la frontera (el cliente
 * solo recibe referencias a sus acciones). Devuelve los archivos alcanzados
 * que son server-only o (con `node`, el valor por omisión) cargan módulos de
 * Node. Es una aproximación por texto: cuenta como valor un nombre importado
 * que solo se usa como tipo, así que en la ficha y en Ajustes, que ya traían
 * módulos así antes de Anura, solo se mira `server-only`.
 */
function serverOnlyReachedFrom(entry: string, opts: { node?: boolean } = {}): string[] {
  const seen = new Set<string>();
  const bad: string[] = [];
  const stack = [path.join(ROOT, entry)];
  while (stack.length) {
    const file = stack.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    const src = readFileSync(file, "utf8");
    if (file !== path.join(ROOT, entry) && isServerActionFile(src)) continue;
    const specs = valueImports(src);
    const nodeModule = (opts.node ?? true) && specs.some((s) => s.startsWith("node:"));
    if (specs.includes("server-only") || nodeModule) bad.push(path.relative(ROOT, file));
    for (const spec of specs) {
      const next = resolveLocal(file, spec);
      if (next && /\.(ts|tsx)$/.test(next)) stack.push(next);
    }
  }
  return bad;
}

describe("la frontera del cliente: nada server-only llega al navegador", () => {
  const CLIENT_ENTRIES = [
    "components/anura-call.tsx",
    "components/anura-settings-section.tsx",
    "lib/anura/ui.ts",
    "lib/anura/events.ts",
    // Fase 2: el teléfono dentro de Kapta.
    "components/anura-phone.tsx",
    "components/anura-kapta-phone-settings.tsx",
    "lib/anura/phone-ui.ts",
    "lib/anura/sip-phone.ts",
    "lib/anura/sip.ts",
    "lib/anura/jssip-client.ts",
    // Las líneas compartidas (0313).
    "components/anura-pool-settings.tsx",
    "lib/anura/pool.ts",
  ];

  it.each(CLIENT_ENTRIES)("%s no alcanza ningún módulo server-only ni de Node en valor", (entry) => {
    expect(serverOnlyReachedFrom(entry)).toEqual([]);
  });

  it.each(["components/order-drawer.tsx", "components/store-settings.tsx"])("%s no alcanza ningún módulo server-only en valor", (entry) => {
    expect(serverOnlyReachedFrom(entry, { node: false })).toEqual([]);
  });

  it("los componentes son de cliente y del servidor de Anura solo toman tipos", () => {
    const SERVER_MODULES = ["server", "calls", "click2dial", "recording", "token", "webhook"].map((m) => `@/lib/anura/${m}`);
    for (const file of [
      "components/anura-call.tsx",
      "components/anura-settings-section.tsx",
      "components/anura-phone.tsx",
      "components/anura-kapta-phone-settings.tsx",
      "components/anura-pool-settings.tsx",
      "lib/anura/ui.ts",
      "lib/anura/phone-ui.ts",
      "lib/anura/pool.ts",
      "components/order-drawer.tsx",
      "components/store-settings.tsx",
    ]) {
      const src = read(file);
      if (file.startsWith("components/")) expect(src.startsWith('"use client";')).toBe(true);
      for (const spec of valueImports(src)) expect(SERVER_MODULES).not.toContain(spec);
      for (const bad of ["@/lib/db", "@/lib/agent-names", "@/lib/access", "@/lib/permissions-access", "@/lib/env"]) {
        expect(valueImports(src)).not.toContain(bad);
      }
    }
  });

  it("el detector ve una importación en valor y deja pasar las de tipos", () => {
    expect(valueImports('import { a } from "@/lib/x";\nimport type { B } from "@/lib/y";\nimport { type C } from "@/lib/z";\nimport "server-only";')).toEqual(["@/lib/x", "server-only"]);
    expect(valueImports('export type { A } from "@/lib/y";\nexport { b } from "@/lib/w";')).toEqual(["@/lib/w"]);
    // Y sabe que lib/anura/server.ts sí es server-only (si no, el test no prueba nada).
    expect(serverOnlyReachedFrom("lib/anura/server.ts")).toContain("lib/anura/server.ts");
  });

  it("las acciones que usa el cliente son archivos `use server`", () => {
    for (const file of ["app/dashboard/pedidos/anura-actions.ts", "app/dashboard/[storeId]/settings/anura-actions.ts"]) {
      expect(isServerActionFile(read(file))).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// Los textos
// ---------------------------------------------------------------------------

describe("los avisos de la ficha", () => {
  it("cada fallo de Click2Dial tiene título y detalle en español", () => {
    for (const kind of Object.keys(CLICK2DIAL_ERROR_TEXT) as (keyof typeof CLICK2DIAL_ERROR_TEXT)[]) {
      expect(ANURA_START_ERROR_TITLE[kind]).toBeTruthy();
    }
    expect(anuraStartErrorTitle("ocupada")).toBe("Ya tienes una llamada en curso");
    expect(anuraStartErrorTitle("terminal_no_registrada")).toBe("Tu teléfono de Anura no está conectado");
    expect(anuraStartErrorTitle("token")).toBe("El token de Anura no es válido");
    expect(anuraStartErrorTitle("tiempo")).toBe("Anura no respondió");
    expect(anuraStartErrorTitle(undefined)).toBe("No se pudo llamar");
  });

  it("cómo terminó, en una línea; CONGESTION llega con su motivo (celulares restringidos)", () => {
    expect(anuraEndedLine({ status: "contestada", billSeconds: 133, failureReason: null })).toBe("Contestó · 2 min 13 s de conversación");
    expect(anuraEndedLine({ status: "no_contestada", billSeconds: 0, failureReason: null })).toBe("No contestó");
    expect(anuraEndedLine({ status: "ocupado", billSeconds: 0, failureReason: null })).toBe("Ocupado");
    expect(anuraEndedLine({ status: "fallida", billSeconds: 0, failureReason: "Destino restringido para tu anexo." })).toBe(
      "No se pudo llamar: Destino restringido para tu anexo.",
    );
  });

  it("la grabación: reproductor, guardándose, vencida o no disponible", () => {
    expect(anuraRecordingNote("guardada", true, true)).toBeNull();
    expect(anuraRecordingNote("guardada", false, true)).toBe("Grabación no disponible.");
    expect(anuraRecordingNote("pendiente", false, true)).toBe("Guardando la grabación…");
    expect(anuraRecordingNote("vencida", false, true)).toMatch(/^Grabación vencida/);
    expect(anuraRecordingNote("sin_grabacion", false, true)).toMatch(/^Sin grabación/);
    expect(anuraRecordingNote("sin_grabacion", false, false)).toBeNull();
  });

  it("al terminar: el historial y la confirmación solo si dejó su hecho y es de este pedido", () => {
    const A = "aaaaaaaa-1111-4222-8333-444444444444";
    const B = "bbbbbbbb-1111-4222-8333-444444444444";
    // De este pedido y con su hecho (también un fin con fallo de Anura).
    expect(anuraEndedFollowUp({ mode: "pedido", orderId: A, inHistory: true }, A)).toEqual({ inHistory: true, otherOrderId: null });
    // De este pedido, pero rechazada o cerrada sola: no dejó hecho.
    expect(anuraEndedFollowUp({ mode: "pedido", orderId: A, inHistory: false }, A)).toEqual({ inHistory: false, otherOrderId: null });
    // La llamada viva retomada es de OTRO pedido: no lleva a la confirmación de este.
    expect(anuraEndedFollowUp({ mode: "pedido", orderId: A, inHistory: true }, B)).toEqual({ inHistory: false, otherOrderId: A });
    // Una prueba de Ajustes nunca.
    expect(anuraEndedFollowUp({ mode: "prueba", orderId: null, inHistory: false }, B)).toEqual({ inHistory: false, otherOrderId: null });
  });

  it("qué llamada dejó su hecho: solo la que terminó con un fin de Anura", () => {
    const base = { mode: "pedido" as const, closed_by_timeout: false };
    expect(anuraReachedHistory({ ...base, status: "fallida", was_recorded: false })).toBe(true); // CONGESTION en el fin
    expect(anuraReachedHistory({ ...base, status: "contestada", was_recorded: true })).toBe(true);
    expect(anuraReachedHistory({ ...base, status: "fallida", was_recorded: null })).toBe(false); // Click2Dial la rechazó
    expect(anuraReachedHistory({ ...base, status: "fallida", closed_by_timeout: true, was_recorded: null })).toBe(false); // 60 s o 2 h
    expect(anuraReachedHistory({ ...base, status: "en_curso", was_recorded: null })).toBe(false);
    expect(anuraReachedHistory({ mode: "prueba", closed_by_timeout: false, status: "contestada", was_recorded: true })).toBe(false);
  });

  it("la entrada del historial se empareja con su llamada por la hora del final", () => {
    const calls = [
      { id: "a", endedAt: "2026-11-05T15:00:00.000+00:00" },
      { id: "b", endedAt: "2026-11-05T15:10:00.123+00:00" },
      { id: "c", endedAt: null },
    ];
    expect(anuraCallForEntry("2026-11-05T15:10:00.123Z", calls)?.id).toBe("b");
    expect(anuraCallForEntry("2026-11-05T15:00:02Z", calls)?.id).toBe("a");
    expect(anuraCallForEntry("2026-11-05T16:00:00Z", calls)).toBeNull();
    expect(anuraCallForEntry("no es fecha", calls)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// El cableado
// ---------------------------------------------------------------------------

describe("la ficha del pedido", () => {
  const drawer = read("components/order-drawer.tsx");
  const button = read("components/anura-call.tsx");

  it("«Llamar con Anura» junto a «Llamar desde Kapta», solo si el servidor lo habilita y con master.edit", () => {
    expect(drawer).toContain("const anura = useAnuraOrderPanel(orderId, detail?.row.order_id === orderId);");
    expect(drawer).toContain("{anura.panel?.enabled && canEdit && (");
    expect(drawer.indexOf("<BrowserCallButton")).toBeLessThan(drawer.indexOf("<AnuraCallButton"));
    expect(drawer).toContain('onGoToDesk={() => jumpTo("confirmacion")}');
  });

  it("pide la llamada sin mandar el teléfono y sondea mientras está viva", () => {
    expect(button).toContain("await startAnuraCall(orderId)");
    expect(button).toContain("await getAnuraCallStatus(callId)");
    expect(button).toContain("ANURA_POLL_INTERVAL_MS");
    // El sondeo se detiene al terminar: el efecto depende de si está viva.
    expect(button).toContain("if (!callId || !active) return;");
    expect(button).toContain("if (!res.call.active) {");
    // Con una llamada viva, o si Anura no respondió y puede llamar igual, se sigue esa.
    expect(button).toContain("if (res.activeCallId) {");
    // Si el estado deja de llegar, se avisa en vez de sondear para siempre.
    expect(button).toContain("failures.current >= MAX_POLL_FAILURES");
    expect(button).not.toMatch(/customer_phone|customerPhone/);
  });

  it("el historial: «Llamada con Anura», con su grabación y el paso a la confirmación", () => {
    expect(read("components/order-master-shared.tsx")).toContain('anura_call: "Llamada con Anura"');
    expect(drawer).toContain('{t.kind === "anura_call" && (');
    expect(drawer).toContain("call={anuraCallForEntry(t.occurredAt, anura.panel?.calls ?? [])}");
    expect(drawer).toContain('onGoToDesk={hasConfirmationDesk ? () => jumpTo("confirmacion") : undefined}');
    expect(button).toContain('aria-label="Grabación de la llamada con Anura"');
    expect(button).toContain("Registrar el resultado en la confirmación");
    // Una entrada del historial siempre tiene su hecho: también un fin con fallo lleva a la confirmación.
    expect(button).not.toContain('call.status !== "fallida"');
    // El aviso de la ficha decide con anuraEndedFollowUp y enlaza al otro pedido.
    expect(button).toContain("anuraEndedFollowUp(ended, orderId)");
    expect(button).toContain("{ended && followUp.inHistory && hasDesk && (");
    expect(button).toContain("masterOrderHref(otherOrder)");
    expect(timelineFact({ kind: "anura_call", newStatus: null, origin: "master" })).toEqual({ icon: "llamada", stage: null });
    expect(timelineOriginLabel({ origin: "master", source: "anura" })).toBe("Anura");
  });
});

describe("Ajustes › Telefonía Anura", () => {
  const section = read("components/anura-settings-section.tsx");
  const settings = read("components/store-settings.tsx");

  it("está en el índice y en Conexiones", () => {
    expect(settings).toContain('{ id: "anura", label: "Telefonía Anura" }');
    expect(settings).toContain("<AnuraSettingsSection storeId={s.id} />");
  });

  it("token solo sí/no, webhook y plantilla para copiar, pasos, anexos, prueba y bitácora", () => {
    expect(section).toContain("await getAnuraSettings(storeId)");
    expect(section).toContain("data.configured");
    expect(section).not.toMatch(/anuraClick2DialToken|process\.env/);
    expect(section).toContain('<CopyRow label="Dirección completa" value={data.webhook.url} />');
    expect(section).toContain("template.copy(data.template)");
    // Los pasos del panel son la lista compartida con el MOM.
    expect(section).toContain("ANURA_PANEL_STEPS.map(");
    expect(section).toContain("{ANURA_AFTER_PANEL_STEPS}");
    const titles = ANURA_PANEL_STEPS.map((p) => p.title).join(" ");
    for (const step of ["Configuración → Cuentas", "Integraciones → Click 2 Dial", "Terminales", "Avanzado", "Límites", "Configuración → Eventos → Agregar", "Eventos → Agregar tres veces"]) {
      expect(titles).toContain(step);
    }
    expect(ANURA_PANEL_STEPS.map((p) => p.text).join(" ")).toContain("una terminal extra en el mismo anexo nunca suena");
    // El sondeo de la prueba también se rinde tras varios fallos seguidos.
    expect(section).toContain("failures >= ANURA_MAX_POLL_FAILURES");
    expect(section).toContain("Kapta dejó de recibir el estado de la llamada.");
    expect(section).toContain("saveAnuraExtension(storeId, userId, extension.trim())");
    expect(section).toContain("setAnuraExtensionActive(storeId, e.id, !e.active)");
    expect(section).toContain("removeAnuraExtension(storeId, e.id)");
    expect(section).toContain("await startAnuraTestCall(storeId, phone, extension || null)");
    expect(section).toContain("No cuenta como intento de ningún pedido");
    expect(section).toContain('title="Últimos avisos de Anura"');
  });
});

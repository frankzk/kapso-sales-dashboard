// La «Lista negra» unificada (MOM §41, §41.11 y §25.3; owner 09-11-2026): lo
// que se dice (lib/lista-negra-copy.ts, la única fuente), lo que pide cada alta
// a mano, la unión que va a las tiendas, el enmascarado, la respuesta de la
// búsqueda (solo ESE celular) y la marca de las filas de Leads y del Master.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  LN_EMPTY_EXCEPTIONS,
  LN_EMPTY_MANUAL,
  LN_EXCEPT_BUTTON,
  LN_EXCEPT_DONE,
  LN_EXCEPT_REASON_LABEL,
  LN_EXCEPT_REASON_PLACEHOLDER,
  LN_EXCEPTION_REMOVE,
  LN_FOOTNOTE,
  LN_GENERATE_NOTICE,
  LN_MANUAL_ADD_BUTTON,
  LN_MANUAL_REMOVE,
  LN_MANUAL_REQUIREMENT_LABEL,
  LN_NAME,
  LN_PAGE_SUBTITLE,
  LN_PANEL_REQUIREMENT_LABEL,
  LN_REQUIREMENT_LABEL,
  LN_RETIRED_LITERALS,
  LN_SEARCH_LABEL,
  LN_SEARCH_NOT_LISTED,
  LN_SEARCH_PLACEHOLDER,
  LN_SECTION_AUTO,
  LN_SECTION_AUTO_HELP,
  LN_SECTION_MANUAL,
  LN_SECTION_MANUAL_HELP,
  lnBadgeLabel,
  lnBadgeTitle,
  lnBotMessage,
  lnBrakeMessage,
  lnChatbyHold,
  lnGenerateRefused,
  lnHistoryLabel,
  lnLeadBannerAction,
  lnMotivo,
  lnOrderBannerAction,
  lnRequisito,
  lnSearchExcepted,
  lnSearchListed,
} from "@/lib/lista-negra-copy";
import {
  listaNegraAutoMark,
  listaNegraBadge,
  listaNegraManualMark,
  listaNegraMaskedPhone,
  listaNegraMergeMarks,
  listaNegraRegla,
  listaNegraSearchLimited,
  listaNegraSearchView,
  listaNegraSendPhones,
  withListaNegra,
  type ListaNegraSearchInput,
} from "@/lib/lista-negra";

const read = (...p: string[]) => readFileSync(resolve(process.cwd(), ...p), "utf8");
/** Código sin comentarios: la prosa puede contar la historia de los nombres viejos. */
const code = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "").replace(/\{\/\*[\s\S]*?\*\/\}/g, "");

describe("la copia (lib/lista-negra-copy.ts)", () => {
  it("el nombre y el motivo, con las cuentas del propio cliente", () => {
    expect(LN_NAME).toBe("Lista negra");
    expect(lnMotivo({ kind: "devuelto", n: 1 })).toBe("Devolvió 1 pedido y nunca recibió");
    expect(lnMotivo({ kind: "devuelto", n: 3 })).toBe("Devolvió 3 pedidos y nunca recibió");
    expect(lnMotivo({ kind: "anulador", n: 6, m: 7 })).toBe("Anuló 6 de 7 pedidos y nunca recibió");
    expect(lnMotivo({ kind: "manual", reason: "Fraude con otra cuenta." })).toBe("Agregada a mano: Fraude con otra cuenta");
    expect(lnMotivo({ kind: "manual", reason: "  " })).toBe("Agregada a mano");
    expect(lnMotivo({ kind: "manual" })).toBe("Agregada a mano");
  });

  it("el requisito, la chapa y su tooltip", () => {
    expect(lnRequisito("adelanto")).toBe("Para contra entrega: adelanto de S/ 20 validado o pago online completo.");
    expect(lnRequisito("pago_completo")).toBe("Solo con pago total por adelantado.");
    expect(lnBadgeLabel("adelanto")).toBe("Lista negra");
    expect(lnBadgeLabel("pago_completo")).toBe("Lista negra · pago total");
    expect(lnBadgeTitle("Devolvió 1 pedido y nunca recibió", "adelanto")).toBe(
      "Devolvió 1 pedido y nunca recibió. Para contra entrega: adelanto de S/ 20 validado o pago online completo.",
    );
    expect(LN_REQUIREMENT_LABEL).toEqual({ adelanto: "Adelanto de S/ 20", pago_completo: "Pago total" });
  });

  it("los avisos: qué hacer en la ficha del pedido y en la del lead, y la nota al pie", () => {
    expect(lnOrderBannerAction("adelanto", false)).toBe("No se confirma ni sale guía hasta validar el adelanto. Regístralo en «Cómo sale el pedido».");
    expect(lnOrderBannerAction("pago_completo", false)).toBe("No se confirma ni sale guía hasta validar el pago total.");
    expect(lnOrderBannerAction("adelanto", true)).toBe("Adelanto validado: el pedido puede seguir.");
    expect(lnOrderBannerAction("pago_completo", true)).toBe("Pago total validado: el pedido puede seguir.");
    expect(lnLeadBannerAction("adelanto")).toBe("Antes de ofrecer contra entrega, pídele el adelanto de S/ 20.");
    expect(lnLeadBannerAction("pago_completo")).toBe("No le ofrezcas contra entrega: solo pago total por adelantado.");
    expect(LN_FOOTNOTE).toBe("Kapta no le escribe a la clienta sobre la Lista negra.");
  });

  it("los mensajes cortos", () => {
    const m = "Devolvió 1 pedido y nunca recibió";
    expect(lnBrakeMessage(m, "adelanto")).toBe("Lista negra (devolvió 1 pedido y nunca recibió): falta el adelanto de S/ 20 validado.");
    expect(lnBrakeMessage(m, "pago_completo")).toBe("Lista negra (devolvió 1 pedido y nunca recibió): falta el pago total validado.");
    expect(lnChatbyHold(m)).toBe("Lista negra (devolvió 1 pedido y nunca recibió): Kapta no crea la guía ni le escribe. Cobra el adelanto y confirma tú.");
    expect(lnBotMessage(m, "adelanto")).toBe(
      "Cliente en Lista negra (devolvió 1 pedido y nunca recibió). El bot no crea pedidos contra entrega: deriva a una asesora para cobrar el adelanto de S/ 20 o el pago online completo.",
    );
    expect(lnBotMessage(m, "pago_completo")).toBe(
      "Cliente en Lista negra (devolvió 1 pedido y nunca recibió). El bot no crea pedidos contra entrega: deriva a una asesora para cobrar el pago total.",
    );
    expect(LN_GENERATE_NOTICE).toBe("· Lista negra: no sale sin el adelanto de S/ 20 validado.");
    expect(lnGenerateRefused(m)).toBe("Lista negra (devolvió 1 pedido y nunca recibió): solo con pago total por adelantado; no se genera contra entrega.");
  });

  it("las acciones, la página y Automatizaciones", () => {
    expect(LN_EXCEPT_BUTTON).toBe("Exceptuar de la Lista negra");
    expect(LN_EXCEPT_REASON_LABEL).toBe("Motivo");
    expect(LN_EXCEPT_REASON_PLACEHOLDER).toBe("Por qué puede pagar contra entrega (mín. 8 caracteres)");
    expect(LN_EXCEPT_DONE).toBe("Exceptuada: Kapta ya no la frena; las tiendas, desde el envío de mañana 05:00.");
    expect(LN_EXCEPTION_REMOVE).toBe("Quitar excepción");
    expect(LN_MANUAL_ADD_BUTTON).toBe("Agregar a la Lista negra");
    expect(LN_MANUAL_REQUIREMENT_LABEL).toBe("Qué se le pide");
    expect(LN_MANUAL_REMOVE).toBe("Sacar de la Lista negra");
    expect(LN_PAGE_SUBTITLE).toBe(
      "Clientes que solo pueden comprar contra entrega con adelanto (o pagando todo online). Kapta la calcula cada día a las 05:00 y la manda a Kenku y Aurela.",
    );
    expect(LN_SECTION_AUTO).toBe("Automática");
    expect(LN_SECTION_AUTO_HELP).toBe("Entra quien devolvió un pedido, rechazó uno en la puerta o anuló 5 o más con 75 % o más anulados, y nunca recibió. Sale sola cuando recibe un pedido.");
    expect(LN_SECTION_MANUAL).toBe("Agregados a mano");
    expect(LN_SECTION_MANUAL_HELP).toBe("Para lo que la regla no ve: fraude, una clienta que avisó que no va a recibir.");
    expect(LN_SEARCH_LABEL).toBe("Buscar un celular");
    expect(LN_SEARCH_PLACEHOLDER).toBe("987 654 321");
    expect(lnSearchListed("Anuló 6 de 7 pedidos y nunca recibió")).toBe("Está en la Lista negra · Anuló 6 de 7 pedidos y nunca recibió");
    expect(LN_SEARCH_NOT_LISTED).toBe("No está en la Lista negra");
    expect(lnSearchExcepted("Ya pagó por Yape")).toBe("Exceptuada · Ya pagó por Yape");
    expect(LN_EMPTY_MANUAL).toBe("Nadie agregado a mano todavía.");
    expect(LN_EMPTY_EXCEPTIONS).toBe("Sin excepciones.");
    expect(LN_PANEL_REQUIREMENT_LABEL).toBe("Qué se pide en los pedidos de Kapta");
    expect(lnHistoryLabel("envío de prueba")).toBe("Lista negra · envío de prueba");
  });
});

describe("cada pantalla dice lo mismo, y de un solo sitio", () => {
  // Cada superficie y por dónde le llega la copia: el módulo, o la chapa y el
  // aviso compartidos (que la importan).
  const SURFACES: Record<string, RegExp> = {
    "components/orders-master.tsx": /@\/components\/lista-negra-badge/,
    "components/leads.tsx": /@\/components\/lista-negra-badge/,
    "components/leads-drawer.tsx": /@\/components\/lista-negra-banner/,
    "components/pago-online-banner.tsx": /@\/lib\/lista-negra-copy/,
    "components/prepay-list-banner.tsx": /@\/components\/lista-negra-banner/,
    "components/prepay-list-page.tsx": /@\/lib\/lista-negra-copy/,
    "components/automations-panel.tsx": /@\/lib\/lista-negra-copy/,
    "components/sidebar.tsx": /@\/lib\/lista-negra-copy/,
    "components/lista-negra-badge.tsx": /@\/lib\/lista-negra-copy/,
    "components/lista-negra-banner.tsx": /@\/lib\/lista-negra-copy/,
    "lib/pago-online.ts": /@\/lib\/lista-negra-copy/,
    "lib/prepay-list.ts": /@\/lib\/lista-negra-copy/,
    "lib/prepay-list-server.ts": /@\/lib\/lista-negra-copy/,
    "lib/chatby-autoconfirm.ts": /@\/lib\/lista-negra-copy/,
    "lib/chatby-autoconfirm-server.ts": /@\/lib\/lista-negra-copy/,
    "lib/automations-catalog.ts": /@\/lib\/lista-negra-copy/,
    "app/dashboard/leads/actions.ts": /@\/lib\/lista-negra-copy/,
    "app/dashboard/pedidos/prepay-actions.ts": /@\/lib\/lista-negra-copy/,
    "app/dashboard/clientes/lista-negra/actions.ts": /@\/lib\/lista-negra-copy/,
  };

  for (const [file, via] of Object.entries(SURFACES)) {
    it(`${file} toma la copia de lib/lista-negra-copy.ts`, () => {
      expect(read(file)).toMatch(via);
    });
  }

  it("las chapas son negras con letras blancas", () => {
    expect(read("components/lista-negra-badge.tsx")).toContain("tone={LN_BADGE_TONE}");
    expect(read("lib/lista-negra-copy.ts")).toContain('export const LN_BADGE_TONE = "blacklist" as const;');
    expect(read("components/ops-ui.tsx")).toContain('blacklist: "bg-ink-900 text-white"');
  });

  it("ningún componente dice los nombres viejos ni la fórmula larga del titular", () => {
    const files = [...Object.keys(SURFACES).filter((f) => f.startsWith("components/")), "components/order-drawer.tsx", "components/lead-post-order-choices.tsx"];
    for (const file of files) {
      const src = code(read(file));
      for (const literal of LN_RETIRED_LITERALS) expect(src.includes(literal), `${file}: «${literal}»`).toBe(false);
      expect(src.includes("Pago adelantado"), `${file}: «Pago adelantado»`).toBe(false);
    }
  });

  it("ni los mensajes que salen de lib (frenos, Chatby, bot, «Generar pedido»)", () => {
    for (const file of ["lib/pago-online.ts", "lib/prepay-list.ts", "lib/prepay-list-server.ts", "lib/chatby-autoconfirm.ts", "lib/chatby-autoconfirm-server.ts", "app/dashboard/leads/actions.ts", "lib/automations-catalog.ts"]) {
      const src = code(read(file));
      for (const literal of LN_RETIRED_LITERALS) expect(src.includes(literal), `${file}: «${literal}»`).toBe(false);
    }
  });
});

describe("lo que va a las tiendas: la unión", () => {
  it("la automática más las altas a mano, en 9 dígitos, sin repetidos y ordenada", () => {
    const out = listaNegraSendPhones(["987654321", "912345678"], ["51987654321", "+51 955 555 555", "51955555555", null, "123"]);
    expect(out).toEqual({ phones: ["912345678", "955555555", "987654321"], manualOnly: 1 });
    expect(listaNegraSendPhones([], [])).toEqual({ phones: [], manualOnly: 0 });
  });

  it("la `regla` dice cuántos van a mano, y nada si no hay", () => {
    expect(listaNegraRegla("1+ devuelto…", 0)).toBe("1+ devuelto…");
    expect(listaNegraRegla("1+ devuelto…", 1)).toBe("1+ devuelto… · más 1 agregado a mano en Kapta");
    expect(listaNegraRegla("r", 3)).toBe("r · más 3 agregados a mano en Kapta");
  });
});

describe("el enmascarado", () => {
  it("de un celular solo se ven los tres últimos dígitos", () => {
    expect(listaNegraMaskedPhone("51987654321")).toBe("••• ••• 321");
    expect(listaNegraMaskedPhone("987 654 321")).toBe("••• ••• 321");
    expect(listaNegraMaskedPhone("12")).toBe("•••");
  });
});

describe("la búsqueda: solo ESE celular", () => {
  const base: ListaNegraSearchInput = {
    phone: "51987654321",
    mode: "activo",
    requirement: "adelanto",
    hasCurrentList: true,
    autoRow: null,
    exception: null,
    manual: null,
    orders: [],
    canManage: true,
    formatAt: (iso) => `F(${iso})`,
  };

  it("en la automática: el motivo, el requisito y se puede exceptuar", () => {
    const v = listaNegraSearchView({
      ...base,
      autoRow: { reason: "anulador", failed: 6, orders: 7 },
      orders: [{ order_id: "o1", order_name: "#KP1", general_status: "anulado", order_created_at: "2026-11-01" }],
    });
    expect(v).toEqual({
      phoneLabel: "987 654 321",
      listed: true,
      mark: { source: "auto", motivo: "Anuló 6 de 7 pedidos y nunca recibió", requirement: "adelanto" },
      requirementLabel: "Adelanto de S/ 20",
      automatic: { braking: true, motivo: "Anuló 6 de 7 pedidos y nunca recibió" },
      automaticNote: null,
      exception: null,
      manual: null,
      orders: [{ id: "o1", name: "#KP1", status: "anulado" }],
      canExcept: true,
    });
    // Ninguna lista, ningún otro celular.
    expect(JSON.stringify(v)).not.toMatch(/celulares|phones/);
  });

  it("exceptuada: no frena, lo dice, y no se vuelve a exceptuar", () => {
    const v = listaNegraSearchView({
      ...base,
      autoRow: { reason: "devuelto", failed: 1, orders: 1 },
      exception: { id: "x1", reason: "Ya pagó por Yape", added_at: "2026-11-09", order_name: "#KP2", added_by_name: "ana" },
    });
    expect(v.listed).toBe(false);
    expect(v.mark).toBeNull();
    expect(v.automatic).toEqual({ braking: false, motivo: "Devolvió 1 pedido y nunca recibió" });
    expect(v.exception).toEqual({ id: "x1", reason: "Ya pagó por Yape", addedAt: "F(2026-11-09)", addedBy: "ana", orderName: "#KP2" });
    expect(v.canExcept).toBe(false);
  });

  it("a mano: su motivo y lo que pide; con las dos, la que pide más", () => {
    const manual = { id: "e1", reason: "Fraude", requirement: "pago_completo", added_at: "2026-11-09", added_by_name: "ana", source: "manual" };
    const v = listaNegraSearchView({ ...base, manual, autoRow: { reason: "devuelto", failed: 1, orders: 1 } });
    expect(v.mark).toEqual({ source: "manual", motivo: "Agregada a mano: Fraude", requirement: "pago_completo" });
    expect(v.manual).toMatchObject({ requirement: "pago_completo", requirementLabel: "Pago total", addedAt: "F(2026-11-09)" });
    // Sin la 0329 la fila no trae lo que pide: el total.
    expect(listaNegraSearchView({ ...base, manual: { ...manual, requirement: undefined } }).mark?.requirement).toBe("pago_completo");
  });

  it("fuera de la lista, o con la automática en Simulación: no está, y se dice por qué no frena", () => {
    expect(listaNegraSearchView(base)).toMatchObject({ listed: false, mark: null, automatic: null, canExcept: false });
    const sim = listaNegraSearchView({ ...base, mode: "simulacion", autoRow: { reason: "devuelto", failed: 1, orders: 1 } });
    expect(sim).toMatchObject({ listed: false, automatic: null, canExcept: false });
    expect(sim.automaticNote).toMatch(/Simulación/);
    // Sin `prepay_list.manage` no se exceptúa.
    expect(listaNegraSearchView({ ...base, canManage: false, autoRow: { reason: "devuelto", failed: 1, orders: 1 } }).canExcept).toBe(false);
  });

  it("el tope de búsquedas por persona", () => {
    expect(listaNegraSearchLimited(29)).toBe(false);
    expect(listaNegraSearchLimited(30)).toBe(true);
  });
});

describe("los documentos", () => {
  const flat = (s: string) => s.replace(/\s+/g, " ");
  it("el MOM: una sola Lista negra, lo que pide cada alta, la regla retirada, el canal y Leads", () => {
    const mom = read("docs/mom/master-pedidos-v1.md");
    const s41 = flat(mom.slice(mom.indexOf("## 41. Lista negra"), mom.indexOf("### 41.1 ")));
    expect(s41).toContain("**Cada alta a mano elige lo que pide** (`prepay_list_entries.requirement`, 0329)");
    expect(s41).toContain("**La regla automática de esta lista (§41.2) queda retirada** por el owner");
    expect(flat(mom)).toContain("### 41.2 Quién entra solo: la regla automática (RETIRADA, owner 09-11-2026)");
    expect(flat(mom)).toContain("**El canal elegido (owner, 09-11-2026): el envío diario de la automática.**");
    const s253 = flat(mom.slice(mom.indexOf("### 25.3 La Lista negra en Leads"), mom.indexOf("## 26. ")));
    expect(s253).toContain("**UNA lectura por página** (`listaNegraMarksAmong`");
  });

  it("DESIGN.md tiene el glosario y la regla de la chapa; DEPLOY la migración arriba", () => {
    const design = flat(read("DESIGN.md"));
    expect(design).toContain("**Glosario (owner, 09-11-2026).** Siempre «Lista negra» (L mayúscula, n minúscula)");
    expect(design).toContain("«Lista negra · pago total»");
    const deploy = read("DEPLOY.md");
    expect(deploy.indexOf("0329_lista_negra_requisito.sql")).toBeGreaterThan(0);
    expect(deploy.indexOf("### 09-11-2026 · «Lista negra» unificada")).toBeLessThan(deploy.indexOf("### 09-11-2026 · «Lista negra»: el nombre en pantalla"));
  });
});

describe("la marca de las filas (Leads y Master)", () => {
  const ORG = "o-1";
  const OTHER = "o-2";
  const storeOrg = new Map([
    ["s-ken", ORG],
    ["s-otra", OTHER],
  ]);
  const auto = listaNegraAutoMark({ reason: "devuelto", failed: 2, orders: 3 }, "adelanto");
  const manual = listaNegraManualMark({ reason: "Avisó que no va a recibir", requirement: "pago_completo" });

  it("marca por organización y celular, con su motivo, y no afirma nada sin lectura", () => {
    const marks = new Map([
      [`${ORG}|987654321`, auto],
      [`${OTHER}|955555555`, manual],
    ]);
    const rows = [
      { id: "l1", store_id: "s-ken", phone: "+51 987 654 321" },
      { id: "l2", store_id: "s-ken", phone: "955555555" }, // listado en OTRA organización
      { id: "l3", store_id: "s-ken", phone: null },
      { id: "l4", store_id: "s-nueva", phone: "987654321" }, // tienda que no está en el mapa
    ];
    const out = withListaNegra(rows, marks, storeOrg, (r) => r.phone);
    expect(out.map((r) => r.lista_negra)).toEqual([auto, null, null, null]);
    expect(withListaNegra(rows, null, storeOrg, (r) => r.phone)).toBe(rows);
  });

  it("la chapa: negra, «· pago total» si es lo que pide, y el tooltip con el motivo", () => {
    expect(listaNegraBadge(auto)).toEqual({
      label: "Lista negra",
      title: "Devolvió 2 pedidos y nunca recibió. Para contra entrega: adelanto de S/ 20 validado o pago online completo.",
    });
    expect(listaNegraBadge(manual)).toEqual({ label: "Lista negra · pago total", title: "Agregada a mano: Avisó que no va a recibir. Solo con pago total por adelantado." });
  });

  it("con las dos listas gana la que pide más; si piden lo mismo, el alta a mano", () => {
    const manualAdelanto = listaNegraManualMark({ reason: "Fraude", requirement: "adelanto" });
    const autoTotal = listaNegraAutoMark({ reason: "devuelto", failed: 1, orders: 1 }, "pago_completo");
    expect(listaNegraMergeMarks(manualAdelanto, autoTotal)).toBe(autoTotal);
    expect(listaNegraMergeMarks(manualAdelanto, auto)).toBe(manualAdelanto);
    expect(listaNegraMergeMarks(null, auto)).toBe(auto);
    expect(listaNegraMergeMarks(null, null)).toBeNull();
  });
});

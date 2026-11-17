/**
 * Los distritos del Perú con su nombre oficial: el buscador del formulario de
 * pedido en Leads y la regla con la que el servidor guarda el distrito (MOM
 * §37.10). Puro: lo importan el cajón y la server action.
 *
 * Por qué existe. El distrito era texto libre y la asesora lo tecleaba como lo
 * oía: «San Martín de portes» (#AUR900990, 16-11-2026). Ese nombre viajaba tal
 * cual a la tienda, a la guía y a la cobertura. Ahora se elige de la lista del
 * INEI (lib/peru-ubigeo-data.ts) y se guarda el nombre oficial, con la región
 * que le corresponde.
 *
 * Lo que Kapta muestra distinto del INEI (`DISPLAY_NAME`): el distrito 150101,
 * que el INEI llama «Lima», es «Cercado de Lima», como lo escriben la clienta y
 * el courier; la cobertura de Lima ya lee los dos nombres igual
 * (`resolveLimaDistrict`). La provincia constitucional del Callao es «Callao».
 */

import { PERU_UBIGEO_DEPARTMENTS, PERU_UBIGEO_DISTRICTS, PERU_UBIGEO_PROVINCES } from "@/lib/peru-ubigeo-data";

export type PeruDistrict = {
  /** Ubigeo del INEI, 6 dígitos. */
  ubigeo: string;
  /** El nombre que se guarda en el pedido. */
  name: string;
  province: string;
  /** El departamento (la «Provincia / Región» del formulario). */
  department: string;
};

type Indexed = PeruDistrict & { key: string; words: string[]; aliases: string[] };

const DISPLAY_NAME: Readonly<Record<string, string>> = {
  "150101": "Cercado de Lima",
};
const DISPLAY_PROVINCE: Readonly<Record<string, string>> = {
  "0701": "Callao",
};

/**
 * Otras formas de buscar el mismo distrito: siglas que usa el equipo y nombres
 * cortos. Solo ayudan a encontrarlo; lo que se guarda es siempre `name`.
 */
const ALIASES: Readonly<Record<string, readonly string[]>> = {
  "150101": ["lima", "lima cercado", "cercado"],
  "070101": ["cercado del callao"],
  "150118": ["chosica", "lurigancho chosica"],
  "150120": ["magdalena"],
  "150132": ["sjl"],
  "150133": ["sjm"],
  "150135": ["smp"],
  "150140": ["surco"],
  "150142": ["ves"],
  "150143": ["vmt"],
  "070103": ["carmen de la legua"],
};

/** Sin tildes, sin mayúsculas, sin signos: para comparar, nunca para mostrar. */
export function districtSearchKey(raw: string | null | undefined): string {
  return String(raw ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

let cache: Indexed[] | null = null;
let byUbigeo: Map<string, Indexed> | null = null;

function all(): Indexed[] {
  if (cache) return cache;
  const list = PERU_UBIGEO_DISTRICTS.split("\n").map((line): Indexed => {
    const cut = line.indexOf("|");
    const ubigeo = line.slice(0, cut);
    const inei = line.slice(cut + 1);
    const name = DISPLAY_NAME[ubigeo] ?? inei;
    const provinceCode = ubigeo.slice(0, 4);
    const key = districtSearchKey(name);
    return {
      ubigeo,
      name,
      province: DISPLAY_PROVINCE[provinceCode] ?? PERU_UBIGEO_PROVINCES[provinceCode] ?? "",
      department: PERU_UBIGEO_DEPARTMENTS[ubigeo.slice(0, 2)] ?? "",
      key,
      words: key.split(" "),
      aliases: [districtSearchKey(inei), ...(ALIASES[ubigeo] ?? [])].filter((a) => a && a !== key),
    };
  });
  byUbigeo = new Map(list.map((d) => [d.ubigeo, d]));
  cache = list;
  return list;
}

function plain(d: Indexed): PeruDistrict {
  return { ubigeo: d.ubigeo, name: d.name, province: d.province, department: d.department };
}

export function peruDistrictCount(): number {
  return all().length;
}

export function peruDistrictByUbigeo(ubigeo: string | null | undefined): PeruDistrict | null {
  all();
  const d = byUbigeo?.get(String(ubigeo ?? "").trim());
  return d ? plain(d) : null;
}

/** «Lima, Lima» o «Cañete, Lima»: la provincia y el departamento del distrito. */
export function peruDistrictPlace(d: Pick<PeruDistrict, "province" | "department">): string {
  return `${d.province}, ${d.department}`;
}

/** El departamento escrito en un texto libre («Lima (provincia)», «arequipa»…). */
function departmentIn(raw: string | null | undefined): string | null {
  const k = districtSearchKey(raw);
  if (!k) return null;
  const names = Object.values(PERU_UBIGEO_DEPARTMENTS);
  const exact = names.find((n) => districtSearchKey(n) === k);
  if (exact) return exact;
  // Por palabras enteras y el nombre más largo: «Región Huancavelica» no es Ica.
  const padded = ` ${k} `;
  const inText = names.filter((n) => padded.includes(` ${districtSearchKey(n)} `));
  return inText.sort((a, b) => b.length - a.length)[0] ?? null;
}

/** Distancia de edición con transposición (dos letras cambiadas = 1). */
function editDistance(a: string, b: string, max: number): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  const w = b.length + 1;
  // Tres filas: la anterior a la anterior (para la transposición), la anterior y la actual.
  let prev2 = new Int32Array(w);
  let prev = Int32Array.from({ length: w }, (_, j) => j);
  let row = new Int32Array(w);
  for (let i = 1; i <= a.length; i++) {
    row[0] = i;
    let best = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let v = Math.min((prev[j] ?? 0) + 1, (row[j - 1] ?? 0) + 1, (prev[j - 1] ?? 0) + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) v = Math.min(v, (prev2[j - 2] ?? 0) + 1);
      row[j] = v;
      if (v < best) best = v;
    }
    if (best > max) return max + 1;
    [prev2, prev, row] = [prev, row, prev2];
  }
  return prev[b.length] ?? max + 1;
}

/** Cuántas letras se le perdonan a lo escrito: ninguna con menos de 4. */
function typoBudget(length: number): number {
  return length >= 9 ? 2 : length >= 4 ? 1 : 0;
}

/**
 * Qué tan bien calza lo escrito con un distrito; menos es mejor, null es no.
 *   0  el nombre (o una de sus formas) es exactamente eso
 *   1  el nombre empieza así
 *   2  cada palabra escrita empieza una palabra del nombre («martin porres»)
 *   3  el nombre lo contiene
 *   4  con una o dos letras mal («San Martín de portes»)
 */
function score(d: Indexed, q: string, qWords: string[]): number | null {
  const keys = [d.key, ...d.aliases];
  if (keys.includes(q)) return 0;
  if (keys.some((k) => k.startsWith(q))) return 1;
  if (qWords.every((w) => d.words.some((dw) => dw.startsWith(w)))) return 2;
  if (d.key.includes(q)) return 3;
  const budget = typoBudget(q.length);
  if (!budget) return null;
  // Lo escrito contra el nombre entero y contra su comienzo del mismo largo:
  // «san martin de portes» es el nombre entero mal escrito; «san martn» es el
  // comienzo de otro.
  for (const k of keys) {
    if (editDistance(q, k, budget) <= budget) return 4;
    if (k.length > q.length && editDistance(q, k.slice(0, q.length), budget) <= budget) return 4;
  }
  return null;
}

/**
 * Los distritos que calzan con lo escrito, los mejores primero. Entre los que
 * calzan igual van primero los del departamento elegido, luego los de Lima y
 * Callao (donde vive la mayoría de los pedidos) y luego por nombre.
 */
export function searchPeruDistricts(
  query: string,
  { department = null, limit = 8 }: { department?: string | null; limit?: number } = {},
): PeruDistrict[] {
  const q = districtSearchKey(query);
  if (!q) return [];
  const qWords = q.split(" ");
  const dep = departmentIn(department);
  const hits: { d: Indexed; s: number; rank: number }[] = [];
  for (const d of all()) {
    const s = score(d, q, qWords);
    if (s === null) continue;
    const rank = dep && d.department === dep ? 0 : d.department === "Lima" || d.department === "Callao" ? 1 : 2;
    hits.push({ d, s, rank });
  }
  // Con algo que calza de verdad, no se ofrecen los parecidos: «breña» no
  // sugiere Arenal ni Bernal.
  const strong = hits.some((h) => h.s <= 2);
  return hits
    .filter((h) => !strong || h.s <= 3)
    .sort((a, b) => a.s - b.s || a.rank - b.rank || a.d.key.localeCompare(b.d.key) || a.d.ubigeo.localeCompare(b.d.ubigeo))
    .slice(0, limit)
    .map((h) => plain(h.d));
}

export type PeruDistrictMatch =
  | { kind: "exact"; district: PeruDistrict }
  | { kind: "ambiguous"; name: string; options: PeruDistrict[] }
  | { kind: "none"; suggestions: PeruDistrict[] };

/**
 * Un distrito escrito a mano contra la lista: el del lead, el del borrador o el
 * de un pedido anterior. Es «exact» solo si el nombre es exactamente uno de la
 * lista —o una de sus formas— y no hay otro igual en el departamento que vino
 * con él. Nunca corrige una letra por su cuenta: eso lo decide la asesora.
 */
export function matchPeruDistrict(raw: string | null | undefined, department?: string | null): PeruDistrictMatch {
  const q = districtSearchKey(raw);
  if (!q) return { kind: "none", suggestions: [] };
  const same = all().filter((d) => d.key === q || d.aliases.includes(q));
  const dep = departmentIn(department);
  let inDep = dep ? same.filter((d) => d.department === dep) : [];
  // En el departamento de Lima se repiten nombres (Miraflores también es de
  // Yauyos; Surco, de Huarochirí; San Luis, de Cañete). Se desempata como la
  // cobertura (`isLimaMetropolitanaOrCallao`): gana el de Lima Metropolitana,
  // salvo San Luis con «Lima (departamento)», que la cobertura tampoco decide.
  if (dep === "Lima" && inDep.length > 1) {
    const metro = inDep.filter((d) => d.ubigeo.startsWith("1501"));
    const outside = /departamento|depto|dpto|region/.test(districtSearchKey(department));
    if (metro.length === 1 && !(outside && q === "san luis")) inDep = metro;
  }
  const [firstInDep] = inDep;
  if (inDep.length === 1 && firstInDep) return { kind: "exact", district: plain(firstInDep) };
  const [first] = same;
  if (same.length === 1 && first) return { kind: "exact", district: plain(first) };
  if (first) {
    const options = (inDep.length > 1 ? inDep : same).map(plain);
    return { kind: "ambiguous", name: first.name, options };
  }
  return { kind: "none", suggestions: searchPeruDistricts(q, { department, limit: 3 }) };
}

/**
 * El distrito con el que se crea el pedido, o por qué no. Manda el ubigeo que
 * eligió la asesora; sin él (un formulario abierto antes de este cambio), el
 * nombre tiene que ser exactamente uno de la lista. Lo que se guarda sale de la
 * lista, no de lo tecleado.
 */
export function resolveOrderDistrict(input: {
  ubigeo?: string | null;
  district: string | null | undefined;
  province?: string | null;
}): { ok: true; district: PeruDistrict } | { ok: false; error: string } {
  const typed = String(input.district ?? "").trim();
  const code = String(input.ubigeo ?? "").trim();
  if (code) {
    const picked = peruDistrictByUbigeo(code);
    if (!picked) return { ok: false, error: "Ese distrito no está en la lista oficial. Vuelve a elegirlo." };
    if (typed && districtSearchKey(typed) !== districtSearchKey(picked.name)) {
      return { ok: false, error: `Vuelve a elegir el distrito de la lista (dice «${typed}»).` };
    }
    return { ok: true, district: picked };
  }
  if (!typed) return { ok: false, error: "El distrito es obligatorio." };
  const m = matchPeruDistrict(typed, input.province);
  if (m.kind === "exact") return { ok: true, district: m.district };
  if (m.kind === "ambiguous") {
    return {
      ok: false,
      error: `Hay ${m.options.length} distritos «${m.name}». Elige de la lista el de la entrega.`,
    };
  }
  const [guess] = m.suggestions;
  const hint = guess ? ` ¿Es ${guess.name} (${peruDistrictPlace(guess)})?` : "";
  return { ok: false, error: `«${typed}» no está en la lista oficial de distritos.${hint} Elígelo de la lista.` };
}

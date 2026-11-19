#!/usr/bin/env node
// Genera lib/peru-ubigeo-data.ts desde el JSON del paquete npm `peru-ubigeo`
// (0.1.3, licencia MIT): node scripts/gen-peru-ubigeo.mjs <ruta>/lib/ubigeo.json
//
// No se instala el paquete: el archivo generado se versiona y no cambia salvo
// que el INEI cree o renombre un distrito. Las correcciones de abajo arreglan
// la ortografía de la fuente; los nombres que Kapta muestra distinto (Cercado
// de Lima, Callao) viven en lib/peru-districts.ts, no aquí.
import { readFileSync, writeFileSync } from "node:fs";

const src = process.argv[2];
if (!src) {
  console.error("Uso: node scripts/gen-peru-ubigeo.mjs <ruta a ubigeo.json>");
  process.exit(1);
}

/** Errores de la fuente: tilde grave, guion bajo o tilde que falta. */
const FIXES = {
  "0408": "La Unión",
  "0508": "Páucar del Sara Sara",
  "030602": "Anco Huallo",
  "150119": "Lurín",
  "250101": "Callería",
};

const tree = JSON.parse(readFileSync(src, "utf8"));
const departments = {};
const provinces = {};
const districts = [];
for (const dep of tree) {
  departments[dep.id] = FIXES[dep.id] ?? dep.name.trim();
  for (const prov of dep.childrens) {
    provinces[prov.id] = FIXES[prov.id] ?? prov.name.trim();
    for (const dist of prov.childrens) {
      if (!/^\d{6}$/.test(dist.id) || !dist.id.startsWith(prov.id)) throw new Error(`ubigeo raro: ${dist.id}`);
      const name = (FIXES[dist.id] ?? dist.name).trim().replace(/\s+/g, " ");
      if (name.includes("|") || name.includes("\n")) throw new Error(`nombre raro: ${dist.id}`);
      districts.push(`${dist.id}|${name}`);
    }
  }
}
districts.sort();

const LICENSE = `The MIT License (MIT)

Copyright (c) 2019 Lord Dicus, amor y señor de la KOMARCA <jholarck@gmail.com>

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.`;

const out = `// GENERADO por scripts/gen-peru-ubigeo.mjs: no editar a mano.
//
// Los ${districts.length} distritos, ${Object.keys(provinces).length} provincias y ${Object.keys(departments).length} departamentos del Perú con su
// ubigeo del INEI. Fuente: paquete npm \`peru-ubigeo\` 0.1.3
// (github.com/Komarcalabs/peru-ubigeo), con estas correcciones de ortografía:
// ${Object.entries(FIXES).map(([k, v]) => `${k} → ${v}`).join("; ")}.
//
${LICENSE.split("\n").map((l) => (l ? `// ${l}` : "//")).join("\n")}

/** Departamento por los 2 primeros dígitos del ubigeo. */
export const PERU_UBIGEO_DEPARTMENTS: Readonly<Record<string, string>> = ${JSON.stringify(departments)};

/** Provincia por los 4 primeros dígitos del ubigeo. */
export const PERU_UBIGEO_PROVINCES: Readonly<Record<string, string>> = ${JSON.stringify(provinces)};

/** Un distrito por línea, «ubigeo|nombre», en orden de ubigeo. */
export const PERU_UBIGEO_DISTRICTS = ${JSON.stringify(districts.join("\n"))};
`;
writeFileSync(new URL("../lib/peru-ubigeo-data.ts", import.meta.url), out);
console.log(`lib/peru-ubigeo-data.ts: ${districts.length} distritos`);

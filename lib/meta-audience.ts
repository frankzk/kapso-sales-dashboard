// Public-audience export for Meta Ads (Custom Audience → "Customer list").
// Turns the leads you are LOOKING AT into the exact CSV schema Meta ingests, so
// a segment that ignores WhatsApp (e.g. the cold queue) can be reached with ads
// instead — or excluded from prospecting, when the segment is your buyers.
//
// Header names are Meta's identifier keys and must stay verbatim: `phone`, `fn`,
// `country`. Meta hashes and normalizes on upload, so we send readable values;
// our only jobs are E.164 phones, one row per person, and no junk names.
// Pure + unit-tested.

import { toCsv, type CsvColumn } from "./csv";
import { normalizePhone } from "./phone";

export interface AudienceLead {
  phone?: string | null;
  name?: string | null;
}

export interface MetaAudienceRow {
  // Digits WITH country code and WITHOUT a leading "+". Meta only requires the
  // country code; the "+" is actively harmful here — our CSV writer prefixes any
  // cell starting with "+" with an apostrophe (Excel formula-injection guard), so
  // "+51…" would ship as "'+51…" and Meta would fail to parse it. Excel also
  // mangles leading "+". Digits sidestep both.
  phone: string;
  fn: string; // first name ("" when we have nothing usable)
  country: string; // ISO-3166 alpha-2, lowercase ("" when unknown)
}

/** Country code prefix → ISO-2, for the markets we actually ship to. Unknown
 *  prefixes export blank rather than guessing: a wrong country hurts the match
 *  rate, a blank one just leaves Meta matching on the phone alone. */
const DIAL_TO_COUNTRY: { prefix: string; country: string }[] = [
  { prefix: "51", country: "pe" },
];

/** Celular peruano completo: 51 + 9 + 8 dígitos. */
const PE_MOBILE_RE = /^519\d{8}$/;

// Cualquier número con código de país llega a 11 dígitos como mínimo (US 1+10,
// Chile 56+9, Bolivia 591+8…) y E.164 tope en 15. Un número fuera de ese rango
// está truncado o mal tipeado.
const MIN_INTL_DIGITS = 11;
const MAX_INTL_DIGITS = 15;

/**
 * ¿Sirve este número para un público de anuncios? Meta descarta en silencio lo
 * que no puede cruzar, así que filtrar acá es lo que evita creer que el público
 * es más grande de lo que es. Perú se valida estrictamente (es el mercado real);
 * otros prefijos solo se acotan por longitud, porque no podemos validar reglas
 * de países que no conocemos.
 */
export function isExportablePhone(digits: string): boolean {
  if (digits.startsWith("51")) return PE_MOBILE_RE.test(digits);
  return digits.length >= MIN_INTL_DIGITS && digits.length <= MAX_INTL_DIGITS;
}

function countryOf(digits: string): string {
  return DIAL_TO_COUNTRY.find((c) => digits.startsWith(c.prefix))?.country ?? "";
}

/** First given name, stripped of emoji/symbols/punctuation. Customers save
 *  themselves as "Ivanita 🐻🍎" or "FerSal", so a blind split leaks emoji into
 *  the audience file. Returns "" when nothing alphabetic survives. */
export function audienceFirstName(raw: string | null | undefined): string {
  if (!raw) return "";
  const cleaned = raw
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "") // accents (Meta normalizes, but keep it plain)
    .replace(/[^A-Za-z\s]/g, " ") // drop emoji, digits, punctuation
    .replace(/\s+/g, " ")
    .trim();
  const first = cleaned.split(" ")[0] ?? "";
  // A single stray letter ("F", "J") is noise, not a name.
  return first.length >= 2 ? first.toLowerCase() : "";
}

/**
 * Build the audience rows: valid phones only, one row per person (first
 * occurrence wins, so the richest earlier row keeps its name), original order
 * preserved for a stable/diffable file.
 */
export function buildMetaAudienceRows(leads: readonly AudienceLead[]): MetaAudienceRow[] {
  const out: MetaAudienceRow[] = [];
  const seen = new Set<string>();
  for (const lead of leads) {
    const digits = normalizePhone(lead.phone);
    if (!digits || !isExportablePhone(digits)) continue;
    if (seen.has(digits)) continue;
    seen.add(digits);
    out.push({
      phone: digits,
      fn: audienceFirstName(lead.name),
      country: countryOf(digits),
    });
  }
  return out;
}

const AUDIENCE_COLUMNS: readonly CsvColumn<MetaAudienceRow>[] = [
  { header: "phone", value: (r) => r.phone },
  { header: "fn", value: (r) => r.fn },
  { header: "country", value: (r) => r.country },
];

/** CSV ready to upload in Meta Ads Manager. No BOM: Meta's parser reads plain
 *  UTF-8 and a BOM can corrupt the first header ("﻿phone" → unrecognized). */
export function buildMetaAudienceCsv(leads: readonly AudienceLead[]): string {
  return toCsv(buildMetaAudienceRows(leads), AUDIENCE_COLUMNS);
}

/** Descriptive filename so several exported segments don't overwrite each other
 *  in the Downloads folder. `segment` is a short slug of the active filters. */
export function metaAudienceFilename(segment: string, today: string): string {
  const slug = segment
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return `audiencia-meta_${slug || "leads"}_${today}.csv`;
}

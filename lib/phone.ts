// Phone normalization so leads (keyed by phone) and orders link reliably.
// Strips non-digits and adds the Peru country code to bare 9-digit mobiles,
// matching Kapso's `phone_number` format (e.g. "51980694766").

export function normalizePhone(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let d = String(raw).replace(/\D+/g, "");
  if (!d) return null;
  d = d.replace(/^00+/, ""); // drop international 00 prefix
  // Peru mobile without country code: 9XXXXXXXX (9 digits) → 51 9XXXXXXXX
  if (d.length === 9 && d.startsWith("9")) d = "51" + d;
  return d;
}

// Meta ad attribution — the metadata behind a Click-to-WhatsApp (CTWA) lead.
// The `referral` Meta attaches to the first inbound message only carries the
// ad_id + a shared creative headline (e.g. "✈️ Viaja Sin Maletas"), so many
// distinct creatives collapse to one identical on-screen label. The real ad /
// adset / campaign names are resolved out-of-band from the Meta Marketing API
// into the `meta_ads` lookup table. This module holds the shared shape + the
// pure display helpers used by BOTH the dashboard and the lead drawer (so it
// must stay free of server-only imports — it is bundled into client code).

export interface AdMeta {
  accountId: string | null; // owning ad account — builds the Ads Manager deep link
  campaignId: string | null;
  campaignName: string | null;
  objective: string | null; // raw Meta campaign objective code
  adsetId: string | null;
  adsetName: string | null;
  adName: string | null; // the real creative name ("mochila viral 81 9:16")
  status: string | null; // ad effective_status snapshot (ACTIVE/PAUSED/…)
  fetchedAt: string | null; // when this row was resolved (the snapshot is "as of")
}

/** Deep link to a specific ad in Meta Ads Manager (needs the owning account). */
export function adsManagerUrl(accountId: string | null, adId: string): string | null {
  if (!accountId || !adId) return null;
  return `https://adsmanager.facebook.com/adsmanager/manage/ads?act=${accountId}&selected_ad_ids=${adId}`;
}

/** Tidy a Meta creative name for display: drop the video/image extension and
 *  normalise the full-width colon Meta stores in aspect-ratio names ("9：16"). */
export function prettyAdName(name: string): string {
  return name
    .replace(/\.(mp4|mov|webm|m4v|jpg|jpeg|png|gif)$/i, "")
    .replace(/：/g, ":")
    .trim();
}

// Meta objective codes → human label (Spanish). Covers the current ODAX codes
// plus a few legacy ones; unknown codes fall back to the raw value.
const OBJECTIVE_LABELS: Record<string, string> = {
  OUTCOME_ENGAGEMENT: "Interacción / Mensajes",
  OUTCOME_SALES: "Ventas",
  OUTCOME_LEADS: "Clientes potenciales",
  OUTCOME_TRAFFIC: "Tráfico",
  OUTCOME_AWARENESS: "Reconocimiento",
  OUTCOME_APP_PROMOTION: "Promoción de app",
  MESSAGES: "Mensajes",
  CONVERSIONS: "Conversiones",
  LINK_CLICKS: "Clics en el enlace",
};

/** Human label for a Meta campaign objective code (raw code if unknown). */
export function adObjectiveLabel(objective: string | null): string | null {
  if (!objective) return null;
  return OBJECTIVE_LABELS[objective] ?? objective;
}

export type AdStatusTone = "green" | "amber" | "slate";

/** Human label + tone for an ad effective_status snapshot. */
export function adStatusLabel(
  status: string | null,
): { label: string; tone: AdStatusTone } | null {
  if (!status) return null;
  switch (status) {
    case "ACTIVE":
      return { label: "Activo", tone: "green" };
    case "PAUSED":
    case "ADSET_PAUSED":
    case "CAMPAIGN_PAUSED":
      return { label: "Pausado", tone: "amber" };
    case "ARCHIVED":
    case "DELETED":
      return { label: "Archivado", tone: "slate" };
    default:
      return { label: status, tone: "slate" };
  }
}

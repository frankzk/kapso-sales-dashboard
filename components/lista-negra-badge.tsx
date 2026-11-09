// La chapa «Lista negra» (MOM §41.11 «Cómo se dice», DESIGN.md › Estados): la
// misma en el Master, en Leads y en la página «Lista negra». Negra con letras
// blancas; «Lista negra · pago total» cuando es lo que se pide; el tooltip es
// «{motivo}. {requisito}». Textos de lib/lista-negra-copy.ts.

import { Badge } from "@/components/ops-ui";
import { LN_BADGE_TONE, lnBadgeLabel, lnBadgeTitle, type LnRequirement } from "@/lib/lista-negra-copy";

export function ListaNegraBadge({
  mark,
  className,
}: {
  mark: { motivo: string; requirement: LnRequirement };
  className?: string;
}) {
  return (
    <Badge tone={LN_BADGE_TONE} className={className} title={lnBadgeTitle(mark.motivo, mark.requirement)}>
      {lnBadgeLabel(mark.requirement)}
    </Badge>
  );
}

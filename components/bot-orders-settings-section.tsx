"use client";

// Ajustes → «Bot de Kapso → pedidos por Kapta» (MOM §38.13): la dirección que el
// bot de Kapso llama para que Kapta cree sus pedidos en WooCommerce, el secreto
// (se genera aquí y se muestra UNA vez), cuándo se cambió, y el último uso y el
// último fallo. El contrato completo, para quien edita el workflow de Kapso,
// está en docs/kapso-pedidos-kapta.md.
//
// NINGÚN SECRETO LLEGA AQUÍ salvo el recién generado, en la respuesta de la
// acción. Kapta guarda solo su sha256: no puede volver a mostrarlo. Este
// archivo no importa nada que arrastre `node:crypto`.

import { useEffect, useActionState } from "react";
import { useRouter } from "next/navigation";
import { cn } from "@/components/ui";
import { Badge, Banner, OpsButton } from "@/components/ops-ui";
import { CARD, CardHeader, CodeLine, HELP, ROW, SettingsSection } from "@/components/settings-ui";
import { IconCopy } from "@/components/icons";
import { copyLabel, useCopyToClipboard } from "@/components/copy-button";
import {
  generateBotOrdersSecret,
  revokeBotOrdersSecret,
  type BotOrdersSettingsState,
} from "@/app/dashboard/[storeId]/settings/bot-orders-actions";

/** Lo que manda la página. Sin el secreto ni su hash: solo si hay uno. */
export interface BotOrdersSettingsView {
  /** `<Kapta>/api/internal/orders/<storeId>`. */
  endpointUrl: string;
  /**
   * `<Kapta>/api/internal/orders/<storeId>/lookup`: consultar un pedido que ya
   * existe, sin crear nada, con el mismo secreto (contrato, sección 10).
   */
  lookupUrl: string;
  configured: boolean;
  createdAt: string | null;
  rotatedAt: string | null;
  lastUsedAt: string | null;
  /** El código de la última llamada autenticada (`ok`, `price_mismatch`…). */
  lastOutcome: string | null;
  lastError: string | null;
  lastErrorAt: string | null;
  /** `stores.platform`: el endpoint solo crea pedidos con `woocommerce`. */
  platform: string;
  /** Pre-0277: la tabla no existe y la sección solo lo dice. */
  migrationMissing: boolean;
}

const initial: BotOrdersSettingsState = {};

const WHEN = new Intl.DateTimeFormat("es-PE", {
  timeZone: "America/Lima",
  day: "2-digit",
  month: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
});

function when(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "—" : WHEN.format(d);
}

function Result({ state }: { state: BotOrdersSettingsState }) {
  if (!state.error && !state.notice) return null;
  return (
    <Banner tone={state.error ? "crit" : "ok"} role={state.error ? "alert" : "status"}>
      <p className="whitespace-pre-line break-words">{state.error ?? state.notice}</p>
    </Banner>
  );
}

export function BotOrdersSettingsSection({ storeId, data }: { storeId: string; data: BotOrdersSettingsView }) {
  const router = useRouter();
  const [secretState, secretAction, secretPending] = useActionState(generateBotOrdersSecret, initial);
  const [revokeState, revokeAction, revokePending] = useActionState(revokeBotOrdersSecret, initial);
  const { state: copied, copy } = useCopyToClipboard();
  const { state: copiedLookup, copy: copyLookup } = useCopyToClipboard();
  const { state: copiedSecret, copy: copySecret } = useCopyToClipboard();

  useEffect(() => {
    if (secretState.botSecret) router.refresh();
  }, [secretState, router]);
  useEffect(() => {
    if (revokeState.notice && !revokeState.error) router.refresh();
  }, [revokeState, router]);

  const title = "Bot de Kapso → pedidos por Kapta";
  if (data.migrationMissing) {
    return (
      <SettingsSection id="bot-pedidos" title={title} badge={<Badge tone="neutral">Sin migración</Badge>}>
        <p className={cn(CARD, ROW, HELP)}>
          Falta aplicar la migración 0277 en la base. Hasta entonces el bot no puede pedir pedidos a Kapta (la dirección
          contesta 503 sin crear nada).
        </p>
      </SettingsSection>
    );
  }

  const onWoo = data.platform === "woocommerce";
  const badge = !data.configured ? (
    <Badge tone="neutral">Sin secreto</Badge>
  ) : onWoo ? (
    <Badge tone="ok">Activo</Badge>
  ) : (
    <Badge tone="warn">Listo, tienda en Shopify</Badge>
  );
  const revealed = secretState.botSecret ?? null;

  return (
    <SettingsSection
      id="bot-pedidos"
      title={title}
      badge={badge}
      description={
        <>
          <p>
            Desde el cierre de Shopify, el bot de Kapso pide sus pedidos a Kapta en vez de crearlos en Shopify. Kapta los
            crea en WooCommerce con el mismo control de precios que «Generar pedido» y las marcas del bot (
            <code>kapso</code>, <code>whatsapp</code>), y le devuelve el número (<code>#KP2…</code>) para confirmarlo.
          </p>
          <p>
            <strong>Solo crea pedidos con la tienda en WooCommerce</strong> («Crear los pedidos nuevos en», arriba).
            Mientras siga en Shopify contesta 409 <code>wrong_platform</code> sin crear nada, y el bot sigue con su acción
            de Shopify.
          </p>
        </>
      }
    >
      <div className={cn(CARD, "divide-y divide-line")}>
        <CardHeader
          title="Dirección para la acción de Kapso"
          description={
            <>
              <code>POST</code> con <code>Authorization: Bearer &lt;secreto&gt;</code> y el cuerpo JSON del contrato
              (docs/kapso-pedidos-kapta.md).
            </>
          }
        />
        <div className={cn(ROW, "space-y-3")}>
          <div className="flex flex-wrap items-stretch gap-2">
            <CodeLine>{data.endpointUrl}</CodeLine>
            <OpsButton onClick={() => copy(data.endpointUrl)} className="h-auto min-h-9">
              <IconCopy />
              {copyLabel(copied)}
            </OpsButton>
          </div>
          <p className={HELP}>
            Tienda en {onWoo ? "WooCommerce: los pedidos del bot se crean allí." : "Shopify: la dirección todavía no crea pedidos."}
          </p>
        </div>
        <div className={cn(ROW, "space-y-3")}>
          <p className={HELP}>
            <strong>Consultar un pedido que ya existe</strong> (la clienta llega desde la página de gracias de la web), sin
            crear nada y con el mismo secreto. Solo devuelve el pedido si es del celular de la conversación; funciona con la
            tienda en Shopify o en WooCommerce.
          </p>
          <div className="flex flex-wrap items-stretch gap-2">
            <CodeLine>{data.lookupUrl}</CodeLine>
            <OpsButton onClick={() => copyLookup(data.lookupUrl)} className="h-auto min-h-9">
              <IconCopy />
              {copyLabel(copiedLookup)}
            </OpsButton>
          </div>
        </div>
      </div>

      <div className={cn(CARD, "divide-y divide-line")}>
        <CardHeader
          title="Secreto del bot"
          description={
            data.configured
              ? `Creado el ${when(data.createdAt)}${data.rotatedAt && data.rotatedAt !== data.createdAt ? ` · cambiado el ${when(data.rotatedAt)}` : ""}. Kapta guarda solo su huella: no puede volver a mostrarlo.`
              : "Sin secreto, la dirección contesta 401 a todo."
          }
          aside={
            <div className="flex flex-wrap gap-2">
              <form
                action={secretAction}
                onSubmit={(e) => {
                  if (
                    data.configured &&
                    !window.confirm("El secreto actual deja de servir en este instante: el bot fallará hasta que pegues el nuevo en Kapso. ¿Generar otro?")
                  ) {
                    e.preventDefault();
                  }
                }}
              >
                <input type="hidden" name="store_id" value={storeId} />
                <OpsButton type="submit" size="sm" disabled={secretPending || revokePending} className="pointer-coarse:h-11">
                  {secretPending ? "Generando…" : data.configured ? "Cambiar secreto" : "Generar secreto"}
                </OpsButton>
              </form>
              {data.configured ? (
                <form
                  action={revokeAction}
                  onSubmit={(e) => {
                    if (!window.confirm("El bot ya no podrá pedir pedidos a Kapta en esta tienda (contestará 401 y derivará a una asesora). ¿Desactivar?")) {
                      e.preventDefault();
                    }
                  }}
                >
                  <input type="hidden" name="store_id" value={storeId} />
                  <OpsButton type="submit" size="sm" disabled={secretPending || revokePending} className="pointer-coarse:h-11">
                    {revokePending ? "Desactivando…" : "Desactivar"}
                  </OpsButton>
                </form>
              ) : null}
            </div>
          }
        />
        <div className={cn(ROW, "space-y-3")}>
          {secretState.error ? <Result state={secretState} /> : null}
          <Result state={revokeState} />
          {revealed ? (
            <Banner tone="ok" role="status" title="Secreto generado. Cópialo ahora: no se vuelve a mostrar.">
              <div className="mt-2 flex flex-wrap items-stretch gap-2">
                <CodeLine className="bg-white">{revealed}</CodeLine>
                <OpsButton onClick={() => copySecret(revealed)} className="h-auto min-h-9">
                  <IconCopy />
                  {copyLabel(copiedSecret)}
                </OpsButton>
              </div>
              <p className="mt-2 text-[13px] leading-5">
                En Kapso, en la acción del pedido: cabecera <code>Authorization</code> con el valor{" "}
                <code>Bearer {"<este secreto>"}</code>.
              </p>
            </Banner>
          ) : null}
          <p className={HELP}>
            Último uso: {data.lastUsedAt ? `${when(data.lastUsedAt)} · ${data.lastOutcome ?? "—"}` : "todavía ninguno"}.
          </p>
          {data.lastError ? (
            <Banner tone="warn" title={`Último fallo (${when(data.lastErrorAt)})`}>
              <p className="break-words">{data.lastError}</p>
            </Banner>
          ) : null}
        </div>
      </div>
    </SettingsSection>
  );
}

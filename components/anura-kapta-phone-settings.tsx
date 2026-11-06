"use client";

// Ajustes › «Telefonía Anura» › «Teléfono dentro de Kapta» (fase 2, solo
// salidas; MOM §8.7). Lo ve quien administra la tienda (`stores.manage`).
//
//   · La central SIP de la org (no es secreto): el dominio que Anura muestra en
//     «Obtener credenciales», y en «Avanzado» la URL WebSocket (por defecto
//     wss://sipwss.anura.pe; solo anura.pe) y el puerto (55090).
//   · Por anexo: el usuario SIP (por defecto `<anexo>-websocket`) y la
//     contraseña, con «Probar y guardar»: ESTE navegador intenta UN registro
//     con lo escrito y, solo si Anura lo acepta, el servidor guarda la clave
//     cifrada. Si Anura la rechaza no se guarda nada ni se reintenta (varios
//     intentos fallidos hacen que Anura bloquee la conexión de la oficina).
//     «Quitar clave» devuelve el anexo a la fase 1.
//   · La clave nunca vuelve aquí: solo «clave guardada: sí/no», la fecha y, si
//     Anura la rechazó al llamar, cuándo y por qué. El campo de la contraseña
//     se vacía después de cada intento.
//
// Del servidor solo se importan acciones y TIPOS (lo vigila
// `test/anura-ui.test.ts`); JsSIP llega con import dinámico al probar.

import { useEffect, useRef, useState } from "react";
import { cn } from "@/components/ui";
import { Badge, Banner, FIELD, OpsButton } from "@/components/ops-ui";
import { CARD, CardHeader, EmptyRow, Field, HELP, ROW, RowList } from "@/components/settings-ui";
import {
  removeAnuraSipCredentials,
  saveAnuraSipCredentials,
  saveAnuraSipSettings,
} from "@/app/dashboard/[storeId]/settings/anura-actions";
import type { AnuraExtensionView, AnuraMutationResult, AnuraSettingsData } from "@/lib/anura/server";
import {
  ANURA_DEFAULT_SIP_PORT,
  ANURA_DEFAULT_WS_URL,
  ANURA_KAPTA_PHONE_OUTBOUND_ONLY,
  ANURA_SIP_PASSWORD_HELP,
  ANURA_SIP_PASSWORD_MAX,
  defaultSipUser,
  looksLikeWebsocketUser,
} from "@/lib/anura/sip";
import { ANURA_PHONE_TEXT, testAnuraRegistration, type AnuraTabLock } from "@/lib/anura/sip-phone";
import {
  anuraSipPhoneBadge,
  anuraSipPhoneLines,
  anuraSipTestCredentials,
  parseAnuraSipCentral,
  type AnuraSipCentralDraft,
} from "@/lib/anura/phone-ui";
import { browserAnuraTabLock, createJsSipUa } from "@/lib/anura/jssip-client";

const WHEN = new Intl.DateTimeFormat("es-PE", {
  timeZone: "America/Lima",
  day: "2-digit",
  month: "2-digit",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
});

function when(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "—" : WHEN.format(d);
}

function draftOf(sip: AnuraSettingsData["sip"]): AnuraSipCentralDraft {
  return {
    domain: sip.domain ?? "",
    wsUrl: sip.wsUrl === ANURA_DEFAULT_WS_URL ? "" : sip.wsUrl,
    port: sip.port === ANURA_DEFAULT_SIP_PORT ? "" : String(sip.port),
  };
}

type RowMessage = { tone: "ok" | "crit" | "warn"; text: string };

export function KaptaPhoneCard({
  storeId,
  data,
  pending,
  mutate,
  onChanged,
}: {
  storeId: string;
  data: AnuraSettingsData;
  pending: boolean;
  mutate: (action: () => Promise<AnuraMutationResult>) => void;
  /** Se guardó o quitó una clave: recargar la sección. */
  onChanged: () => void;
}) {
  const [central, setCentral] = useState<AnuraSipCentralDraft>(() => draftOf(data.sip));
  const [centralError, setCentralError] = useState<string | null>(null);
  // Una sola prueba a la vez en esta pantalla (y el candado, una por navegador).
  const [testingId, setTestingId] = useState<string | null>(null);
  const lockRef = useRef<AnuraTabLock | null>(null);
  const lock = () => (lockRef.current ??= browserAnuraTabLock());

  // Lo guardado manda cuando cambia en el servidor.
  const savedKey = `${data.sip.domain ?? ""}|${data.sip.wsUrl}|${data.sip.port}|${data.sip.updatedAt ?? ""}`;
  useEffect(() => {
    setCentral(draftOf(data.sip));
    setCentralError(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- solo cuando cambia lo guardado
  }, [savedKey]);

  if (data.sipMigrationMissing) {
    return (
      <div className={cn(CARD, "divide-y divide-line")}>
        <CardHeader title="Teléfono dentro de Kapta (solo salidas)" aside={<Badge tone="neutral">Sin migración</Badge>} />
        <p className={cn(ROW, HELP)}>
          Falta aplicar la migración 0311 en la base. Hasta entonces todos los anexos llaman como en la fase 1: suena su teléfono
          de Anura.
        </p>
      </div>
    );
  }

  const withPhone = data.extensions.filter((e) => e.phone.hasPassword).length;
  const savedCentral = Boolean(data.sip.domain);

  return (
    <div className={cn(CARD, "divide-y divide-line")}>
      <CardHeader
        title="Teléfono dentro de Kapta (solo salidas)"
        description={
          <>
            <span className="block">
              Con la clave de la terminal web del anexo guardada aquí, «Llamar con Anura» usa un teléfono dentro de Kapta: la
              asesora habla con audífonos desde la ficha, sin nada instalado en su celular ni en su computadora. Sin clave, ese
              anexo sigue como antes: suena su teléfono de Anura.
            </span>
            <span className="mt-1.5 block">{ANURA_KAPTA_PHONE_OUTBOUND_ONLY}</span>
          </>
        }
        aside={
          <Badge tone={withPhone > 0 && savedCentral ? "ok" : "neutral"}>
            {withPhone > 0 ? `${withPhone} anexo${withPhone === 1 ? "" : "s"} con teléfono` : "Sin teléfonos"}
          </Badge>
        }
      />

      <form
        className={cn(ROW, "space-y-3")}
        onSubmit={(ev) => {
          ev.preventDefault();
          const parsed = parseAnuraSipCentral(central);
          if (!parsed.ok) {
            setCentralError(parsed.error);
            return;
          }
          setCentralError(null);
          mutate(() => saveAnuraSipSettings(storeId, { domain: parsed.domain, wsUrl: parsed.wsUrl, port: parsed.port }));
        }}
      >
        <div className="flex flex-wrap items-end gap-3">
          <Field
            label="Dominio SIP de la central"
            htmlFor="anura-sip-domain"
            hint="El que Anura muestra en «Obtener credenciales» de la terminal web. Es el mismo para todos los anexos."
            className="min-w-64 flex-1"
          >
            <input
              id="anura-sip-domain"
              autoComplete="off"
              spellCheck={false}
              value={central.domain}
              onChange={(e) => setCentral((c) => ({ ...c, domain: e.target.value }))}
              placeholder="miempresa.anura.pe"
              className={FIELD}
            />
          </Field>
          <OpsButton type="submit" disabled={pending || testingId !== null || !central.domain.trim()} className="mb-[26px] pointer-coarse:h-11">
            Guardar central
          </OpsButton>
        </div>
        <details className="text-sm">
          <summary className="cursor-pointer text-[13px] font-medium text-ink-700">Avanzado: URL WebSocket y puerto</summary>
          <div className="mt-3 flex flex-wrap items-end gap-3">
            <Field
              label="URL WebSocket"
              htmlFor="anura-sip-ws"
              hint={`Vacío: ${ANURA_DEFAULT_WS_URL} (Perú). Solo wss:// a servidores de anura.pe; anura.dev es Argentina y no sirve.`}
              className="min-w-64 flex-1"
            >
              <input
                id="anura-sip-ws"
                autoComplete="off"
                spellCheck={false}
                value={central.wsUrl}
                onChange={(e) => setCentral((c) => ({ ...c, wsUrl: e.target.value }))}
                placeholder={ANURA_DEFAULT_WS_URL}
                className={FIELD}
              />
            </Field>
            <Field label="Puerto SIP" htmlFor="anura-sip-port" hint={`Vacío: ${ANURA_DEFAULT_SIP_PORT}.`} className="w-32">
              <input
                id="anura-sip-port"
                inputMode="numeric"
                autoComplete="off"
                maxLength={5}
                value={central.port}
                onChange={(e) => setCentral((c) => ({ ...c, port: e.target.value.replace(/\D/g, "") }))}
                placeholder={String(ANURA_DEFAULT_SIP_PORT)}
                className={cn(FIELD, "tabular-nums")}
              />
            </Field>
          </div>
        </details>
        {centralError && (
          <p role="alert" className="text-sm text-crit-fg">
            {centralError}
          </p>
        )}
        <p className={HELP}>
          {savedCentral ? <>Central guardada el {when(data.sip.updatedAt)}.</> : <>Todavía no hay dominio: sin él ningún anexo puede usar el teléfono de Kapta.</>}
        </p>
      </form>

      <p className={cn(ROW, HELP)}>{ANURA_SIP_PASSWORD_HELP}</p>

      {data.extensions.length === 0 ? (
        <EmptyRow>Asigna primero un anexo a cada persona (arriba). La clave es de cada anexo.</EmptyRow>
      ) : (
        <RowList>
          {data.extensions.map((e) => (
            <SipExtensionRow
              key={`${e.id}:${e.extension}`}
              storeId={storeId}
              ext={e}
              central={central}
              pending={pending}
              testingId={testingId}
              setTestingId={setTestingId}
              lock={lock}
              mutate={mutate}
              onChanged={onChanged}
            />
          ))}
        </RowList>
      )}
    </div>
  );
}

function SipExtensionRow({
  storeId,
  ext,
  central,
  pending,
  testingId,
  setTestingId,
  lock,
  mutate,
  onChanged,
}: {
  storeId: string;
  ext: AnuraExtensionView;
  central: AnuraSipCentralDraft;
  pending: boolean;
  testingId: string | null;
  setTestingId: (id: string | null) => void;
  lock: () => AnuraTabLock;
  mutate: (action: () => Promise<AnuraMutationResult>) => void;
  onChanged: () => void;
}) {
  const [sipUser, setSipUser] = useState(ext.phone.sipUser || defaultSipUser(ext.extension));
  const [password, setPassword] = useState("");
  const [step, setStep] = useState<"probando" | "guardando" | null>(null);
  const [message, setMessage] = useState<RowMessage | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const badge = anuraSipPhoneBadge(ext.phone);
  const lines = anuraSipPhoneLines(ext.phone, when);
  const busy = testingId !== null;
  const userId = `anura-sip-user-${ext.id}`;
  const passId = `anura-sip-pass-${ext.id}`;
  const notWebsocket = sipUser.trim() !== "" && !looksLikeWebsocketUser(sipUser);

  async function testAndSave() {
    const built = anuraSipTestCredentials(central, ext.extension, sipUser, password);
    if (!built.ok) {
      setMessage({ tone: "crit", text: built.error });
      return;
    }
    setTestingId(ext.id);
    setStep("probando");
    setMessage(null);
    let held: { release(): void } | null = null;
    try {
      held = await lock().acquire();
      if (!held) {
        setMessage({ tone: "crit", text: `${ANURA_PHONE_TEXT.otra_pestana} Ciérrala antes de probar.` });
        return;
      }
      // UN registro, sin llamada y sin reintentos.
      const res = await testAnuraRegistration({ createUa: createJsSipUa }, built.creds);
      held.release();
      held = null;
      if (!res.ok) {
        if (mounted.current) {
          // Con una clave mala se vacía el campo: otro intento tiene que ser a propósito.
          if (res.kind === "clave") setPassword("");
          setMessage({ tone: "crit", text: res.message });
        }
        return;
      }
      if (mounted.current) setStep("guardando");
      const saved = await saveAnuraSipCredentials(storeId, ext.id, {
        domain: built.creds.domain,
        wsUrl: built.creds.wsUrl,
        port: built.creds.port,
        sipUser: built.sipUser,
        password: built.creds.password,
      });
      if (!mounted.current) return;
      setPassword("");
      if (saved.ok) {
        setMessage({ tone: "ok", text: `Anura aceptó la clave. ${saved.notice}` });
        onChanged();
      } else {
        setMessage({ tone: "crit", text: `Anura aceptó la clave, pero no se pudo guardar: ${saved.error}` });
      }
    } catch {
      if (mounted.current) setMessage({ tone: "crit", text: "No se pudo probar la clave. No se guardó nada; vuelve a intentar en un momento." });
    } finally {
      held?.release();
      setTestingId(null);
      if (mounted.current) setStep(null);
    }
  }

  return (
    <li className={cn(ROW, "space-y-3")}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-medium text-ink-900">
            {ext.name} · anexo <span className="tabular-nums">{ext.extension}</span>
            {!ext.active && <span className="font-normal text-ink-500"> (apagado)</span>}
          </p>
          {lines.map((line) => (
            <p key={line} className={cn(HELP, "break-words")}>
              {line}
            </p>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone={badge.tone}>{badge.label}</Badge>
          {ext.phone.hasPassword && (
            <OpsButton
              size="sm"
              disabled={pending || busy}
              onClick={() => {
                if (
                  window.confirm(
                    `¿Quitar la clave del teléfono de Kapta del anexo ${ext.extension}? Ese anexo vuelve a llamar como antes: suena su teléfono de Anura. ` +
                      "Deja en Anura como principal la terminal que va a contestar.",
                  )
                ) {
                  mutate(() => removeAnuraSipCredentials(storeId, ext.id));
                }
              }}
              className="pointer-coarse:h-11"
            >
              Quitar clave
            </OpsButton>
          )}
        </div>
      </div>

      <form
        className="flex flex-wrap items-end gap-3"
        onSubmit={(ev) => {
          ev.preventDefault();
          if (!busy && !pending && password) void testAndSave();
        }}
      >
        <Field
          label="Usuario SIP"
          htmlFor={userId}
          hint={notWebsocket ? "Ojo: la terminal web suele terminar en «-websocket»." : `Por defecto, ${defaultSipUser(ext.extension)}.`}
          className="min-w-48 flex-1"
        >
          <input
            id={userId}
            autoComplete="off"
            spellCheck={false}
            value={sipUser}
            disabled={busy}
            onChange={(e) => setSipUser(e.target.value)}
            placeholder={defaultSipUser(ext.extension)}
            className={FIELD}
          />
        </Field>
        <Field
          label={ext.phone.hasPassword ? "Contraseña SIP nueva" : "Contraseña SIP"}
          htmlFor={passId}
          hint="La de la terminal «-websocket». Kapta la guarda cifrada y no la vuelve a mostrar."
          className="min-w-48 flex-1"
        >
          <input
            id={passId}
            type="password"
            autoComplete="new-password"
            spellCheck={false}
            maxLength={ANURA_SIP_PASSWORD_MAX}
            value={password}
            disabled={busy}
            onChange={(e) => setPassword(e.target.value)}
            className={FIELD}
          />
        </Field>
        <OpsButton type="submit" variant="primary" disabled={pending || busy || !password} className="mb-[26px] pointer-coarse:h-11">
          {step === "probando" ? "Probando con Anura…" : step === "guardando" ? "Guardando…" : "Probar y guardar"}
        </OpsButton>
      </form>

      {message && (
        <Banner tone={message.tone} role={message.tone === "ok" ? "status" : "alert"}>
          <p className="break-words">{message.text}</p>
        </Banner>
      )}
    </li>
  );
}

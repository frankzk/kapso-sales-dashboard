import { describe, expect, it } from "vitest";
import { cleanDiag, cleanDiagValue } from "@/lib/anura/phone-diag";

describe("diagnóstico del teléfono de Kapta (sin datos personales)", () => {
  it("borra cualquier secuencia de 6+ dígitos (un teléfono nunca llega al log)", () => {
    expect(cleanDiagValue("sip:965391481@central.anura.pe")).toBe("sip:#@central.anura.pe");
    expect(cleanDiagValue("+51 965391481")).toBe("+51 #");
    expect(cleanDiagValue(486)).toBe(486);
    expect(cleanDiagValue(undefined)).toBeNull();
  });

  it("acorta textos y limpia nombres de evento y claves", () => {
    expect(String(cleanDiagValue("x".repeat(200))).length).toBe(80);
    expect(cleanDiag("invite!", { "why;": "no_remoto", ok: true })).toEqual({ event: "invite", data: { why: "no_remoto", ok: true } });
    expect(cleanDiag("", {})).toBeNull();
    expect(cleanDiag(42, {})).toBeNull();
  });
});

import { sdpTraits } from "@/lib/anura/sip-phone";

describe("rasgos del SDP de Anura (diagnóstico)", () => {
  it("lee protocolo, rtcp-mux, DTLS, ICE y códecs sin IPs", () => {
    const sdp = [
      "v=0",
      "o=- 1 2 IN IP4 10.0.0.1",
      "c=IN IP4 10.0.0.1",
      "m=audio 10000 UDP/TLS/RTP/SAVPF 0 8 101",
      "a=rtpmap:0 PCMU/8000",
      "a=rtpmap:8 PCMA/8000",
      "a=rtpmap:101 telephone-event/8000",
      "a=fingerprint:sha-256 AA:BB",
      "a=setup:actpass",
      "a=ice-ufrag:abc",
      "a=rtcp-mux",
    ].join("\r\n");
    expect(sdpTraits(sdp)).toEqual({
      sdp: true, proto: "UDP/TLS/RTP/SAVPF", mux: true, dtls: true, crypto: false, ice: true, bundle: false, setup: "actpass",
      codecs: "PCMU,PCMA,telephone-event",
    });
    expect(sdpTraits(undefined)).toEqual({ sdp: false });
  });
});

import { ANURA_VOLUME_DEFAULT, clampAnuraVolume } from "@/lib/anura/phone-ui";

describe("volumen de la llamada (amplificador)", () => {
  it("queda entre 1× y 4×, en pasos de 0,25; lo inválido vuelve a 2,5×", () => {
    expect(ANURA_VOLUME_DEFAULT).toBe(2.5);
    expect(clampAnuraVolume(0.2)).toBe(1);
    expect(clampAnuraVolume(9)).toBe(4);
    expect(clampAnuraVolume(2.1)).toBe(2);
    expect(clampAnuraVolume(Number.NaN)).toBe(2.5);
  });
});

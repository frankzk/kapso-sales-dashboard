import { describe, expect, it } from "vitest";
import {
  mergeTranscriptWithOutbox,
  parseWhatsappStatusEvents,
  isRetryableWhatsappFailure,
  shouldAdvanceWhatsappStatus,
  type WhatsappOutboxRow,
} from "@/lib/whatsapp-outbox";

function row(overrides: Partial<WhatsappOutboxRow> = {}): WhatsappOutboxRow {
  return {
    id: "attempt-1",
    store_id: "store-1",
    lead_id: "lead-1",
    client_token: "token-1",
    retry_of: null,
    provider_message_id: "wamid.1",
    phone_number_id: "pn-1",
    to_phone: "51999",
    kind: "text",
    body: "Hola",
    status: "sent",
    retryable: false,
    error_code: null,
    error_message: null,
    created_at: "2026-07-17T15:00:00.000Z",
    updated_at: "2026-07-17T15:00:00.000Z",
    sent_at: "2026-07-17T15:00:00.000Z",
    delivered_at: null,
    read_at: null,
    failed_at: null,
    ...overrides,
  };
}

describe("WhatsApp delivery lifecycle", () => {
  it("parses Meta Cloud API status batches", () => {
    const events = parseWhatsappStatusEvents({
      entry: [{ changes: [{ value: { statuses: [{ id: "wamid.1", status: "read", timestamp: "1784300400" }] } }] }],
    });
    expect(events).toEqual([
      expect.objectContaining({ providerMessageId: "wamid.1", status: "read" }),
    ]);
    expect(events[0]?.at).toBe("2026-07-17T15:00:00.000Z");
  });

  it("parses flattened Kapso failed events and their error", () => {
    const events = parseWhatsappStatusEvents(
      { message: { id: "wamid.2", errors: [{ code: 131026, message: "Undeliverable" }] } },
      "whatsapp.message.failed",
    );
    expect(events).toEqual([
      expect.objectContaining({
        providerMessageId: "wamid.2",
        status: "failed",
        errorCode: "131026",
        errorMessage: "Undeliverable",
      }),
    ]);
  });

  it("never downgrades delivered/read and does not overwrite a declared failure with sent", () => {
    expect(shouldAdvanceWhatsappStatus("sent", "delivered")).toBe(true);
    expect(shouldAdvanceWhatsappStatus("delivered", "sent")).toBe(false);
    expect(shouldAdvanceWhatsappStatus("read", "failed")).toBe(false);
    expect(shouldAdvanceWhatsappStatus("failed", "sent")).toBe(false);
  });

  it("does not offer futile retries for permanent Meta errors", () => {
    expect(isRetryableWhatsappFailure(131047)).toBe(false);
    expect(isRetryableWhatsappFailure("131026")).toBe(false);
    expect(isRetryableWhatsappFailure(130429)).toBe(true);
  });

  it("merges local state into the provider transcript", () => {
    const result = mergeTranscriptWithOutbox(
      [{
        id: "wamid.1",
        direction: "outbound",
        at: "2026-07-17T15:00:00.000Z",
        text: "Hola",
        mediaKind: null,
        mediaUrl: null,
        status: "sent",
      }],
      [row({ status: "read", read_at: "2026-07-17T15:01:00.000Z" })],
      "pn-1",
    );
    expect(result[0]).toMatchObject({ status: "read", outboxId: "attempt-1" });
  });

  it("does not downgrade a newer provider status when a webhook was missed", () => {
    const result = mergeTranscriptWithOutbox(
      [{
        id: "wamid.1",
        direction: "outbound",
        at: "2026-07-17T15:00:00.000Z",
        text: "Hola",
        mediaKind: null,
        mediaUrl: null,
        status: "delivered",
      }],
      [row({ status: "sent" })],
      "pn-1",
    );
    expect(result[0]?.status).toBe("delivered");
  });

  it("hides the failed attempt after its explicit retry exists", () => {
    const result = mergeTranscriptWithOutbox(
      [],
      [
        row({ provider_message_id: null, status: "failed", retryable: true }),
        row({ id: "attempt-2", client_token: "token-2", retry_of: "attempt-1", provider_message_id: "wamid.2" }),
      ],
      "pn-1",
    );
    expect(result).toHaveLength(1);
    expect(result[0]?.outboxId).toBe("attempt-2");
  });
});

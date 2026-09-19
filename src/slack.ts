import { IntegrationError } from "./errors";
import { isNonEmptyString, isRecord } from "./guards";
import { discardResponseBody } from "./http";

export interface TargetMessage {
  eventId: string;
  channel: string;
  timestamp: string;
  text: string;
}

const CHANNEL_TYPES = new Set(["channel", "group", "im", "mpim"]);

function constantTimeEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) {
    return false;
  }

  let difference = 0;
  for (let index = 0; index < left.byteLength; index += 1) {
    difference |= left[index]! ^ right[index]!;
  }
  return difference === 0;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function verifySlackSignature(
  rawBody: string,
  timestamp: string | null,
  signature: string | null,
  signingSecret: string,
  nowMs = Date.now(),
): Promise<boolean> {
  if (
    timestamp === null ||
    signature === null ||
    !/^\d+$/.test(timestamp) ||
    !/^v0=[0-9a-f]{64}$/i.test(signature)
  ) {
    return false;
  }

  const timestampSeconds = Number(timestamp);
  if (!Number.isSafeInteger(timestampSeconds) || Math.abs(nowMs / 1000 - timestampSeconds) > 300) {
    return false;
  }

  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(signingSecret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signed = await crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode(`v0:${timestamp}:${rawBody}`),
  );
  const expected = encoder.encode(`v0=${bytesToHex(new Uint8Array(signed))}`);
  return constantTimeEqual(expected, encoder.encode(signature.toLowerCase()));
}

export function getTargetMessage(payload: unknown): TargetMessage | null {
  if (!isRecord(payload) || payload.type !== "event_callback" || !isRecord(payload.event)) {
    return null;
  }

  const event = payload.event;
  if (
    event.type !== "message" ||
    !isNonEmptyString(event.channel_type) ||
    !CHANNEL_TYPES.has(event.channel_type) ||
    !isNonEmptyString(event.user) ||
    !isNonEmptyString(event.channel) ||
    !isNonEmptyString(event.ts) ||
    !isNonEmptyString(event.text) ||
    event.text.trim() === "" ||
    event.subtype !== undefined ||
    event.thread_ts !== undefined ||
    event.bot_id !== undefined ||
    event.app_id !== undefined
  ) {
    return null;
  }

  if (!/^\d+(?:\.\d+)?$/.test(event.ts)) {
    return null;
  }

  return {
    eventId: isNonEmptyString(payload.event_id) ? payload.event_id : "unknown",
    channel: event.channel,
    timestamp: event.ts,
    text: event.text,
  };
}

export async function addReaction(
  botToken: string,
  channel: string,
  timestamp: string,
  emojiName: string,
): Promise<void> {
  let response: Response;

  try {
    response = await fetch("https://slack.com/api/reactions.add", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${botToken}`,
        "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
      },
      body: new URLSearchParams({ channel, timestamp, name: emojiName }),
      signal: AbortSignal.timeout(7_000),
    });
  } catch {
    throw new IntegrationError("slack_network_error");
  }

  if (!response.ok) {
    await discardResponseBody(response);
    throw new IntegrationError(`slack_http_${response.status}`);
  }

  let result: unknown;
  try {
    result = await response.json();
  } catch {
    throw new IntegrationError("slack_invalid_json");
  }

  if (!isRecord(result) || typeof result.ok !== "boolean") {
    throw new IntegrationError("slack_invalid_response");
  }

  if (result.ok) {
    return;
  }

  if (result.error === "already_reacted") {
    return;
  }

  throw new IntegrationError(
    typeof result.error === "string" && /^[a-z0-9_]+$/.test(result.error)
      ? `slack_${result.error}`
      : "slack_api_error",
  );
}

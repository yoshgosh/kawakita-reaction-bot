import { parseReactionConfig, type ReactionConfig } from "./config";
import { IntegrationError } from "./errors";
import { isRecord } from "./guards";
import { addReaction, getTargetMessage, type TargetMessage, verifySlackSignature } from "./slack";
import { chooseReaction } from "./typesafe";

interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
}

const EVENT_PATH = "/slack/events";
const MAX_BODY_BYTES = 1_000_000;

function textResponse(body: string, status: number, contentType = "text/plain; charset=utf-8"): Response {
  return new Response(body, {
    status,
    headers: { "Content-Type": contentType, "Cache-Control": "no-store" },
  });
}

function logFailure(eventId: string, step: string, error: unknown): void {
  const code = error instanceof IntegrationError ? error.code : "unexpected_error";
  console.error(JSON.stringify({ level: "error", event_id: eventId, step, code }));
}

async function processMessage(
  env: Env,
  message: TargetMessage,
): Promise<void> {
  if (!env.SLACK_BOT_TOKEN || !env.TYPESAFE_API_KEY || !env.REACTION_CONFIG) {
    logFailure(message.eventId, "configuration", new IntegrationError("missing_environment_binding"));
    return;
  }

  let config: ReactionConfig;
  try {
    config = parseReactionConfig(env.REACTION_CONFIG);
  } catch {
    logFailure(message.eventId, "configuration", new IntegrationError("invalid_reaction_config"));
    return;
  }

  let emojiName: string;
  try {
    emojiName = await chooseReaction(env.TYPESAFE_API_KEY, message.text, config);
  } catch (error) {
    logFailure(message.eventId, "typesafe", error);
    return;
  }

  try {
    await addReaction(env.SLACK_BOT_TOKEN, message.channel, message.timestamp, emojiName);
  } catch (error) {
    logFailure(message.eventId, "slack", error);
  }
}

async function handleRequest(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname !== EVENT_PATH) {
    return textResponse("Not found", 404);
  }
  if (request.method !== "POST") {
    return textResponse("Method not allowed", 405, "text/plain; charset=utf-8");
  }

  if (!env.SLACK_SIGNING_SECRET) {
    return textResponse("Service unavailable", 503);
  }

  const contentLength = request.headers.get("Content-Length");
  if (contentLength !== null && Number(contentLength) > MAX_BODY_BYTES) {
    return textResponse("Payload too large", 413);
  }

  let rawBody: string;
  try {
    rawBody = await request.text();
  } catch {
    return textResponse("Invalid request body", 400);
  }
  if (new TextEncoder().encode(rawBody).byteLength > MAX_BODY_BYTES) {
    return textResponse("Payload too large", 413);
  }

  const verified = await verifySlackSignature(
    rawBody,
    request.headers.get("X-Slack-Request-Timestamp"),
    request.headers.get("X-Slack-Signature"),
    env.SLACK_SIGNING_SECRET,
  );
  if (!verified) {
    return textResponse("Unauthorized", 401);
  }

  let payload: unknown;
  try {
    payload = JSON.parse(rawBody) as unknown;
  } catch {
    return textResponse("Invalid JSON", 400);
  }

  if (isRecord(payload) && payload.type === "url_verification") {
    if (typeof payload.challenge !== "string") {
      return textResponse("Invalid challenge", 400);
    }
    return textResponse(JSON.stringify({ challenge: payload.challenge }), 200, "application/json; charset=utf-8");
  }

  if (request.headers.has("X-Slack-Retry-Num")) {
    return textResponse("ok", 200);
  }

  const message = getTargetMessage(payload);
  if (message === null) {
    return textResponse("ok", 200);
  }

  ctx.waitUntil(processMessage(env, message));
  return textResponse("ok", 200);
}

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    return handleRequest(request, env, ctx);
  },
};

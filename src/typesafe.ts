import type { ReactionConfig } from "./config";
import { IntegrationError } from "./errors";
import { isRecord } from "./guards";
import { discardResponseBody } from "./http";

const TYPESAFE_ENDPOINT = "https://api.typesafe.ai/v1/systemone";
const MODEL = "jev-1.13.0";
const REQUEST_TIMEOUT_MS = 7_000;
const MAX_RETRY_DELAY_MS = 5_000;

function parseRetryAfter(value: string | null): number | null {
  if (value === null) {
    return 1_000;
  }

  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.ceil(seconds * 1_000);
  }

  const dateMs = Date.parse(value);
  return Number.isNaN(dateMs) ? null : Math.max(0, dateMs - Date.now());
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export async function chooseReaction(
  apiKey: string,
  messageText: string,
  config: ReactionConfig,
): Promise<string> {
  const criteria = Object.fromEntries(
    config.options.map((option) => [option.id, option.description]),
  );
  const body = JSON.stringify({
    state: messageText,
    model: MODEL,
    questions: {
      reaction: {
        type: "choice",
        instructions: config.instruction,
        criteria,
      },
    },
  });

  let response: Response | undefined;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      response = await fetch(TYPESAFE_ENDPOINT, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch {
      throw new IntegrationError("typesafe_network_error");
    }

    if (response.status !== 429 && response.status !== 529) {
      break;
    }

    if (attempt === 1) {
      await discardResponseBody(response);
      throw new IntegrationError(`typesafe_http_${response.status}`);
    }

    const delay = parseRetryAfter(response.headers.get("Retry-After"));
    if (delay === null || delay > MAX_RETRY_DELAY_MS) {
      await discardResponseBody(response);
      throw new IntegrationError(`typesafe_http_${response.status}`);
    }
    await discardResponseBody(response);
    await wait(delay);
  }

  if (response === undefined) {
    throw new IntegrationError("typesafe_missing_response");
  }
  if (!response.ok) {
    await discardResponseBody(response);
    throw new IntegrationError(`typesafe_http_${response.status}`);
  }

  let result: unknown;
  try {
    result = await response.json();
  } catch {
    throw new IntegrationError("typesafe_invalid_json");
  }

  if (!isRecord(result) || !isRecord(result.answers) || !isRecord(result.answers.reaction)) {
    throw new IntegrationError("typesafe_invalid_response");
  }

  const answer = result.answers.reaction;
  if (answer.type !== "choice" || typeof answer.choice !== "string") {
    throw new IntegrationError("typesafe_invalid_choice");
  }

  const selected = config.options.find((option) => option.id === answer.choice);
  if (selected === undefined) {
    throw new IntegrationError("typesafe_unknown_choice");
  }

  return selected.slackEmoji;
}

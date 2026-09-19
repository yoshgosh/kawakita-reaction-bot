import { isRecord } from "./guards";

export interface ReactionOption {
  id: string;
  slackEmoji: string;
  description: string;
}

export interface ReactionConfig {
  instruction: string;
  options: ReactionOption[];
}

function requiredText(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`invalid_reaction_config_${field}`);
  }
  return value.trim();
}

export function parseReactionConfig(raw: string): ReactionConfig {
  let value: unknown;

  try {
    value = JSON.parse(raw) as unknown;
  } catch {
    throw new Error("invalid_reaction_config_json");
  }

  if (!isRecord(value) || !Array.isArray(value.options)) {
    throw new Error("invalid_reaction_config_shape");
  }

  const instruction = requiredText(value.instruction, "instruction");
  if (value.options.length === 0) {
    throw new Error("invalid_reaction_config_options");
  }

  const seenIds = new Set<string>();
  const seenEmojiNames = new Set<string>();
  const options = value.options.map((entry: unknown): ReactionOption => {
    if (!isRecord(entry)) {
      throw new Error("invalid_reaction_config_option");
    }

    const id = requiredText(entry.id, "option_id");
    const slackEmoji = requiredText(entry.slackEmoji, "slack_emoji");
    const description = requiredText(entry.description, "description");

    if (seenIds.has(id) || seenEmojiNames.has(slackEmoji)) {
      throw new Error("duplicate_reaction_config_option");
    }

    seenIds.add(id);
    seenEmojiNames.add(slackEmoji);
    return { id, slackEmoji, description };
  });

  return { instruction, options };
}

import { applyCompressionAsync } from "./strategySelector.ts";
import { createCompressionStats } from "./stats.ts";
import type { CompressionConfig, CompressionResult } from "./types.ts";

type MessageLike = {
  role?: unknown;
  content?: unknown;
  tool_calls?: unknown;
  [key: string]: unknown;
};

/** The current prompt is the final direct user message; replayed history is never selected. */
export function findCurrentGrevPromptIndex(messages: MessageLike[]): number {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (
      message.role === "user" &&
      typeof message.content === "string" &&
      !Array.isArray(message.tool_calls) &&
      !message.content.startsWith("[CCR retrieve ")
    ) {
      return index;
    }
  }
  return -1;
}

/**
 * Runs only the explicitly selected GrevCaching engines against the newest direct
 * user message. The replayed request prefix is copied unchanged.
 */
export async function applyGrevNewBlockPipeline(
  body: Record<string, unknown>,
  pipeline: string[],
  _options: { model?: string; principalId?: string; provider?: string } = {}
): Promise<CompressionResult> {
  if (!Array.isArray(body.messages)) {
    return { body, compressed: false, stats: null };
  }
  const messages = body.messages as MessageLike[];
  const index = findCurrentGrevPromptIndex(messages);
  if (index < 0) return { body, compressed: false, stats: null };

  const current = messages[index];
  if (pipeline.length === 0) {
    return {
      body,
      compressed: false,
      stats: createCompressionStats(
        { messages: [current] },
        { messages: [current] },
        "stacked",
        ["no-current-message-passes-selected"]
      ),
    };
  }

  const result = await applyCompressionAsync({ messages: [current] }, "stacked", {
    model: _options.model,
    principalId: _options.principalId,
    provider: _options.provider,
    config: {
      enabled: true,
      stackedPipeline: pipeline.map((engine) => ({ engine })),
    } as CompressionConfig,
  });
  const rewritten = Array.isArray(result.body.messages)
    ? (result.body.messages as MessageLike[])
    : [];
  const stats = result.stats ?? createCompressionStats(
    { messages: [current] },
    { messages: [current] },
    "stacked",
    pipeline.map((engine) => `${engine}-no-change`)
  );
  if (rewritten.length === 0) return { body, compressed: false, stats };
  const changed = JSON.stringify(rewritten[0]) !== JSON.stringify(current);
  if (!changed) return { body, compressed: false, stats };
  return {
    ...result,
    body: {
      ...body,
      messages: [...messages.slice(0, index), ...rewritten, ...messages.slice(index + 1)],
    },
  };
}

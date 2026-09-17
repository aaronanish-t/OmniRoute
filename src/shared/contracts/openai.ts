import { z } from "zod";

/** Shared wire contracts for the OpenAI-compatible public API. */

export const openAiMessageContentSchema = z.union([z.string(), z.array(z.unknown())]);

export const openAiChatMessageSchema = z
  .object({
    role: z.enum(["system", "developer", "user", "assistant", "tool"]),
    content: openAiMessageContentSchema.nullable().optional(),
    name: z.string().optional(),
    tool_call_id: z.string().optional(),
    tool_calls: z.array(z.unknown()).optional(),
  })
  .passthrough();

export const openAiChatCompletionRequestSchema = z
  .object({
    model: z.string().min(1),
    messages: z.array(openAiChatMessageSchema).min(1),
    stream: z.boolean().optional(),
    temperature: z.number().min(0).max(2).optional(),
    top_p: z.number().min(0).max(1).optional(),
    max_tokens: z.number().int().positive().optional(),
    max_completion_tokens: z.number().int().positive().optional(),
    n: z.number().int().positive().optional(),
    tools: z.array(z.unknown()).optional(),
    tool_choice: z.unknown().optional(),
    response_format: z.unknown().optional(),
  })
  .passthrough();

export const openAiUsageSchema = z
  .object({
    prompt_tokens: z.number().int().nonnegative(),
    completion_tokens: z.number().int().nonnegative(),
    total_tokens: z.number().int().nonnegative(),
  })
  .passthrough();

export const openAiChatCompletionChoiceSchema = z
  .object({
    index: z.number().int().nonnegative(),
    message: openAiChatMessageSchema.optional(),
    finish_reason: z.string().nullable().optional(),
    delta: z.record(z.string(), z.unknown()).optional(),
  })
  .passthrough();

export const openAiChatCompletionResponseSchema = z
  .object({
    id: z.string().min(1),
    object: z.literal("chat.completion"),
    created: z.number().int().nonnegative(),
    model: z.string().min(1),
    choices: z.array(openAiChatCompletionChoiceSchema),
    usage: openAiUsageSchema.nullable().optional(),
  })
  .passthrough();

export const openAiChatCompletionChunkSchema = z
  .object({
    id: z.string().min(1),
    object: z.literal("chat.completion.chunk"),
    created: z.number().int().nonnegative(),
    model: z.string().min(1),
    choices: z.array(openAiChatCompletionChoiceSchema),
    usage: openAiUsageSchema.nullable().optional(),
  })
  .passthrough();

export const openAiErrorSchema = z
  .object({
    error: z
      .object({
        message: z.string(),
        type: z.string(),
        param: z.string().nullable().optional(),
        code: z.union([z.string(), z.number()]).nullable().optional(),
      })
      .passthrough(),
  })
  .passthrough();

export const openAiModelSchema = z
  .object({
    id: z.string().min(1),
    object: z.literal("model"),
    created: z.number().int().nonnegative(),
    owned_by: z.string().min(1),
  })
  .passthrough();

export const openAiModelListSchema = z.object({
  object: z.literal("list"),
  data: z.array(openAiModelSchema),
});


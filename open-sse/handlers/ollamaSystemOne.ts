/**
 * Ollama System One proxy (`POST {ollama}/v1/systemone`, Ollama >= 0.35).
 *
 * System One models (Nimble, Tev) answer typed `choice` / `noul` / `score`
 * questions about a `state` with calibrated probabilities instead of generating
 * text. The request is a single non-streaming JSON POST, so this handler only
 * validates, forwards the known fields, and maps failures onto OmniRoute's
 * resilience layers:
 *
 * - 404 (model not pulled)            → model lockout on that connection
 * - 400 (e.g. not a System One model) → returned as-is, connection untouched
 * - 5xx / unreachable / timeout       → connection cooldown
 *
 * Limits mirror the ones Ollama enforces so callers get the same answers
 * without a round trip. See https://docs.ollama.com/api/systemone
 */

import { z } from "zod";
import { CORS_HEADERS } from "../utils/cors.ts";
import { errorResponse } from "../utils/error.ts";
import { stripTrailingSlashes } from "../utils/urlSanitize.ts";
import { attachOmniRouteMetaHeaders } from "@/domain/omnirouteResponseMeta";
import { generateRequestId } from "@/shared/utils/requestId";
import { saveCallLog } from "@/lib/usageDb";

export const OLLAMA_SYSTEMONE_PROVIDER = "ollama-local";
export const OLLAMA_SYSTEMONE_DEFAULT_BASE_URL = "http://localhost:11434/v1";
export const OLLAMA_SYSTEMONE_MAX_BODY_BYTES = 64 * 1024;
export const OLLAMA_SYSTEMONE_MAX_QUESTIONS = 64;
export const OLLAMA_SYSTEMONE_MIN_CRITERIA = 2;
export const OLLAMA_SYSTEMONE_MAX_CRITERIA = 26;
// The first call loads the model; on a Jetson-class host that alone took 8–10s.
export const OLLAMA_SYSTEMONE_DEFAULT_TIMEOUT_MS = 60_000;

const UNSUPPORTED_MODEL_PATTERN = /not supported by system one/i;

const structuredTextSchema = z.union([
  z.string().trim().min(1),
  z.record(z.string(), z.unknown()),
  z.array(z.unknown()),
]);

const criteriaCountMessage = `criteria must contain ${OLLAMA_SYSTEMONE_MIN_CRITERIA}–${OLLAMA_SYSTEMONE_MAX_CRITERIA} candidates`;

const choiceQuestionSchema = z
  .object({
    type: z.literal("choice"),
    instructions: structuredTextSchema,
    criteria: z.record(z.string().min(1), z.unknown()).refine((criteria) => {
      const count = Object.keys(criteria).length;
      return count >= OLLAMA_SYSTEMONE_MIN_CRITERIA && count <= OLLAMA_SYSTEMONE_MAX_CRITERIA;
    }, criteriaCountMessage),
  })
  .passthrough();

const noulQuestionSchema = z
  .object({
    type: z.literal("noul"),
    instructions: structuredTextSchema,
    criteria: z
      .object({ true: z.unknown().optional(), false: z.unknown().optional() })
      .passthrough()
      .optional(),
  })
  .passthrough();

const scoreQuestionSchema = z
  .object({
    type: z.literal("score"),
    instructions: structuredTextSchema,
    criteria: z
      .array(z.unknown())
      .min(OLLAMA_SYSTEMONE_MIN_CRITERIA, criteriaCountMessage)
      .max(OLLAMA_SYSTEMONE_MAX_CRITERIA, criteriaCountMessage),
  })
  .passthrough();

const questionSchema = z.discriminatedUnion("type", [
  choiceQuestionSchema,
  noulQuestionSchema,
  scoreQuestionSchema,
]);

export const ollamaSystemOneRequestSchema = z.object({
  model: z.string().trim().min(1),
  state: structuredTextSchema,
  questions: z.record(z.string().min(1), questionSchema).refine((questions) => {
    const count = Object.keys(questions).length;
    return count >= 1 && count <= OLLAMA_SYSTEMONE_MAX_QUESTIONS;
  }, `questions must contain 1–${OLLAMA_SYSTEMONE_MAX_QUESTIONS} fields`),
  keep_alive: z.union([z.string().min(1), z.number()]).optional(),
});

export type OllamaSystemOneRequest = z.infer<typeof ollamaSystemOneRequestSchema>;

export type OllamaSystemOneValidation =
  { ok: true; data: OllamaSystemOneRequest } | { ok: false; status: 400 | 413; message: string };

/**
 * Validate a raw `/v1/systemone` body against Ollama's limits. Unknown top-level
 * fields (e.g. `stream`) are dropped, matching Ollama, which ignores them.
 */
export function validateOllamaSystemOneRequest(raw: unknown): OllamaSystemOneValidation {
  let serializedBytes = 0;
  try {
    serializedBytes = Buffer.byteLength(JSON.stringify(raw ?? null), "utf8");
  } catch {
    return { ok: false, status: 400, message: "Invalid JSON body" };
  }
  if (serializedBytes > OLLAMA_SYSTEMONE_MAX_BODY_BYTES) {
    return { ok: false, status: 413, message: "request body must not exceed 64 KiB" };
  }

  const parsed = ollamaSystemOneRequestSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const where = issue?.path?.length ? `${issue.path.join(".")}: ` : "";
    return { ok: false, status: 400, message: `${where}${issue?.message ?? "invalid request"}` };
  }
  return { ok: true, data: parsed.data };
}

/** Build the native System One URL from the connection's OpenAI-compatible base URL. */
export function buildOllamaSystemOneUrl(baseUrl: string | null | undefined): string {
  let base = stripTrailingSlashes((baseUrl || OLLAMA_SYSTEMONE_DEFAULT_BASE_URL).trim());
  base = base.replace(/\/(?:chat\/completions|completions|embeddings|systemone)$/i, "");
  base = base.replace(/\/api\/chat$/i, "");
  if (base.toLowerCase().endsWith("/v1")) base = base.slice(0, -3);
  return `${base}/v1/systemone`;
}

export type OllamaSystemOneFailureKind =
  | "model_not_found"
  | "unsupported_model"
  | "invalid_request"
  | "upstream_error"
  | "unreachable"
  | "timeout";

/** Map an upstream status onto the resilience layer it belongs to. */
export function classifyOllamaSystemOneFailure(
  status: number,
  message: string
): OllamaSystemOneFailureKind {
  if (status === 404) return "model_not_found";
  if (status === 400 && UNSUPPORTED_MODEL_PATTERN.test(message)) return "unsupported_model";
  if (status >= 500) return "upstream_error";
  return "invalid_request";
}

/** Only these kinds say something about the connection or model, not the request. */
function shouldMarkUnavailable(kind: OllamaSystemOneFailureKind): boolean {
  return (
    kind === "model_not_found" ||
    kind === "upstream_error" ||
    kind === "unreachable" ||
    kind === "timeout"
  );
}

export interface OllamaSystemOneCredentials {
  connectionId?: string | null;
  apiKey?: string | null;
  providerSpecificData?: { baseUrl?: unknown } | null;
}

type MarkUnavailable = (
  connectionId: string,
  status: number,
  errorText: string,
  provider: string | null,
  model: string | null
) => Promise<unknown>;

export interface OllamaSystemOneOptions {
  /** Validated body; `model` is the upstream id without the provider prefix. */
  body: OllamaSystemOneRequest;
  /** Model id as the caller sent it (e.g. `ollama-local/nimble`), echoed back. */
  requestedModel: string;
  credentials: OllamaSystemOneCredentials | null;
  provider?: string;
  timeoutMs?: number;
  signal?: AbortSignal | null;
  apiKeyId?: string | null;
  apiKeyName?: string | null;
  fetchImpl?: typeof fetch;
  markAccountUnavailable?: MarkUnavailable;
  clearRecoveredState?: (credentials: OllamaSystemOneCredentials) => Promise<unknown>;
  logCall?: (entry: Record<string, unknown>) => Promise<void>;
}

async function defaultClearRecoveredState(
  credentials: OllamaSystemOneCredentials
): Promise<unknown> {
  const { clearRecoveredProviderState } = await import("@/sse/services/auth.ts");
  return clearRecoveredProviderState(credentials);
}

async function defaultMarkAccountUnavailable(
  ...args: Parameters<MarkUnavailable>
): Promise<unknown> {
  const { markAccountUnavailable } = await import("@/sse/services/auth.ts");
  return markAccountUnavailable(...args);
}

function readUpstreamError(parsed: unknown, text: string, status: number): string {
  const record = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  const error = record?.error;
  if (typeof error === "string" && error) return error;
  if (error && typeof error === "object") {
    const message = (error as Record<string, unknown>).message;
    if (typeof message === "string" && message) return message;
  }
  return text.slice(0, 500) || `Ollama returned HTTP ${status}`;
}

function readUsage(parsed: Record<string, unknown>): { input: number; output: number } {
  const usage =
    parsed.usage && typeof parsed.usage === "object"
      ? (parsed.usage as Record<string, unknown>)
      : {};
  const asCount = (value: unknown) =>
    typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
  return { input: asCount(usage.input_tokens), output: asCount(usage.output_tokens) };
}

export async function handleOllamaSystemOne(options: OllamaSystemOneOptions): Promise<Response> {
  const startTime = Date.now();
  const provider = options.provider || OLLAMA_SYSTEMONE_PROVIDER;
  const connectionId = options.credentials?.connectionId || null;
  const fetchImpl = options.fetchImpl ?? fetch;
  const markUnavailable = options.markAccountUnavailable ?? defaultMarkAccountUnavailable;
  const logCall = options.logCall ?? saveCallLog;
  const configuredBaseUrl = options.credentials?.providerSpecificData?.baseUrl;
  const url = buildOllamaSystemOneUrl(
    typeof configuredBaseUrl === "string" ? configuredBaseUrl : null
  );
  const upstreamModel = options.body.model;

  const upstreamBody: Record<string, unknown> = {
    model: upstreamModel,
    state: options.body.state,
    questions: options.body.questions,
    ...(options.body.keep_alive !== undefined ? { keep_alive: options.body.keep_alive } : {}),
  };

  const log = (status: number, extra: Record<string, unknown> = {}) => {
    logCall({
      method: "POST",
      path: "/v1/systemone",
      status,
      model: options.requestedModel,
      provider,
      duration: Date.now() - startTime,
      connectionId,
      apiKeyId: options.apiKeyId ?? null,
      apiKeyName: options.apiKeyName ?? null,
      ...extra,
    }).catch(() => {});
  };

  const fail = async (kind: OllamaSystemOneFailureKind, status: number, message: string) => {
    log(status, { error: message.slice(0, 500) });
    if (connectionId && shouldMarkUnavailable(kind)) {
      try {
        await markUnavailable(connectionId, status, message, provider, upstreamModel);
      } catch {
        // Resilience bookkeeping must never mask the upstream answer.
      }
    }
    return errorResponse(status, message);
  };

  const timeoutMs = options.timeoutMs ?? OLLAMA_SYSTEMONE_DEFAULT_TIMEOUT_MS;
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const signal = options.signal ? AbortSignal.any([options.signal, timeoutSignal]) : timeoutSignal;

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json",
  };
  // Ollama itself has no auth; a key is only meaningful behind an auth proxy.
  if (options.credentials?.apiKey) headers.Authorization = `Bearer ${options.credentials.apiKey}`;

  let res: Response;
  try {
    res = await fetchImpl(url, {
      method: "POST",
      headers,
      body: JSON.stringify(upstreamBody),
      signal,
    });
  } catch {
    if (options.signal?.aborted) {
      // The caller went away; that says nothing about the connection.
      log(499, { error: "client aborted" });
      return errorResponse(499, "Request aborted by client");
    }
    if (timeoutSignal.aborted) {
      return fail(
        "timeout",
        504,
        `Ollama System One did not answer within ${Math.round(timeoutMs / 1000)}s`
      );
    }
    return fail("unreachable", 503, "Ollama System One upstream is unreachable");
  }

  const text = await res.text().catch(() => "");
  let parsed: unknown = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = null;
  }

  if (!res.ok) {
    const message = readUpstreamError(parsed, text, res.status);
    return fail(classifyOllamaSystemOneFailure(res.status, message), res.status, message);
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return fail("upstream_error", 502, "Ollama System One returned an invalid response");
  }
  const record = parsed as Record<string, unknown>;
  if (!record.answers || typeof record.answers !== "object") {
    return fail("upstream_error", 502, "Ollama System One response is missing answers");
  }

  const usage = readUsage(record);
  log(200, { tokens: { prompt_tokens: usage.input, completion_tokens: usage.output } });

  if (connectionId && options.credentials) {
    try {
      await (options.clearRecoveredState ?? defaultClearRecoveredState)(options.credentials);
    } catch {
      // Best effort, same as the other non-chat proxies.
    }
  }

  const responseHeaders = new Headers({ ...CORS_HEADERS, "Content-Type": "application/json" });
  attachOmniRouteMetaHeaders(responseHeaders, {
    provider,
    model: options.requestedModel,
    costUsd: 0,
    latencyMs: Date.now() - startTime,
    requestId: generateRequestId(),
  });
  // Ollama echoes `nimble` for `nimble:latest`; report the id the caller routed with.
  return new Response(JSON.stringify({ ...record, model: options.requestedModel }), {
    status: 200,
    headers: responseHeaders,
  });
}

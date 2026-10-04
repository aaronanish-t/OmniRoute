/**
 * Live natural-conversation GrevCaching rollover and CCR recall exercise for llama.cpp.
 * Sends real requests directly to the configured OpenAI-compatible llama.cpp server;
 * GrevCaching is applied locally using its production engine implementation.
 */
import {
  appendPreservingCcrEngine,
  retrieveBlock,
} from "../../open-sse/services/compression/engines/appendPreservingCcr/index.ts";
import { request as httpRequest } from "node:http";

type ChatMessage = Record<string, unknown>;
type ChatResponse = {
  choices?: Array<{ finish_reason?: string; message?: ChatMessage }>;
  usage?: Record<string, unknown>;
};

const baseUrl = (process.env["GREV_LLAMA_BASE_URL"] ?? "http://127.0.0.1:11434/v1").replace(
  /\/$/,
  ""
);
// This direct-engine exercise is intentionally process-local; never write its prompt
// archives to or clear OmniRoute's persistent CCR table.
process.env.COMPRESSION_CCR_DURABLE_STORE = "false";
const model =
  process.env["GREV_LLAMA_MODEL"] ??
  "local-model";
const requestedContextLimit = Number(process.env["GREV_CONTEXT_LIMIT"] ?? "0");
const maxOutputTokens = Number(process.env["GREV_MAX_OUTPUT_TOKENS"] ?? "256");
const timeoutMs = Number(process.env["GREV_REQUEST_TIMEOUT_MS"] ?? "3300000");
const settleMs = Number(process.env["GREV_POST_PREFILL_SETTLE_MS"] ?? "10000");
const principalId = `grev-live-rollover-test-${Date.now()}`;
const hiddenAnswer = "NORTHSTAR-731-COBALT";
const targetTopic = "emergency cache recovery procedure";
const topics = [
  "project overview and ownership",
  "deployment and build procedure",
  "provider connection configuration",
  "API request routing and translation",
  "authentication and key rotation",
  "retry policy and rate limiting",
  "database backup and recovery",
  "service health and monitoring",
  "client integration examples",
  "logging and diagnostic reference",
  "network topology and endpoints",
  "model catalog and context limits",
  `${targetTopic}; exact access phrase appears in the detailed checklist`,
  "release checklist and rollback plan",
  "security review and threat model",
  "quota management and provider fallback",
  "performance testing and benchmarks",
  "maintenance contacts and escalation",
];
const ccrTool = {
  type: "function",
  function: {
    name: "omniroute_ccr_retrieve",
    description: "Retrieve an archived GrevCaching history exchange by its hash.",
    parameters: {
      type: "object",
      properties: { hash: { type: "string" } },
      required: ["hash"],
      additionalProperties: false,
    },
  },
};

function brief(value: unknown, limit = 180): string {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return text.replace(/\s+/g, " ").slice(0, limit);
}

function contentOf(message: ChatMessage | undefined): string {
  return typeof message?.["content"] === "string" ? message["content"] : "";
}

function archiveSection(index: number, chars: number): string {
  const header = `ARCHIVE SECTION ${index + 1}/${topics.length}. TOPIC: ${topics[index]}.\n`;
  const answer =
    index === 12
      ? `\nDETAILED MAINTENANCE CHECKLIST: The exact emergency cache access phrase is ${hiddenAnswer}.\n`
      : "";
  const answerAt = Math.floor(chars * 0.56);
  const before = Math.max(0, (index === 12 ? answerAt : chars) - header.length);
  const after = Math.max(0, chars - header.length - before - answer.length);
  const filler = (count: number) => "the ".repeat(Math.ceil(count / 4)).slice(0, count);
  const result = `${header}${filler(before)}${answer}${filler(after)}`;
  return result.length >= chars
    ? result.slice(0, chars)
    : result + " ".repeat(chars - result.length);
}

function extractToolCall(
  message: ChatMessage | undefined
): { id: string; name: string; arguments: string } | undefined {
  const calls = message?.["tool_calls"];
  if (!Array.isArray(calls)) return undefined;
  const call = calls.find(
    (candidate): candidate is Record<string, unknown> =>
      typeof candidate === "object" && candidate !== null
  );
  if (!call || typeof call["id"] !== "string") return undefined;
  const fn = call["function"];
  if (!fn || typeof fn !== "object") return undefined;
  const record = fn as Record<string, unknown>;
  return typeof record["name"] === "string" && typeof record["arguments"] === "string"
    ? { id: call["id"], name: record["name"], arguments: record["arguments"] }
    : undefined;
}

async function postJson(
  url: string,
  body: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const payload = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      url,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-length": Buffer.byteLength(payload),
        },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("error", reject);
        response.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          if ((response.statusCode ?? 500) >= 400) {
            reject(
              new Error(`${response.statusCode} ${response.statusMessage}: ${brief(text, 400)}`)
            );
            return;
          }
          try {
            resolve(JSON.parse(text) as Record<string, unknown>);
          } catch (error) {
            reject(error);
          }
        });
      }
    );
    request.setTimeout(timeoutMs, () =>
      request.destroy(
        new Error(`request timed out after ${Math.round(timeoutMs / 60_000)} minutes`)
      )
    );
    request.on("error", reject);
    request.end(payload);
  });
}

async function liveContextLimit(): Promise<number | undefined> {
  const response = await fetch(`${baseUrl}/models`, { signal: AbortSignal.timeout(30_000) });
  if (!response.ok) return undefined;
  const catalog = (await response.json()) as { data?: unknown };
  if (!Array.isArray(catalog.data)) return undefined;
  const found = catalog.data.find(
    (
      candidate
    ): candidate is {
      id?: unknown;
      meta?: { n_ctx?: unknown };
      status?: { args?: unknown };
    } => typeof candidate === "object" && candidate !== null && candidate.id === model
  );
  const metaLimit = found?.meta?.n_ctx;
  const args = found?.status?.args;
  let argLimit: number | undefined;
  if (Array.isArray(args)) {
    const ctxIndex = args.indexOf("--ctx-size");
    if (ctxIndex >= 0) {
      const parsed = Number(args[ctxIndex + 1]);
      if (Number.isFinite(parsed) && parsed > 0) argLimit = parsed;
    }
  }
  const limit = metaLimit ?? argLimit;
  return typeof limit === "number" && Number.isFinite(limit) && limit > 0 ? limit : undefined;
}

async function promptTokensTotal(): Promise<number | undefined> {
  try {
    const response = await fetch(new URL("/metrics", new URL(baseUrl).origin), {
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) return undefined;
    const line = (await response.text())
      .split(/\r?\n/)
      .find((item) => item.startsWith("llamacpp:prompt_tokens_total "));
    const value = Number(line?.slice("llamacpp:prompt_tokens_total ".length));
    return Number.isFinite(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

async function chat(
  phase: string,
  messages: ChatMessage[],
  maxTokens = maxOutputTokens
): Promise<ChatResponse> {
  const approxTokens = Math.ceil(
    messages.reduce((sum, message) => sum + contentOf(message).length, 0) / 4
  );
  console.log(`${phase}: ${messages.length} messages; approx ${approxTokens} input tokens`);
  const started = Date.now();
  let result: ChatResponse | undefined;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      result = (await postJson(`${baseUrl}/chat/completions`, {
        model,
        stream: false,
        max_tokens: maxTokens,
        messages,
        tools: [ccrTool],
      })) as ChatResponse;
      break;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (attempt === 2 || !/socket hang up|ECONNRESET/i.test(message)) throw error;
      console.log(
        `${phase}: connection reset; cooling ${settleMs}ms then retrying the same turn once`
      );
      await new Promise<void>((resolve) => setTimeout(resolve, settleMs));
    }
  }
  if (!result) throw new Error(`${phase}: request produced no response`);
  console.log(
    `${phase}: HTTP 200 in ${((Date.now() - started) / 1000).toFixed(1)}s; ` +
      `finish=${result.choices?.[0]?.finish_reason ?? "unknown"}; ` +
      `usage=${JSON.stringify(result.usage ?? "not reported")}; ` +
      `reply=${brief(result.choices?.[0]?.message)}`
  );
  return result;
}

async function main(): Promise<void> {
  const serverLimit = await liveContextLimit();
  if (!serverLimit) {
    throw new Error(`Could not read n_ctx from ${baseUrl}/models for model ${model}`);
  }
  // This cap only sizes the test fixture; production GrevCaching resolves its own
  // limit from OmniRoute's selected provider/model on every incoming request.
  const contextLimit =
    requestedContextLimit > 0 ? Math.min(serverLimit, requestedContextLimit) : serverLimit;
  const charsPerSection = Math.floor((contextLimit * 4 * 0.68) / topics.length);
  // Leave a small safety margin above the threshold because the Grev estimator
  // and llama.cpp tokenizer differ on prose/tool serialization.
  const triggerChars = Math.floor(contextLimit * 4 * 0.28);
  const sectionsPerExchange = 3;
  const triggerText =
    "Hi, I hope your day is going well. I thought we could be friends and have a relaxed " +
    "chat. Before we do, here are a few more ordinary travel-journal notes; no need to " +
    "summarize them, just say hello back.\n" +
    (
      "We took the quieter road through the old town, stopped for coffee, and wrote down " +
      "what we noticed about the weather, buildings, and people along the way. It was a " +
      "pleasant ordinary day; these notes are just background for our conversation. "
    ).repeat(Math.ceil(triggerChars / 280));
  console.log(
    `server n_ctx=${serverLimit}; harness context=${contextLimit}; Grev threshold≈${Math.floor(contextLimit * 0.9)}; ` +
      `archive≈${Math.floor(contextLimit * 0.68)} tokens; trigger≈${Math.floor(triggerChars / 4)} tokens; ` +
      `pre-compression total≈${Math.floor(contextLimit * 0.68 + triggerChars / 4)} tokens`
  );

  const metricStart = await promptTokensTotal();
  const transcript: ChatMessage[] = [];
  for (let first = 0; first < topics.length; first += sectionsPerExchange) {
    const noteBlock = topics
      .slice(first, first + sectionsPerExchange)
      .map((_, offset) => archiveSection(first + offset, charsPerSection))
      .join("");
    const userMessage: ChatMessage = {
      role: "user",
      content:
        "I’m sharing another part of my project notes for background. Please just acknowledge " +
        "this part briefly; we can chat about it later.\n\n" +
        noteBlock,
    };
    const candidate = appendPreservingCcrEngine.apply(
      { model, messages: [...transcript, userMessage], tools: [ccrTool] },
      { modelContextLimit: contextLimit, requestMaxTokens: maxOutputTokens, principalId }
    );
    if (candidate.compressed) throw new Error(`archive setup block ${first} rolled over early`);
    transcript.push(userMessage);
    const response = await chat(
      `archive-exchange-${first / sectionsPerExchange + 1}`,
      transcript,
      1
    );
    const assistant = response.choices?.[0]?.message;
    if (!assistant) throw new Error("archive setup did not return an assistant message");
    if (contentOf(assistant).includes(hiddenAnswer))
      throw new Error("hidden answer leaked during setup");
    transcript.push(assistant);
    console.log(`cooldown: waiting ${settleMs}ms before next history block`);
    await new Promise<void>((resolve) => setTimeout(resolve, settleMs));
  }

  const rawMessages = [...transcript, { role: "user", content: triggerText }];
  const rollover = appendPreservingCcrEngine.apply(
    { model, messages: rawMessages, tools: [ccrTool] },
    {
      modelContextLimit: contextLimit,
      requestMaxTokens: maxOutputTokens,
      principalId,
      stepConfig: { maxArchiveSectionChars: charsPerSection },
    }
  );
  const liveMessages = rollover.body["messages"] as ChatMessage[];
  const markers = liveMessages.filter(
    (message) =>
      typeof message["content"] === "string" && message["content"].startsWith("[CCR retrieve hash=")
  );
  console.log(`natural trigger: compressed=${rollover.compressed}; CCR sections=${markers.length}`);
  console.log(
    `previews: ${JSON.stringify(
      markers.map((message) => {
        const text = String(message["content"]);
        return text.slice(text.indexOf("Preview: ") + 9, text.indexOf("Preview: ") + 99);
      })
    )}`
  );
  if (!rollover.compressed || markers.length < topics.length - sectionsPerExchange) {
    throw new Error("natural trigger did not create the expected section-level CCR markers");
  }
  const archivedBlocks: string[] = [];
  for (const marker of markers) {
    const hash = /\[CCR retrieve hash=([0-9a-f]{24})/.exec(String(marker["content"]))?.[1];
    const block = hash ? retrieveBlock(hash, principalId) : null;
    if (block === null)
      throw new Error("a visible CCR marker could not resolve to its archive block");
    archivedBlocks.push(block);
  }
  const sectionOrder = [...archivedBlocks.join("").matchAll(/ARCHIVE SECTION (\d+)\//g)].map(
    (match) => Number(match[1])
  );
  if (
    sectionOrder.length === 0 ||
    sectionOrder.some((section, index) => index > 0 && section < sectionOrder[index - 1]) ||
    !sectionOrder.includes(13)
  ) {
    throw new Error("CCR blocks did not preserve the source sections in their original order");
  }
  const expectedMarker = markers.find((message) =>
    String(message["content"]).includes(targetTopic)
  );
  const expectedHash = expectedMarker
    ? /\[CCR retrieve hash=([0-9a-f]{24})/.exec(String(expectedMarker["content"]))?.[1]
    : undefined;
  if (!expectedHash) throw new Error("hidden-answer section has no readable CCR preview/hash");

  const triggerResponse = await chat("natural-rollover-friendly-trigger", liveMessages);
  const triggerAssistant = triggerResponse.choices?.[0]?.message;
  if (!triggerAssistant || extractToolCall(triggerAssistant)) {
    throw new Error("friendly rollover turn unexpectedly attempted CCR retrieval");
  }
  transcript.splice(0, transcript.length, ...liveMessages, triggerAssistant);
  console.log(`cooldown: waiting ${settleMs}ms after rollover before the follow-up turn`);
  await new Promise<void>((resolve) => setTimeout(resolve, settleMs));

  for (const [index, prompt] of [
    "That sounds lovely. What kinds of places do you enjoy visiting when you want to relax?",
    "I like quiet places too. Is there a small everyday thing that usually makes your day better?",
  ].entries()) {
    const userMessage: ChatMessage = { role: "user", content: prompt };
    const check = appendPreservingCcrEngine.apply(
      { model, messages: [...transcript, userMessage], tools: [ccrTool] },
      { modelContextLimit: contextLimit, requestMaxTokens: maxOutputTokens, principalId }
    );
    if (check.compressed) throw new Error("stable post-rollover conversation was compressed again");
    transcript.push(userMessage);
    const response = await chat(`post-rollover-friendly-${index + 1}`, transcript);
    const assistant = response.choices?.[0]?.message;
    if (!assistant) throw new Error("friendly follow-up returned no assistant response");
    transcript.push(assistant);
    console.log(`cooldown: waiting ${settleMs}ms before the next friendly exchange`);
    await new Promise<void>((resolve) => setTimeout(resolve, settleMs));
  }

  const recallQuestion: ChatMessage = {
    role: "user",
    content:
      "One more thing from the project notes I shared earlier: what exact access phrase was " +
      "listed in the emergency cache recovery checklist? Please retrieve the relevant old " +
      "section and reply with the phrase only.",
  };
  const recallRequest = appendPreservingCcrEngine.apply(
    { model, messages: [...transcript, recallQuestion], tools: [ccrTool] },
    { modelContextLimit: contextLimit, requestMaxTokens: maxOutputTokens, principalId }
  );
  const recallMessages = recallRequest.body["messages"] as ChatMessage[];
  const recallResponse = await chat("hidden-answer-recall", recallMessages);
  const recallAssistant = recallResponse.choices?.[0]?.message;
  const toolCall = extractToolCall(recallAssistant);
  if (!toolCall || toolCall.name !== "omniroute_ccr_retrieve") {
    throw new Error("recall failed: model did not select a CCR marker by its preview");
  }
  let selectedHash: string | undefined;
  try {
    const args = JSON.parse(toolCall.arguments) as { hash?: unknown };
    selectedHash = typeof args.hash === "string" ? args.hash : undefined;
  } catch {
    // Invalid model arguments are rejected below; the value is never used as a path.
  }
  if (!selectedHash)
    throw new Error(`recall returned invalid tool arguments: ${brief(toolCall.arguments)}`);
  if (selectedHash !== expectedHash) {
    throw new Error(`wrong CCR section selected: ${selectedHash}; expected ${expectedHash}`);
  }
  const archived = retrieveBlock(selectedHash, principalId);
  if (!archived?.includes(hiddenAnswer))
    throw new Error("selected CCR section lacked the hidden answer");
  console.log(`CCR selection passed: hash=${selectedHash}; retrievedChars=${archived.length}`);

  const finalMessages = [
    ...recallMessages,
    recallAssistant ?? { role: "assistant", content: "" },
    { role: "tool", tool_call_id: toolCall.id, content: archived },
  ];
  const finalResponse = await chat("retrieval-answer", finalMessages);
  const finalAnswer = contentOf(finalResponse.choices?.[0]?.message);
  if (!finalAnswer.includes(hiddenAnswer)) {
    throw new Error(`answer mismatch: expected ${hiddenAnswer}; got ${brief(finalAnswer)}`);
  }
  const metricEnd = await promptTokensTotal();
  console.log(
    `server prompt_tokens_total: ${metricStart ?? "unavailable"} -> ${metricEnd ?? "unavailable"}`
  );
  console.log("LIVE NATURAL GREV ROLLOVER + CCR RECALL PASSED");
}

main().catch((error: unknown) => {
  console.error(`LIVE GREV TEST FAILED: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});

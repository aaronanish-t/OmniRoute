/**
 * Live GrevCaching rollover + five-answer CCR selection test through OmniRoute.
 *
 * Every exchange goes through OmniRoute's OpenAI-compatible chat endpoint. The
 * script never runs the rollover engine locally: runtime compression, archive
 * storage, model dispatch, and CCR retrieval are exercised on the server path.
 *
 * Run: node --import tsx/esm scripts/compression/runGrevLlamaFiveRecall.ts
 * Optional: GREV_TEST_TEXT_FILE=<path>, GREV_CONTEXT_LIMIT=<cap>,
 *          GREV_OMNI_MODEL=<provider/model>, GREV_OMNI_BASE_URL=<url>
 */
import { readFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";

type ChatMessage = Record<string, unknown>;
type ChatResponse = {
  choices?: Array<{ finish_reason?: string; message?: ChatMessage }>;
  usage?: Record<string, unknown>;
};
type RoutedResponse = { response: ChatResponse; compression: string | undefined };
type RecallTarget = { id: string; answer: string; position: number };

const DEFAULT_BASE_URL = "http://127.0.0.1:20128/v1";
const GUTENBERG_WAR_AND_PEACE = "https://www.gutenberg.org/cache/epub/2600/pg2600.txt";
const MAX_TEST_CONTEXT = 232_000;
const baseUrl = (process.env["GREV_OMNI_BASE_URL"] ?? DEFAULT_BASE_URL).replace(/\/$/, "");
const model =
  process.env["GREV_OMNI_MODEL"] ??
  "llamacpp/local-model";
const requestedContextLimit = Number(process.env["GREV_CONTEXT_LIMIT"] ?? String(MAX_TEST_CONTEXT));
const maxOutputTokens = Number(process.env["GREV_MAX_OUTPUT_TOKENS"] ?? "256");
const timeoutMs = Number(process.env["GREV_REQUEST_TIMEOUT_MS"] ?? "3300000");
const settleMs = Number(process.env["GREV_POST_PREFILL_SETTLE_MS"] ?? "10000");
const principalId = `grev-five-recall-${Date.now()}`;
const sessionId = principalId;
const omniOrigin = new URL(baseUrl).origin;
const historyFraction = 0.81;
const triggerFraction = 0.1;
const recallTargets: RecallTarget[] = [
  { id: "RECALL-RECORD-01", answer: "EMBER-418-QUARTZ", position: 0.15 },
  { id: "RECALL-RECORD-02", answer: "MAPLE-762-INDIGO", position: 0.32 },
  { id: "RECALL-RECORD-03", answer: "HARBOR-295-COPPER", position: 0.49 },
  { id: "RECALL-RECORD-04", answer: "ORBIT-831-JADE", position: 0.66 },
  { id: "RECALL-RECORD-05", answer: "FROST-547-CEDAR", position: 0.83 },
];

const ccrTool = {
  type: "function",
  function: {
    name: "omniroute_ccr_retrieve",
    description: "Retrieve one archived GrevCaching history block by its CCR hash.",
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

function messageContent(message: ChatMessage | undefined): string {
  return typeof message?.["content"] === "string" ? message["content"] : "";
}

function promptTokenUsage(response: ChatResponse): number | undefined {
  const value = response.usage?.["prompt_tokens"];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function cleanGutenbergText(raw: string): string {
  const start = raw.search(/\*\*\* START OF (?:THE|THIS) PROJECT GUTENBERG EBOOK/i);
  const body = start >= 0 ? raw.slice(raw.indexOf("\n", start) + 1) : raw;
  const end = body.search(/\*\*\* END OF (?:THE|THIS) PROJECT GUTENBERG EBOOK/i);
  return (end >= 0 ? body.slice(0, end) : body).replace(/\r\n?/g, "\n").trim();
}

function makeNeutralFiller(minChars: number): string {
  const locations = ["north field", "river plain", "cedar ridge", "east basin", "granite pass", "lower valley"];
  const subjects = ["surface patterns", "seasonal shifts", "wind direction", "soil readings", "cloud cover", "water levels"];
  const observations = ["remained within the usual range", "changed gradually through the afternoon", "matched the prior survey", "varied between nearby stations", "showed no abrupt transition", "followed a steady weekly cycle"];
  const qualifiers = ["under clear conditions", "after a mild overnight period", "during the regular survey", "with instruments checked twice", "across the marked transect", "at the end of the observation window"];
  const paragraphs: string[] = [];
  let index = 0;
  let chars = 0;
  while (chars < minChars) {
    const paragraph: string[] = [];
    for (let line = 0; line < 7; line++, index++) {
      paragraph.push(
        `Survey ${index + 1}: at the ${locations[index % locations.length]}, ${subjects[(index * 3) % subjects.length]} ${observations[(index * 5) % observations.length]} ${qualifiers[(index * 7) % qualifiers.length]}. ` +
          `The logged interval was ${index % 24}:00 to ${(index + 1) % 24}:00; the reference grid used row ${index % 97 + 1}, column ${index % 61 + 1}, and marker ${String(index % 4096).padStart(4, "0")}.`
      );
    }
    const block = `${paragraph.join(" ")}\n\n`;
    paragraphs.push(block);
    chars += block.length;
  }
  return paragraphs.join("");
}

async function loadBookText(): Promise<{ text: string; source: string }> {
  const localPath = process.env["GREV_TEST_TEXT_FILE"];
  if (localPath) return { text: cleanGutenbergText(await readFile(localPath, "utf8")), source: localPath };

  try {
    const response = await fetch(GUTENBERG_WAR_AND_PEACE, {
      signal: AbortSignal.timeout(45_000),
      headers: { "user-agent": "OmniRoute GrevCaching live test" },
    });
    if (response.ok) {
      return { text: cleanGutenbergText(await response.text()), source: "Project Gutenberg: War and Peace" };
    }
  } catch {
    // Network access may be disabled on the OmniRoute host; use local project docs below.
  }
  return {
    text: makeNeutralFiller(1_500_000),
    source: "generated neutral survey filler (Gutenberg unavailable)",
  };
}

function chooseBoundary(text: string, targetChars: number): number {
  if (text.length <= targetChars) return text.length;
  const newline = text.lastIndexOf("\n", targetChars);
  const space = text.lastIndexOf(" ", targetChars);
  const boundary = Math.max(newline, space);
  return boundary > targetChars * 0.9 ? boundary : targetChars;
}

function splitBookIntoExchanges(
  book: string,
  contextLimit: number
): {
  exchanges: string[];
  targets: RecallTarget[];
  triggerText: string;
} {
  const historyChars = Math.floor(contextLimit * historyFraction * 4);
  const triggerChars = Math.floor(contextLimit * triggerFraction * 4);
  const sourceEnd = chooseBoundary(book, historyChars);
  const triggerEnd = chooseBoundary(book.slice(sourceEnd), triggerChars);
  if (sourceEnd < historyChars * 0.95 || triggerEnd < triggerChars * 0.9) {
    throw new Error(
      `The selected book is too short (${book.length} chars). Need about ${historyChars + triggerChars} ` +
        "characters for this context size; provide a longer GREV_TEST_TEXT_FILE."
    );
  }

  const chunkCount = Math.max(8, Math.min(16, Math.round(contextLimit / 18_000)));
  const chunkChars = Math.ceil(sourceEnd / chunkCount);
  const exchanges: string[] = [];
  const targetIndices = new Map<number, RecallTarget[]>();
  for (const target of recallTargets) {
    const chunkIndex = Math.min(chunkCount - 1, Math.floor(target.position * chunkCount));
    const atIndex = targetIndices.get(chunkIndex) ?? [];
    atIndex.push(target);
    targetIndices.set(chunkIndex, atIndex);
  }

  for (let index = 0; index < chunkCount; index++) {
    const start = index * chunkChars;
    const end = index === chunkCount - 1 ? sourceEnd : Math.min(sourceEnd, start + chunkChars);
    let section = book.slice(start, end).trim();
    const sectionTargets = targetIndices.get(index) ?? [];
    for (const target of sectionTargets) {
      const noteHeader = `\nREFERENCE NOTE ${target.id}: an exact archival locator appears later in this excerpt.\n`;
      const insertionPoint = Math.floor(section.length * 0.56);
      const hiddenRecord =
        `\nThe recorded locator for ${target.id} is ${target.answer}. ` +
        "Copy the locator exactly if asked about this note.\n";
      section = section.slice(0, insertionPoint) + hiddenRecord + section.slice(insertionPoint);
      section = noteHeader + section;
    }
    exchanges.push(
      `Book excerpt ${index + 1}/${chunkCount}. Read it as background; do not summarize or extract facts yet.\n\n${section}`
    );
  }

  const triggerText =
    "Thanks, that is the next part of the book. Please acknowledge it briefly; we can discuss " +
    "details from the earlier excerpts afterward.\n\n" +
    book.slice(sourceEnd, sourceEnd + triggerEnd).trim();
  return { exchanges, targets: recallTargets, triggerText };
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
  body: Record<string, unknown>,
  headers: Record<string, string> = {}
): Promise<RoutedResponse> {
  const payload = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      url,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-length": Buffer.byteLength(payload),
          "x-omniroute-session-id": sessionId,
          ...(process.env["OMNIROUTE_API_KEY"]
            ? { authorization: `Bearer ${process.env["OMNIROUTE_API_KEY"]}` }
            : {}),
          ...headers,
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
              new Error(`${response.statusCode} ${response.statusMessage}: ${brief(text, 500)}`)
            );
            return;
          }
          try {
            resolve({
              response: JSON.parse(text) as ChatResponse,
              compression: response.headers["x-omniroute-compression"]?.toString(),
            });
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

async function chat(
  phase: string,
  messages: ChatMessage[],
  outputLimit = maxOutputTokens,
  extraRequest: Record<string, unknown> = {}
): Promise<RoutedResponse> {
  console.log(`${phase}: routing ${messages.length} messages through OmniRoute`);
  const startedAt = Date.now();
  const routed = await postJson(`${baseUrl}/chat/completions`, {
    model,
    stream: false,
    max_tokens: outputLimit,
    messages,
    tools: [ccrTool],
    ...extraRequest,
  });
  const actualPromptTokens = promptTokenUsage(routed.response);
  console.log(
    `${phase}: OmniRoute HTTP 200 in ${((Date.now() - startedAt) / 1000).toFixed(1)}s; ` +
      `provider prompt_tokens=${actualPromptTokens ?? "not reported"}; ` +
      `compression=${routed.compression ?? "header missing"}; ` +
      `finish=${routed.response.choices?.[0]?.finish_reason ?? "unknown"}; ` +
      `reply=${brief(routed.response.choices?.[0]?.message)}`
  );
  if (!routed.compression?.includes("grev-caching")) {
    throw new Error(`OmniRoute did not confirm GrevCaching on ${phase}`);
  }
  return routed;
}

async function liveContextLimit(): Promise<number | undefined> {
  const response = await fetch(`${baseUrl}/models`, {
    signal: AbortSignal.timeout(30_000),
    headers: process.env["OMNIROUTE_API_KEY"]
      ? { authorization: `Bearer ${process.env["OMNIROUTE_API_KEY"]}` }
      : {},
  });
  if (!response.ok) return undefined;
  const catalog = (await response.json()) as { data?: unknown };
  if (!Array.isArray(catalog.data)) return undefined;
  const found = catalog.data.find(
    (
      candidate
    ): candidate is { id?: unknown; context_length?: unknown } =>
      typeof candidate === "object" && candidate !== null && candidate.id === model
  );
  const limit = found?.context_length;
  return typeof limit === "number" && Number.isFinite(limit) && limit > 0 ? limit : undefined;
}

function parseSelectedHash(argumentsText: string): string | undefined {
  try {
    const parsed = JSON.parse(argumentsText) as { hash?: unknown };
    return typeof parsed.hash === "string" ? parsed.hash : undefined;
  } catch {
    return undefined;
  }
}

async function main(): Promise<void> {
  const serverLimit = await liveContextLimit();
  if (!serverLimit) throw new Error(`Could not read context_length from ${baseUrl}/models for ${model}`);

  const settingsResponse = await fetch(`${omniOrigin}/api/settings/compression`, {
    signal: AbortSignal.timeout(30_000),
  });
  if (!settingsResponse.ok) {
    throw new Error(`Could not verify OmniRoute GrevCaching settings (HTTP ${settingsResponse.status})`);
  }
  const compressionSettings = (await settingsResponse.json()) as {
    grevCaching?: { enabled?: boolean; triggerPercent?: number; excludedModelKeys?: string[] };
  };
  if (!compressionSettings.grevCaching?.enabled) {
    throw new Error("GrevCaching is disabled in OmniRoute compression settings");
  }
  const normalizedModel = model.toLowerCase();
  if (
    compressionSettings.grevCaching.excludedModelKeys?.some((key) =>
      normalizedModel.includes(key.toLowerCase())
    )
  ) {
    throw new Error(`The test model ${model} is excluded from GrevCaching`);
  }

  const contextLimit = Math.min(
    serverLimit,
    MAX_TEST_CONTEXT,
    requestedContextLimit || MAX_TEST_CONTEXT
  );
  const { text: book, source } = await loadBookText();
  const { exchanges, targets, triggerText } = splitBookIntoExchanges(book, contextLimit);
  const transcript: ChatMessage[] = [];
  let lastBeforeRolloverUsage: number | undefined;
  console.log(
    `OmniRoute model context=${serverLimit.toLocaleString()}; test cap=${contextLimit.toLocaleString()}; ` +
      `configured GrevCaching trigger=${compressionSettings.grevCaching.triggerPercent ?? 90}%; ` +
      `threshold≈${Math.floor(serverLimit * ((compressionSettings.grevCaching.triggerPercent ?? 90) / 100)).toLocaleString()} tokens; ` +
      `source=${source}; ` +
      `history target≈${Math.round(historyFraction * 100)}%; trigger≈${Math.round(triggerFraction * 100)}%; ` +
      `max test size=${MAX_TEST_CONTEXT.toLocaleString()} tokens`
  );

  for (const [index, content] of exchanges.entries()) {
    const userMessage: ChatMessage = { role: "user", content };
    const response = await chat(`book-excerpt-${index + 1}/${exchanges.length}`, [...transcript, userMessage], 8);
    const assistant = response.response.choices?.[0]?.message;
    if (!assistant) throw new Error(`No assistant acknowledgement for book excerpt ${index + 1}`);
    const leaked = targets.find((target) => messageContent(assistant).includes(target.answer));
    if (leaked) throw new Error(`Model repeated hidden answer ${leaked.id} before rollover`);
    lastBeforeRolloverUsage = promptTokenUsage(response.response) ?? lastBeforeRolloverUsage;
    transcript.push(userMessage, assistant);
    console.log(`cooldown: ${settleMs}ms before the next excerpt`);
    await new Promise<void>((resolve) => setTimeout(resolve, settleMs));
  }

  const preRolloverMessages = [...transcript, { role: "user", content: triggerText }];
  const rolloverResponse = await chat("natural-rollover-trigger", preRolloverMessages, 8);
  const rolloverAssistant = rolloverResponse.response.choices?.[0]?.message;
  if (!rolloverAssistant || extractToolCall(rolloverAssistant)) {
    throw new Error("The friendly rollover turn unexpectedly attempted CCR retrieval");
  }
  let liveTranscript = [...preRolloverMessages, rolloverAssistant];
  const rolloverUsage = promptTokenUsage(rolloverResponse.response);
  if (
    lastBeforeRolloverUsage !== undefined &&
    rolloverUsage !== undefined &&
    rolloverUsage >= lastBeforeRolloverUsage
  ) {
    console.warn(
      `Observed upstream prompt_tokens did not drop (${lastBeforeRolloverUsage} → ${rolloverUsage}); ` +
        "the local production-engine estimate did shrink, but check server usage/cache telemetry."
    );
  }
  await new Promise<void>((resolve) => setTimeout(resolve, settleMs));

  if (rolloverUsage === undefined) {
    throw new Error("OmniRoute/provider did not report prompt_tokens; cannot verify live usage behavior");
  }
  console.log(
    `Rollover trigger provider prompt_tokens=${rolloverUsage}; before trigger=${lastBeforeRolloverUsage ?? "unreported"}`
  );

  const firstTryResults: Array<{
    id: string;
    answerCorrect: boolean;
    correctBlock: boolean;
    detail: string;
  }> = [];
  for (const [index, target] of targets.entries()) {
    const question: ChatMessage = {
      role: "user",
      content:
        `ACT NOW. Do not reason, explain, summarize, or describe your plan. Inspect the CCR ` +
        `markers and choose the ONE marker whose preview identifies REFERENCE NOTE ${target.id}. ` +
        `Immediately call omniroute_ccr_retrieve with that marker's exact hash. Do not guess the ` +
        "locator and do not answer until retrieval returns the matching block.",
    };
    const questionMessages = [...liveTranscript, question];
    let retrievalResponse: RoutedResponse;
    try {
      retrievalResponse = await chat(
        `recall-${index + 1}/${targets.length}`,
        questionMessages,
        1024,
        {
          tool_choice: {
            type: "function",
            function: { name: "omniroute_ccr_retrieve" },
          },
          reasoning_effort: "none",
        }
      );
    } catch (error) {
      const detail = `routed request failed: ${error instanceof Error ? error.message : String(error)}`;
      firstTryResults.push({ id: target.id, answerCorrect: false, correctBlock: false, detail });
      console.error(`${target.id}: first try failed; ${detail}`);
      liveTranscript = questionMessages;
      continue;
    }
    const retrievalAssistant = retrievalResponse.response.choices?.[0]?.message;
    const call = extractToolCall(retrievalAssistant);
    if (!call || call.name !== "omniroute_ccr_retrieve") {
      const detail = "model did not call the CCR retrieval tool";
      firstTryResults.push({ id: target.id, answerCorrect: false, correctBlock: false, detail });
      console.error(`${target.id}: first try failed; ${detail}`);
      liveTranscript = [...questionMessages, ...(retrievalAssistant ? [retrievalAssistant] : [])];
      continue;
    }
    const selectedHash = parseSelectedHash(call.arguments);
    if (!selectedHash) {
      const detail = "CCR tool call did not include a block hash";
      firstTryResults.push({ id: target.id, answerCorrect: false, correctBlock: false, detail });
      console.error(`${target.id}: first try failed; ${detail}`);
      liveTranscript = [...questionMessages, retrievalAssistant!];
      continue;
    }
    let block: string | null = null;
    try {
      const retrieved = await postJson(`${omniOrigin}/api/compression/retrieve`, { hash: selectedHash });
      const retrievedData = retrieved.response as ChatResponse & { found?: boolean; block?: string };
      block = retrievedData.found && typeof retrievedData.block === "string" ? retrievedData.block : null;
    } catch (error) {
      console.error(
        `${target.id}: CCR retrieval failed: ${error instanceof Error ? error.message : String(error)}`
      );
    }
    const correctBlock = Boolean(
      block?.includes(`REFERENCE NOTE ${target.id}`) && block.includes(target.answer)
    );

    const toolResponse: ChatMessage = {
      role: "tool",
      tool_call_id: call.id,
      content: block ?? JSON.stringify({ found: false }),
    };
    let answer = "";
    let answerFailure: string | undefined;
    try {
      const finalResponse = await chat(
        `answer-${index + 1}/${targets.length}`,
        [...questionMessages, retrievalAssistant!, toolResponse],
        256,
        { reasoning_effort: "none" }
      );
      answer = messageContent(finalResponse.response.choices?.[0]?.message).trim();
    } catch (error) {
      answerFailure = error instanceof Error ? error.message : String(error);
    }
    const answerCorrect = answer.includes(target.answer);
    const detail = [
      correctBlock ? "correct CCR block" : `wrong CCR block (${selectedHash})`,
      answerCorrect
        ? "exact answer correct"
        : `wrong/missing answer (${brief(answer || answerFailure || "empty response")})`,
    ].join("; ");
    firstTryResults.push({ id: target.id, answerCorrect, correctBlock, detail });
    console.log(`${target.id}: first try ${answerCorrect && correctBlock ? "PASS" : "FAIL"}; ${detail}`);
    liveTranscript = [
      ...questionMessages,
      retrievalAssistant!,
      toolResponse,
      { role: "assistant", content: answer },
    ];
    await new Promise<void>((resolve) => setTimeout(resolve, settleMs));
  }

  const correctAnswers = firstTryResults.filter((result) => result.answerCorrect).length;
  const correctBlocks = firstTryResults.filter((result) => result.correctBlock).length;
  const failedFirstTries = firstTryResults.length - correctAnswers;
  console.log(
    `FIRST-TRY SUMMARY: exact answers ${correctAnswers}/${targets.length}; ` +
      `correct CCR blocks ${correctBlocks}/${targets.length}; failed answers ${failedFirstTries}/${targets.length}`
  );
  if (correctAnswers !== targets.length || correctBlocks !== targets.length) {
    throw new Error(
      `First-try recall failed: answers=${correctAnswers}/${targets.length}, ` +
        `correctBlocks=${correctBlocks}/${targets.length}`
    );
  }
  console.log("LIVE GREVCACHING BOOK ROLLOVER + FIVE CORRECT CCR RETRIEVALS: PASS (5/5 first try)");
}

main().catch((error: unknown) => {
  console.error(
    `LIVE GREVCACHING TEST FAILED: ${error instanceof Error ? error.message : String(error)}`
  );
  process.exitCode = 1;
});

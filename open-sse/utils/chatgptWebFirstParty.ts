import type { Page } from "playwright";

import type { ChatGptWebResolvedAttachment } from "./chatgptWebAttachments.ts";

type JsonRecord = Record<string, unknown>;

export interface ChatGptWebFirstPartyModuleContract {
  finalizeRequirements: string;
  proofManager: string;
  turnstileManager: string;
  requestClient: string;
  buildSentinelHeaders: string;
}

export interface ChatGptWebFirstPartyRequest {
  prompt: string;
  attachments: ChatGptWebResolvedAttachment[];
  selection: ChatGptWebUiSelection;
}

export type ChatGptWebUiSelection =
  | {
      kind: "picker";
      modelLabel: "GPT-5.6 Sol" | "GPT-5.5";
      effortIndex: 0 | 1 | 2 | 3 | 4;
    }
  | {
      kind: "free";
      thinkEnabled: boolean;
    };

interface RegisteredAttachment {
  fileId: string;
  uploadUrl: string;
  attachment: ChatGptWebResolvedAttachment;
}

interface BrowserRegisteredAttachment {
  fileId: string;
  uploadUrl: string;
}

interface BrowserConversationAttachment {
  fileId: string;
  kind: ChatGptWebResolvedAttachment["kind"];
  mimeType: string;
  name: string;
  size: number;
  width?: number;
  height?: number;
}

const CHATGPT_ORIGIN = "https://chatgpt.com";
const CHATGPT_ASSET_PATH_RE = /^\/cdn\/assets\/[A-Za-z0-9_-]+\.js$/;
const OAI_UPLOAD_HOST_RE = /(?:^|\.)oaiusercontent\.com$/i;
const FIRST_PARTY_BRIDGE_KEY = "__omnirouteChatGptFirstPartyV1";
const FIRST_PARTY_ABORT_KEY = "__omnirouteChatGptAbortV1";
const FIRST_PARTY_REQUEST_KEY = "__omnirouteChatGptRequestV1";
const MAX_ASSET_SOURCE_BYTES = 24 * 1024 * 1024;
const MAX_CONVERSATION_RESPONSE_BYTES = 16 * 1024 * 1024;
const ASSET_FETCH_TIMEOUT_MS = 20_000;
const MAX_DISCOVERY_ASSETS = 512;
const MODULE_DISCOVERY_TIMEOUT_MS = 15_000;
const MODULE_DISCOVERY_POLL_MS = 250;
const contractCache = new Map<string, Promise<ChatGptWebFirstPartyModuleContract>>();
const pageRequestTails = new WeakMap<Page, Promise<void>>();
let lastKnownModuleAssetUrl: string | null = null;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function exportedName(source: string, localName: string): string | null {
  const exportStart = source.lastIndexOf("export{");
  if (exportStart < 0) return null;
  const exportBlock = source.slice(exportStart + "export{".length);
  const match = exportBlock.match(
    new RegExp(`(?:^|,)${escapeRegExp(localName)} as ([A-Za-z_$][\\w$]*)`)
  );
  return match?.[1] ?? null;
}

/**
 * Discover the public exports used by ChatGPT's own request path from semantic markers.
 * Minified local/export names are deliberately not pinned and may change on every deployment.
 */
export function parseChatGptWebFirstPartyModuleContract(
  source: string
): ChatGptWebFirstPartyModuleContract {
  const finalizeLocal = source.match(
    /function ([A-Za-z_$][\w$]*)\(e=!1,t=`none`(?:,n=[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)?)?\)\{return [A-Za-z_$][\w$]*\(`finalized`,e,t(?:,n)?\)\}/
  )?.[1];
  const enforcement = source.match(
    /Promise\.all\(\[([A-Za-z_$][\w$]*)\.getEnforcementToken\(t,\{forceSync:!0\}\),([A-Za-z_$][\w$]*)\.getEnforcementToken\(t\)\]\)/
  );
  const requestClientLocal = source.match(
    /([A-Za-z_$][\w$]*)\.safePost\(`\/sentinel\/chat-requirements\/prepare`/
  )?.[1];
  const headerBuilderLocal = source.match(
    /function ([A-Za-z_$][\w$]*)\(e,t,n,r,i,a\)\{let o=\{\};return e\?\.token\?o\[`OpenAI-Sentinel-Chat-Requirements-Token`\]/
  )?.[1];
  const proofLocal = enforcement?.[1];
  const turnstileLocal = enforcement?.[2];
  if (
    !finalizeLocal ||
    !proofLocal ||
    !turnstileLocal ||
    !requestClientLocal ||
    !headerBuilderLocal
  ) {
    throw new Error("ChatGPT Web first-party module contract was not found");
  }

  const contract = {
    finalizeRequirements: exportedName(source, finalizeLocal),
    proofManager: exportedName(source, proofLocal),
    turnstileManager: exportedName(source, turnstileLocal),
    requestClient: exportedName(source, requestClientLocal),
    buildSentinelHeaders: exportedName(source, headerBuilderLocal),
  };
  if (Object.values(contract).some((value) => value === null)) {
    throw new Error("ChatGPT Web first-party module contract exports were not found");
  }
  return contract as ChatGptWebFirstPartyModuleContract;
}

function requireChatGptAssetUrl(value: string): string {
  const url = new URL(value);
  if (url.origin !== CHATGPT_ORIGIN || !CHATGPT_ASSET_PATH_RE.test(url.pathname)) {
    throw new Error("ChatGPT Web exposed an invalid first-party asset URL");
  }
  return url.toString();
}

export function collectChatGptWebFirstPartyAssetCandidates(
  resourceUrls: readonly string[],
  modulePreloadUrls: readonly string[]
): string[] {
  return Array.from(new Set([...resourceUrls, ...modulePreloadUrls])).filter(
    (url) => url.includes("/cdn/assets/") && url.endsWith(".js")
  );
}

/** Find first-party chunks referenced by an already-loaded ChatGPT module. */
export function extractChatGptWebFirstPartyAssetReferences(
  source: string,
  parentAssetUrl: string
): string[] {
  const references: string[] = [];
  const seen = new Set<string>();
  const pattern = /["']\.\/([A-Za-z0-9_-]+\.js)["']/g;
  for (let match = pattern.exec(source); match; match = pattern.exec(source)) {
    let assetUrl: string;
    try {
      assetUrl = requireChatGptAssetUrl(new URL(`./${match[1]}`, parentAssetUrl).toString());
    } catch {
      continue;
    }
    if (!seen.has(assetUrl)) {
      seen.add(assetUrl);
      references.push(assetUrl);
    }
  }
  return references;
}

async function readAssetSource(url: string): Promise<string> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), ASSET_FETCH_TIMEOUT_MS);
  timeout.unref?.();
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) throw new Error("ChatGPT Web first-party asset could not be loaded");
    const declared = Number(response.headers.get("content-length") ?? "0");
    if (Number.isFinite(declared) && declared > MAX_ASSET_SOURCE_BYTES) {
      throw new Error("ChatGPT Web first-party asset exceeded the size limit");
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > MAX_ASSET_SOURCE_BYTES) {
      throw new Error("ChatGPT Web first-party asset exceeded the size limit");
    }
    return new TextDecoder().decode(bytes);
  } finally {
    clearTimeout(timeout);
  }
}

interface FirstPartyModuleResult {
  assetUrl: string;
  contract: ChatGptWebFirstPartyModuleContract;
}

interface FirstPartyDiscoveryState {
  queue: string[];
  visited: Set<string>;
  index: number;
  lastError: Error | null;
}

function discoveryError(error: unknown, fallback: string): Error {
  return error instanceof Error ? error : new Error(fallback);
}

async function collectPageAssetCandidates(page: Page): Promise<string[]> {
  const sources = await page.evaluate(() => ({
    modulePreloadUrls: Array.from(
      document.querySelectorAll<HTMLLinkElement>('link[rel="modulepreload"][href]'),
      (link) => link.href
    ),
    resourceUrls: performance.getEntriesByType("resource").map((entry) => entry.name),
  }));
  return collectChatGptWebFirstPartyAssetCandidates(
    sources.resourceUrls,
    sources.modulePreloadUrls
  );
}

async function inspectFirstPartyAsset(
  candidate: string,
  state: FirstPartyDiscoveryState
): Promise<FirstPartyModuleResult | null> {
  let assetUrl: string;
  try {
    assetUrl = requireChatGptAssetUrl(candidate);
  } catch (error) {
    state.lastError = discoveryError(error, "Invalid ChatGPT asset URL");
    return null;
  }
  if (state.visited.has(assetUrl)) return null;
  state.visited.add(assetUrl);

  const cached = contractCache.get(assetUrl);
  if (cached) {
    try {
      return { assetUrl, contract: await cached };
    } catch {
      contractCache.delete(assetUrl);
    }
  }

  let source: string;
  try {
    source = await readAssetSource(assetUrl);
  } catch (error) {
    state.lastError = discoveryError(error, "ChatGPT asset discovery failed");
    return null;
  }
  try {
    const contract = parseChatGptWebFirstPartyModuleContract(source);
    contractCache.set(assetUrl, Promise.resolve(contract));
    lastKnownModuleAssetUrl = assetUrl;
    return { assetUrl, contract };
  } catch (error) {
    state.lastError = discoveryError(error, "ChatGPT module discovery failed");
    const references = extractChatGptWebFirstPartyAssetReferences(source, assetUrl);
    state.queue.push(...references.filter((reference) => !state.visited.has(reference)));
    return null;
  }
}

async function scanQueuedFirstPartyAssets(
  state: FirstPartyDiscoveryState
): Promise<FirstPartyModuleResult | null> {
  while (state.index < state.queue.length && state.visited.size < MAX_DISCOVERY_ASSETS) {
    const candidate = state.queue[state.index];
    state.index += 1;
    const result = await inspectFirstPartyAsset(candidate, state);
    if (result) return result;
  }
  return null;
}

async function discoverFirstPartyModule(page: Page): Promise<FirstPartyModuleResult> {
  const state: FirstPartyDiscoveryState = {
    queue: [...(lastKnownModuleAssetUrl ? [lastKnownModuleAssetUrl] : [])],
    visited: new Set<string>(),
    index: 0,
    lastError: null,
  };
  const deadline = Date.now() + MODULE_DISCOVERY_TIMEOUT_MS;

  while (Date.now() <= deadline && state.visited.size < MAX_DISCOVERY_ASSETS) {
    state.queue.push(...(await collectPageAssetCandidates(page)));
    const result = await scanQueuedFirstPartyAssets(state);
    if (result) return result;
    if (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, MODULE_DISCOVERY_POLL_MS));
    }
  }
  throw new Error("ChatGPT Web first-party request module was not loaded", {
    ...(state.lastError ? { cause: state.lastError } : {}),
  });
}

async function ensureFirstPartyBridge(page: Page): Promise<void> {
  const ready = await page.evaluate((key) => {
    const root = globalThis as typeof globalThis & Record<string, unknown>;
    const bridge = root[key] as
      | {
          finalizeRequirements?: unknown;
          proofManager?: { getEnforcementToken?: unknown };
          turnstileManager?: { getEnforcementToken?: unknown };
          requestClient?: { safePost?: unknown };
          buildSentinelHeaders?: unknown;
        }
      | undefined;
    return Boolean(
      typeof bridge?.finalizeRequirements === "function" &&
      typeof bridge.proofManager?.getEnforcementToken === "function" &&
      typeof bridge.turnstileManager?.getEnforcementToken === "function" &&
      typeof bridge.requestClient?.safePost === "function" &&
      typeof bridge.buildSentinelHeaders === "function"
    );
  }, FIRST_PARTY_BRIDGE_KEY);
  if (ready) return;

  const { assetUrl, contract } = await discoverFirstPartyModule(page);
  const moduleUrlLiteral = JSON.stringify(requireChatGptAssetUrl(assetUrl));
  const contractLiteral = JSON.stringify(contract);
  const bridgeKeyLiteral = JSON.stringify(FIRST_PARTY_BRIDGE_KEY);
  await page.evaluate(`(async () => {
        const bridgeKey = ${bridgeKeyLiteral};
        const names = ${contractLiteral};
        const root = globalThis;
        const existing = root[bridgeKey];
        if (
          existing &&
          typeof existing === "object" &&
          typeof existing.requestClient?.safePost === "function"
        ) {
          return;
        }
        // Import from the first-party page context directly. Injecting a blob: module is
        // rejected by ChatGPT's CSP, even though the same-origin asset itself is allowed.
        let upstream;
        try {
          upstream = await import(${moduleUrlLiteral});
        } catch (importError) {
          root[bridgeKey + ":diag"] = { stage: "import-failed", error: String(importError && importError.message || importError) };
          throw importError;
        }
        root[bridgeKey + ":diag"] = {
          stage: "imported",
          names,
          upstreamKeyCount: Object.keys(upstream || {}).length,
          upstreamKeys: Object.keys(upstream || {}).slice(0, 40),
          resolved: Object.fromEntries(
            Object.entries(names).map(([k, v]) => [k, typeof (upstream || {})[v]])
          ),
        };
        const hasSafePost = (value) =>
          value != null &&
          (typeof value.safePost === "function" ||
            typeof value.prototype?.safePost === "function");
        const candidates = [];
        const seen = new Set();
        const collect = (value, depth = 0) => {
          if (value == null || (typeof value !== "object" && typeof value !== "function") || seen.has(value)) return;
          seen.add(value);
          candidates.push(value);
          if (depth >= 3) return;
          for (const nested of Object.values(value)) collect(nested, depth + 1);
        };
        collect(upstream);
        let requestClient = upstream[names.requestClient] &&
          hasSafePost(upstream[names.requestClient])
          ? upstream[names.requestClient]
          : candidates.find(hasSafePost);
        if (!requestClient) {
          requestClient = {
            safePost: (path, options = {}) => {
              const requestBody = options.requestBody;
              return fetch(path, {
                method: "POST",
                credentials: "include",
                headers: {
                  Accept: "application/json, text/plain, */*",
                  ...(requestBody === undefined ? {} : { "Content-Type": "application/json" }),
                  ...(options.additionalHeaders ?? {}),
                },
                ...(requestBody === undefined ? {} : { body: JSON.stringify(requestBody) }),
                ...(options.signal ? { signal: options.signal } : {}),
              });
            },
          };
        }
        const proofManagers = candidates.filter(
          (value) => value && typeof value.getEnforcementToken === "function"
        );
        const proofManager = upstream[names.proofManager] &&
          typeof upstream[names.proofManager].getEnforcementToken === "function"
          ? upstream[names.proofManager]
          : proofManagers[0];
        const turnstileManager = upstream[names.turnstileManager] &&
          typeof upstream[names.turnstileManager].getEnforcementToken === "function"
          ? upstream[names.turnstileManager]
          : proofManagers[1] ?? proofManagers[0];
        const finalizeRequirements = typeof upstream[names.finalizeRequirements] === "function"
          ? upstream[names.finalizeRequirements]
          : candidates.find(
              (value) => typeof value === "function" && /finalized|requirements/i.test(String(value))
            );
        const buildSentinelHeaders = typeof upstream[names.buildSentinelHeaders] === "function"
          ? upstream[names.buildSentinelHeaders]
          : candidates.find(
              (value) => typeof value === "function" && /OpenAI-Sentinel-Chat-Requirements-Token/.test(String(value))
            );
        root[bridgeKey] = {
          finalizeRequirements,
          proofManager,
          turnstileManager,
          requestClient,
          buildSentinelHeaders,
        };
        if (typeof root[bridgeKey] !== "object" || root[bridgeKey] === null) {
          throw new Error("ChatGPT Web first-party bridge did not initialize");
        }
      })()`);
}

function directModel(selection: ChatGptWebUiSelection): { model: string; reason: boolean } {
  if (selection.kind === "free") return { model: "auto", reason: selection.thinkEnabled };
  const base = selection.modelLabel === "GPT-5.6 Sol" ? "gpt-5-6" : "gpt-5-5";
  if (selection.effortIndex === 4) return { model: `${base}-pro`, reason: false };
  return { model: base, reason: selection.effortIndex > 0 };
}

async function registerAttachments(
  page: Page,
  requestId: string,
  attachments: ChatGptWebResolvedAttachment[]
): Promise<BrowserRegisteredAttachment[]> {
  return page.evaluate(
    async ({ abortKey, attachments: metadata, bridgeKey, requestId }) => {
      const root = globalThis as typeof globalThis & Record<string, unknown>;
      const abortStore = (root[abortKey] ??= {}) as Record<string, AbortController>;
      const controller = new AbortController();
      abortStore[requestId] = controller;
      if (metadata.length === 0) return [];
      const bridge = root[bridgeKey] as {
        requestClient?: {
          safePost(path: string, options: JsonRecord): Promise<unknown>;
        };
      };
      if (typeof bridge?.requestClient?.safePost !== "function") {
        throw new Error("ChatGPT Web first-party request client is unavailable");
      }
      const registered: BrowserRegisteredAttachment[] = [];
      for (const attachment of metadata) {
        const useCase = attachment.kind === "image" ? "multimodal" : "my_files";
        const response = await bridge.requestClient.safePost("/files", {
          requestBody: {
            file_name: attachment.name,
            file_size: attachment.size,
            use_case: useCase,
            timezone_offset_min: new Date().getTimezoneOffset(),
            reset_rate_limits: false,
            supports_direct_azure_multipart: true,
            mime_type: attachment.mimeType,
            entry_surface: "chat_composer",
            selection_method: "file_picker",
            client_resolved_mime_type: attachment.mimeType,
            mime_resolution_source: "filename_extension",
            store_in_library: false,
          },
          signal: controller.signal,
        });
        let payload: unknown = response;
        if (response instanceof Response) {
          if (!response.ok) {
            const status = response.status;
            await response.body?.cancel().catch(() => {});
            throw new Error(`ChatGPT Web file registration failed with status ${status}`);
          }
          payload = await response.json();
        }
        if (
          !payload ||
          typeof payload !== "object" ||
          typeof (payload as JsonRecord).file_id !== "string" ||
          typeof (payload as JsonRecord).upload_url !== "string"
        ) {
          throw new Error("ChatGPT Web file registration returned an invalid response");
        }
        registered.push({
          fileId: (payload as JsonRecord).file_id as string,
          uploadUrl: (payload as JsonRecord).upload_url as string,
        });
      }
      return registered;
    },
    {
      abortKey: FIRST_PARTY_ABORT_KEY,
      attachments: attachments.map(({ kind, mimeType, name, size }) => ({
        kind,
        mimeType,
        name,
        size,
      })),
      bridgeKey: FIRST_PARTY_BRIDGE_KEY,
      requestId,
    }
  );
}

function requireUploadUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "https:" || !OAI_UPLOAD_HOST_RE.test(url.hostname)) {
    throw new Error("ChatGPT Web returned an invalid upload destination");
  }
  return url.toString();
}

async function uploadRegisteredAttachments(
  registered: RegisteredAttachment[],
  signal?: AbortSignal | null
): Promise<void> {
  for (const item of registered) {
    const response = await fetch(requireUploadUrl(item.uploadUrl), {
      method: "PUT",
      headers: {
        Accept: "application/json, text/plain, */*",
        "Content-Type": item.attachment.mimeType,
        "x-ms-blob-type": "BlockBlob",
        "x-ms-version": "2020-04-08",
      },
      body: new Uint8Array(item.attachment.data),
      signal: signal ?? undefined,
    });
    if (!response.ok) {
      throw new Error(`ChatGPT Web attachment upload failed with status ${response.status}`);
    }
  }
}

function browserConversationAttachments(
  registered: RegisteredAttachment[]
): BrowserConversationAttachment[] {
  return registered.map(({ attachment, fileId }) => ({
    fileId,
    kind: attachment.kind,
    mimeType: attachment.mimeType,
    name: attachment.name,
    size: attachment.size,
    width: attachment.width,
    height: attachment.height,
  }));
}

async function processRegisteredAttachments(
  page: Page,
  requestId: string,
  registered: BrowserConversationAttachment[]
): Promise<void> {
  await page.evaluate(
    async ({ abortKey, bridgeKey, registered, requestId }) => {
      if (registered.length === 0) return;
      const root = globalThis as typeof globalThis & Record<string, unknown>;
      const bridge = root[bridgeKey] as {
        requestClient?: { safePost(path: string, options: JsonRecord): Promise<unknown> };
      };
      if (typeof bridge?.requestClient?.safePost !== "function") {
        throw new Error("ChatGPT Web first-party request client is unavailable");
      }
      const abortStore = root[abortKey] as Record<string, AbortController> | undefined;
      const controller = abortStore?.[requestId];
      if (!controller) throw new Error("ChatGPT Web request cancellation scope is unavailable");

      for (const item of registered) {
        const useCase = item.kind === "image" ? "multimodal" : "my_files";
        const processResponse = await bridge.requestClient.safePost(
          "/files/process_upload_stream",
          {
            requestBody: {
              file_id: item.fileId,
              use_case: useCase,
              index_for_retrieval: item.kind !== "image",
              file_name: item.name,
              entry_surface: "chat_composer",
              metadata: {
                store_in_library: false,
                is_temporary_chat: true,
                library_eligibility_reason: "eligible",
                is_project_thread: false,
              },
            },
            signal: controller.signal,
            skipJsonTransform: true,
          }
        );
        if (processResponse instanceof Response) {
          const status = processResponse.status;
          const ok = processResponse.ok;
          await processResponse.text();
          if (!ok) {
            throw new Error(`ChatGPT Web file processing failed with status ${status}`);
          }
        }
      }
    },
    { abortKey: FIRST_PARTY_ABORT_KEY, bridgeKey: FIRST_PARTY_BRIDGE_KEY, registered, requestId }
  );
}

async function storeConversationDraft(
  page: Page,
  input: ChatGptWebFirstPartyRequest,
  requestId: string,
  registered: BrowserConversationAttachment[]
): Promise<void> {
  const mode = directModel(input.selection);
  await page.evaluate(
    ({ mode, prompt, registered, requestId, requestKey }) => {
      const root = globalThis as typeof globalThis & Record<string, unknown>;
      const images = registered.filter((item) => item.kind === "image");
      const attachments = registered.map((item) => ({
        id: item.fileId,
        size: item.size,
        name: item.name,
        mime_type: item.mimeType,
        ...(item.kind === "image"
          ? { width: item.width, height: item.height }
          : { non_library_my_files_injest_upload: true }),
        source: "local",
        is_big_paste: false,
      }));
      const metadata: JsonRecord = {
        ...(mode.reason ? { system_hints: ["reason"] } : {}),
        ...(attachments.length ? { attachments } : {}),
        serialization_metadata: { custom_symbol_offsets: [] },
      };
      const content = images.length
        ? {
            content_type: "multimodal_text",
            parts: [
              ...images.map((item) => ({
                content_type: "image_asset_pointer",
                asset_pointer: `sediment://${item.fileId}`,
                size_bytes: item.size,
                width: item.width,
                height: item.height,
              })),
              prompt,
            ],
          }
        : { content_type: "text", parts: [prompt] };
      const requestStore = (root[requestKey] ??= {}) as Record<string, JsonRecord>;
      requestStore[requestId] = {
        body: {
          action: "next",
          messages: [
            {
              id: crypto.randomUUID(),
              author: { role: "user" },
              create_time: Date.now() / 1000,
              content,
              metadata,
            },
          ],
          parent_message_id: "client-created-root",
          model: mode.model,
          timezone_offset_min: new Date().getTimezoneOffset(),
          timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
          history_and_training_disabled: true,
          conversation_mode: { kind: "primary_assistant" },
          system_hints: mode.reason ? ["reason"] : [],
          supports_buffering: true,
          supported_encodings: ["v1"],
        },
      };
    },
    {
      mode,
      prompt: input.prompt,
      registered,
      requestId,
      requestKey: FIRST_PARTY_REQUEST_KEY,
    }
  );
}

/**
 * Returns true only when the sentinel headers were actually attached. A page whose
 * first-party challenge bridge is missing cannot authenticate `/f/conversation`:
 * ChatGPT answers with a redirect to the app root and the caller sees the SPA HTML
 * instead of an SSE stream. Proceeding without these headers therefore guarantees a
 * useless request, so callers must treat `false` as a failure to repair, not as an
 * optional enhancement.
 */
interface ConversationHeadersResult {
  ready: boolean;
  reason?: string;
  members?: Record<string, string>;
  headerKeys?: string[];
  count?: number;
}

async function storeConversationHeaders(
  page: Page,
  requestId: string
): Promise<ConversationHeadersResult> {
  return page.evaluate(
    async ({ abortKey, bridgeKey, requestId, requestKey }) => {
      const root = globalThis as typeof globalThis & Record<string, unknown>;
      const bridge = root[bridgeKey] as {
        finalizeRequirements?: (cache?: boolean, source?: string) => Promise<JsonRecord>;
        proofManager?: {
          getEnforcementToken(value: JsonRecord, options: JsonRecord): Promise<string>;
        };
        turnstileManager?: { getEnforcementToken(value: JsonRecord): Promise<string> };
        buildSentinelHeaders?: (
          requirements: JsonRecord,
          turnstile: string,
          proof: string,
          sentinel: null,
          observer: null,
          telemetry: null
        ) => Record<string, string>;
      };
      const bridgeReady = [
        bridge?.finalizeRequirements,
        bridge?.proofManager?.getEnforcementToken,
        bridge?.turnstileManager?.getEnforcementToken,
        bridge?.buildSentinelHeaders,
      ].every((member) => typeof member === "function");
      if (!bridgeReady)
        return {
          ready: false,
          reason: "bridge-members-missing",
          members: {
            finalizeRequirements: typeof bridge?.finalizeRequirements,
            proofManagerToken: typeof bridge?.proofManager?.getEnforcementToken,
            turnstileToken: typeof bridge?.turnstileManager?.getEnforcementToken,
            buildSentinelHeaders: typeof bridge?.buildSentinelHeaders,
          },
        };
      const controller = (root[abortKey] as Record<string, AbortController>)?.[requestId];
      const draft = (root[requestKey] as Record<string, JsonRecord>)?.[requestId];
      if (!controller || !draft) throw new Error("ChatGPT Web request scope is unavailable");

      const requirements = await bridge.finalizeRequirements!(false, "none");
      if (controller.signal.aborted) throw new DOMException("Aborted", "AbortError");
      const [proof, turnstile] = await Promise.all([
        bridge.proofManager!.getEnforcementToken(requirements, { forceSync: true }),
        bridge.turnstileManager!.getEnforcementToken(requirements),
      ]);
      const additionalHeaders = bridge.buildSentinelHeaders!(
        requirements,
        turnstile,
        proof,
        null,
        null,
        null
      );
      draft.additionalHeaders = additionalHeaders;
      return {
        ready: true,
        headerKeys: Object.keys(additionalHeaders ?? {}),
        count: Object.keys(additionalHeaders ?? {}).length,
      };
    },
    {
      abortKey: FIRST_PARTY_ABORT_KEY,
      bridgeKey: FIRST_PARTY_BRIDGE_KEY,
      requestId,
      requestKey: FIRST_PARTY_REQUEST_KEY,
    }
  );
}

async function submitConversationRequest(page: Page, requestId: string): Promise<void> {
  await page.evaluate(
    async ({ abortKey, bridgeKey, requestId, requestKey }) => {
      const root = globalThis as typeof globalThis & Record<string, unknown>;
      const requestClient = (
        root[bridgeKey] as {
          requestClient?: { safePost(path: string, options: JsonRecord): Promise<unknown> };
        }
      )?.requestClient;
      const controller = (root[abortKey] as Record<string, AbortController>)?.[requestId];
      const draft = (root[requestKey] as Record<string, JsonRecord>)?.[requestId];
      if (!controller || !draft) {
        throw new Error("ChatGPT Web conversation request scope is unavailable");
      }
      const safePost =
        typeof requestClient?.safePost === "function"
          ? requestClient.safePost.bind(requestClient)
          : (path: string, options: JsonRecord = {}) =>
              fetch(path, {
                method: "POST",
                credentials: "include",
                headers: {
                  Accept: "application/json, text/plain, */*",
                  "Content-Type": "application/json",
                  ...(options.additionalHeaders ?? {}),
                },
                body: JSON.stringify(options.requestBody),
                signal: options.signal as AbortSignal | undefined,
              });
      const response = await safePost("/f/conversation", {
        requestBody: draft.body,
        additionalHeaders: draft.additionalHeaders,
        signal: controller.signal,
        skipJsonTransform: true,
      });
      if (!(response instanceof Response)) {
        throw new Error("ChatGPT Web conversation returned an invalid response");
      }
      if (!response.ok) {
        const status = response.status;
        await response.body?.cancel().catch(() => {});
        throw new Error(`ChatGPT Web conversation failed with status ${status}`);
      }
      draft.response = response;
    },
    {
      abortKey: FIRST_PARTY_ABORT_KEY,
      bridgeKey: FIRST_PARTY_BRIDGE_KEY,
      requestId,
      requestKey: FIRST_PARTY_REQUEST_KEY,
    }
  );
}

async function readConversationResponse(page: Page, requestId: string): Promise<string> {
  return page.evaluate(
    async ({ requestId, requestKey, responseLimit }) => {
      const root = globalThis as typeof globalThis & Record<string, unknown>;
      const draft = (root[requestKey] as Record<string, JsonRecord>)?.[requestId];
      const response = draft?.response;
      if (!(response instanceof Response)) {
        throw new Error("ChatGPT Web conversation response is unavailable");
      }
      const reader = response.body?.getReader();
      if (!reader) throw new Error("ChatGPT Web conversation returned an empty stream");
      const decoder = new TextDecoder();
      const chunks: string[] = [];
      let total = 0;
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          if (!value) continue;
          total += value.byteLength;
          if (total > responseLimit) {
            await reader.cancel().catch(() => {});
            throw new Error("ChatGPT Web conversation response exceeded the size limit");
          }
          const chunk = decoder.decode(value, { stream: true });
          chunks.push(chunk);
          // This function is serialized into the browser page, so keep the
          // boundary detector self-contained rather than closing over a
          // module-level constant.
          if (/(?:<|\\u003c)\\?\/tool(?:>|\\u003e)/i.test(chunks.join(""))) {
            await reader.cancel().catch(() => {});
            return chunks.join("");
          }
        }
        chunks.push(decoder.decode());
      } finally {
        try {
          reader.releaseLock();
        } catch {
          // The stream can already be released after cancellation.
        }
      }
      return chunks.join("");
    },
    {
      requestId,
      requestKey: FIRST_PARTY_REQUEST_KEY,
      responseLimit: MAX_CONVERSATION_RESPONSE_BYTES,
    }
  );
}

async function processAndSubmit(
  page: Page,
  input: ChatGptWebFirstPartyRequest,
  requestId: string,
  registered: RegisteredAttachment[]
): Promise<string> {
  const browserRegistered = browserConversationAttachments(registered);
  await processRegisteredAttachments(page, requestId, browserRegistered);
  await storeConversationDraft(page, input, requestId, browserRegistered);
  // Re-verify (and if needed re-inject) the bridge immediately before signing the
  // request: the SPA can navigate between the initial handshake and this point,
  // which wipes the bridge from `window` and used to leave the request unsigned.
  await ensureFirstPartyBridge(page);
  let headerDiag = await storeConversationHeaders(page, requestId);
  console.error("[HEADERS] " + JSON.stringify(headerDiag));
  if (!headerDiag.ready) {
    // One repair attempt, then fail loudly instead of sending an unsigned request.
    await ensureFirstPartyBridge(page);
    headerDiag = await storeConversationHeaders(page, requestId);
    console.error("[HEADERS retry] " + JSON.stringify(headerDiag));
    if (!headerDiag.ready) {
      throw new Error(
        "ChatGPT Web sentinel headers are unavailable (the first-party challenge module did not load); " +
          "refusing to send an unauthenticated conversation request"
      );
    }
  }
  await submitConversationRequest(page, requestId);
  return readConversationResponse(page, requestId);
}

async function cleanupRequest(page: Page, requestId: string): Promise<void> {
  await page
    .evaluate(
      ({ abortKey, requestId, requestKey }) => {
        const root = globalThis as typeof globalThis & Record<string, unknown>;
        const abortStore = root[abortKey] as Record<string, AbortController> | undefined;
        const requestStore = root[requestKey] as Record<string, JsonRecord> | undefined;
        delete abortStore?.[requestId];
        delete requestStore?.[requestId];
      },
      { abortKey: FIRST_PARTY_ABORT_KEY, requestId, requestKey: FIRST_PARTY_REQUEST_KEY }
    )
    .catch(() => {});
}

export async function abortChatGptWebFirstPartyTurn(page: Page, requestId: string): Promise<void> {
  await page
    .evaluate(
      ({ abortKey, requestId }) => {
        const root = globalThis as typeof globalThis & Record<string, unknown>;
        const store = root[abortKey] as Record<string, AbortController> | undefined;
        store?.[requestId]?.abort();
      },
      { abortKey: FIRST_PARTY_ABORT_KEY, requestId }
    )
    .catch(() => {});
}

async function runSerialized<T>(page: Page, task: () => Promise<T>): Promise<T> {
  const previous = pageRequestTails.get(page) ?? Promise.resolve();
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.catch(() => {}).then(() => gate);
  pageRequestTails.set(page, tail);
  await previous.catch(() => {});
  try {
    return await task();
  } finally {
    release();
    if (pageRequestTails.get(page) === tail) pageRequestTails.delete(page);
  }
}

export async function executeChatGptWebFirstPartyTurn(
  page: Page,
  input: ChatGptWebFirstPartyRequest,
  options: { requestId?: string; signal?: AbortSignal | null } = {}
): Promise<string> {
  const requestId = options.requestId ?? crypto.randomUUID();
  return runSerialized(page, async () => {
    if (options.signal?.aborted) throw new DOMException("Aborted", "AbortError");
    const abort = (): void => {
      void abortChatGptWebFirstPartyTurn(page, requestId);
    };
    options.signal?.addEventListener("abort", abort, { once: true });
    try {
      await ensureFirstPartyBridge(page);
      try {
        const bridgeDiag = await page.evaluate((key) => {
          const root = globalThis as Record<string, unknown>;
          return root[key + ":diag"] ?? null;
        }, FIRST_PARTY_BRIDGE_KEY);
        console.error("[BRIDGE] " + JSON.stringify(bridgeDiag));
      } catch {}
      const registrations = await registerAttachments(page, requestId, input.attachments);
      const registered = registrations.map((registration, index) => ({
        ...registration,
        attachment: input.attachments[index],
      }));
      await uploadRegisteredAttachments(registered, options.signal);
      return await processAndSubmit(page, input, requestId, registered);
    } finally {
      options.signal?.removeEventListener("abort", abort);
      await cleanupRequest(page, requestId);
    }
  });
}

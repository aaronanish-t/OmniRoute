// @vitest-environment jsdom
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EngineConfigPage } from "@/shared/components/compression/EngineConfigPage";
import {
  compressionPreviewConfigSchema,
  compressionSettingsUpdateSchema,
} from "@/shared/validation/compressionConfigSchemas";
import {
  aggressiveEngine,
  liteEngine,
  ultraEngine,
} from "@omniroute/open-sse/services/compression/engines/cavemanAdapter.ts";
import { headroomEngine } from "@omniroute/open-sse/services/compression/engines/headroom/index.ts";
import { ccrEngine } from "@omniroute/open-sse/services/compression/engines/ccr/index.ts";
import { DEFAULT_AGGRESSIVE_CONFIG } from "@omniroute/open-sse/services/compression/types.ts";

type Settings = Record<string, unknown>;

// The same fields GET /api/compression/engines returns, taken from the real engines.
const ENGINES = {
  engines: [aggressiveEngine, ultraEngine, liteEngine, headroomEngine, ccrEngine].map((engine) => ({
    id: engine.id,
    name: engine.name,
    description: engine.description,
    icon: engine.icon,
    stackable: engine.stackable,
    stackPriority: engine.stackPriority,
    metadata: engine.metadata,
    configSchema: engine.getConfigSchema(),
  })),
};

// Lite rows merge with the stored row, as mergeLiteSettingsForWrite does: an omitted cap stays,
// and a null cap is cleared.
function mergeLite(existing: unknown, incoming: Settings): Settings {
  const merged: Settings = { ...(existing as Settings), ...incoming };
  if (merged.maxToolLength === null) delete merged.maxToolLength;
  return merged;
}

// Stands in for /api/settings/compression. A PUT is checked against the real update schema,
// and each key in its body replaces the stored sub-object whole, as updateCompressionSettings
// does, except lite, which merges. A preview's config is checked against the preview route's
// schema.
function startServer(initial: Settings) {
  let stored: Settings = JSON.parse(JSON.stringify(initial));
  const server = {
    puts: [] as { body: Settings; status: number }[],
    previews: [] as { config: unknown; status: number }[],
    get stored() {
      return stored;
    },
  };
  const respond = (data: unknown, status = 200) =>
    new Response(JSON.stringify(data), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const { pathname } = new URL(String(input), "http://localhost");
      if (pathname === "/api/compression/engines") return respond(ENGINES);
      if (pathname === "/api/context/analytics/engine") {
        return respond({ engineId: "", runs: 0, tokensSaved: 0, avgSavingsPercent: 0, days: 7 });
      }
      if (pathname === "/api/settings/compression") {
        if (init?.method !== "PUT") return respond(stored);
        const body = JSON.parse(String(init.body)) as Settings;
        const parsed = compressionSettingsUpdateSchema.safeParse(body);
        server.puts.push({ body, status: parsed.success ? 200 : 400 });
        if (!parsed.success) return respond({ error: "Invalid request" }, 400);
        const { lite, ...rest } = parsed.data as Settings;
        stored = { ...stored, ...rest };
        if (lite) stored.lite = mergeLite(stored.lite, lite as Settings);
        return respond(stored);
      }
      if (pathname === "/api/compression/preview") {
        const { config } = JSON.parse(String(init?.body)) as { config?: unknown };
        const parsed = compressionPreviewConfigSchema.optional().safeParse(config);
        server.previews.push({ config, status: parsed.success ? 200 : 400 });
        if (!parsed.success) return respond({ error: "Invalid request" }, 400);
        return respond({
          original: "original text",
          compressed: "compressed text",
          originalTokens: 4,
          compressedTokens: 2,
          savingsPct: 50,
        });
      }
      return respond(null, 404);
    })
  );
  return server;
}

async function settle() {
  for (let i = 0; i < 3; i++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

function inputFor(label: string): HTMLInputElement {
  const input = screen.getByText(label).closest("label")?.querySelector("input");
  if (!input) throw new Error(`no input for ${label}`);
  return input;
}

async function renderPage(engineId: string) {
  render(<EngineConfigPage engineId={engineId} />);
  await settle();
}

async function save() {
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await settle();
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("EngineConfigPage treats an emptied number field as not set", () => {
  it("keeps an emptied number field empty instead of writing zero", async () => {
    const server = startServer({
      aggressive: { ...DEFAULT_AGGRESSIVE_CONFIG, minSavingsThreshold: 0.5 },
    });
    await renderPage("aggressive");

    fireEvent.change(inputFor("Minimum savings threshold"), { target: { value: "" } });
    await settle();

    expect(inputFor("Minimum savings threshold").value).toBe("");
    expect(server.puts).toHaveLength(0);
  });

  it("saves an emptied number field as unset", async () => {
    const server = startServer({
      aggressive: { ...DEFAULT_AGGRESSIVE_CONFIG, minSavingsThreshold: 0.5 },
    });
    await renderPage("aggressive");

    fireEvent.change(inputFor("Minimum savings threshold"), { target: { value: "" } });
    await save();

    expect(server.puts.at(-1)?.status).toBe(200);
    const { minSavingsThreshold: _unset, ...defaults } = DEFAULT_AGGRESSIVE_CONFIG;
    expect(server.stored.aggressive).toEqual(defaults);
    expect(screen.queryByText("Failed to save configuration.")).toBeNull();
  });

  it("saves a page whose emptied field rejects zero", async () => {
    const server = startServer({ ccr: { minChars: 500 } });
    await renderPage("ccr");

    fireEvent.change(inputFor("Minimum block characters"), { target: { value: "" } });
    await save();

    expect(server.puts.at(-1)?.status).toBe(200);
    expect(server.stored.ccr).toEqual({});
    expect(screen.queryByText("Failed to save configuration.")).toBeNull();
  });

  it("previews without an emptied number field", async () => {
    const server = startServer({ headroom: { minRows: 8 } });
    await renderPage("headroom");

    fireEvent.change(inputFor("Minimum rows to compact"), { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "Preview" }));
    await settle();

    expect(server.previews.at(-1)?.status).toBe(200);
    expect(server.previews.at(-1)?.config).toEqual({ headroom: {} });
    expect(screen.queryByText("Preview failed.")).toBeNull();
  });

  it("still clears the stored Lite cap when the field is emptied", async () => {
    const server = startServer({ lite: { compressToolResults: true, maxToolLength: 8000 } });
    await renderPage("lite");

    fireEvent.change(inputFor("Maximum tool-result length"), { target: { value: "" } });
    await save();

    expect(server.puts.at(-1)?.status).toBe(200);
    expect(server.stored.lite).toEqual({ compressToolResults: true });
  });

  it("keeps a zero the operator types", async () => {
    const server = startServer({ aggressive: DEFAULT_AGGRESSIVE_CONFIG });
    await renderPage("aggressive");

    fireEvent.change(inputFor("Minimum savings threshold"), { target: { value: "0" } });
    await save();

    expect(server.puts.at(-1)?.status).toBe(200);
    expect((server.stored.aggressive as Settings).minSavingsThreshold).toBe(0);
  });
});

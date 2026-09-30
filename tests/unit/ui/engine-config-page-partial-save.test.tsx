// @vitest-environment jsdom
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EngineConfigPage } from "@/shared/components/compression/EngineConfigPage";
import { compressionSettingsUpdateSchema } from "@/shared/validation/compressionConfigSchemas";
import {
  aggressiveEngine,
  ultraEngine,
} from "@omniroute/open-sse/services/compression/engines/cavemanAdapter.ts";
import {
  DEFAULT_AGGRESSIVE_CONFIG,
  DEFAULT_ULTRA_CONFIG,
} from "@omniroute/open-sse/services/compression/types.ts";

type Settings = Record<string, unknown>;

// The same fields GET /api/compression/engines returns, taken from the real engines.
const ENGINES = {
  engines: [aggressiveEngine, ultraEngine].map((engine) => ({
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

// Stands in for /api/settings/compression. A PUT is checked against the real update schema,
// and each key in its body replaces the stored sub-object whole, as updateCompressionSettings
// does. `readsFail` makes later GETs fail.
function startServer(initial: Settings) {
  let stored: Settings = JSON.parse(JSON.stringify(initial));
  const server = {
    readsFail: false,
    puts: [] as { body: Settings; status: number }[],
    get stored() {
      return stored;
    },
    // A save made on another page, such as the compression settings tab.
    write(patch: Settings) {
      stored = { ...stored, ...patch };
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
        if (init?.method !== "PUT") {
          return server.readsFail ? respond({ error: "unavailable" }, 500) : respond(stored);
        }
        const body = JSON.parse(String(init.body)) as Settings;
        const parsed = compressionSettingsUpdateSchema.safeParse(body);
        server.puts.push({ body, status: parsed.success ? 200 : 400 });
        if (!parsed.success) return respond({ error: "Invalid request" }, 400);
        stored = { ...stored, ...parsed.data };
        return respond(stored);
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

describe("EngineConfigPage saves only what the operator changed", () => {
  it("keeps Aggressive thresholds and tool strategies saved elsewhere after the page loaded", async () => {
    const server = startServer({ aggressive: DEFAULT_AGGRESSIVE_CONFIG });
    await renderPage("aggressive");
    // The compression settings tab edits the same sub-object after this page loaded.
    const fromSettingsTab = {
      ...DEFAULT_AGGRESSIVE_CONFIG,
      thresholds: { ...DEFAULT_AGGRESSIVE_CONFIG.thresholds, fullSummary: 9 },
      toolStrategies: { ...DEFAULT_AGGRESSIVE_CONFIG.toolStrategies, json: false },
      summarizerEnabled: false,
    };
    server.write({ aggressive: fromSettingsTab });

    fireEvent.change(inputFor("Maximum tokens per message"), { target: { value: "4096" } });
    await save();

    expect(server.puts.at(-1)?.status).toBe(200);
    expect(server.stored.aggressive).toEqual({ ...fromSettingsTab, maxTokensPerMessage: 4096 });
  });

  it("saves the Ultra page on a default install that has no model path", async () => {
    const server = startServer({ ultra: DEFAULT_ULTRA_CONFIG });
    await renderPage("ultra");

    fireEvent.change(inputFor("Compression rate"), { target: { value: "0.4" } });
    await save();

    expect(server.puts.at(-1)?.status).toBe(200);
    expect(server.stored.ultra).toEqual({ ...DEFAULT_ULTRA_CONFIG, compressionRate: 0.4 });
    expect(screen.queryByText("Failed to save configuration.")).toBeNull();
  });

  it("keeps ultra.enabled when the Ultra page saves", async () => {
    const server = startServer({
      ultra: { ...DEFAULT_ULTRA_CONFIG, enabled: true, modelPath: "/models/ultra" },
    });
    await renderPage("ultra");

    fireEvent.change(inputFor("Compression rate"), { target: { value: "0.4" } });
    await save();

    expect(server.puts.at(-1)?.status).toBe(200);
    expect(server.stored.ultra).toEqual({
      ...DEFAULT_ULTRA_CONFIG,
      enabled: true,
      modelPath: "/models/ultra",
      compressionRate: 0.4,
    });
  });

  it("clears a stored model path when the field is emptied", async () => {
    const server = startServer({ ultra: { ...DEFAULT_ULTRA_CONFIG, modelPath: "/models/ultra" } });
    await renderPage("ultra");

    fireEvent.change(inputFor("Model path"), { target: { value: "  " } });
    await save();

    expect(server.puts.at(-1)?.status).toBe(200);
    expect(server.stored.ultra).toEqual(DEFAULT_ULTRA_CONFIG);
  });

  it("fails the save without writing when the current settings cannot be read", async () => {
    const server = startServer({ aggressive: DEFAULT_AGGRESSIVE_CONFIG });
    await renderPage("aggressive");
    server.readsFail = true;

    fireEvent.change(inputFor("Maximum tokens per message"), { target: { value: "4096" } });
    await save();

    expect(server.puts).toHaveLength(0);
    expect(screen.getByText("Failed to save configuration.")).toBeTruthy();
  });

  it("sends a second save's change without resending the first one", async () => {
    const server = startServer({ aggressive: DEFAULT_AGGRESSIVE_CONFIG });
    await renderPage("aggressive");

    fireEvent.change(inputFor("Maximum tokens per message"), { target: { value: "4096" } });
    await save();
    // Another page sets the same field back after the first save.
    server.write({ aggressive: { ...DEFAULT_AGGRESSIVE_CONFIG, maxTokensPerMessage: 1024 } });

    fireEvent.change(inputFor("Minimum savings threshold"), { target: { value: "0.2" } });
    await save();

    expect(server.stored.aggressive).toEqual({
      ...DEFAULT_AGGRESSIVE_CONFIG,
      maxTokensPerMessage: 1024,
      minSavingsThreshold: 0.2,
    });
  });
});

// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { fireEvent } from "@testing-library/react";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { ENGINE_IDS } from "../../../open-sse/services/compression/engineCatalog.ts";

// i18n does not resolve to a real locale in vitest/jsdom, so mock next-intl to echo
// the key. This test therefore asserts on translation keys, engine ids,
// data-testid hooks, and the PUT request body.
vi.mock("next-intl", () => ({
  useTranslations: () => (key: string, values?: Record<string, unknown>) =>
    values ? `${key} ${Object.values(values).join(" ")}` : key,
  useLocale: () => "en",
}));

// ── Harness ─────────────────────────────────────────────────────────────────

const containers: HTMLElement[] = [];
const roots: Array<{ unmount: () => void }> = [];

function mount(ui: React.ReactElement): HTMLElement {
  const container = document.createElement("div");
  document.body.appendChild(container);
  containers.push(container);
  const root = createRoot(container);
  roots.push(root);
  act(() => {
    root.render(ui);
  });
  return container;
}

beforeEach(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(async () => {
  vi.restoreAllMocks();
  await act(async () => {
    while (roots.length > 0) {
      roots.pop()?.unmount();
    }
  });
  for (let i = 0; i < 10; i++) {
    await Promise.resolve();
  }
  while (containers.length > 0) {
    containers.pop()?.remove();
  }
  document.body.innerHTML = "";
});

async function flush() {
  await act(async () => {
    for (let i = 0; i < 10; i++) await Promise.resolve();
  });
}

// ── Fetch stub ────────────────────────────────────────────────────────────────

interface CapturedPut {
  url: string;
  body: Record<string, unknown>;
}

function setupFetchMock(): { puts: CapturedPut[] } {
  const puts: CapturedPut[] = [];
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    });

  const initialConfig = {
    enabled: true,
    defaultMode: "stacked",
    autoTriggerTokens: 0,
    cacheMinutes: 5,
    preserveSystemPrompt: true,
    comboOverrides: {},
    engines: {
      rtk: { enabled: true, level: "standard" },
      caveman: { enabled: false },
    },
    activeComboId: null,
    // GET /api/settings/compression reports a stored engines row as enginesExplicit
    // (src/lib/db/compression.ts). Since #14700 the preview follows the runtime default
    // derivation, which only reads the engines map when this flag is set.
    enginesExplicit: true,
    cavemanOutputMode: { enabled: false, intensity: "full", autoClarity: true },
  };

  vi.spyOn(globalThis, "fetch").mockImplementation(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      const method = (init?.method ?? "GET").toUpperCase();

      if (url.includes("/api/settings/compression/mcp-accessibility")) {
        if (method === "PUT") {
          puts.push({ url, body: JSON.parse(String(init?.body ?? "{}")) });
          return json({ enabled: true });
        }
        return json({ enabled: true, maxTextChars: 50000 });
      }

      if (url.includes("/api/settings/compression")) {
        if (method === "PUT") {
          const body = JSON.parse(String(init?.body ?? "{}"));
          puts.push({ url, body });
          // Echo a merged config so the panel keeps a coherent state.
          return json({ ...initialConfig, ...body });
        }
        return json(initialConfig);
      }

      return json({}, 404);
    }
  );

  return { puts };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("CompressionPanel", () => {
  it("renders a row for every engine id in the catalog", async () => {
    setupFetchMock();
    const { default: CompressionPanel } =
      await import("../../../src/app/(dashboard)/dashboard/context/settings/CompressionPanel");

    let container!: HTMLElement;
    await act(async () => {
      container = mount(<CompressionPanel />);
    });
    await flush();

    for (const id of ENGINE_IDS) {
      const row = container.querySelector(`[data-testid="engine-row-${id}"]`);
      expect(row, `expected a row for engine "${id}"`).toBeTruthy();
      expect(container.textContent).toContain(`compressionEngine.${id}.label`);
    }
  });

  it("shows the rtk level 'standard' as selected", async () => {
    setupFetchMock();
    const { default: CompressionPanel } =
      await import("../../../src/app/(dashboard)/dashboard/context/settings/CompressionPanel");

    let container!: HTMLElement;
    await act(async () => {
      container = mount(<CompressionPanel />);
    });
    await flush();

    const select = container.querySelector(
      `[data-testid="engine-row-rtk"] select`
    ) as HTMLSelectElement | null;
    expect(select).toBeTruthy();
    expect(select?.value).toBe("standard");
  });

  it("toggling caveman PUTs engines.caveman.enabled === true", async () => {
    const { puts } = setupFetchMock();
    const { default: CompressionPanel } =
      await import("../../../src/app/(dashboard)/dashboard/context/settings/CompressionPanel");

    let container!: HTMLElement;
    await act(async () => {
      container = mount(<CompressionPanel />);
    });
    await flush();

    // The data-testid hook wraps the Toggle; its inner <button role="switch"> is the
    // clickable element.
    const toggle = container.querySelector(
      `[data-testid="engine-toggle-caveman"] button`
    ) as HTMLButtonElement | null;
    expect(toggle, "caveman toggle must exist").toBeTruthy();

    await act(async () => {
      toggle!.click();
    });
    await flush();

    const settingsPuts = puts.filter(
      (p) => p.url.includes("/api/settings/compression") && !p.url.includes("mcp-accessibility")
    );
    expect(settingsPuts.length).toBeGreaterThan(0);
    const lastEngines = settingsPuts
      .map((p) => p.body.engines as Record<string, { enabled: boolean }> | undefined)
      .filter(Boolean)
      .pop();
    expect(lastEngines).toBeTruthy();
    expect(lastEngines!.caveman.enabled).toBe(true);
    // Full engines map is sent (whole-row persistence), so rtk is not dropped.
    expect(lastEngines!.rtk.enabled).toBe(true);
  });

  it("derived-pipeline preview reflects the enabled engines", async () => {
    setupFetchMock();
    const { default: CompressionPanel } =
      await import("../../../src/app/(dashboard)/dashboard/context/settings/CompressionPanel");

    let container!: HTMLElement;
    await act(async () => {
      container = mount(<CompressionPanel />);
    });
    await flush();

    const preview = container.querySelector(`[data-testid="derived-pipeline-preview"]`);
    expect(preview).toBeTruthy();
    // Only rtk is enabled in the initial config. rtk is lossy, and a header-less request
    // downgrades lossy steps to the safe session-dedup → lite pipeline (#14529); the preview
    // shows what a request actually runs (#14700), so it names that pipeline — not rtk,
    // and never the disabled caveman engine.
    expect(preview?.textContent).toContain("session-dedup → lite");
    expect(preview?.textContent).not.toContain("rtk");
    expect(preview?.textContent).not.toContain("caveman");
  });

  async function renderPanel() {
    const { default: CompressionPanel } =
      await import("../../../src/app/(dashboard)/dashboard/context/settings/CompressionPanel");
    let container!: HTMLElement;
    await act(async () => {
      container = mount(<CompressionPanel />);
    });
    await flush();
    return container;
  }

  // Settings PUTs wait until the test answers them, so several saves stay in flight together
  // and can answer in any order.
  function holdSettingsPuts() {
    setupFetchMock();
    const respond = vi.mocked(globalThis.fetch).getMockImplementation()!;
    const puts: Array<Record<string, unknown>> = [];
    const answers: Array<(status: number) => void> = [];
    vi.mocked(globalThis.fetch).mockImplementation((input, init) => {
      if (init?.method !== "PUT") return respond(input, init);
      puts.push(JSON.parse(String(init.body)));
      return new Promise<Response>((resolve, reject) => {
        answers.push((status) => resolve(new Response("{}", { status })));
        init.signal?.addEventListener("abort", () => reject(init.signal?.reason));
      });
    });
    const answer = async (index: number, status: number) => {
      await act(async () => answers[index](status));
      await flush();
    };
    return { puts, answer };
  }

  async function commitAutoTrigger(input: HTMLInputElement, value: string) {
    await act(async () => {
      fireEvent.change(input, { target: { value } });
    });
    await act(async () => {
      fireEvent.keyDown(input, { key: "Enter" });
    });
  }

  // The ultra-engine select is disabled while a save is in flight, but the auto-trigger input
  // never is, so a value committed there goes out while the ultra-engine save still waits.
  async function changeUltraEngineThenAutoTrigger(container: HTMLElement) {
    const ultraEngine = container.querySelector(
      `[data-testid="ultra-engine-select"]`
    ) as HTMLSelectElement;
    const autoTrigger = container.querySelector(`input[type="number"]`) as HTMLInputElement;
    await act(async () => {
      fireEvent.change(ultraEngine, { target: { value: "slm" } });
    });
    await commitAutoTrigger(autoTrigger, "500");
    return { ultraEngine, autoTrigger };
  }

  it("a failed save rolls back its own field and keeps a later save", async () => {
    const { puts, answer } = holdSettingsPuts();
    const container = await renderPanel();
    const { ultraEngine, autoTrigger } = await changeUltraEngineThenAutoTrigger(container);
    // Each PUT carries only its own field, so the server never stored ultraEngine "slm".
    expect(puts).toEqual([{ ultraEngine: "slm" }, { autoTriggerTokens: 500 }]);

    await answer(0, 500);
    await answer(1, 200);
    expect(ultraEngine.value).toBe("heuristic");
    expect(autoTrigger.value).toBe("500");
    expect(container.textContent).toContain("saveFailed");
  });

  it("a failed later save rolls back its own field and keeps the earlier save", async () => {
    const { answer } = holdSettingsPuts();
    const container = await renderPanel();
    const { ultraEngine, autoTrigger } = await changeUltraEngineThenAutoTrigger(container);

    await answer(0, 200);
    await answer(1, 500);
    expect(ultraEngine.value).toBe("slm");
    expect(autoTrigger.value).toBe("0");
    expect(container.textContent).toContain("saveFailed");
  });

  it("saves the auto-trigger value once, on Enter or when the field loses focus", async () => {
    const { puts } = holdSettingsPuts();
    const container = await renderPanel();
    const autoTrigger = container.querySelector(`input[type="number"]`) as HTMLInputElement;

    for (const value of ["8", "80", "8000"]) {
      await act(async () => {
        fireEvent.change(autoTrigger, { target: { value } });
      });
    }
    expect(puts, "typing alone saves nothing").toEqual([]);
    await act(async () => {
      fireEvent.keyDown(autoTrigger, { key: "Enter" });
    });
    await act(async () => {
      fireEvent.blur(autoTrigger);
    });
    expect(puts, "the blur after Enter has nothing new to save").toEqual([
      { autoTriggerTokens: 8000 },
    ]);

    await act(async () => {
      fireEvent.change(autoTrigger, { target: { value: "9000" } });
    });
    await act(async () => {
      fireEvent.blur(autoTrigger);
    });
    expect(puts).toEqual([{ autoTriggerTokens: 8000 }, { autoTriggerTokens: 9000 }]);
  });

  it("shows the value of the save that answered last when saves of one field overlap", async () => {
    const { puts, answer } = holdSettingsPuts();
    const container = await renderPanel();
    const autoTrigger = container.querySelector(`input[type="number"]`) as HTMLInputElement;
    await commitAutoTrigger(autoTrigger, "1");
    await commitAutoTrigger(autoTrigger, "100");
    expect(puts).toEqual([{ autoTriggerTokens: 1 }, { autoTriggerTokens: 100 }]);

    // The server stores each save just before it answers, so the save that answers last holds
    // the stored value.
    await answer(1, 200);
    await answer(0, 200);
    expect(autoTrigger.value).toBe("1");
  });

  it("shows Saved again once a save succeeds after an earlier failure settled", async () => {
    const { answer } = holdSettingsPuts();
    const container = await renderPanel();
    const ultraEngine = container.querySelector(
      `[data-testid="ultra-engine-select"]`
    ) as HTMLSelectElement;

    await act(async () => {
      fireEvent.change(ultraEngine, { target: { value: "slm" } });
    });
    await answer(0, 500);
    expect(container.textContent).toContain("saveFailed");

    await act(async () => {
      fireEvent.change(ultraEngine, { target: { value: "slm" } });
    });
    await answer(1, 200);
    expect(ultraEngine.value).toBe("slm");
    expect(container.textContent).toContain("saved");
    expect(container.textContent).not.toContain("saveFailed");
  });

  it("shows Save failed at once and keeps it while other saves are in flight", async () => {
    const { answer } = holdSettingsPuts();
    const container = await renderPanel();
    const { autoTrigger } = await changeUltraEngineThenAutoTrigger(container);

    // The auto-trigger save fails while the ultra-engine save still waits on the server.
    await answer(1, 500);
    expect(container.textContent, "the failure shows at once").toContain("saveFailed");
    await commitAutoTrigger(autoTrigger, "700");
    expect(container.textContent, "a new save does not hide it").toContain("saveFailed");

    await answer(2, 200);
    await answer(0, 200);
    expect(autoTrigger.value).toBe("700");
    expect(container.textContent).toContain("saveFailed");
  });

  it("fails a PUT that outlives the save timeout", async () => {
    const { puts, answer } = holdSettingsPuts();
    const timeouts: AbortController[] = [];
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout").mockImplementation(() => {
      const controller = new AbortController();
      timeouts.push(controller);
      return controller.signal;
    });
    const container = await renderPanel();
    const { ultraEngine, autoTrigger } = await changeUltraEngineThenAutoTrigger(container);
    expect(puts, "the auto-trigger save does not wait").toEqual([
      { ultraEngine: "slm" },
      { autoTriggerTokens: 500 },
    ]);
    await answer(1, 200);
    expect(ultraEngine.disabled, "controls stay disabled while a PUT is in flight").toBe(true);

    // The first PUT never answers; its timeout signal ends it.
    await act(async () => timeouts[0].abort());
    for (let i = 0; i < 5; i++) await flush();

    expect(timeoutSpy).toHaveBeenCalledWith(15_000);
    expect(ultraEngine.disabled).toBe(false);
    expect(ultraEngine.value).toBe("heuristic");
    expect(autoTrigger.value).toBe("500");
    expect(container.textContent).toContain("saveFailed");
  });
});

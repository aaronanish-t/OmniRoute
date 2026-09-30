// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { NextIntlClientProvider } from "next-intl";
import messages from "../../../src/i18n/messages/en.json";

const containers: HTMLElement[] = [];
const roots: Array<{ unmount: () => void }> = [];
// Settings PUTs a test is holding. afterEach answers any it left, so none stalls a later test.
const heldPuts: Array<() => void> = [];

function mount(ui: React.ReactElement): HTMLElement {
  const container = document.createElement("div");
  document.body.appendChild(container);
  containers.push(container);
  const root = createRoot(container);
  roots.push(root);
  act(() => {
    root.render(
      <NextIntlClientProvider locale="en" messages={{ contextCombos: messages.contextCombos }}>
        {ui}
      </NextIntlClientProvider>
    );
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
    while (heldPuts.length > 0) heldPuts.shift()?.();
    while (roots.length > 0) roots.pop()?.unmount();
  });
  for (let i = 0; i < 10; i++) await Promise.resolve();
  while (containers.length > 0) containers.pop()?.remove();
  document.body.innerHTML = "";
});

async function flush() {
  await act(async () => {
    for (let i = 0; i < 10; i++) await Promise.resolve();
  });
}

interface CapturedPut {
  url: string;
  body: Record<string, unknown>;
}

// failPutKeys: a settings PUT whose body carries one of these keys gets a 500, as when the server
// rejects that save. hold: each settings PUT waits until the test calls its entry in `held`, so
// the test decides the order in which saves answer.
function setupFetchMock(opts: { failPutKeys?: string[]; hold?: boolean } = {}): {
  puts: CapturedPut[];
  held: Array<() => void>;
} {
  const puts: CapturedPut[] = [];
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

  const initialConfig = {
    enabled: true,
    defaultMode: "off",
    autoTriggerTokens: 0,
    cacheMinutes: 5,
    preserveSystemPrompt: true,
    comboOverrides: {},
    activeComboId: null,
    contextEditing: { enabled: false },
  };
  const combos = [
    { id: "c1", name: "RTK only", pipeline: [{ engine: "rtk" }] },
    { id: "c2", name: "Caveman only", pipeline: [{ engine: "caveman" }] },
  ];

  vi.spyOn(globalThis, "fetch").mockImplementation(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      const method = (init?.method ?? "GET").toUpperCase();
      if (url.includes("/api/context/combos/default")) return json({}, 404);
      if (url.includes("/api/context/combos")) return json({ combos });
      if (url.includes("/api/compression/engines")) return json({ engines: [] });
      if (url.includes("/api/settings/compression")) {
        if (method === "PUT") {
          const body = JSON.parse(String(init?.body ?? "{}"));
          puts.push({ url, body });
          if (opts.hold) await new Promise<void>((release) => heldPuts.push(release));
          if (opts.failPutKeys?.some((key) => key in body)) return json({ error: "rejected" }, 500);
          return json({ ...initialConfig, ...body });
        }
        return json(initialConfig);
      }
      return json({}, 404);
    }
  );
  return { puts, held: heldPuts };
}

function setSelectValue(select: HTMLSelectElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, "value")!.set!;
  setter.call(select, value);
  select.dispatchEvent(new Event("change", { bubbles: true }));
}

const saveFailed = messages.contextCombos.saveSettingsFailed;

function activeProfileSelect(container: HTMLElement) {
  return container.querySelector('[data-testid="active-profile-select"]') as HTMLSelectElement;
}

function contextEditingToggle(container: HTMLElement) {
  return container.querySelector('button[role="switch"]') as HTMLButtonElement;
}

// Answers the held PUTs in the order they went out, including any sent while answering.
async function releaseInOrder(held: Array<() => void>) {
  for (let i = 0; i < held.length; i++) {
    await act(async () => held[i]());
    for (let j = 0; j < 5; j++) await flush();
  }
}

async function render() {
  const { default: CompressionHub } =
    await import("../../../src/app/(dashboard)/dashboard/context/combos/CompressionHub");
  let container!: HTMLElement;
  await act(async () => {
    container = mount(<CompressionHub />);
  });
  await flush();
  return container;
}

describe("CompressionHub — active-profile selector", () => {
  it("renders the active-profile select with Default + each named combo", async () => {
    setupFetchMock();
    const container = await render();
    const select = container.querySelector(
      '[data-testid="active-profile-select"]'
    ) as HTMLSelectElement | null;
    expect(select).toBeTruthy();
    expect(container.textContent).toContain("Default (from panel)");
    expect(container.textContent).toContain("RTK only");
  });

  it("changing the select to a combo PUTs activeComboId === that id", async () => {
    const { puts } = setupFetchMock();
    const container = await render();
    const select = container.querySelector(
      '[data-testid="active-profile-select"]'
    ) as HTMLSelectElement;
    await act(async () => {
      setSelectValue(select, "c1");
    });
    await flush();
    const settingsPuts = puts.filter((p) => p.url.includes("/api/settings/compression"));
    expect(settingsPuts.length).toBeGreaterThan(0);
    expect(settingsPuts.pop()!.body.activeComboId).toBe("c1");
  });

  it("preview shows the Default fallback initially, and the combo engines once a combo is active", async () => {
    setupFetchMock();
    const container = await render();
    const preview = () => container.querySelector('[data-testid="active-profile-preview"]');
    expect(preview()).toBeTruthy();
    expect(preview()!.textContent).toContain("Default");
    const select = container.querySelector(
      '[data-testid="active-profile-select"]'
    ) as HTMLSelectElement;
    await act(async () => {
      setSelectValue(select, "c1");
    });
    await flush();
    expect(preview()!.textContent).toContain("rtk");
  });

  it("no longer renders the master Token Saver toggle, the mode selector, or reorder buttons", async () => {
    setupFetchMock();
    const container = await render();
    expect(container.querySelector('[aria-label="Toggle Token Saver"]')).toBeNull();
    expect(container.querySelector('[aria-label="Move up"]')).toBeNull();
    expect(container.querySelector('[aria-label="Move down"]')).toBeNull();
    // The Aggressive mode button's hint text is gone with the mode selector.
    expect(container.textContent).not.toContain("Summary plus aging");
  });
});

describe("CompressionHub overlapping saves", () => {
  // The select and the toggle stay enabled while a save is in flight, so a second save can start
  // before the first one answers.
  async function changeProfileThenToggle(failPutKeys: string[]) {
    const { puts, held } = setupFetchMock({ failPutKeys, hold: true });
    const container = await render();
    await act(async () => {
      setSelectValue(activeProfileSelect(container), "c1");
    });
    await act(async () => {
      contextEditingToggle(container).click();
    });
    await releaseInOrder(held);
    return { container, puts };
  }

  it("a failed save rolls back only its own field and keeps a later save the server stored", async () => {
    const { container, puts } = await changeProfileThenToggle(["activeComboId"]);

    expect(puts.map((p) => p.body)).toEqual([
      { activeComboId: "c1" },
      { contextEditing: { enabled: true } },
    ]);
    expect(activeProfileSelect(container).value).toBe("");
    expect(contextEditingToggle(container).getAttribute("aria-checked")).toBe("true");
    // The later save's success leaves the earlier failure on screen.
    expect(container.textContent).toContain(saveFailed);
  });

  it("a later failed save does not bring back an earlier value the server rejected", async () => {
    const { container } = await changeProfileThenToggle(["activeComboId", "contextEditing"]);

    expect(activeProfileSelect(container).value).toBe("");
    expect(contextEditingToggle(container).getAttribute("aria-checked")).toBe("false");
    expect(container.textContent).toContain(saveFailed);
  });

  it("a later failed save keeps an earlier save the server stored", async () => {
    const { container } = await changeProfileThenToggle(["contextEditing"]);

    expect(activeProfileSelect(container).value).toBe("c1");
    expect(contextEditingToggle(container).getAttribute("aria-checked")).toBe("false");
    expect(container.textContent).toContain(saveFailed);
  });

  it("skips a queued save that a later queued save replaces", async () => {
    const { puts, held } = setupFetchMock({ hold: true });
    const container = await render();
    for (const value of ["c1", "c2", ""]) {
      await act(async () => {
        setSelectValue(activeProfileSelect(container), value);
      });
    }
    await releaseInOrder(held);

    // "c1" went out at once; "c2" was still queued when "" replaced it.
    expect(puts.map((p) => p.body)).toEqual([{ activeComboId: "c1" }, { activeComboId: null }]);
    expect(activeProfileSelect(container).value).toBe("");
  });

  it("fails a PUT that outlives the save timeout and sends the save queued behind it", async () => {
    const { puts } = setupFetchMock();
    const respond = vi.mocked(globalThis.fetch).getMockImplementation()!;
    const timeouts: AbortController[] = [];
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout").mockImplementation(() => {
      const controller = new AbortController();
      timeouts.push(controller);
      return controller.signal;
    });
    // The first settings PUT never answers on its own; only its timeout signal ends it.
    vi.mocked(globalThis.fetch).mockImplementation(async (input, init) => {
      const res = await respond(input, init);
      if (init?.method === "PUT" && puts.length === 1) {
        await new Promise((_, reject) =>
          init.signal?.addEventListener("abort", () => reject(init.signal?.reason))
        );
      }
      return res;
    });
    const container = await render();
    await act(async () => {
      setSelectValue(activeProfileSelect(container), "c1");
    });
    await act(async () => {
      contextEditingToggle(container).click();
    });
    await flush();
    expect(puts, "the toggle save waits behind the stalled PUT").toHaveLength(1);

    await act(async () => timeouts[0].abort());
    for (let i = 0; i < 5; i++) await flush();

    expect(timeoutSpy).toHaveBeenCalledWith(15_000);
    expect(puts.map((p) => p.body)).toEqual([
      { activeComboId: "c1" },
      { contextEditing: { enabled: true } },
    ]);
    expect(activeProfileSelect(container).value).toBe("");
    expect(contextEditingToggle(container).getAttribute("aria-checked")).toBe("true");
    expect(container.textContent).toContain(saveFailed);
  });
});

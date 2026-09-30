// @vitest-environment jsdom
import type { ReactNode } from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import RtkContextPageClient from "@/app/(dashboard)/dashboard/context/rtk/RtkContextPageClient";
import { rtkConfigSchema } from "@/shared/validation/compressionConfigSchemas";

// next-intl echoes the key, so labels and messages are their translation keys.
vi.mock("next-intl", () => {
  const t = (key: string) => key;
  return { useTranslations: () => t, useLocale: () => "en" };
});

vi.mock("@/shared/components", () => ({
  SegmentedControl: ({
    options,
    onChange,
  }: {
    options: { value: string; label: string }[];
    onChange: (value: string) => void;
  }) => (
    <div>
      {options.map((option) => (
        <button key={option.value} onClick={() => onChange(option.value)}>
          {option.label}
        </button>
      ))}
    </div>
  ),
  Collapsible: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
}));

vi.mock("@/app/(dashboard)/dashboard/context/rtk/RtkLearnDiscoverCard", () => ({
  default: () => null,
}));
vi.mock("@/app/(dashboard)/dashboard/context/rtk/RtkTomlImportCard", () => ({
  default: () => null,
}));

type Json = Record<string, unknown>;

const STORED_CONFIG: Json = {
  enabled: true,
  intensity: "standard",
  applyToToolResults: true,
  applyToAssistantMessages: false,
  applyToCodeBlocks: false,
  enabledFilters: [],
  disabledFilters: [],
  maxLinesPerResult: 200,
  maxCharsPerResult: 20000,
  deduplicateThreshold: 5,
  customFiltersEnabled: false,
  trustProjectFilters: false,
  rawOutputRetention: "failures",
  rawOutputMaxBytes: 65536,
};

const FILTERS = [
  {
    id: "git-status",
    name: "Git status",
    description: "Trims working-tree listings",
    commandTypes: ["git"],
    category: "git",
    priority: 10,
  },
  {
    id: "npm-install",
    name: "npm install",
    description: "Trims dependency logs",
    commandTypes: ["npm"],
    category: "npm",
    priority: 20,
  },
];

function respond(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

async function settle() {
  for (let round = 0; round < 3; round++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

// Stands in for /api/context/rtk/config (plus the page's other GETs). Like the route, a PUT
// that fails rtkConfigSchema gets a 400 and stores nothing; a valid one is merged into the
// stored config when it arrives, and its reply is a snapshot taken at that moment. With
// `hold`, replies wait until the test releases them, like a slow network.
function startServer({
  hold = false,
  fail = () => false,
  reject = () => false,
}: {
  hold?: boolean;
  fail?: (body: Json) => boolean;
  reject?: (body: Json) => boolean;
} = {}) {
  let stored: Json = { ...STORED_CONFIG };
  const puts: Json[] = [];
  const waiting: Array<() => void> = [];

  const receive = (body: Json): Response | TypeError => {
    if (reject(body)) return new TypeError("Failed to fetch");
    if (fail(body)) return respond({ error: "Save failed" }, 500);
    const parsed = rtkConfigSchema.safeParse(body);
    if (!parsed.success) return respond({ error: "Invalid rtkConfig" }, 400);
    stored = { ...stored, ...parsed.data };
    return respond(stored);
  };

  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const { pathname } = new URL(String(input), "http://localhost");
      if (pathname === "/api/settings/compression") return respond({ enabled: true });
      if (pathname === "/api/context/rtk/filters") return respond({ filters: FILTERS });
      if (pathname === "/api/context/analytics") return respond({});
      if (pathname !== "/api/context/rtk/config") return respond(null, 404);
      if (init?.method !== "PUT") return respond(stored);

      const body = JSON.parse(String(init.body)) as Json;
      puts.push(body);
      const reply = receive(body);
      return new Promise<Response>((resolve, rejectReply) => {
        const send = () => (reply instanceof TypeError ? rejectReply(reply) : resolve(reply));
        if (hold) waiting.push(send);
        else send();
      });
    })
  );

  const release = async (send: (() => void) | undefined) => {
    if (!send) throw new Error("no PUT reply is waiting");
    await act(async () => {
      send();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await settle();
  };
  // A page that saves one at a time sends its next PUT only after a reply lands, so keep
  // releasing until nothing is waiting.
  const releaseUntilIdle = async (next: () => (() => void) | undefined) => {
    for (let round = 0; waiting.length > 0; round++) {
      if (round === 20) throw new Error("PUT replies kept coming");
      await release(next());
    }
  };

  return {
    get stored() {
      return stored;
    },
    puts,
    get pending() {
      return waiting.length;
    },
    releaseOldest: () => release(waiting.shift()),
    releaseNewestFirst: () => releaseUntilIdle(() => waiting.pop()),
    releaseAll: () => releaseUntilIdle(() => waiting.shift()),
  };
}

// The control the label names, whether it sits inside the label or is tied to it by htmlFor.
function inputFor(labelKey: string): HTMLInputElement {
  const input = screen.getByText(labelKey).closest("label")?.control;
  if (!(input instanceof HTMLInputElement)) throw new Error(`no input labelled ${labelKey}`);
  return input;
}

function filterCheckbox(name: string): HTMLInputElement {
  let row: HTMLElement | null = screen.getByText(name);
  while (row && !row.querySelector('input[type="checkbox"]')) row = row.parentElement;
  const checkbox = row?.querySelector<HTMLInputElement>('input[type="checkbox"]');
  if (!checkbox) throw new Error(`no checkbox in the ${name} row`);
  return checkbox;
}

// Wherever the page shows it, the message counts.
function pageText(): string {
  return document.body.textContent ?? "";
}

// Focuses the field and fires one change per value, like typing digit by digit.
function type(labelKey: string, values: string[]): HTMLInputElement {
  const input = inputFor(labelKey);
  act(() => input.focus());
  for (const value of values) fireEvent.change(input, { target: { value } });
  return input;
}

// Types the values, then finishes the edit by leaving the field or pressing Enter.
async function commit(labelKey: string, values: string[], via: "blur" | "enter" = "blur") {
  const input = type(labelKey, values);
  if (via === "enter") fireEvent.keyDown(input, { key: "Enter", code: "Enter", keyCode: 13 });
  else act(() => input.blur());
  await settle();
}

async function renderPage() {
  render(<RtkContextPageClient />);
  await settle();
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("RTK page config saves", { timeout: 20_000 }, () => {
  it("typing 120 into max lines saves once, with 120, when the field loses focus", async () => {
    const server = startServer();
    await renderPage();

    await commit("maxLines", ["1", "12", "120"]);

    expect(server.puts).toHaveLength(1);
    expect(server.puts[0]).toMatchObject({ maxLinesPerResult: 120 });
    expect(inputFor("maxLines").value).toBe("120");
  });

  it("pressing Enter in max lines saves the typed value once", async () => {
    const server = startServer();
    await renderPage();

    await commit("maxLines", ["50"], "enter");

    expect(server.puts).toHaveLength(1);
    expect(server.puts[0]).toMatchObject({ maxLinesPerResult: 50 });
    expect(inputFor("maxLines").value).toBe("50");
  });

  it("when the server refuses a save, max chars shows the stored value again and says the save failed", async () => {
    startServer({ fail: (body) => "maxCharsPerResult" in body });
    await renderPage();

    await commit("maxChars", ["5000"]);

    expect(inputFor("maxChars").value).toBe("20000");
    expect(pageText()).toContain("saveFailed");
  });

  it("when a save cannot reach the server, max chars shows the stored value again and says the save failed", async () => {
    const escaped: unknown[] = [];
    const onUnhandled = (reason: unknown) => {
      escaped.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);
    try {
      startServer({ reject: (body) => "maxCharsPerResult" in body });
      await renderPage();

      await commit("maxChars", ["5000"]);

      expect(inputFor("maxChars").value).toBe("20000");
      expect(pageText()).toContain("saveFailed");
      // The page handles the failed fetch instead of leaving an unhandled rejection.
      expect(escaped).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("the save-failed message goes away when the next edit saves", async () => {
    const server = startServer({ fail: (body) => "maxCharsPerResult" in body });
    await renderPage();
    await commit("maxChars", ["5000"]);
    expect(pageText()).toContain("saveFailed");

    await commit("maxLines", ["150"]);

    expect(pageText()).not.toContain("saveFailed");
    expect(server.stored.maxLinesPerResult).toBe(150);
  });

  it("the reply to an older save does not put back a value edited since", async () => {
    const server = startServer({ hold: true });
    await renderPage();
    await commit("maxLines", ["12"]);
    await commit("maxChars", ["5000"]);
    expect(server.pending).toBeGreaterThan(0);

    await server.releaseOldest();

    expect(inputFor("maxChars").value).toBe("5000");
    expect(inputFor("maxLines").value).toBe("12");
  });

  it("when replies arrive newest first, the form ends on the last edits and matches the server", async () => {
    const server = startServer({ hold: true });
    await renderPage();
    await commit("maxLines", ["12"]);
    await commit("maxChars", ["5000"]);
    expect(server.pending).toBeGreaterThan(0);

    await server.releaseNewestFirst();

    expect(inputFor("maxLines").value).toBe("12");
    expect(inputFor("maxChars").value).toBe("5000");
    expect(server.stored).toMatchObject({ maxLinesPerResult: 12, maxCharsPerResult: 5000 });
  });

  it("a filter unchecked while another save is in flight stays unchecked and gets saved", async () => {
    const user = userEvent.setup();
    const server = startServer({ hold: true });
    await renderPage();
    await commit("maxLines", ["12"]);
    await commit("maxChars", ["5000"]);
    expect(server.pending).toBeGreaterThan(0);
    await server.releaseOldest();

    // A real click, so a checkbox disabled during the save cannot toggle (fireEvent.click
    // would toggle it anyway in jsdom).
    await user.click(filterCheckbox("npm install"));
    await settle();
    expect(filterCheckbox("npm install").checked).toBe(false);
    await server.releaseOldest();

    expect(filterCheckbox("npm install").checked).toBe(false);
    await server.releaseAll();
    expect(server.stored.disabledFilters).toContain("npm-install");
  });

  it("clicking a checkbox right after typing a number applies and saves both changes", async () => {
    const user = userEvent.setup();
    const server = startServer({ hold: true });
    await renderPage();
    type("maxLines", ["12"]);

    // Moving focus to the checkbox blurs the number field first, which finishes that edit.
    await user.click(inputFor("toolResults"));
    await settle();
    expect(server.pending).toBeGreaterThan(0);

    expect(inputFor("toolResults").checked).toBe(false);
    await server.releaseAll();
    expect(server.stored.applyToToolResults).toBe(false);
    expect(server.stored.maxLinesPerResult).toBe(12);
  });

  it("typing a byte limit digit by digit saves the finished value and shows no error", async () => {
    const server = startServer();
    await renderPage();

    await commit("rawOutputMaxBytes", ["2", "20", "204", "2048"]);

    expect(server.stored.rawOutputMaxBytes).toBe(2048);
    expect(inputFor("rawOutputMaxBytes").value).toBe("2048");
    expect(pageText()).not.toContain("saveFailed");
  });

  it("an edit made while a save is in flight is sent only after that save's reply arrives", async () => {
    const server = startServer({ hold: true });
    await renderPage();
    await commit("maxLines", ["12"]);
    await commit("maxChars", ["5000"]);

    expect(server.puts).toHaveLength(1);
    expect(inputFor("maxChars").value).toBe("5000");
    await server.releaseOldest();
    expect(server.puts).toHaveLength(2);
    expect(server.puts[1]).toMatchObject({ maxCharsPerResult: 5000 });
  });

  it("a failed save keeps the edits made while it was in flight", async () => {
    const server = startServer({ hold: true, fail: (body) => "maxCharsPerResult" in body });
    await renderPage();
    await commit("maxChars", ["5000"]);
    await commit("maxLines", ["150"]);

    await server.releaseOldest();

    expect(inputFor("maxChars").value).toBe("20000");
    expect(inputFor("maxLines").value).toBe("150");
    await server.releaseAll();
    expect(server.stored.maxLinesPerResult).toBe(150);
  });
});

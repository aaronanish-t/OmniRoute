// @vitest-environment jsdom
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import ExclusionsPanel from "@/app/(dashboard)/dashboard/compression/exclusions/ExclusionsPanel";

// next-intl echoes the key and ignores params, so t("saveFailed") renders "saveFailed".
// One shared t keeps the same identity on every render, as the real hook does.
vi.mock("next-intl", () => {
  const t = (key: string) => key;
  return { useTranslations: () => t, useLocale: () => "en" };
});

// The exclusions the server already holds, and what the user types over them.
const STORED = ["openai/text-embedding-3-large"];
const TYPED = "anthropic/*\ngpt-5-6";

// An HTTP status, or "offline" for a fetch that rejects because the request never
// reached the server.
type Reply = number | "offline";

interface ServerOptions {
  load?: Reply;
  // Replaces the stored settings row in a 200 GET answer.
  loadBody?: unknown;
  // The reply to each PUT in turn; PUTs past the end succeed.
  saves?: Reply[];
}

// Stands in for GET/PUT /api/settings/compression, which answers with the settings row
// (a PUT with the row after the write), or with { error } and the failing status.
function startServer({ load = 200, loadBody, saves = [] }: ServerOptions = {}) {
  let stored: Record<string, unknown> = { exclusions: STORED };
  const puts: Array<Record<string, unknown>> = [];
  const answer = (reply: Reply, okBody: () => unknown) => {
    if (reply === "offline") throw new TypeError("Failed to fetch");
    const body = reply === 200 ? okBody() : { error: "Internal Server Error" };
    return new Response(JSON.stringify(body), {
      status: reply,
      headers: { "Content-Type": "application/json" },
    });
  };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const { pathname } = new URL(String(input), "http://localhost");
      if (pathname !== "/api/settings/compression") return answer(404, () => null);
      if (init?.method !== "PUT") return answer(load, () => loadBody ?? stored);
      const body = JSON.parse(String(init.body));
      puts.push(body);
      return answer(saves[puts.length - 1] ?? 200, () => {
        stored = { ...stored, ...body };
        return stored;
      });
    })
  );
  return { puts };
}

async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function renderPanel() {
  render(<ExclusionsPanel />);
  await settle();
  return {
    textarea: screen.getByTestId("compression-exclusions-textarea") as HTMLTextAreaElement,
    save: screen.getByTestId("compression-exclusions-save") as HTMLButtonElement,
  };
}

// Any element whose own text holds the key as a whole word, so a message with more words
// beside it, or one mirrored into a live region, still counts. A missing text fails as an
// assertion that names it.
function expectShown(text: string) {
  const matches = screen.queryAllByText(new RegExp(`\\b${text}\\b`));
  expect(matches, `panel shows ${text}`).not.toHaveLength(0);
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("ExclusionsPanel reports failed saves and loads", () => {
  it.each<[string, Reply]>([
    ["returns 500", 500],
    ["cannot reach the server", "offline"],
  ])(
    "shows the save-failed message and keeps the typed patterns when the save %s",
    async (_case, reply) => {
      startServer({ saves: [reply] });
      const { textarea, save } = await renderPanel();
      expect(textarea.value).toBe(STORED.join("\n"));

      fireEvent.change(textarea, { target: { value: TYPED } });
      fireEvent.click(save);
      await settle();

      expectShown("saveFailed");
      expect(textarea.value).toBe(TYPED);
      // Screen readers skip the icon's ligature text and read only the message.
      expect(screen.getByText("error").getAttribute("aria-hidden")).toBe("true");
    }
  );

  it("keeps the save-failed message visible after an earlier save's success message times out", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    startServer({ saves: [200, 500] });
    const { textarea, save } = await renderPanel();
    expect(textarea.value).toBe(STORED.join("\n"));

    fireEvent.change(textarea, { target: { value: TYPED } });
    fireEvent.click(save);
    await settle();
    expectShown("compressionExclusionsSaved");

    fireEvent.click(save);
    await settle();
    expectShown("saveFailed");

    // The first save's success timeout, whatever its length, fires after the second save failed.
    await act(() => vi.runOnlyPendingTimersAsync());
    expectShown("saveFailed");
  });

  it("keeps a second save's saved message up for its full time", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    startServer();
    const { textarea, save } = await renderPanel();
    fireEvent.change(textarea, { target: { value: TYPED } });

    fireEvent.click(save);
    await settle();
    await act(() => vi.advanceTimersByTimeAsync(1500));
    fireEvent.click(save);
    await settle();

    // Past the point where the first save's message would have gone.
    await act(() => vi.advanceTimersByTimeAsync(1000));
    expectShown("compressionExclusionsSaved");

    await act(() => vi.advanceTimersByTimeAsync(2000));
    expect(screen.queryAllByText(/\bcompressionExclusionsSaved\b/)).toHaveLength(0);
  });

  it("announces the saved message in a status region that is there before the save", async () => {
    startServer();
    const { textarea, save } = await renderPanel();
    const status = screen.getByRole("status");
    expect(status.textContent).toBe("");

    fireEvent.change(textarea, { target: { value: TYPED } });
    fireEvent.click(save);
    await settle();

    expect(status.textContent).toBe("compressionExclusionsSaved");
  });

  it.each<[string, ServerOptions]>([
    ["returns 500", { load: 500 }],
    ["cannot reach the server", { load: "offline" }],
    ["answers without an exclusions list", { loadBody: {} }],
  ])(
    "shows the load-failed message and blocks editing and saving when loading %s",
    async (_case, options) => {
      const server = startServer(options);
      const { textarea, save } = await renderPanel();

      expectShown("failedLoadWithStatus");
      expect(screen.getByText("error").getAttribute("aria-hidden")).toBe("true");
      expect(textarea.disabled, "textarea disabled after a failed load").toBe(true);
      expect(save.disabled, "Save disabled after a failed load").toBe(true);

      // A Save now would store an empty list over the exclusions the server still holds.
      fireEvent.click(save);
      await settle();
      expect(server.puts, "PUTs sent after a failed load").toEqual([]);
    }
  );
});

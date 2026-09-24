// @vitest-environment jsdom
import React from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import CavemanContextPageClient from "@/app/(dashboard)/dashboard/context/caveman/CavemanContextPageClient";

// next-intl echoes the key, so every label is its translation key.
vi.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}));

vi.mock("next/link", () => ({
  default: ({ children, href }: { children: React.ReactNode; href: string }) => (
    <a href={href}>{children}</a>
  ),
}));

vi.mock("@/shared/components", () => ({
  Card: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
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
}));

let stored: Record<string, unknown>;

beforeEach(() => {
  // Compression on and an output mode stored, so every output-mode control the page
  // can show is rendered.
  stored = {
    enabled: true,
    defaultMode: "standard",
    autoTriggerTokens: 0,
    cacheMinutes: 5,
    preserveSystemPrompt: true,
    comboOverrides: {},
    cavemanOutputMode: { enabled: true, intensity: "full", autoClarity: true },
  };
  // Both config routes share one handler; a PUT overwrites the keys in its body. Every
  // other route 404s, which the page and the tab treat as empty.
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const { pathname } = new URL(String(input), "http://localhost");
      if (pathname !== "/api/settings/compression" && pathname !== "/api/context/caveman/config") {
        return new Response("null", { status: 404 });
      }
      if (init?.method === "PUT") stored = { ...stored, ...JSON.parse(String(init.body)) };
      return new Response(JSON.stringify(stored));
    })
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

describe("caveman page Auto-Clarity", () => {
  it("shows one Auto-Clarity control in the advanced view, and it tracks the saved value", async () => {
    render(<CavemanContextPageClient />);
    await settle();
    fireEvent.click(screen.getByText("advancedMode"));
    await settle();

    // The page's checkbox is labelled "autoClarity"; any second Auto-Clarity control
    // would carry another key containing that word.
    expect(screen.getAllByText(/autoclarity/i)).toHaveLength(1);

    const autoClarity = screen.getByLabelText("autoClarity") as HTMLInputElement;
    expect(autoClarity.checked).toBe(true);
    fireEvent.click(autoClarity);
    await settle();

    expect(stored.cavemanOutputMode).toMatchObject({ autoClarity: false });
    expect(autoClarity.checked).toBe(false);
  });
});

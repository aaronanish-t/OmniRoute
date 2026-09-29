import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import React from "react";
import { renderToString } from "react-dom/server";
import { NextIntlClientProvider } from "next-intl";

const { CompressionPipelineEditor } =
  await import("../../../src/shared/components/compression/CompressionPipelineEditor.tsx");
const { default: SidebarTab } =
  await import("../../../src/app/(dashboard)/dashboard/settings/components/SidebarTab.tsx");

const here = dirname(fileURLToPath(import.meta.url));
const enMessages = JSON.parse(
  readFileSync(resolve(here, "../../../src/i18n/messages/en.json"), "utf8")
);

function renderOnServer(element: React.ReactElement) {
  return renderToString(
    React.createElement(
      NextIntlClientProvider,
      { locale: "en", timeZone: "UTC", messages: enMessages },
      element
    )
  );
}

function describedByIds(html: string) {
  return [...html.matchAll(/aria-describedby="([^"]*)"/g)].map((match) => match[1]);
}

// Without an `id`, DndContext numbers its drag handles' aria-describedby from a counter that
// lives for the whole server process, while each browser load starts from zero, so once the
// server has rendered a page its HTML stops matching the client render. A second server render
// in the same process must emit the same ids as the first.
const cases: Array<[string, () => React.ReactElement]> = [
  [
    "CompressionPipelineEditor",
    () =>
      React.createElement(CompressionPipelineEditor, {
        steps: [
          { engine: "rtk", intensity: "standard" },
          { engine: "caveman", intensity: "full" },
        ],
        onChange: () => {},
        engineIntensities: { rtk: ["standard", "aggressive"], caveman: ["lite", "full", "ultra"] },
      }),
  ],
  ["SidebarTab", () => React.createElement(SidebarTab)],
];

for (const [name, build] of cases) {
  test(`${name}: drag-handle aria-describedby is identical across server renders`, () => {
    const first = describedByIds(renderOnServer(build()));
    const second = describedByIds(renderOnServer(build()));
    assert.ok(first.length > 0, "expected drag handles carrying aria-describedby");
    assert.deepEqual(second, first);
  });
}

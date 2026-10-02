import { test } from "node:test";
import assert from "node:assert/strict";
import {
  applyCavemanOutputMode,
  CAVEMAN_INSTRUCTION_BY_LANGUAGE,
} from "../../../open-sse/services/compression/outputMode.ts";
import { resolveOutputStyleSelection } from "../../../open-sse/services/compression/outputStyles/backCompat.ts";
import {
  applyOutputStyles,
  OUTPUT_STYLE_MARKER,
} from "../../../open-sse/services/compression/outputStyles/apply.ts";

const LEGACY_MARKER = "[OmniRoute Caveman Output Mode]";
const LEVELS = ["lite", "full", "ultra"] as const;

// The instruction text below the marker line. With no system turn in the body, both injectors
// append the instruction as a trailing system message, so it is found by role.
function instructionText(
  result: { applied: boolean; body: { messages?: Array<{ role?: string; content?: unknown }> } },
  marker: string
): string {
  assert.equal(result.applied, true, "the injector applied the instruction");
  const injected = result.body.messages?.find((message) => message.role === "system");
  assert.ok(injected, "the injector added a system message");
  const text = String(injected.content);
  assert.ok(text.startsWith(`${marker}\n`), `the instruction starts with ${marker}`);
  return text.slice(marker.length + 1);
}

// The languages come from the legacy table at runtime, so a language pack added there without a
// matching terse-prose translation fails here.
for (const language of Object.keys(CAVEMAN_INSTRUCTION_BY_LANGUAGE)) {
  for (const intensity of LEVELS) {
    test(`legacy ${language} ${intensity}: the unified injector writes the legacy text below its marker`, () => {
      const body = { messages: [{ role: "user", content: "Summarize this API response." }] };
      const config = { enabled: true, intensity, autoClarity: true };
      const legacy = applyCavemanOutputMode(structuredClone(body), config, language);
      const next = applyOutputStyles(
        structuredClone(body),
        resolveOutputStyleSelection({ cavemanOutputMode: config }),
        language,
        { autoClarity: true }
      );
      assert.equal(
        instructionText(next, OUTPUT_STYLE_MARKER),
        instructionText(legacy, LEGACY_MARKER)
      );
    });
  }
}

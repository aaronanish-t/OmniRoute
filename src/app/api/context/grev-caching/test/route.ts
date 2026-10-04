import { NextResponse } from "next/server";
import { z } from "zod";
import { requireManagementAuth } from "@/lib/api/requireManagementAuth";
import { sanitizeErrorMessage } from "@omniroute/open-sse/utils/error";
import {
  appendPreservingCcrEngine,
  retrieveBlock,
} from "@omniroute/open-sse/services/compression/engines/appendPreservingCcr";

const testConfigSchema = z
  .object({
    triggerPercent: z.number().int().min(1).max(100).optional(),
    preserveRecentPercent: z.number().int().min(1).max(90).optional(),
    minArchiveChars: z.number().int().min(1).max(1_000_000).optional(),
    minRetainedMessages: z.number().int().min(1).max(100).optional(),
    maxArchiveSectionChars: z.number().int().min(1_000).max(1_000_000).optional(),
  })
  .strict();

function markerHash(content: string): string | null {
  return content.match(/^\[CCR retrieve hash=([0-9a-f]{24}) chars=\d+\]/)?.[1] ?? null;
}

/** Runs an in-process synthetic 64k rollover against the real GrevCaching archive engine. */
export async function POST(request: Request) {
  const authError = await requireManagementAuth(request);
  if (authError) return authError;

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const parsed = testConfigSchema.safeParse(raw);
  if (!parsed.success)
    return NextResponse.json({ error: "Invalid test configuration" }, { status: 400 });

  try {
    const principalId = `grev-preview-${crypto.randomUUID()}`;
    const oldUser = "a".repeat(90_000);
    const oldAssistant = "b".repeat(90_000);
    const freshTail = "c".repeat(56_000);
    const tools = [{ type: "function", function: { name: "omniroute_ccr_retrieve" } }];
    const before = appendPreservingCcrEngine.apply(
      {
        messages: [
          { role: "system", content: "Stable system prefix" },
          { role: "user", content: oldUser },
          { role: "assistant", content: oldAssistant },
          { role: "tool", tool_call_id: "preview-tool", content: "Protected direct tool state" },
        ],
        tools,
      },
      { principalId, modelContextLimit: 64_000, stepConfig: parsed.data }
    );
    const after = appendPreservingCcrEngine.apply(
      {
        messages: [
          { role: "system", content: "Stable system prefix" },
          { role: "user", content: oldUser },
          { role: "assistant", content: oldAssistant },
          { role: "tool", tool_call_id: "preview-tool", content: "Protected direct tool state" },
          { role: "user", content: freshTail },
        ],
        tools,
      },
      { principalId, modelContextLimit: 64_000, stepConfig: parsed.data }
    );
    const messages = Array.isArray(after.body.messages)
      ? (after.body.messages as Array<{ content?: unknown }>)
      : [];
    const markers = messages
      .map((message) => (typeof message.content === "string" ? markerHash(message.content) : null))
      .filter((hash): hash is string => hash !== null);
    return NextResponse.json({
      contextWindow: 64_000,
      triggerTokens: 57_600,
      beforeThresholdCompressed: before.compressed,
      afterThresholdCompressed: after.compressed,
      markerCount: markers.length,
      markersRetrievable:
        markers.map((hash) => retrieveBlock(hash, principalId)).join("") ===
        `${oldUser}\n\n${oldAssistant}`,
      protectedToolDirect: messages.some(
        (message) => message.content === "Protected direct tool state"
      ),
      freshTailDirect: messages.at(-1)?.content === freshTail,
    });
  } catch (error) {
    return NextResponse.json(
      { error: "GrevCaching test failed", details: sanitizeErrorMessage(error) },
      { status: 500 }
    );
  }
}

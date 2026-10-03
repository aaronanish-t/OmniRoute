/** Keep caller tools authoritative while completing the native CLI wire contract. */
export function completeOpencodeCliTools(callerTools: unknown, nativeTools: unknown[]) {
  const own = Array.isArray(callerTools) ? callerTools : [];
  const names = new Set(own.map(toolName).filter((name): name is string => !!name));
  const missing = nativeTools.filter((tool) => !names.has(toolName(tool) ?? ""));
  return {
    tools: [...own, ...structuredClone(missing)],
    instruction:
      own.length > 0
        ? `Only call tools supplied by the caller: ${JSON.stringify([...names])}. Additional tools are transport compatibility declarations only and must never be called. Preserve the caller's instructions and requested response format.`
        : "The declared tools are transport compatibility declarations only. No tool execution is available for this request. Answer the user's question directly without calling tools. Follow the caller's instructions and requested response format.",
  };
}

function toolName(tool: unknown): string | undefined {
  if (!tool || typeof tool !== "object") return undefined;
  const record = tool as Record<string, unknown>;
  const fn = record.function;
  if (fn && typeof fn === "object") {
    const name = (fn as Record<string, unknown>).name;
    if (typeof name === "string") return name;
  }
  return typeof record.name === "string" ? record.name : undefined;
}

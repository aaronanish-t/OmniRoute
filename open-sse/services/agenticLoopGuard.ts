type RecordValue = Record<string, unknown>;
const record = (value: unknown): RecordValue =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as RecordValue) : {};

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stable(record(value)[key])}`)
      .join(",")}}`;
  return JSON.stringify(value) ?? "null";
}

type Round = { calls: string[]; results: string[]; errors: boolean[] };

function collectCall(block: RecordValue, round: Round): void {
  const { calls } = round;
  const fn = record(block.functionCall ?? block.function_call);
  if (block.type === "tool_use") calls.push(stable({ name: block.name, arguments: block.input }));
  else if (block.type === "function_call")
    calls.push(stable({ name: block.name, arguments: parseArguments(block.arguments) }));
  else if (block.functionCall || block.function_call)
    calls.push(stable({ name: fn.name, arguments: fn.args }));
}

function collectResult(block: RecordValue, round: Round): void {
  const { results, errors } = round;
  const output = record(block.functionResponse ?? block.function_response);
  if (
    [
      "tool_result",
      "function_call_output",
      "computer_call_output",
      "local_shell_call_output",
    ].includes(String(block.type))
  ) {
    results.push(stable(block.content ?? block.output));
    errors.push(block.is_error === true);
  } else if (block.functionResponse || block.function_response) {
    results.push(stable(output.response));
    errors.push(record(output.response).error != null);
  }
}

function collectEntry(item: RecordValue): Round {
  const parts = Array.isArray(item.content)
    ? item.content
    : Array.isArray(item.parts)
      ? item.parts
      : [item];
  const calls: string[] = [];
  const results: string[] = [];
  const errors: boolean[] = [];

  const round = { calls, results, errors };
  for (const part of parts) {
    collectCall(record(part), round);
    collectResult(record(part), round);
  }
  if (Array.isArray(item.tool_calls))
    for (const tool of item.tool_calls) {
      const fn = record(record(tool).function);
      calls.push(stable({ name: fn.name, arguments: parseArguments(fn.arguments) }));
    }
  if (item.role === "tool") {
    results.push(stable(item.content));
    errors.push(item.is_error === true);
  }

  return round;
}

/** Inspect only completed rounds in the active user turn, across native protocols. */
export function stalledToolLoopReason(body: RecordValue): string | null {
  const key = Array.isArray(body.messages)
    ? "messages"
    : Array.isArray(body.input)
      ? "input"
      : "contents";
  const entries = Array.isArray(body[key]) ? (body[key] as unknown[]) : [];
  const rounds: Round[] = [];
  let pending: Round = { calls: [], results: [], errors: [] };
  for (const entry of entries) {
    const item = record(entry);
    const { calls, results, errors } = collectEntry(item);
    if (item.role === "user" && !results.length) {
      rounds.length = 0;
      pending = { calls: [], results: [], errors: [] };
    }
    if (calls.length && pending.results.length) {
      rounds.push(pending);
      pending = { calls: [], results: [], errors: [] };
    }
    pending.calls.push(...calls);
    pending.results.push(...results);
    pending.errors.push(...errors);
  }
  if (pending.results.length) rounds.push(pending);
  return compareRounds(rounds);
}

function compareRounds(rounds: Round[]): string | null {
  const previous = rounds.at(-2);
  const current = rounds.at(-1);
  if (!previous || !current) return null;
  if (
    previous.calls.length &&
    current.calls.length &&
    stable(previous.calls.slice().sort()) === stable(current.calls.slice().sort()) &&
    stable(previous.results.slice().sort()) === stable(current.results.slice().sort())
  ) {
    return "the same tool calls returned the same results in two consecutive rounds";
  }
  if (
    previous.errors.length &&
    current.errors.length &&
    previous.errors.every(Boolean) &&
    current.errors.every(Boolean)
  )
    return "two consecutive tool rounds failed";
  return null;
}

function parseArguments(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

export type TeamCostShape = {
  input: number;
  output: number;
  cacheRead: number;
  cacheCreation: number;
  reasoning: number;
};

// Retained buckets must describe every counted request. A partial or malformed
// shape map is no more authoritative than a legacy bucket with no shape map.
export function parseShapeCounts(
  value: string | null | undefined,
  expectedRequests: number
): Array<{ shape: TeamCostShape; count: number }> {
  if (!value) return [];
  try {
    const parsed: unknown = JSON.parse(value);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return [];
    const result: Array<{ shape: TeamCostShape; count: number }> = [];
    let total = 0;
    for (const [key, count] of Object.entries(parsed)) {
      const values: unknown = JSON.parse(key);
      if (
        typeof count !== "number" ||
        !Number.isSafeInteger(count) ||
        count < 0 ||
        !Array.isArray(values) ||
        values.length !== 5 ||
        values.some(
          (token) => typeof token !== "number" || !Number.isSafeInteger(token) || token < 0
        )
      )
        return [];
      total += count;
      if (!Number.isSafeInteger(total)) return [];
      if (count > 0)
        result.push({
          shape: {
            input: values[0],
            output: values[1],
            cacheRead: values[2],
            cacheCreation: values[3],
            reasoning: values[4],
          },
          count,
        });
    }
    return total === expectedRequests ? result : [];
  } catch {
    return [];
  }
}

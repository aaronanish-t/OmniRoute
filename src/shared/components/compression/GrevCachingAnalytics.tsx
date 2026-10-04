"use client";

import { useEffect, useState } from "react";

type Since = "24h" | "7d" | "30d" | "all";
interface Analytics {
  totalRuns: number;
  totalConversations: number;
  originalTokens: number;
  compressedTokens: number;
  tokensSaved: number;
  averageSavingsPercent: number;
  requestsWithUsage: number;
  promptReportingRequests: number;
  cacheReadReportingRequests: number;
  actualPromptTokens: number;
  cacheReadTokens: number;
  estimatedCacheHitTokens: number;
  conversations: Array<{
    conversationId: string;
    model: string | null;
    exchanges: number;
    promptEstimatedTokens: number;
    actualPromptTokens: number;
    promptRequestsReported: number;
    cacheReadRequestsReported: number;
    compressionTokensSaved: number;
    compressionSavingsPercent: number;
    engineTokensSaved: number;
    engineSavingsPercent: number;
    estimatedPrefixTokensReused: number;
    lastActivity: string;
  }>;
}

const number = new Intl.NumberFormat();

export function GrevCachingAnalytics() {
  const [since, setSince] = useState<Since>("7d");
  const [stats, setStats] = useState<Analytics | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const refresh = async () => {
      try {
        const response = await fetch(`/api/context/grev-caching/analytics?since=${since}`);
        if (!response.ok) throw new Error("analytics request failed");
        const data = (await response.json()) as Analytics;
        if (!cancelled) {
          setStats(data);
          setError(false);
        }
      } catch {
        if (!cancelled) setError(true);
      }
    };
    void refresh();
    const refreshTimer = setInterval(() => void refresh(), 15_000);
    return () => {
      cancelled = true;
      clearInterval(refreshTimer);
    };
  }, [since]);

  const cards = [
    ["Tracked chats", stats ? number.format(stats.totalConversations) : "—"],
    ["Estimated prefix tokens reused", stats ? number.format(stats.estimatedCacheHitTokens) : "—"],
    [
      "Provider cache-read tokens (actual)",
      stats
        ? stats.cacheReadReportingRequests > 0
          ? `${number.format(stats.cacheReadTokens)} (${number.format(stats.cacheReadReportingRequests)} turns)`
          : "Not reported"
        : "—",
    ],
    [
      "Provider-reported prompt tokens",
      stats
        ? stats.promptReportingRequests > 0
          ? `${number.format(stats.actualPromptTokens)} (${number.format(stats.promptReportingRequests)} turns)`
          : "Not reported"
        : "—",
    ],
  ];

  return (
    <section className="rounded-lg border border-border bg-surface p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="font-medium text-text">GrevCaching cache performance</h2>
          <p className="mt-1 text-xs text-text-muted">
            Provider cache reads and prompt counts below come from usage receipts when reported.
            Estimated prefix reuse is separate and is not proof of a cache hit. Compression savings
            are estimates.
          </p>
        </div>
        <label className="text-xs text-text-muted">
          Period{" "}
          <select
            className="ml-1 rounded border border-border bg-background px-2 py-1 text-text"
            value={since}
            onChange={(event) => setSince(event.target.value as Since)}
          >
            <option value="24h">24 hours</option>
            <option value="7d">7 days</option>
            <option value="30d">30 days</option>
            <option value="all">All time</option>
          </select>
        </label>
      </div>
      {error ? (
        <p className="mt-3 text-sm text-red-500">Unable to load GrevCaching usage.</p>
      ) : (
        <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {cards.map(([label, value]) => (
            <div key={label} className="rounded border border-border bg-background p-3">
              <div className="text-xs text-text-muted">{label}</div>
              <div className="mt-1 text-lg font-semibold text-text">{value}</div>
            </div>
          ))}
        </div>
      )}
      {stats && (
        <>
          <h3 className="mt-6 font-medium text-text">Conversation history (latest 50)</h3>
          {stats.conversations.length === 0 ? (
            <p className="mt-2 text-sm text-text-muted">
              No GrevCaching conversations recorded yet.
            </p>
          ) : (
            <div className="mt-2 overflow-x-auto">
              <table className="w-full min-w-[1180px] text-left text-sm">
                <thead className="text-xs text-text-muted">
                  <tr>
                    <th className="p-2">Chat / last activity</th>
                    <th className="p-2">Model</th>
                    <th className="p-2">Turns</th>
                    <th className="p-2">Estimated prompt total</th>
                    <th className="p-2">Actual prompt tokens</th>
                    <th className="p-2">Compression saved (est.)</th>
                    <th className="p-2">Compression reduction (est.)</th>
                    <th className="p-2">Engine cache savings (actual)</th>
                    <th className="p-2">Cache-read share of prompt</th>
                    <th className="p-2">Reusable prefix (estimated)</th>
                  </tr>
                </thead>
                <tbody>
                  {stats.conversations.map((chat) => (
                    <tr key={chat.conversationId} className="border-t border-border text-text">
                      <td className="p-2" title={chat.conversationId}>
                        Chat {chat.conversationId.slice(-8)} ·{" "}
                        {new Date(chat.lastActivity).toLocaleString()}
                      </td>
                      <td className="p-2">{chat.model ?? "—"}</td>
                      <td className="p-2">{number.format(chat.exchanges)}</td>
                      <td className="p-2">{number.format(chat.promptEstimatedTokens)}</td>
                      <td className="p-2">
                        {chat.promptRequestsReported > 0
                          ? `${number.format(chat.actualPromptTokens)} (${number.format(chat.promptRequestsReported)}/${number.format(chat.exchanges)} turns)`
                          : "Not reported"}
                      </td>
                      <td className="p-2">{number.format(chat.compressionTokensSaved)}</td>
                      <td className="p-2">{chat.compressionSavingsPercent}%</td>
                      <td className="p-2">
                        {chat.cacheReadRequestsReported > 0
                          ? `${number.format(chat.engineTokensSaved)} (${number.format(chat.cacheReadRequestsReported)}/${number.format(chat.exchanges)} turns)`
                          : "Not reported"}
                      </td>
                      <td className="p-2">
                        {chat.actualPromptTokens > 0 &&
                        chat.cacheReadRequestsReported === chat.exchanges &&
                        chat.promptRequestsReported === chat.exchanges
                          ? `${chat.engineSavingsPercent}%`
                          : chat.cacheReadRequestsReported > 0 || chat.promptRequestsReported > 0
                            ? "Partial"
                            : "Not reported"}
                      </td>
                      <td className="p-2">{number.format(chat.estimatedPrefixTokensReused)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </section>
  );
}

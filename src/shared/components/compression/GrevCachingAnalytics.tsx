"use client";

import { useEffect, useState } from "react";

type Since = "24h" | "7d" | "30d" | "all";
interface Analytics {
  totalRuns: number;
  originalTokens: number;
  compressedTokens: number;
  tokensSaved: number;
  averageSavingsPercent: number;
  requestsWithUsage: number;
  actualPromptTokens: number;
  cacheReadTokens: number;
  estimatedCacheHitTokens: number;
  engines: Array<{
    engine: string;
    runs: number;
    originalTokens: number;
    compressedTokens: number;
    tokensSaved: number;
    averageSavingsPercent: number;
  }>;
  conversations: Array<{
    conversationId: string;
    model: string | null;
    exchanges: number;
    promptEstimatedTokens: number;
    actualPromptTokens: number;
    compressionTokensSaved: number;
    compressionSavingsPercent: number;
    engineTokensSaved: number;
    engineSavingsPercent: number;
    lastActivity: string;
  }>;
}

const number = new Intl.NumberFormat();
const formatTokens = (value: number | null) =>
  value === null ? "Not reported" : number.format(value);

export function GrevCachingAnalytics({ compact = false }: { compact?: boolean }) {
  const [since, setSince] = useState<Since>("7d");
  const [stats, setStats] = useState<Analytics | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/context/grev-caching/analytics?since=${since}`)
      .then(async (response) => {
        if (!response.ok) throw new Error("analytics request failed");
        return (await response.json()) as Analytics;
      })
      .then((data) => {
        if (!cancelled) {
          setStats(data);
          setError(false);
        }
      })
      .catch(() => !cancelled && setError(true));
    return () => {
      cancelled = true;
    };
  }, [since]);

  const cards = [
    ["Grev exchanges", stats ? number.format(stats.totalRuns) : "—"],
    ["Estimated compression tokens saved", stats ? number.format(stats.tokensSaved) : "—"],
    ["Average compression reduction", stats ? `${stats.averageSavingsPercent}%` : "—"],
    ["Estimated engine prefix reuse", stats ? number.format(stats.estimatedCacheHitTokens) : "—"],
  ];

  return (
    <section className="rounded-lg border border-border bg-surface p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="font-medium text-text">GrevCaching usage</h2>
          <p className="mt-1 text-xs text-text-muted">
            Compression savings are measured per exchange and added up by conversation. Engine
            savings estimate the unchanged prompt prefix across turns; this is not provider
            confirmation of a KV-cache hit. Provider-reported cache reads are tracked separately.
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
      {!compact && stats && (
        <>
          <div className="mt-4 grid gap-3 text-sm text-text sm:grid-cols-3">
            <div>Estimated input before: {formatTokens(stats.originalTokens)} tokens</div>
            <div>Estimated input after: {formatTokens(stats.compressedTokens)} tokens</div>
            <div>Provider-reported prompt tokens: {formatTokens(stats.actualPromptTokens)}</div>
          </div>
          <h3 className="mt-6 font-medium text-text">GrevCaching engine breakdown</h3>
          {stats.engines.length === 0 ? (
            <p className="mt-2 text-sm text-text-muted">
              No per-engine compression passes have produced savings in this period.
            </p>
          ) : (
            <div className="mt-2 overflow-x-auto">
              <table className="w-full min-w-[640px] text-left text-sm">
                <thead className="text-xs text-text-muted">
                  <tr>
                    <th className="p-2">Engine</th>
                    <th className="p-2">Runs</th>
                    <th className="p-2">Estimated tokens saved</th>
                    <th className="p-2">Average reduction</th>
                  </tr>
                </thead>
                <tbody>
                  {stats.engines.map((engine) => (
                    <tr key={engine.engine} className="border-t border-border text-text">
                      <td className="p-2">{engine.engine}</td>
                      <td className="p-2">{number.format(engine.runs)}</td>
                      <td className="p-2">{number.format(engine.tokensSaved)}</td>
                      <td className="p-2">{engine.averageSavingsPercent}%</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <h3 className="mt-6 font-medium text-text">Conversation history</h3>
          {stats.conversations.length === 0 ? (
            <p className="mt-2 text-sm text-text-muted">
              No GrevCaching conversations recorded yet.
            </p>
          ) : (
            <div className="mt-2 overflow-x-auto">
              <table className="w-full min-w-[1050px] text-left text-sm">
                <thead className="text-xs text-text-muted">
                  <tr>
                    <th className="p-2">Chat / last activity</th>
                    <th className="p-2">Model</th>
                    <th className="p-2">Turns</th>
                    <th className="p-2">Estimated prompt total</th>
                    <th className="p-2">Actual prompt tokens</th>
                    <th className="p-2">Compression saved</th>
                    <th className="p-2">Compression saved %</th>
                    <th className="p-2">Estimated engine saved</th>
                    <th className="p-2">Engine saved %</th>
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
                        {chat.actualPromptTokens ? number.format(chat.actualPromptTokens) : "—"}
                      </td>
                      <td className="p-2">{number.format(chat.compressionTokensSaved)}</td>
                      <td className="p-2">{chat.compressionSavingsPercent}%</td>
                      <td className="p-2">{number.format(chat.engineTokensSaved)}</td>
                      <td className="p-2">{chat.engineSavingsPercent}%</td>
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

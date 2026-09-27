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
  recentRuns: Array<{
    timestamp: string;
    provider: string | null;
    originalTokens: number;
    compressedTokens: number;
    tokensSaved: number;
    actualPromptTokens: number | null;
    cacheReadTokens: number | null;
    estimatedCacheHitTokens: number | null;
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
    ["Grev runs", stats ? number.format(stats.totalRuns) : "—"],
    ["Estimated tokens saved (compression)", stats ? formatTokens(stats.tokensSaved) : "—"],
    ["Average reduction", stats ? `${stats.averageSavingsPercent}%` : "—"],
    [
      "Estimated tokens saved (KV-cache hits)",
      stats
        ? formatTokens(stats.estimatedCacheHitTokens)
        : "—",
    ],
  ];

  return (
    <section className="rounded-lg border border-border bg-surface p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="font-medium text-text">GrevCaching usage</h2>
          <p className="mt-1 text-xs text-text-muted">
            Compression savings are separate from estimated KV-cache reuse. Reuse estimates count
            the unchanged message prefix from the previous request in this model/session; provider-
            reported cache reads are shown separately when available.
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
            <div>
              Provider-reported prompt tokens: {formatTokens(stats.actualPromptTokens)}
            </div>
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
          <h3 className="mt-6 font-medium text-text">Recent Grev requests</h3>
          {stats.recentRuns.length === 0 ? (
            <p className="mt-2 text-sm text-text-muted">No GrevCaching runs recorded yet.</p>
          ) : (
            <div className="mt-2 overflow-x-auto">
              <table className="w-full min-w-[720px] text-left text-sm">
                <thead className="text-xs text-text-muted">
                  <tr>
                    <th className="p-2">Time</th>
                    <th className="p-2">Provider</th>
                    <th className="p-2">Compression tokens saved</th>
                    <th className="p-2">Prompt tokens</th>
                    <th className="p-2">Estimated prefix reuse</th>
                    <th className="p-2">Provider cache reads</th>
                  </tr>
                </thead>
                <tbody>
                  {stats.recentRuns.map((run, index) => (
                    <tr
                      key={`${run.timestamp}-${index}`}
                      className="border-t border-border text-text"
                    >
                      <td className="p-2">{new Date(run.timestamp).toLocaleString()}</td>
                      <td className="p-2">{run.provider ?? "—"}</td>
                      <td className="p-2">{number.format(run.tokensSaved)}</td>
                      <td className="p-2">{formatTokens(run.actualPromptTokens)}</td>
                      <td className="p-2">{formatTokens(run.estimatedCacheHitTokens)}</td>
                      <td className="p-2">{formatTokens(run.cacheReadTokens)}</td>
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

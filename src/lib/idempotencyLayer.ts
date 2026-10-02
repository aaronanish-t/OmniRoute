/**
 * Idempotency Layer — Phase 9.2
 *
 * In-memory deduplication of requests with the same idempotency key.
 * If a request with the same key arrives within the idempotency window (5 seconds by
 * default, configurable via the `idempotencyWindowMs` setting), returns
 * the cached response instead of making a new API call.
 *
 * Headers: X-Request-Id or Idempotency-Key
 *
 * @module lib/idempotencyLayer
 */

import { getSettings } from "@/lib/db/settings";
import { getCachedSettings } from "@/lib/db/readCache";

const DEFAULT_WINDOW_MS = 5000;

/** @type {Map<string, { response: object, status: number, expiresAt: number }>} */
const idempotencyStore = new Map();

// Periodic cleanup every 30s
let cleanupInterval;

function ensureCleanup() {
  if (cleanupInterval) return;
  cleanupInterval = setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of idempotencyStore) {
      if (now >= entry.expiresAt) {
        idempotencyStore.delete(key);
      }
    }
  }, 30000);
  // Don't prevent process exit
  if (cleanupInterval.unref) cleanupInterval.unref();
}

/**
 * Extract idempotency key from request headers.
 * @param {Headers|object} headers
 * @returns {string|null}
 */
export function getIdempotencyKey(headers) {
  if (!headers) return null;
  const get = typeof headers.get === "function" ? (k) => headers.get(k) : (k) => headers[k];
  return get("idempotency-key") || get("x-request-id") || null;
}

/**
 * Check if a response exists for the given idempotency key.
 * @param {string} key
 * @returns {{ response: object, status: number }|null}
 */
export function checkIdempotency(key) {
  if (!key) return null;
  const entry = idempotencyStore.get(key);
  if (!entry) return null;
  if (Date.now() >= entry.expiresAt) {
    idempotencyStore.delete(key);
    return null;
  }
  return { response: entry.response, status: entry.status };
}

/**
 * Resolve effective idempotency window in milliseconds from cached settings or parameter.
 * @param {Record<string, unknown>} [settings]
 * @returns {number}
 */
export function resolveIdempotencyWindowMs(settings?: Record<string, unknown>): number {
  if (
    settings &&
    typeof settings.idempotencyWindowMs === "number" &&
    settings.idempotencyWindowMs > 0
  ) {
    return settings.idempotencyWindowMs;
  }
  return DEFAULT_WINDOW_MS;
}

/**
 * Save a response for idempotency dedup.
 * @param {string} key
 * @param {object} response - Response body to cache
 * @param {number} status - HTTP status code
 * @param {number} [windowMs=5000] - Dedup window in ms
 */
export function saveIdempotency(key, response, status, windowMs?: number) {
  if (!key) return;
  ensureCleanup();
  const effectiveWindowMs =
    typeof windowMs === "number" && windowMs > 0 ? windowMs : DEFAULT_WINDOW_MS;
  idempotencyStore.set(key, {
    response,
    status,
    expiresAt: Date.now() + effectiveWindowMs,
  });
}

/**
 * Save a response for idempotency dedup using configured windowMs from cached settings.
 * @param {string} key
 * @param {object} response - Response body to cache
 * @param {number} status - HTTP status code
 * @param {Record<string, unknown>} [cachedSettings]
 */
export async function saveIdempotencyWithSettings(
  key,
  response,
  status,
  cachedSettings?: Record<string, unknown>
) {
  if (!key) return;
  let windowMs = DEFAULT_WINDOW_MS;
  try {
    const settings = cachedSettings ?? (await getCachedSettings());
    windowMs = resolveIdempotencyWindowMs(settings);
  } catch {
    // Fallback to default
  }
  saveIdempotency(key, response, status, windowMs);
}

/**
 * Get current idempotency store stats.
 */
export async function getIdempotencyStats() {
  let windowMs = DEFAULT_WINDOW_MS;
  try {
    const settings = await getSettings();
    if (typeof settings.idempotencyWindowMs === "number" && settings.idempotencyWindowMs > 0) {
      windowMs = settings.idempotencyWindowMs;
    }
  } catch {
    // Fallback to default if settings unavailable
  }
  return {
    activeKeys: idempotencyStore.size,
    windowMs,
  };
}

/**
 * Clear all idempotency entries (for testing).
 */
export function clearIdempotency() {
  idempotencyStore.clear();
}

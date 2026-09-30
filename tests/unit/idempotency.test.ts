import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  getIdempotencyKey,
  checkIdempotency,
  saveIdempotency,
  saveIdempotencyWithSettings,
  resolveIdempotencyWindowMs,
  clearIdempotency,
  getIdempotencyStats,
} from "../../src/lib/idempotencyLayer.ts";

describe("Idempotency Layer", () => {
  beforeEach(() => {
    clearIdempotency();
  });

  describe("getIdempotencyKey", () => {
    it("returns null for null headers", () => {
      assert.equal(getIdempotencyKey(null), null);
    });

    it("returns Idempotency-Key header", () => {
      const headers = new Headers({ "Idempotency-Key": "abc-123" });
      assert.equal(getIdempotencyKey(headers), "abc-123");
    });

    it("returns X-Request-Id header", () => {
      const headers = new Headers({ "X-Request-Id": "req-456" });
      assert.equal(getIdempotencyKey(headers), "req-456");
    });

    it("prefers Idempotency-Key over X-Request-Id", () => {
      const headers = new Headers({
        "Idempotency-Key": "idemp-1",
        "X-Request-Id": "req-2",
      });
      assert.equal(getIdempotencyKey(headers), "idemp-1");
    });

    it("supports plain object headers", () => {
      const headers = { "idempotency-key": "obj-key" };
      assert.equal(getIdempotencyKey(headers), "obj-key");
    });
  });

  describe("checkIdempotency / saveIdempotency", () => {
    it("returns null for unknown key", () => {
      assert.equal(checkIdempotency("unknown"), null);
    });

    it("returns null for null key", () => {
      assert.equal(checkIdempotency(null), null);
    });

    it("returns cached response within window", () => {
      const response = { choices: [{ message: { content: "hello" } }] };
      saveIdempotency("key-1", response, 200);
      const result = checkIdempotency("key-1");
      assert.deepEqual(result, { response, status: 200 });
    });

    it("returns null after expiry", async () => {
      const response = { choices: [] };
      saveIdempotency("key-2", response, 200, 50); // 50ms window
      await new Promise((r) => setTimeout(r, 100));
      assert.equal(checkIdempotency("key-2"), null);
    });

    it("does nothing for null key", async () => {
      saveIdempotency(null, { data: 1 }, 200);
      assert.equal((await getIdempotencyStats()).activeKeys, 0);
    });
  });

  describe("getIdempotencyStats", () => {
    it("reports active keys", async () => {
      saveIdempotency("a", {}, 200);
      saveIdempotency("b", {}, 200);
      const stats = await getIdempotencyStats();
      assert.equal(stats.activeKeys, 2);
      assert.equal(stats.windowMs, 5000);
    });
  });

  describe("resolveIdempotencyWindowMs / saveIdempotencyWithSettings (#15124)", () => {
    it("resolves default window when settings are undefined or invalid", () => {
      assert.equal(resolveIdempotencyWindowMs(undefined), 5000);
      assert.equal(resolveIdempotencyWindowMs({}), 5000);
      assert.equal(resolveIdempotencyWindowMs({ idempotencyWindowMs: 0 }), 5000);
      assert.equal(resolveIdempotencyWindowMs({ idempotencyWindowMs: -100 }), 5000);
      assert.equal(
        resolveIdempotencyWindowMs({ idempotencyWindowMs: "invalid" as unknown as number }),
        5000
      );
    });

    it("resolves configured window from settings object", () => {
      assert.equal(resolveIdempotencyWindowMs({ idempotencyWindowMs: 60000 }), 60000);
      assert.equal(resolveIdempotencyWindowMs({ idempotencyWindowMs: 1500 }), 1500);
    });

    it("saves entry with custom window via saveIdempotencyWithSettings", async () => {
      const response = { choices: [{ message: { content: "custom-window" } }] };
      await saveIdempotencyWithSettings("key-custom", response, 200, { idempotencyWindowMs: 80 });
      assert.deepEqual(checkIdempotency("key-custom"), { response, status: 200 });

      await new Promise((r) => setTimeout(r, 120));
      assert.equal(checkIdempotency("key-custom"), null);
    });
  });
});

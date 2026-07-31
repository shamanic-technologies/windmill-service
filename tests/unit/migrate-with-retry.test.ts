import { describe, it, expect, vi } from "vitest";
import {
  isTransientConnectError,
  migrateWithRetry,
} from "../../src/lib/migrate-with-retry.js";

function errWithCode(code: string, message = "boom"): Error {
  return Object.assign(new Error(message), { code });
}

describe("isTransientConnectError", () => {
  it("recognises the postgres.js cold-compute codes", () => {
    expect(isTransientConnectError(errWithCode("CONNECT_TIMEOUT"))).toBe(true);
    expect(isTransientConnectError(errWithCode("CONNECTION_CLOSED"))).toBe(true);
    expect(isTransientConnectError(errWithCode("ECONNREFUSED"))).toBe(true);
    expect(isTransientConnectError(errWithCode("ECONNRESET"))).toBe(true);
    expect(isTransientConnectError(errWithCode("ETIMEDOUT"))).toBe(true);
  });

  it("unwraps a Node happy-eyeballs AggregateError", () => {
    const aggregate = new AggregateError(
      [errWithCode("ETIMEDOUT"), errWithCode("ETIMEDOUT")],
      "",
    );
    expect(isTransientConnectError(aggregate)).toBe(true);
  });

  it("unwraps a cause chain", () => {
    const outer = new Error("fetch failed", { cause: errWithCode("ECONNRESET") });
    expect(isTransientConnectError(outer)).toBe(true);
  });

  it("matches connect-phase failures that only carry a message", () => {
    expect(isTransientConnectError(new Error("timeout expired"))).toBe(true);
    expect(
      isTransientConnectError(new Error("timeout exceeded when trying to connect")),
    ).toBe(true);
    expect(
      isTransientConnectError(new Error("the database system is starting up")),
    ).toBe(true);
  });

  it("does NOT treat a real migration failure as transient", () => {
    expect(
      isTransientConnectError(
        Object.assign(new Error('column "foo" does not exist'), { code: "42703" }),
      ),
    ).toBe(false);
    expect(isTransientConnectError(new Error("syntax error at or near"))).toBe(false);
    expect(isTransientConnectError(undefined)).toBe(false);
  });
});

describe("migrateWithRetry", () => {
  it("runs the migration once when the database is reachable", async () => {
    const run = vi.fn().mockResolvedValue(undefined);
    await migrateWithRetry(run, { sleep: async () => {} });
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("retries while the compute is resuming, then succeeds", async () => {
    const run = vi
      .fn()
      .mockRejectedValueOnce(errWithCode("CONNECT_TIMEOUT"))
      .mockRejectedValueOnce(errWithCode("ECONNREFUSED"))
      .mockResolvedValue(undefined);

    const slept: number[] = [];
    await migrateWithRetry(run, {
      sleep: async (ms) => {
        slept.push(ms);
      },
    });

    expect(run).toHaveBeenCalledTimes(3);
    expect(slept).toEqual([250, 500]);
  });

  it("caps the backoff delay", async () => {
    const run = vi.fn().mockRejectedValue(errWithCode("CONNECT_TIMEOUT"));
    const slept: number[] = [];
    let clock = 0;

    await expect(
      migrateWithRetry(run, {
        deadlineMs: 120_000,
        maxDelayMs: 1_000,
        sleep: async (ms) => {
          slept.push(ms);
          clock += ms;
        },
        now: () => clock,
        log: () => {},
      }),
    ).rejects.toThrow();

    expect(Math.max(...slept)).toBe(1_000);
  });

  it("gives up once the deadline is reached and rethrows the connect error", async () => {
    const run = vi.fn().mockRejectedValue(errWithCode("CONNECT_TIMEOUT", "cold"));
    let clock = 0;

    await expect(
      migrateWithRetry(run, {
        deadlineMs: 2_000,
        sleep: async (ms) => {
          clock += ms;
        },
        now: () => clock,
        log: () => {},
      }),
    ).rejects.toThrow("cold");

    expect(run.mock.calls.length).toBeGreaterThan(1);
  });

  it("never retries a genuine migration failure — it rethrows immediately", async () => {
    const run = vi.fn().mockRejectedValue(new Error('relation "workflows" already exists'));
    const sleep = vi.fn(async () => {});

    await expect(migrateWithRetry(run, { sleep })).rejects.toThrow(
      'relation "workflows" already exists',
    );

    expect(run).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });
});

import { describe, it, expect, beforeEach, vi } from "vitest";
import type { Request, Response, NextFunction } from "express";
import {
  getSchemaReadiness,
  markSchemaFailed,
  markSchemaPending,
  markSchemaReady,
  requireSchemaReady,
} from "../../src/lib/schema-readiness.js";

function fakeRes() {
  const res = {
    statusCode: 0,
    body: undefined as unknown,
    headers: {} as Record<string, string>,
    setHeader(key: string, value: string) {
      this.headers[key] = value;
    },
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(payload: unknown) {
      this.body = payload;
      return this;
    },
  };
  return res as unknown as Response & { statusCode: number; body: any; headers: Record<string, string> };
}

describe("schema readiness gate", () => {
  beforeEach(() => {
    markSchemaPending();
  });

  it("defaults to pending — a process that never declares itself ready serves 503", () => {
    expect(getSchemaReadiness()).toBe("pending");
  });

  it("blocks DB-touching routes with 503 + Retry-After while migrations are pending", () => {
    const res = fakeRes();
    const next = vi.fn();

    requireSchemaReady({} as Request, res, next as unknown as NextFunction);

    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(503);
    expect(res.headers["Retry-After"]).toBe("5");
    expect(res.body.migrations).toBe("pending");
  });

  it("passes the request through once migrations are applied", () => {
    markSchemaReady();
    const res = fakeRes();
    const next = vi.fn();

    requireSchemaReady({} as Request, res, next as unknown as NextFunction);

    expect(next).toHaveBeenCalledTimes(1);
    expect(res.statusCode).toBe(0);
  });

  it("surfaces the failure reason when migrations failed", () => {
    markSchemaFailed('column "foo" does not exist');
    const res = fakeRes();
    const next = vi.fn();

    requireSchemaReady({} as Request, res, next as unknown as NextFunction);

    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(503);
    expect(res.body.migrations).toBe("failed");
    expect(res.body.reason).toBe('column "foo" does not exist');
  });
});

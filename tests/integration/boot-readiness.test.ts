import { describe, it, expect, vi, afterEach } from "vitest";

// --- Mock DB: `SELECT 1` in /health must never be reached while pending ---
const healthProbe = vi.fn(() => Promise.resolve([{ "?column?": 1 }]));

vi.mock("../../src/db/index.js", () => {
  const sql = (..._args: unknown[]) => healthProbe();
  return {
    db: {
      select: () => ({
        from: () => {
          const result = Promise.resolve([]);
          (result as any).where = () => Promise.resolve([]);
          return result;
        },
      }),
    },
    sql: Object.assign(sql, { end: () => Promise.resolve() }),
  };
});

vi.mock("../../src/lib/windmill-client.js", () => ({
  getWindmillClient: () => null,
  WindmillClient: vi.fn(),
  resetWindmillClient: vi.fn(),
}));

import supertest from "supertest";
import app from "../../src/index.js";
import {
  markSchemaPending,
  markSchemaReady,
} from "../../src/lib/schema-readiness.js";

const request = supertest(app);

afterEach(() => {
  markSchemaReady();
  healthProbe.mockClear();
});

describe("boot readiness (cold Neon compute)", () => {
  it("answers /health 200 while migrations are still pending", async () => {
    markSchemaPending();

    const res = await request.get("/health");

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("starting");
    expect(res.body.migrations).toBe("pending");
  });

  it("does not touch the database while migrations are pending", async () => {
    markSchemaPending();

    await request.get("/health");

    // The whole point: a cold compute must not be queried inside Railway's
    // healthcheck window.
    expect(healthProbe).not.toHaveBeenCalled();
  });

  it("refuses DB-touching routes with 503 while migrations are pending", async () => {
    markSchemaPending();

    const res = await request.get("/workflows/by-slug/whatever");

    expect(res.status).toBe(503);
    expect(res.body.migrations).toBe("pending");
    expect(res.headers["retry-after"]).toBe("5");
  });

  it("lets requests through once migrations are applied", async () => {
    markSchemaReady();

    const res = await request.get("/definitely-not-a-route");

    // Reached the identity middleware sitting behind the gate, not the gate.
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("x-org-id");
  });

  it("probes the database again once ready", async () => {
    markSchemaReady();

    const res = await request.get("/health");

    expect(healthProbe).toHaveBeenCalled();
    expect(res.status).toBe(200);
    expect(res.body.db).toBe("connected");
  });
});

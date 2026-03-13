import { describe, it, expect } from "vitest";
import type { Request, Response, NextFunction } from "express";
import { requireIdentity } from "../../src/middleware/auth.js";

function mockReqRes(headers: Record<string, string>) {
  const req = { headers } as unknown as Request;
  const locals: Record<string, unknown> = {};
  const res = { locals, status: () => ({ json: () => {} }) } as unknown as Response;
  return { req, res, locals };
}

describe("requireIdentity – tracking headers", () => {
  it("extracts optional x-campaign-id, x-brand-id, x-workflow-name into res.locals", () => {
    const { req, res, locals } = mockReqRes({
      "x-org-id": "org-1",
      "x-user-id": "user-1",
      "x-run-id": "run-1",
      "x-campaign-id": "camp-abc",
      "x-brand-id": "brand-xyz",
      "x-workflow-name": "sales-email-cold-outreach",
    });

    let called = false;
    const next: NextFunction = () => { called = true; };

    requireIdentity(req, res, next);

    expect(called).toBe(true);
    expect(locals.campaignId).toBe("camp-abc");
    expect(locals.brandId).toBe("brand-xyz");
    expect(locals.workflowName).toBe("sales-email-cold-outreach");
  });

  it("does not set tracking locals when headers are absent", () => {
    const { req, res, locals } = mockReqRes({
      "x-org-id": "org-1",
      "x-user-id": "user-1",
      "x-run-id": "run-1",
    });

    let called = false;
    const next: NextFunction = () => { called = true; };

    requireIdentity(req, res, next);

    expect(called).toBe(true);
    expect(locals).not.toHaveProperty("campaignId");
    expect(locals).not.toHaveProperty("brandId");
    expect(locals).not.toHaveProperty("workflowName");
  });

  it("still rejects requests missing required identity headers", () => {
    const req = { headers: { "x-campaign-id": "camp-1" } } as unknown as Request;
    let statusCode = 0;
    const res = {
      locals: {},
      status: (code: number) => {
        statusCode = code;
        return { json: () => {} };
      },
    } as unknown as Response;

    let called = false;
    const next: NextFunction = () => { called = true; };

    requireIdentity(req, res, next);

    expect(called).toBe(false);
    expect(statusCode).toBe(400);
  });
});

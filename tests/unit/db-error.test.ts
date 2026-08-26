import { describe, it, expect } from "vitest";
import {
  describeDbConstraintFailure,
  constraintErrorResponse,
} from "../../src/lib/db-error.js";

describe("describeDbConstraintFailure", () => {
  it("names the request field behind a NOT NULL violation", () => {
    const failure = describeDbConstraintFailure({
      code: "23502",
      table_name: "workflows",
      column_name: "audience_type",
      message: 'null value in column "audience_type" violates not-null constraint',
    });

    expect(failure).not.toBeNull();
    expect(failure!.field).toBe("audienceType");
    expect(failure!.column).toBe("audience_type");
    expect(failure!.message).toContain("audienceType");
  });

  it("reads node-postgres' `column` as well as postgres.js' `column_name`", () => {
    const failure = describeDbConstraintFailure({ code: "23502", column: "channel" });
    expect(failure!.field).toBe("channel");
  });

  it("names the constraint behind a CHECK violation", () => {
    const failure = describeDbConstraintFailure({
      code: "23514",
      constraint_name: "workflows_workflow_dynasty_status_check",
    });

    expect(failure!.code).toBe("23514");
    expect(failure!.message).toContain("workflows_workflow_dynasty_status_check");
  });

  it("leaves anything else to the existing 500 path", () => {
    expect(describeDbConstraintFailure(new Error("connection reset"))).toBeNull();
    expect(describeDbConstraintFailure({ code: "23505" })).toBeNull();
    expect(describeDbConstraintFailure(null)).toBeNull();
    expect(describeDbConstraintFailure("boom")).toBeNull();
  });
});

describe("constraintErrorResponse", () => {
  it("builds a body that names the field", () => {
    const body = constraintErrorResponse({ code: "23502", column_name: "category" });
    expect(body).toEqual({
      error: expect.stringContaining("category"),
      details: expect.objectContaining({ field: "category", code: "23502" }),
    });
  });

  it("returns null for a non-constraint error", () => {
    expect(constraintErrorResponse(new Error("nope"))).toBeNull();
  });
});

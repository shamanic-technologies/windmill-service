import { describe, it, expect } from "vitest";
import { resolveStatusFilter } from "../../src/lib/status-filter.js";

describe("resolveStatusFilter", () => {
  it("treats an absent status as the runnable set", () => {
    // campaign-service provisions off the default listing and never reads the
    // status field back, so the default has to already exclude what cannot run.
    expect(resolveStatusFilter(undefined)).toEqual({ kind: "executable" });
  });

  it("treats 'active' as executable, which is both axes, not just the version one", () => {
    expect(resolveStatusFilter("active")).toEqual({ kind: "executable" });
  });

  it("treats 'deprecated' as the complement: either axis deprecated", () => {
    expect(resolveStatusFilter("deprecated")).toEqual({ kind: "retired" });
  });

  it("leaves 'all' unconstrained", () => {
    expect(resolveStatusFilter("all")).toEqual({ kind: "all" });
  });

  it("passes any other value through as a plain per-version status", () => {
    expect(resolveStatusFilter("draft")).toEqual({ kind: "versionStatus", value: "draft" });
  });
});

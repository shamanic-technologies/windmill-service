import { describe, it, expect } from "vitest";
import { buildInputTransforms } from "../../src/lib/input-mapping.js";

describe("buildInputTransforms", () => {
  it("translates $ref:node.output.field to javascript transform", () => {
    const result = buildInputTransforms(undefined, {
      leadData: "$ref:lead-search.output.lead",
    });

    expect(result.leadData).toEqual({
      type: "javascript",
      expr: "results.lead_search.lead",
    });
  });

  it("translates $ref:flow_input.field to javascript transform", () => {
    const result = buildInputTransforms(undefined, {
      brandIntel: "$ref:flow_input.brandIntel",
    });

    expect(result.brandIntel).toEqual({
      type: "javascript",
      expr: "flow_input.brandIntel",
    });
  });

  it("handles nested output paths", () => {
    const result = buildInputTransforms(undefined, {
      email: "$ref:lead-search.output.lead.email",
    });

    expect(result.email).toEqual({
      type: "javascript",
      expr: "results.lead_search.lead.email",
    });
  });

  it("treats non-$ref strings as static values", () => {
    const result = buildInputTransforms(undefined, {
      channel: "email",
    });

    expect(result.channel).toEqual({
      type: "static",
      value: "email",
    });
  });

  it("spreads config entries as individual static transforms", () => {
    const result = buildInputTransforms(
      { source: "apollo", limit: 10 },
      undefined
    );

    expect(result.source).toEqual({ type: "static", value: "apollo" });
    expect(result.limit).toEqual({ type: "static", value: 10 });
    expect(result.config).toBeUndefined();
  });

  it("combines config and inputMapping as individual transforms", () => {
    const result = buildInputTransforms(
      { contentType: "cold-email" },
      { leadData: "$ref:lead-search.output.lead" }
    );

    expect(result.contentType).toEqual({
      type: "static",
      value: "cold-email",
    });
    expect(result.leadData).toEqual({
      type: "javascript",
      expr: "results.lead_search.lead",
    });
    expect(result.config).toBeUndefined();
  });

  it("translates $ref:flow_input (whole object) to javascript transform", () => {
    const result = buildInputTransforms(undefined, {
      body: "$ref:flow_input",
    });

    expect(result.body).toEqual({
      type: "javascript",
      expr: "flow_input",
    });
  });

  it("returns empty object for no inputs", () => {
    const result = buildInputTransforms(undefined, undefined);
    expect(result).toEqual({});
  });
});

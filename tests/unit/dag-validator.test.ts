import { describe, it, expect } from "vitest";
import { validateDAG } from "../../src/lib/dag-validator.js";
import {
  VALID_LINEAR_DAG,
  DAG_WITH_CYCLE,
  DAG_WITH_UNKNOWN_TYPE,
  DAG_WITH_BAD_EDGE,
  DAG_WITH_BAD_REF,
  DAG_WITH_DUPLICATE_IDS,
  DAG_NO_ENTRY_NODE,
  DAG_WITH_WAIT,
  DAG_WITH_CONDITION,
  DAG_WITH_FOREACH,
  DAG_WITH_STRIPE_NODES,
  DAG_WITH_CLIENT_NODES,
  DAG_WITH_TRANSACTIONAL_EMAIL_SEND,
  DAG_WITH_MIXED_DOT_NOTATION,
  POLARITY_WELCOME_DAG,
} from "../helpers/fixtures.js";

describe("validateDAG", () => {
  it("accepts a valid linear DAG", () => {
    const result = validateDAG(VALID_LINEAR_DAG);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it("accepts a single-node DAG (Polarity welcome)", () => {
    const result = validateDAG(POLARITY_WELCOME_DAG);
    expect(result.valid).toBe(true);
  });

  it("accepts a DAG with wait node", () => {
    const result = validateDAG(DAG_WITH_WAIT);
    expect(result.valid).toBe(true);
  });

  it("accepts a DAG with condition node", () => {
    const result = validateDAG(DAG_WITH_CONDITION);
    expect(result.valid).toBe(true);
  });

  it("accepts a DAG with for-each node", () => {
    const result = validateDAG(DAG_WITH_FOREACH);
    expect(result.valid).toBe(true);
  });

  it("rejects a DAG with a cycle", () => {
    const result = validateDAG(DAG_WITH_CYCLE);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.message.includes("cycle"))).toBe(true);
  });

  it("rejects a DAG with unknown node type", () => {
    const result = validateDAG(DAG_WITH_UNKNOWN_TYPE);
    expect(result.valid).toBe(false);
    expect(
      result.errors.some((e) => e.message.includes("Unknown node type"))
    ).toBe(true);
  });

  it("rejects a DAG with edge to non-existent node", () => {
    const result = validateDAG(DAG_WITH_BAD_EDGE);
    expect(result.valid).toBe(false);
    expect(
      result.errors.some((e) => e.message.includes("unknown target node"))
    ).toBe(true);
  });

  it("rejects a DAG with $ref to non-existent node", () => {
    const result = validateDAG(DAG_WITH_BAD_REF);
    expect(result.valid).toBe(false);
    expect(
      result.errors.some((e) => e.message.includes("References unknown node"))
    ).toBe(true);
  });

  it("rejects a DAG with duplicate node IDs", () => {
    const result = validateDAG(DAG_WITH_DUPLICATE_IDS);
    expect(result.valid).toBe(false);
    expect(
      result.errors.some((e) => e.message.includes("Duplicate node ID"))
    ).toBe(true);
  });

  it("accepts a DAG with stripe dot-notation node types", () => {
    const result = validateDAG(DAG_WITH_STRIPE_NODES);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it("accepts a DAG with client dot-notation node types", () => {
    const result = validateDAG(DAG_WITH_CLIENT_NODES);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it("accepts a DAG with transactional-email.send node type", () => {
    const result = validateDAG(DAG_WITH_TRANSACTIONAL_EMAIL_SEND);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it("accepts a DAG mixing dot-notation and app.* node types", () => {
    const result = validateDAG(DAG_WITH_MIXED_DOT_NOTATION);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it("rejects a DAG with no entry node (all cycled)", () => {
    const result = validateDAG(DAG_NO_ENTRY_NODE);
    expect(result.valid).toBe(false);
    expect(
      result.errors.some((e) => e.message.includes("No entry node"))
    ).toBe(true);
  });
});

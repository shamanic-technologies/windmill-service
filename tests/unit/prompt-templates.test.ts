import { describe, it, expect } from "vitest";
import { buildSystemPrompt } from "../../src/lib/prompt-templates.js";

describe("buildSystemPrompt", () => {
  const prompt = buildSystemPrompt();

  it("uses cold-email as the canonical prompt type for content-generation", () => {
    // The example DAG should use "cold-email" as the prompt type, not "email" or "cold_outreach"
    expect(prompt).toContain('"type": "cold-email"');
    expect(prompt).not.toMatch(/"type":\s*"email"/);
    expect(prompt).not.toContain('"type": "cold_outreach"');
  });

  it("passes sequence array to email-gateway (not bodyHtml)", () => {
    // email-send node should reference the generated sequence array, not bodyHtml.
    // Output paths are placeholders ("<path to ...>") that the LLM resolves from
    // the live OpenAPI spec — we only assert intent is preserved.
    expect(prompt).toContain('"body.sequence"');
    expect(prompt).toMatch(/\$ref:email-generate\.output\.<[^>]*sequence[^>]*>/);
    expect(prompt).not.toMatch(/\$ref:email-generate\.output\.bodyHtml/);
  });

  it("includes required content-generation fields in the example", () => {
    // content-generation POST /generate requires type and variables
    expect(prompt).toContain("body.variables.leadEmail");
    expect(prompt).toContain("body.brandId");
    expect(prompt).toContain("body.campaignId");
    expect(prompt).toContain("body.leadId");
  });

  it("includes required email-gateway broadcast fields in the example", () => {
    // broadcast send requires recipientFirstName, recipientLastName, recipientCompany
    expect(prompt).toContain("body.recipientFirstName");
    expect(prompt).toContain("body.recipientLastName");
    expect(prompt).toContain("body.recipientCompany");
  });

  it("maps the recipient's timezone onto the email-gateway send body", () => {
    // Without it, instantly-service schedules every prospect on its own default
    // timezone — US business hours for the whole fleet.
    expect(prompt).toContain('"body.timezone"');
    expect(prompt).toMatch(/"body\.timezone":\s*"\$ref:fetch-lead\.output\.<[^>]*timezone[^>]*>"/);
    // No default may be introduced here — instantly-service owns its own.
    expect(prompt).not.toMatch(/"body\.timezone":\s*"[A-Za-z]+\/[A-Za-z_]+"/);
  });

  it("documents the content-generation + email send pattern", () => {
    expect(prompt).toContain("Content Generation + Email Send Pattern");
    expect(prompt).toContain('body.type` MUST be "cold-email"');
    expect(prompt).toContain("body.variables` MUST contain FLAT keys only");
    expect(prompt).toContain("variable-length");
  });

  it("forbids cost-tracking nodes in workflows", () => {
    expect(prompt).toContain("NEVER include cost-tracking nodes");
    expect(prompt).toContain("handled internally by each downstream service");
  });

  it("documents the script node type with a code example", () => {
    expect(prompt).toContain('"script"');
    expect(prompt).toContain("config.code");
    expect(prompt).toContain("rawscript");
  });

  it("documents the $ref resolution rule (properties vs additionalProperties)", () => {
    expect(prompt).toContain("$ref` resolution rule");
    expect(prompt).toContain("Fixed-schema objects");
    expect(prompt).toContain("properties");
    expect(prompt).toContain("Dynamic-key maps");
    expect(prompt).toContain("additionalProperties");
    expect(prompt).toContain("caller-chosen");
    expect(prompt).toContain("Inventing paths against fixed schemas is a hard failure");
  });
});

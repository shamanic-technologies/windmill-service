import { describe, it, expect } from "vitest";
import type { DAG } from "../../src/lib/dag-validator.js";
import { validateDAG } from "../../src/lib/dag-validator.js";
import {
  planRecipientTimezoneMapping,
  applyRecipientTimezoneMapping,
  TIMEZONE_BODY_KEY,
} from "../../src/lib/recipient-timezone-mapping.js";

function dagWith(sendMapping: Record<string, string>, fetchNode?: Partial<DAG["nodes"][number]>): DAG {
  return {
    nodes: [
      {
        id: "fetch-lead",
        type: "http.call",
        config: { service: "lead", method: "POST", path: "/orgs/buffer/next" },
        ...(fetchNode ?? {}),
      },
      {
        id: "email-send",
        type: "http.call",
        config: {
          service: "email-gateway",
          method: "POST",
          path: "/orgs/send",
          body: { type: "broadcast" },
        },
        inputMapping: sendMapping,
      },
    ],
    edges: [{ from: "fetch-lead", to: "email-send" }],
  };
}

const LEAD_TZ_REF = "$ref:fetch-lead.output.lead.data.timezone";

describe("planRecipientTimezoneMapping", () => {
  it("derives the timezone ref from the node the recipient email comes from", () => {
    const dag = dagWith({
      "body.to": "$ref:fetch-lead.output.lead.email",
      "body.recipientFirstName": "$ref:fetch-lead.output.lead.data.firstName",
    });

    expect(planRecipientTimezoneMapping(dag)).toEqual([
      { nodeId: "email-send", action: "add", ref: LEAD_TZ_REF },
    ]);
  });

  it("uses the producer's own timezone depth, not the first-name depth", () => {
    // This DAG shape exists in prod: recipient names read one level shallower
    // than the canonical lead payload actually nests them. The timezone still
    // lives at lead.data.timezone on lead-service's response.
    const dag = dagWith({
      "body.to": "$ref:fetch-lead.output.lead.email",
      "body.recipientFirstName": "$ref:fetch-lead.output.lead.firstName",
      "body.recipientCompany": "$ref:fetch-lead.output.lead.organization.name",
    });

    expect(planRecipientTimezoneMapping(dag)[0].ref).toBe(LEAD_TZ_REF);
  });

  it("derives the producing node from the other recipient fields when body.to is absent", () => {
    const dag = dagWith({
      "body.leadId": "$ref:fetch-lead.output.lead.leadId",
      "body.recipientFirstName": "$ref:fetch-lead.output.lead.data.firstName",
      "body.recipientLastName": "$ref:fetch-lead.output.lead.data.lastName",
    });

    expect(planRecipientTimezoneMapping(dag)[0]).toEqual({
      nodeId: "email-send",
      action: "add",
      ref: LEAD_TZ_REF,
    });
  });

  it("skips a recipient resolved off a producer that serves no timezone", () => {
    const dag: DAG = {
      nodes: [
        {
          id: "fetch-lead",
          type: "http.call",
          config: { service: "journalists", method: "POST", path: "/orgs/buffer/next" },
        },
        {
          id: "email-send",
          type: "http.call",
          config: { service: "email-gateway", method: "POST", path: "/orgs/send" },
          inputMapping: {
            "body.to": "$ref:fetch-lead.output.journalist.email",
            "body.recipientFirstName": "$ref:fetch-lead.output.journalist.firstName",
          },
        },
      ],
      edges: [{ from: "fetch-lead", to: "email-send" }],
    };

    const [plan] = planRecipientTimezoneMapping(dag);
    expect(plan.action).toBe("skip");
    expect(plan.ref).toBeUndefined();
    expect(plan.reason).toContain("serves no timezone");
  });

  it("skips when there is no recipient mapping to derive from", () => {
    const dag = dagWith({ "body.subject": "$ref:email-generate.output.subject" });
    const [plan] = planRecipientTimezoneMapping(dag);
    expect(plan.action).toBe("skip");
    expect(plan.reason).toContain("no recipient mapping");
  });

  it("skips when recipient mappings disagree on the producing object", () => {
    const dag = dagWith({
      "body.to": "$ref:fetch-lead.output.lead.email",
      "body.recipientFirstName": "$ref:fetch-lead.output.journalist.firstName",
    });
    const [plan] = planRecipientTimezoneMapping(dag);
    expect(plan.action).toBe("skip");
    expect(plan.reason).toContain("disagree");
  });

  it("reports an already-mapped node as already-present", () => {
    const dag = dagWith({
      "body.to": "$ref:fetch-lead.output.lead.email",
      [TIMEZONE_BODY_KEY]: LEAD_TZ_REF,
    });
    expect(planRecipientTimezoneMapping(dag)).toEqual([
      { nodeId: "email-send", action: "already-present" },
    ]);
  });

  it("ignores workflows with no email-gateway node", () => {
    const dag: DAG = {
      nodes: [
        {
          id: "fetch-lead",
          type: "http.call",
          config: { service: "lead", method: "POST", path: "/orgs/buffer/next" },
        },
      ],
      edges: [],
    };
    expect(planRecipientTimezoneMapping(dag)).toEqual([]);
  });
});

describe("applyRecipientTimezoneMapping", () => {
  const base = dagWith({
    "body.to": "$ref:fetch-lead.output.lead.email",
    "body.recipientFirstName": "$ref:fetch-lead.output.lead.data.firstName",
    "body.recipientLastName": "$ref:fetch-lead.output.lead.data.lastName",
  });

  it("adds only the timezone key and leaves everything else byte-identical", () => {
    const before = structuredClone(base);
    const { dag: after, changed } = applyRecipientTimezoneMapping(base);

    expect(changed).toBe(true);
    expect(base).toEqual(before); // input not mutated

    const sendNode = after.nodes.find((n) => n.id === "email-send")!;
    expect(sendNode.inputMapping?.[TIMEZONE_BODY_KEY]).toBe(LEAD_TZ_REF);

    const stripped = structuredClone(after);
    for (const node of stripped.nodes) {
      if (node.inputMapping) delete node.inputMapping[TIMEZONE_BODY_KEY];
    }
    expect(stripped).toEqual(before);
  });

  it("is idempotent — a second pass changes nothing", () => {
    const first = applyRecipientTimezoneMapping(base);
    const second = applyRecipientTimezoneMapping(first.dag);

    expect(second.changed).toBe(false);
    expect(second.dag).toEqual(first.dag);
    expect(second.plans).toEqual([{ nodeId: "email-send", action: "already-present" }]);
  });

  it("leaves a skipped workflow untouched", () => {
    const journalistDag: DAG = {
      nodes: [
        {
          id: "fetch-lead",
          type: "http.call",
          config: { service: "journalists", method: "POST", path: "/orgs/buffer/next" },
        },
        {
          id: "email-send",
          type: "http.call",
          config: { service: "email-gateway", method: "POST", path: "/orgs/send" },
          inputMapping: { "body.to": "$ref:fetch-lead.output.journalist.email" },
        },
      ],
      edges: [{ from: "fetch-lead", to: "email-send" }],
    };
    const before = structuredClone(journalistDag);
    const { dag: after, changed } = applyRecipientTimezoneMapping(journalistDag);

    expect(changed).toBe(false);
    expect(after).toEqual(before);
  });

  it("produces a DAG that still passes the workflow validator", () => {
    const { dag: after } = applyRecipientTimezoneMapping(base);
    expect(validateDAG(after)).toEqual({ valid: true, errors: [] });
  });

  it("never introduces a default timezone value", () => {
    const { dag: after } = applyRecipientTimezoneMapping(base);
    const value = after.nodes.find((n) => n.id === "email-send")!.inputMapping![TIMEZONE_BODY_KEY];
    expect(value.startsWith("$ref:")).toBe(true);
  });
});

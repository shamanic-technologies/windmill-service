import { describe, it, expect } from "vitest";
import { validateDAG } from "../../src/lib/dag-validator.js";
import { dagToOpenFlow } from "../../src/lib/dag-to-openflow.js";
import { POLARITY_WORKFLOWS } from "../../src/workflows/polarity/index.js";

describe("Polarity workflows", () => {
  // Validate all 6 DAGs
  for (const wf of POLARITY_WORKFLOWS) {
    describe(wf.name, () => {
      it("has a valid DAG", () => {
        const result = validateDAG(wf.dag);
        expect(result.valid).toBe(true);
        expect(result.errors).toHaveLength(0);
      });

      it("translates to OpenFlow without errors", () => {
        const openflow = dagToOpenFlow(wf.dag, wf.name);
        expect(openflow.summary).toBe(wf.name);
        expect(openflow.value.modules.length).toBeGreaterThan(0);
      });
    });
  }

  // Specific structure checks
  describe("Post-Registration Welcome", () => {
    const wf = POLARITY_WORKFLOWS[0];

    it("has a single transactional-email.send node", () => {
      expect(wf.dag.nodes).toHaveLength(1);
      expect(wf.dag.nodes[0].type).toBe("transactional-email.send");
      expect(wf.dag.edges).toHaveLength(0);
    });

    it("uses polaritycourse appId", () => {
      expect(wf.dag.nodes[0].config?.appId).toBe("polaritycourse");
    });

    it("maps email from flow_input", () => {
      expect(wf.dag.nodes[0].inputMapping?.recipientEmail).toBe(
        "$ref:flow_input.email"
      );
    });
  });

  describe("Reminder Sequence", () => {
    const wf = POLARITY_WORKFLOWS[1];

    it("fetches contacts then loops and sends", () => {
      expect(wf.dag.nodes).toHaveLength(3);
      expect(wf.dag.nodes[0].type).toBe("client-service");
      expect(wf.dag.nodes[1].type).toBe("for-each");
      expect(wf.dag.nodes[2].type).toBe("transactional-email.send");
    });

    it("translates for-each to forloopflow module", () => {
      const openflow = dagToOpenFlow(wf.dag, wf.name);
      const loopModule = openflow.value.modules.find(
        (m) => m.id === "loop-contacts"
      );
      expect(loopModule).toBeDefined();
      expect(loopModule!.value.type).toBe("forloopflow");
    });
  });

  describe("SMS Reminder", () => {
    const wf = POLARITY_WORKFLOWS[2];

    it("uses twilio-sms node type", () => {
      const smsNode = wf.dag.nodes.find((n) => n.type === "twilio-sms");
      expect(smsNode).toBeDefined();
    });
  });

  describe("Post-Webinar Offer", () => {
    const wf = POLARITY_WORKFLOWS[3];

    it("sends webinar-post-offer event", () => {
      const sendNode = wf.dag.nodes.find(
        (n) => n.type === "transactional-email.send"
      );
      expect(sendNode?.config?.eventType).toBe("webinar-post-offer");
    });
  });

  describe("Discount Expiry Follow-up", () => {
    const wf = POLARITY_WORKFLOWS[4];

    it("sends webinar-discount-expiring event", () => {
      const sendNode = wf.dag.nodes.find(
        (n) => n.type === "transactional-email.send"
      );
      expect(sendNode?.config?.eventType).toBe("webinar-discount-expiring");
    });
  });

  describe("Payment Confirmation", () => {
    const wf = POLARITY_WORKFLOWS[5];

    it("updates order then sends confirmation", () => {
      expect(wf.dag.nodes).toHaveLength(2);
      expect(wf.dag.nodes[0].type).toBe("order-service");
      expect(wf.dag.nodes[1].type).toBe("transactional-email.send");
      expect(wf.dag.edges).toHaveLength(1);
      expect(wf.dag.edges[0]).toEqual({
        from: "update-order",
        to: "send-confirmation",
      });
    });

    it("sends course-purchase-confirmation event", () => {
      const sendNode = wf.dag.nodes.find(
        (n) => n.type === "transactional-email.send"
      );
      expect(sendNode?.config?.eventType).toBe("course-purchase-confirmation");
    });
  });
});

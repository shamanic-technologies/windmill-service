import type { DAG } from "../../lib/dag-validator.js";

/**
 * Workflow 5: Discount Expiry Follow-up
 *
 * Trigger: Scheduled — 2 hours before discount expires (~18h SGT March 14)
 * Flow input: {}
 *
 * Steps:
 * 1. Fetch all contacts for polaritycourse
 * 2. For each contact, check if they've paid (via order-service)
 * 3. If not paid, send discount-expiring email
 *
 * Note: Filtering logic (paid vs unpaid) is handled at the node script
 * level — the order-service node checks order status and the transactional-email
 * node uses dedupKey to avoid duplicates.
 */
export const discountExpiryFollowup: DAG = {
  nodes: [
    {
      id: "fetch-contacts",
      type: "client-service",
      config: {
        action: "list",
        appId: "polaritycourse",
      },
    },
    {
      id: "loop-contacts",
      type: "for-each",
      config: {
        iterator: "results.fetch_contacts",
        parallel: false,
      },
    },
    {
      id: "send-followup",
      type: "transactional-email.send",
      config: {
        appId: "polaritycourse",
        eventType: "webinar-discount-expiring",
      },
      inputMapping: {
        recipientEmail: "$ref:loop-contacts.output.email",
        metadata: "$ref:flow_input.expiryMetadata",
      },
    },
  ],
  edges: [
    { from: "fetch-contacts", to: "loop-contacts" },
    { from: "loop-contacts", to: "send-followup" },
  ],
};

import type { DAG } from "../../lib/dag-validator.js";

/**
 * Workflow 4: Post-Webinar Offer Email
 *
 * Trigger: Scheduled — 15 minutes after webinar end (2025-03-14T20:15:00+08:00)
 * Flow input: {}
 *
 * Steps:
 * 1. Fetch all contacts registered for polaritycourse
 * 2. For each contact, send offer email via transactional-email
 */
export const postWebinarOffer: DAG = {
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
      id: "send-offer",
      type: "transactional-email.send",
      config: {
        appId: "polaritycourse",
        eventType: "webinar-post-offer",
      },
      inputMapping: {
        recipientEmail: "$ref:loop-contacts.output.email",
        metadata: "$ref:flow_input.offerMetadata",
      },
    },
  ],
  edges: [
    { from: "fetch-contacts", to: "loop-contacts" },
    { from: "loop-contacts", to: "send-offer" },
  ],
};

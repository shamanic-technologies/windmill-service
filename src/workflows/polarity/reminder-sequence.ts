import type { DAG } from "../../lib/dag-validator.js";

/**
 * Workflow 2: Reminder Sequence (Email)
 *
 * Trigger: Scheduled — J-7, J-1, H-1 before webinar
 * Flow input: { eventType: string (webinar-reminder-7d|1d|1h) }
 *
 * Steps:
 * 1. Fetch all contacts with registration on pi_webinar_001
 * 2. For each contact, send reminder email via transactional-email
 */
export const reminderSequence: DAG = {
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
      id: "send-reminder",
      type: "transactional-email.send",
      config: {
        appId: "polaritycourse",
      },
      inputMapping: {
        recipientEmail: "$ref:loop-contacts.output.email",
        metadata: "$ref:flow_input.metadata",
      },
    },
  ],
  edges: [
    { from: "fetch-contacts", to: "loop-contacts" },
    { from: "loop-contacts", to: "send-reminder" },
  ],
};

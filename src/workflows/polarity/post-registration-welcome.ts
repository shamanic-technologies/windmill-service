import type { DAG } from "../../lib/dag-validator.js";

/**
 * Workflow 1: Post-Registration Welcome
 *
 * Trigger: New contact registered for pi_webinar_001
 * Flow input: { email: string, contactData: object }
 *
 * Serves as a fallback — the frontend already sends this email.
 * Uses dedupKey to avoid duplicates.
 */
export const postRegistrationWelcome: DAG = {
  nodes: [
    {
      id: "send-welcome",
      type: "lifecycle-emails",
      config: {
        appId: "polaritycourse",
        eventType: "webinar-registration-welcome",
      },
      inputMapping: {
        recipientEmail: "$ref:flow_input.email",
        metadata: "$ref:flow_input.contactData",
      },
    },
  ],
  edges: [],
};

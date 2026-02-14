import type { DAG } from "../../lib/dag-validator.js";

/**
 * Workflow 3: SMS Reminder (30 min before)
 *
 * Trigger: Scheduled — 2025-03-14T17:30:00+01:00
 * Flow input: { webinarLink: string }
 *
 * Steps:
 * 1. Fetch all contacts for polaritycourse
 * 2. For each contact with a phone number, send SMS
 *
 * Note: The for-each + condition filtering (phone != null) is handled
 * by the twilio-sms node script which skips contacts without phone.
 */
export const smsReminder: DAG = {
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
      id: "send-sms",
      type: "twilio-sms",
      config: {
        messageTemplate:
          "Your Polarity webinar starts in 30 minutes! Join here: {{webinarLink}}",
      },
      inputMapping: {
        to: "$ref:loop-contacts.output.phone",
        body: "$ref:flow_input.smsBody",
      },
    },
  ],
  edges: [
    { from: "fetch-contacts", to: "loop-contacts" },
    { from: "loop-contacts", to: "send-sms" },
  ],
};

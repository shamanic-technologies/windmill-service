import type { DAG } from "../../lib/dag-validator.js";

/**
 * Workflow 6: Payment Confirmation
 *
 * Trigger: Stripe webhook — payment status "succeeded"
 * Flow input: { email: string, orderId: string, amountCents: number }
 *
 * Steps:
 * 1. Update order status to "paid" via order-service
 * 2. Send purchase confirmation email via lifecycle-emails
 */
export const paymentConfirmation: DAG = {
  nodes: [
    {
      id: "update-order",
      type: "order-service",
      config: {
        action: "update",
      },
      inputMapping: {
        orderId: "$ref:flow_input.orderId",
        data: "$ref:flow_input.orderUpdate",
      },
    },
    {
      id: "send-confirmation",
      type: "lifecycle-emails",
      config: {
        appId: "polaritycourse",
        eventType: "course-purchase-confirmation",
      },
      inputMapping: {
        recipientEmail: "$ref:flow_input.email",
        metadata: "$ref:flow_input.paymentMetadata",
      },
    },
  ],
  edges: [{ from: "update-order", to: "send-confirmation" }],
};

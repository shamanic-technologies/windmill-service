export { postRegistrationWelcome } from "./post-registration-welcome.js";
export { reminderSequence } from "./reminder-sequence.js";
export { smsReminder } from "./sms-reminder.js";
export { postWebinarOffer } from "./post-webinar-offer.js";
export { discountExpiryFollowup } from "./discount-expiry-followup.js";
export { paymentConfirmation } from "./payment-confirmation.js";

import type { DAG } from "../../lib/dag-validator.js";
import { postRegistrationWelcome } from "./post-registration-welcome.js";
import { reminderSequence } from "./reminder-sequence.js";
import { smsReminder } from "./sms-reminder.js";
import { postWebinarOffer } from "./post-webinar-offer.js";
import { discountExpiryFollowup } from "./discount-expiry-followup.js";
import { paymentConfirmation } from "./payment-confirmation.js";

export interface WorkflowDefinition {
  name: string;
  description: string;
  dag: DAG;
}

export const POLARITY_WORKFLOWS: WorkflowDefinition[] = [
  {
    name: "Post-Registration Welcome",
    description:
      "Sends welcome email after webinar registration. Fallback for frontend — uses dedupKey to avoid duplicates.",
    dag: postRegistrationWelcome,
  },
  {
    name: "Reminder Sequence",
    description:
      "Scheduled email reminders: J-7, J-1, H-1 before the webinar. Fetches all registered contacts and sends via lifecycle-emails.",
    dag: reminderSequence,
  },
  {
    name: "SMS Reminder",
    description:
      "Sends SMS 30 minutes before webinar to contacts with phone numbers.",
    dag: smsReminder,
  },
  {
    name: "Post-Webinar Offer",
    description:
      "Sends course offer email 15 minutes after webinar ends. 50% discount ($750 instead of $1,500).",
    dag: postWebinarOffer,
  },
  {
    name: "Discount Expiry Follow-up",
    description:
      "Sends urgency email 2 hours before discount expires. Only to contacts who haven't paid yet.",
    dag: discountExpiryFollowup,
  },
  {
    name: "Payment Confirmation",
    description:
      "Triggered on Stripe payment success. Updates order status to paid and sends confirmation email.",
    dag: paymentConfirmation,
  },
];

/**
 * The DAG of the `ai-meeting-booking` channel.
 *
 * One run answers EXACTLY ONE prospect who is owed a message on this campaign:
 * it claims them, reads what they wrote and what we already sent, drafts an
 * answer to the question they actually asked, offers two concrete slots taken
 * from the brand's booking page in the prospect's own timezone, sends it as a
 * reply in their existing thread, and only THEN records what it did and when
 * the next follow-up is owed.
 *
 * Three things this DAG deliberately does NOT do, because another service
 * already owns them:
 *
 *  - It does not decide WHO to answer, in what order, or when to stop. That is
 *    lead-service's follow-up queue: `POST /orgs/campaigns/{campaignId}/followups/claim-next`
 *    hands out at most one person, exactly once, oldest-due-first, with an
 *    atomic claim — so two concurrent runs can never answer the same person.
 *  - It does not resolve WHICH MAILBOX answers. instantly-service reads that
 *    off the mailbox that originally contacted the prospect; a caller-supplied
 *    from-address is exactly the failure `POST /orgs/replies` exists to prevent.
 *  - It does not compute the next due date by a fixed ladder. The date is
 *    chosen per lead, because a prospect who writes "recontact me in January"
 *    must be honoured; lead-service stores it rather than deriving it.
 *
 * The single stated degradation: if the booking page cannot be read, the reply
 * still goes out with the plain booking link and no slots, logged loudly.
 * Everything else fails loud and lands on the error branch.
 */

import type { DAG } from "./dag-validator.js";

/**
 * The instantly-service read of the conversation being answered.
 *
 * instantly-service owns this contract — these three constants are read off its
 * DEPLOYED OpenAPI spec (the API registry mirrors it), never guessed, because
 * `validateWorkflowEndpoints` resolves the live spec on every write path and a
 * path that does not exist there is a 400 at creation time.
 */
export const CONVERSATION_READ = {
  service: "instantly",
  method: "GET",
  path: "/orgs/conversations",
} as const;

/** How far ahead of today the booking page is read for availability. */
export const SLOT_LOOKAHEAD_DAYS = 14;

/** How many candidate slots are handed to the model, which then picks two. */
export const SLOT_CANDIDATES = 6;

/**
 * Reads the brand's booking page for this funnel and returns slots ALREADY
 * CONVERTED to the prospect's own timezone.
 *
 * Calendly's public booking API answers both of these with no API key and no
 * OAuth: one call resolves the event type behind the public URL, the second
 * reads a date range. Passing the IANA timezone is what does the conversion, so
 * there is no timezone arithmetic on our side.
 *
 * This is an UNDOCUMENTED internal API and will break one day without notice.
 * That is why every failure here is a DEGRADATION and never an exception: the
 * prospect still gets an answer carrying the plain booking link, and the reason
 * is logged loudly and returned so the prompt can tell the model what it has.
 * Calendly's official API cannot serve this — it needs the customer's own OAuth
 * and a paid plan.
 *
 * Only Calendly is read for now; any other host degrades rather than guessing.
 */
export const READ_BOOKING_SLOTS_TEMPLATE = `
export async function main(bookingUrl, timezone) {
  const tz = typeof timezone === "string" && timezone.trim() ? timezone.trim() : "UTC";
  const days = LOOKAHEAD_DAYS;
  const want = MAX_SLOTS;

  const degraded = (reason) => {
    console.error("[ai-meeting-booking] no slots read from the booking page: " + reason +
      " (bookingUrl=" + String(bookingUrl) + ", timezone=" + tz + ")");
    return { bookingUrl: bookingUrl ?? null, timezone: tz, slots: [], degraded: true, degradedReason: reason };
  };

  if (typeof bookingUrl !== "string" || !bookingUrl.trim()) return degraded("no_booking_url");

  let parsed;
  try {
    parsed = new URL(bookingUrl.trim());
  } catch {
    return degraded("booking_url_unparseable");
  }
  if (!/(^|\\.)calendly\\.com$/i.test(parsed.hostname)) return degraded("unsupported_provider");

  const segments = parsed.pathname.split("/").filter(Boolean);
  let lookupQuery;
  if (segments[0] === "d" && segments[1]) {
    // Short form: calendly.com/d/xxx-xxx-xxx
    lookupQuery = "event_type_uuid=" + encodeURIComponent(segments[1]);
  } else if (segments.length >= 2) {
    // Long form: calendly.com/<user>/<event>
    lookupQuery = "event_type_slug=" + encodeURIComponent(segments[1]) +
      "&profile_slug=" + encodeURIComponent(segments[0]);
  } else {
    return degraded("booking_url_not_an_event_page");
  }

  let uuid;
  try {
    const res = await fetch("https://calendly.com/api/booking/event_types/lookup?" + lookupQuery, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) return degraded("event_type_lookup_http_" + res.status);
    const body = await res.json();
    uuid = body?.uuid ?? body?.id ?? body?.event_type?.uuid ?? body?.event_type?.id;
  } catch (err) {
    return degraded("event_type_lookup_failed: " + (err instanceof Error ? err.message : String(err)));
  }
  if (!uuid) return degraded("event_type_lookup_returned_no_uuid");

  const startDate = new Date();
  const endDate = new Date(startDate.getTime() + days * 86400000);
  const ymd = (d) => d.toISOString().split("T")[0];

  let payload;
  try {
    const res = await fetch(
      "https://calendly.com/api/booking/event_types/" + encodeURIComponent(uuid) +
        "/calendar/range?timezone=" + encodeURIComponent(tz) +
        "&diagnostics=false&range_start=" + ymd(startDate) + "&range_end=" + ymd(endDate),
      { headers: { accept: "application/json" }, signal: AbortSignal.timeout(15000) },
    );
    if (!res.ok) return degraded("calendar_range_http_" + res.status);
    payload = await res.json();
  } catch (err) {
    return degraded("calendar_range_failed: " + (err instanceof Error ? err.message : String(err)));
  }

  const slots = [];
  for (const day of payload?.days ?? []) {
    for (const spot of day?.spots ?? []) {
      if (spot?.status !== "available" || typeof spot?.start_time !== "string") continue;
      slots.push(spot.start_time);
      if (slots.length >= want) break;
    }
    if (slots.length >= want) break;
  }

  if (slots.length === 0) return degraded("no_available_spots_in_range");
  return { bookingUrl, timezone: tz, slots, degraded: false, degradedReason: null };
}
`.trim();

/**
 * The booking-slots script with its two bounds inlined.
 *
 * They are inlined rather than passed through `inputMapping` because a Windmill
 * input transform carries the value it is given, and a DAG's inputMapping states
 * strings — a lookahead handed over as `"14"` would silently fall through the
 * script's own number check and take a default nobody chose.
 */
export function readBookingSlotsCode(): string {
  return READ_BOOKING_SLOTS_TEMPLATE
    .replace("LOOKAHEAD_DAYS", String(SLOT_LOOKAHEAD_DAYS))
    .replace("MAX_SLOTS", String(SLOT_CANDIDATES));
}

/**
 * Builds the single string the model is asked to answer.
 *
 * chat-service `/complete` takes one flat `message`, so the interpolation has to
 * happen in the flow rather than in an input mapping. Everything the answer
 * depends on is assembled here and nowhere else, which is also what makes the
 * prompt readable in the stored DAG.
 *
 * It also computes `ladderNextDueAt` — the date we would owe them if they said
 * nothing about timing. The model may override it with a date the prospect
 * actually asked for; the ladder is what "grows the interval" means, and there
 * is deliberately no cap on the number of follow-ups.
 */
export const COMPOSE_REPLY_PROMPT_CODE = `
export async function main(followup, leadDetail, conversation, priorGeneration, booking, offerFunnels, funnelKey, brand, currentDate) {
  const person = leadDetail?.leadDetail?.lead ?? {};
  const timezone = booking?.timezone ?? "UTC";

  const messages = conversation?.conversation?.messages ?? [];
  const transcript = messages.map((m) => {
    const who = m?.direction === "inbound" ? "PROSPECT" : "US";
    const when = m?.at ? " (" + m.at + ")" : "";
    return who + when + ":\\n" + String(m?.text ?? "").trim();
  }).join("\\n\\n---\\n\\n");

  const funnel = (offerFunnels?.funnels ?? []).find((f) => f?.funnelKey === funnelKey) ?? null;

  const priorSubject = priorGeneration?.generation?.subject ?? null;
  const followupCount = Number(followup?.followup?.followupCount ?? 0);

  // The interval grows: 3d, 7d, 21d, 60d, then 180d for every one after that.
  const ladder = [3, 7, 21, 60, 180];
  const ladderDays = ladder[Math.min(followupCount, ladder.length - 1)];
  const ladderNextDueAt = new Date(Date.now() + ladderDays * 86400000).toISOString();

  const slotLines = (booking?.slots ?? []).map((s) => "- " + s).join("\\n");

  const bookingSection = booking?.degraded
    ? (booking?.bookingUrl
        ? "The booking page could not be read (" + booking.degradedReason + "). Do NOT invent times. Give them the booking link and let them pick: " + booking.bookingUrl
        : "This brand has no booking link for this funnel (" + booking.degradedReason + "). Do NOT invent times and do NOT invent a link. Ask them which times suit them and say you will send an invite.")
    : "Availability, already converted to the prospect's own timezone (" + timezone + "). Propose EXACTLY TWO of these, written out in plain words, and give the link so they can pick another if neither works: " + booking.bookingUrl + "\\n" + slotLines;

  const message = [
    "Today is " + (currentDate ?? new Date().toISOString().split("T")[0]) + ".",
    "",
    "You are answering one prospect who replied to " + (brand?.brand?.name ?? "our client") + "'s outreach and showed interest.",
    "",
    "WHO THEY ARE",
    "Name: " + [person.firstName, person.lastName].filter(Boolean).join(" "),
    "Title: " + (person.currentTitle ?? ""),
    "Company: " + (person.organization?.name ?? ""),
    "Timezone: " + timezone,
    "",
    "WHAT WE SELL THEM",
    "Funnel: " + (funnel?.name ?? funnelKey ?? ""),
    "",
    "THE CONVERSATION SO FAR, oldest first" + (priorSubject ? " (thread subject: " + priorSubject + ")" : ""),
    transcript || "(no messages on record)",
    "",
    "WHAT YOU MUST DO",
    "1. ANSWER THE QUESTION THEY ASKED. Read their last message and reply to what is in it. A reply that ignores what they wrote is worse than no reply at all.",
    "2. Then propose the meeting.",
    "",
    "BOOKING",
    bookingSection,
    "",
    "WHEN TO COME BACK",
    "If nothing in their message says anything about timing, the next follow-up is owed on " + ladderNextDueAt + ".",
    "If they DID say something about timing (\\"recontact me in January\\", \\"we decide after the summer\\", \\"call me next week\\"), honour THAT instead and return the date they asked for.",
    "Return it as an ISO-8601 timestamp, strictly after now and no more than one year out.",
    "",
    "HOW TO WRITE IT",
    "Write only the words the prospect reads, as HTML. No signature — the mailbox that answers appends its own.",
    "No subject line: this goes into the thread they already have.",
    "Short. Plain. The way one person writes to another.",
  ].join("\\n");

  const systemPrompt = [
    "You answer one prospect at a time, in an email thread that is already running.",
    "You are the person who has been writing to them. You are not a bot and you do not say you are one.",
    "You answer what they asked before you ask for anything.",
    "You never invent availability, prices, names, or facts that are not in front of you.",
  ].join(" ");

  return { message, systemPrompt, ladderNextDueAt, timezone };
}
`.trim();

/**
 * Bounds the date the model chose against the contract lead-service publishes.
 *
 * This is NOT a fallback for data somebody failed to give us: the model's date
 * is untrusted input, and lead-service answers 400 to a date in the past or
 * further out than a year. That 400 would land AFTER the reply has already been
 * sent, leaving the person answered but with no record and no next due date —
 * their claim would expire and the queue would hand them out to be answered a
 * second time. So an unusable date falls back to the ladder date computed
 * alongside it, loudly, rather than failing the run after the irreversible step.
 */
export const RESOLVE_NEXT_DUE_CODE = `
export async function main(draft, ladderNextDueAt) {
  const proposed = draft?.json?.nextDueAt;
  const now = Date.now();
  const ceiling = now + 365 * 86400000;
  const parsed = typeof proposed === "string" ? Date.parse(proposed) : NaN;

  if (Number.isFinite(parsed) && parsed > now && parsed <= ceiling) {
    return { nextDueAt: new Date(parsed).toISOString(), source: "prospect_stated" };
  }

  console.error("[ai-meeting-booking] the model's next-due date is unusable (" + JSON.stringify(proposed) +
    "); falling back to the growing interval " + ladderNextDueAt);
  return { nextDueAt: ladderNextDueAt, source: "interval_ladder" };
}
`.trim();

export const FEATURE_SLUG = "ai-meeting-booking";

export interface AiMeetingBookingDagOptions {
  /** chat-service provider, e.g. "google". */
  provider: string;
  /** chat-service model alias, e.g. "pro". */
  model: string;
}

/**
 * The answer the model must return. Strict, because Anthropic rejects a
 * permissive schema and because a missing `nextDueAt` would otherwise only
 * surface after the reply has gone out.
 */
export const REPLY_RESPONSE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    replyHtml: {
      type: "string",
      description: "The answer the prospect reads, as HTML. No signature, no subject.",
    },
    nextDueAt: {
      type: "string",
      description: "ISO-8601 timestamp of when the next follow-up is owed.",
    },
    answeredQuestion: {
      type: "string",
      description: "The question this reply answers, in the prospect's own words.",
    },
  },
  required: ["replyHtml", "nextDueAt", "answeredQuestion"],
} as const;

export function buildAiMeetingBookingDag(opts: AiMeetingBookingDagOptions): DAG {
  return {
    nodes: [
      {
        id: "gate-check",
        type: "http.call",
        config: {
          service: "campaign",
          method: "POST",
          path: "/gate-check",
          stopAfterIf: "result.allowed == false",
        },
      },
      {
        id: "start-run",
        type: "http.call",
        config: { service: "campaign", method: "POST", path: "/start-run" },
      },
      // At most one person, exactly once, oldest-due-first. The claim is atomic
      // and lives in lead-service; nothing here re-implements it.
      {
        id: "claim-followup",
        type: "http.call",
        config: {
          service: "lead",
          method: "POST",
          path: "/orgs/campaigns/{campaignId}/followups/claim-next",
        },
        retries: 0,
        inputMapping: { "params.campaignId": "$ref:flow_input.campaignId" },
      },
      { id: "check-claim", type: "condition" },
      // Which offer and funnel this campaign sells — the campaign row states both.
      {
        id: "campaign-detail",
        type: "http.call",
        config: { service: "campaign", method: "GET", path: "/campaigns/{id}" },
        inputMapping: { "params.id": "$ref:flow_input.campaignId" },
      },
      // The booking link is per FUNNEL, not per brand: a brand selling several
      // funnels has a different one for each.
      {
        id: "offer-funnels",
        type: "http.call",
        config: { service: "brand", method: "GET", path: "/internal/offers/{offerId}/sales-funnels" },
        inputMapping: { "params.offerId": "$ref:campaign-detail.output.campaign.offerId" },
      },
      {
        id: "brand-profile",
        type: "http.call",
        config: { service: "brand", method: "GET", path: "/internal/brands/{id}" },
        inputMapping: { "params.id": "$ref:claim-followup.output.followup.brandId" },
      },
      // The person, for their name and their own timezone.
      {
        id: "lead-detail",
        type: "http.call",
        config: { service: "lead", method: "GET", path: "/orgs/leads/{id}" },
        inputMapping: {
          "params.id": "$ref:claim-followup.output.followup.id",
          "query.campaignId": "$ref:flow_input.campaignId",
        },
      },
      // What they wrote, and what we sent them.
      {
        id: "conversation",
        type: "http.call",
        config: {
          service: CONVERSATION_READ.service,
          method: CONVERSATION_READ.method,
          path: CONVERSATION_READ.path,
        },
        inputMapping: {
          "query.campaign_id": "$ref:flow_input.campaignId",
          "query.email": "$ref:claim-followup.output.followup.email",
        },
      },
      {
        id: "prior-generation",
        type: "http.call",
        config: { service: "content-generation", method: "GET", path: "/generations/by-lead/{leadId}" },
        retries: 0,
        inputMapping: { "params.leadId": "$ref:claim-followup.output.followup.leadId" },
      },
      {
        id: "booking-slots",
        type: "script",
        config: { code: readBookingSlotsCode() },
        retries: 0,
        inputMapping: {
          bookingUrl: "$ref:pick-booking-url.output.bookingUrl",
          timezone: "$ref:lead-detail.output.leadDetail.lead.timezone",
        },
      },
      {
        id: "pick-booking-url",
        type: "script",
        config: {
          code: `
export async function main(offerFunnels, funnelKey) {
  const funnels = offerFunnels?.funnels ?? [];
  const funnel = funnels.find((f) => f?.funnelKey === funnelKey) ?? null;
  if (!funnel) {
    console.error("[ai-meeting-booking] this campaign's funnel (" + String(funnelKey) +
      ") is not among the offer's active funnels; the prospect still gets an answer, without slots");
  }
  return { bookingUrl: funnel?.bookingUrl ?? null, funnelName: funnel?.name ?? null };
}
`.trim(),
        },
        inputMapping: {
          offerFunnels: "$ref:offer-funnels.output",
          funnelKey: "$ref:campaign-detail.output.campaign.funnelKey",
        },
      },
      {
        id: "compose-prompt",
        type: "script",
        config: { code: COMPOSE_REPLY_PROMPT_CODE },
        retries: 0,
        inputMapping: {
          followup: "$ref:claim-followup.output",
          leadDetail: "$ref:lead-detail.output",
          conversation: "$ref:conversation.output",
          priorGeneration: "$ref:prior-generation.output",
          booking: "$ref:booking-slots.output",
          offerFunnels: "$ref:offer-funnels.output",
          funnelKey: "$ref:campaign-detail.output.campaign.funnelKey",
          brand: "$ref:brand-profile.output",
          currentDate: "$ref:flow_input.currentDate",
        },
      },
      // The LLM call goes through chat-service, which owns the model resolution,
      // the provider key AND the cost declaration for this run's spend.
      {
        id: "draft-reply",
        type: "http.call",
        config: {
          service: "chat",
          method: "POST",
          path: "/complete",
          body: {
            provider: opts.provider,
            model: opts.model,
            responseFormat: "json",
            responseSchema: REPLY_RESPONSE_SCHEMA,
            temperature: 0.4,
            maxTokens: 2000,
          },
        },
        retries: 0,
        inputMapping: {
          "body.message": "$ref:compose-prompt.output.message",
          "body.systemPrompt": "$ref:compose-prompt.output.systemPrompt",
        },
      },
      {
        id: "resolve-next-due",
        type: "script",
        config: { code: RESOLVE_NEXT_DUE_CODE },
        retries: 0,
        inputMapping: {
          draft: "$ref:draft-reply.output",
          ladderNextDueAt: "$ref:compose-prompt.output.ladderNextDueAt",
        },
      },
      // In their existing thread, from the mailbox that contacted them.
      // instantly-service resolves the sending identity; we never supply it.
      {
        id: "send-reply",
        type: "http.call",
        config: {
          service: "instantly",
          method: "POST",
          path: "/orgs/replies",
          validateResponse: { field: "success", equals: true },
        },
        retries: 0,
        inputMapping: {
          "body.campaign_id": "$ref:flow_input.campaignId",
          "body.email": "$ref:claim-followup.output.followup.email",
          "body.body_html": "$ref:draft-reply.output.json.replyHtml",
        },
      },
      // Recorded AFTER the send, never before: the count moves and the next due
      // date is written only once the prospect has actually been answered.
      {
        id: "record-followup",
        type: "http.call",
        config: {
          service: "lead",
          method: "POST",
          path: "/orgs/leads/{id}/followups",
          body: { kind: "acted" },
        },
        retries: 0,
        inputMapping: {
          "params.id": "$ref:claim-followup.output.followup.id",
          "body.nextDueAt": "$ref:resolve-next-due.output.nextDueAt",
        },
      },
      {
        id: "end-run",
        type: "http.call",
        config: {
          service: "campaign",
          method: "POST",
          path: "/end-run",
          body: { success: true, stopCampaign: false },
        },
      },
      // Nobody due right now is not the campaign being finished — the queue
      // fills again as prospects reply and as follow-ups come due.
      {
        id: "end-run-nobody-due",
        type: "http.call",
        config: {
          service: "campaign",
          method: "POST",
          path: "/end-run",
          body: { success: true, stopCampaign: false },
        },
      },
      {
        id: "end-run-error",
        type: "http.call",
        config: {
          service: "campaign",
          method: "POST",
          path: "/end-run",
          body: { success: false, stopCampaign: false },
        },
      },
    ],
    edges: [
      { from: "gate-check", to: "start-run" },
      { from: "start-run", to: "claim-followup" },
      { from: "claim-followup", to: "check-claim" },
      { from: "check-claim", to: "campaign-detail", condition: "results['claim-followup'].found == true" },
      { from: "check-claim", to: "end-run-nobody-due", condition: "results['claim-followup'].found == false" },
      { from: "campaign-detail", to: "offer-funnels" },
      { from: "offer-funnels", to: "pick-booking-url" },
      { from: "pick-booking-url", to: "brand-profile" },
      { from: "brand-profile", to: "lead-detail" },
      { from: "lead-detail", to: "booking-slots" },
      { from: "booking-slots", to: "conversation" },
      { from: "conversation", to: "prior-generation" },
      { from: "prior-generation", to: "compose-prompt" },
      { from: "compose-prompt", to: "draft-reply" },
      { from: "draft-reply", to: "resolve-next-due" },
      { from: "resolve-next-due", to: "send-reply" },
      { from: "send-reply", to: "record-followup" },
      { from: "record-followup", to: "end-run" },
    ],
    onError: "end-run-error",
  };
}

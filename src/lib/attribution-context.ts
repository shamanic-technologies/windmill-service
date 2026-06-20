export interface CampaignAttributionContext extends Record<string, unknown> {
  brandId?: string;
  brandIds?: string[];
  campaignId?: string;
  featureSlug?: string;
  goal?: string;
  brandProfileId?: string;
  customerPersonaId?: string;
  profileId?: string;
  personaId?: string;
  goalId?: string;
  goalSlug?: string;
  optimizationGoal?: string;
}

const ATTRIBUTION_HEADER_FIELDS = [
  ["x-goal", "goal"],
  ["x-brand-profile-id", "brandProfileId"],
  ["x-customer-persona-id", "customerPersonaId"],
  ["x-profile-id", "profileId"],
  ["x-persona-id", "personaId"],
  ["x-goal-id", "goalId"],
  ["x-goal-slug", "goalSlug"],
  ["x-optimization-goal", "optimizationGoal"],
] as const;

const FLAT_INPUT_FIELDS = [
  "goal",
  "brandProfileId",
  "customerPersonaId",
  "profileId",
  "personaId",
  "goalId",
  "goalSlug",
  "optimizationGoal",
] as const;

type HeadersLike = Record<string, string | string[] | undefined>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function copyExplicitObject(
  target: CampaignAttributionContext,
  value: unknown,
): boolean {
  if (!isRecord(value)) return false;

  let copied = false;
  for (const [key, entry] of Object.entries(value)) {
    if (entry !== undefined) {
      target[key] = entry;
      copied = true;
    }
  }
  return copied;
}

export function buildCampaignAttributionContext(input: {
  headers: HeadersLike;
  bodyAttributionContext?: unknown;
  inputs?: Record<string, unknown>;
  campaignId: string;
  brandIds: string[];
  featureSlug: string;
}): CampaignAttributionContext | null {
  const context: CampaignAttributionContext = {};

  const nestedInputContext = input.inputs?.attributionContext;
  let hasExplicitAttribution = copyExplicitObject(context, nestedInputContext);
  hasExplicitAttribution = copyExplicitObject(context, input.bodyAttributionContext) || hasExplicitAttribution;

  for (const field of FLAT_INPUT_FIELDS) {
    const value = nonEmptyString(input.inputs?.[field]);
    if (value) {
      context[field] = value;
      hasExplicitAttribution = true;
    }
  }

  for (const [header, field] of ATTRIBUTION_HEADER_FIELDS) {
    const value = nonEmptyString(input.headers[header]);
    if (value) {
      context[field] = value;
      hasExplicitAttribution = true;
    }
  }

  if (!hasExplicitAttribution) {
    return null;
  }

  context.campaignId = input.campaignId;
  context.featureSlug = input.featureSlug;
  if (input.brandIds.length > 0) {
    context.brandIds = input.brandIds;
    if (input.brandIds.length === 1) {
      context.brandId = input.brandIds[0];
    }
  }

  return context;
}

export function attributionContextToHeaders(
  context: CampaignAttributionContext | null | undefined,
): Record<string, string> {
  if (!context) return {};

  const headers: Record<string, string> = {};
  for (const [header, field] of ATTRIBUTION_HEADER_FIELDS) {
    const value = nonEmptyString(context[field]);
    if (value) headers[header] = value;
  }
  return headers;
}

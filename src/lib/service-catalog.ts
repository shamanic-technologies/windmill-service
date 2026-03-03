export interface ServiceInfo {
  name: string;
  description: string;
  keyEndpoints: string[];
}

export const SERVICE_CATALOG: ServiceInfo[] = [
  {
    name: "campaign",
    description: "Campaign lifecycle: gate-check (budget/volume validation), start-run (creates execution run), end-run (finalizes run, auto-retriggers if budget remains)",
    keyEndpoints: ["POST /internal/gate-check", "POST /internal/start-run", "POST /internal/end-run"],
  },
  {
    name: "lead",
    description: "Lead buffer management: push leads, pull next lead for outreach, search leads",
    keyEndpoints: ["POST /buffer/next", "POST /buffer/push", "GET /leads"],
  },
  {
    name: "brand",
    description: "Brand intelligence: company profiles, sales profiles, tone of voice, value propositions",
    keyEndpoints: ["GET /brands/:id", "POST /sales-profile"],
  },
  {
    name: "content-generation",
    description: "AI-powered content generation: emails, subject lines using stored prompt templates",
    keyEndpoints: ["POST /generate", "POST /generate/content"],
  },
  {
    name: "email-gateway",
    description: "Low-level email sending via configured provider (Postmark, SES)",
    keyEndpoints: ["POST /send"],
  },
  {
    name: "transactional-email",
    description: "Template-based transactional emails by eventType (welcome, confirmation, etc.)",
    keyEndpoints: ["POST /send", "GET /stats"],
  },
  {
    name: "runs",
    description: "Execution tracking: create runs, add costs, mark complete/failed",
    keyEndpoints: ["POST /runs/start", "POST /runs/end", "POST /runs/:id/costs"],
  },
  {
    name: "costs",
    description: "Unit price registry for cost tracking",
    keyEndpoints: ["GET /prices"],
  },
  {
    name: "key",
    description: "API key management: resolve external API keys by org/user",
    keyEndpoints: ["GET /keys/:provider/decrypt"],
  },
  {
    name: "client",
    description: "User/contact management: CRUD users and contacts for an app",
    keyEndpoints: ["POST /users", "GET /users", "PUT /users/:id"],
  },
  {
    name: "stripe",
    description: "Stripe operations: products, prices, checkout sessions, coupons",
    keyEndpoints: ["POST /products", "POST /prices", "POST /checkout-sessions"],
  },
  {
    name: "twilio",
    description: "SMS sending via Twilio",
    keyEndpoints: ["POST /send"],
  },
  {
    name: "instantly",
    description: "Cold email sending via Instantly.ai platform",
    keyEndpoints: ["POST /send"],
  },
  {
    name: "reply-qualification",
    description: "AI classification of email replies: interested, not interested, bounce, etc.",
    keyEndpoints: ["POST /qualify"],
  },
  {
    name: "outlets",
    description: "Media outlet database for PR outreach: find relevant outlets by topic/industry",
    keyEndpoints: ["GET /outlets", "GET /outlets/:id"],
  },
  {
    name: "journalists",
    description: "Journalist database for PR outreach: find and rank journalists by outlet",
    keyEndpoints: ["GET /journalists", "GET /journalists/:id"],
  },
  {
    name: "articles",
    description: "Article database: journalist articles for ranking and context",
    keyEndpoints: ["GET /articles"],
  },
  {
    name: "press-kits",
    description: "Press kit management: generate/cache press kits, return public URL",
    keyEndpoints: ["GET /press-kits/:id", "POST /press-kits"],
  },
  {
    name: "scraping",
    description: "Web scraping: extract structured data from URLs",
    keyEndpoints: ["POST /scrape"],
  },
  {
    name: "apollo",
    description: "Apollo.io integration: people search, enrichment",
    keyEndpoints: ["POST /search", "POST /enrich"],
  },
  {
    name: "ahref",
    description: "Ahrefs SEO data: backlinks, domain rating",
    keyEndpoints: ["POST /analyze"],
  },
];

export function getServiceCatalogForPrompt(filterServices?: string[]): string {
  const services = filterServices
    ? SERVICE_CATALOG.filter((s) => filterServices.includes(s.name))
    : SERVICE_CATALOG;

  return services
    .map((s) => `- **${s.name}**: ${s.description}\n  Endpoints: ${s.keyEndpoints.join(", ")}`)
    .join("\n");
}

/**
 * Maps our DAG node types to Windmill script paths.
 * null = native Windmill construct (wait, condition, for-each).
 */
export const NODE_TYPE_REGISTRY: Record<string, string | null> = {
  // Live services
  "lead-service": "f/nodes/lead_service",
  "content-generation": "f/nodes/content_generation",
  "outbound-sending": "f/nodes/outbound_sending",
  "brand-intel": "f/nodes/brand_intel",
  "content-sentiment": "f/nodes/content_sentiment",
  "client-service": "f/nodes/client_service",

  // Stripe service (dot notation)
  "stripe.createProduct": "f/nodes/stripe_create_product",
  "stripe.getProduct": "f/nodes/stripe_get_product",
  "stripe.createPrice": "f/nodes/stripe_create_price",
  "stripe.getPricesByProduct": "f/nodes/stripe_get_prices_by_product",
  "stripe.createCoupon": "f/nodes/stripe_create_coupon",
  "stripe.getCoupon": "f/nodes/stripe_get_coupon",
  "stripe.createCheckout": "f/nodes/stripe_create_checkout",
  "stripe.getStats": "f/nodes/stripe_get_stats",

  // Client service (dot notation)
  "client.createUser": "f/nodes/client_create_user",
  "client.updateUser": "f/nodes/client_update_user",
  "client.getUsers": "f/nodes/client_get_users",

  // Transactional email (dot notation)
  "transactional-email.send": "f/nodes/transactional_email_send",
  "transactional-email.getStats": "f/nodes/transactional_email_get_stats",

  // App-level logic (inline scripts, no HTTP calls)
  "app.resolveProduct": "f/nodes/app_resolve_product",
  "app.resolveDiscount": "f/nodes/app_resolve_discount",

  // Legacy names (kept for backward compatibility)
  "twilio-sms": "f/nodes/twilio_sms",
  "order-service": "f/nodes/order_service",
  "product-service": "f/nodes/product_service",
  "stripe-service": "f/nodes/stripe_service",

  // Stubs (not yet implemented)
  "linkedin-dm": "f/nodes/linkedin_dm",
  "linkedin-connect": "f/nodes/linkedin_connect",
  "linkedin-post": "f/nodes/linkedin_post",
  "google-ads": "f/nodes/google_ads",
  "meta-ads": "f/nodes/meta_ads",

  // Native Windmill constructs
  wait: null,
  condition: null,
  "for-each": null,
};

export function getScriptPath(nodeType: string): string | null {
  if (!(nodeType in NODE_TYPE_REGISTRY)) {
    return undefined as unknown as null;
  }
  return NODE_TYPE_REGISTRY[nodeType];
}

export function isKnownNodeType(nodeType: string): boolean {
  return nodeType in NODE_TYPE_REGISTRY;
}

export function isNativeNode(nodeType: string): boolean {
  return nodeType in NODE_TYPE_REGISTRY && NODE_TYPE_REGISTRY[nodeType] === null;
}

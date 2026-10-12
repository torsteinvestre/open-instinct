/**
 * The names a deployment shows people. Unset, the gateway speaks as Open Instinct and each
 * agent is "Maria's Instinct". A brand renames both, for operators who run it as their own service.
 */
export interface Brand {
  /** The service, on every page ("Open Instinct", "Sunshine"). */
  product: string;
  /** What each person's agent is called ("Instinct", "Sunshine"). */
  agent: string;
}

export const DEFAULT_BRAND: Brand = { product: "Open Instinct", agent: "Instinct" };

/** GATEWAY_BRAND_NAME: one name for the service and every agent. Empty means the default brand. */
export function brandFrom(name: string | undefined): Brand | undefined {
  const n = name?.trim();
  return n ? { product: n, agent: n } : undefined;
}

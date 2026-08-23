import type { AvailabilityStatus } from "./availability";

export type VariantHideDecision = "hide" | "unhide" | "none";

export function variantHideDecision(input: {
  enabled: boolean;
  eligible: boolean;
  ignored: boolean;
  status: AvailabilityStatus;
  activelyHidden: boolean;
  hideErrored?: boolean;
}): VariantHideDecision {
  const shouldHide =
    input.enabled &&
    input.eligible &&
    !input.ignored &&
    input.status === "soldOut";
  if (!shouldHide) return input.activelyHidden ? "unhide" : "none";
  // Recheck app-owned hidden variants so a later product-level publish cannot
  // accidentally make a sold-out variant visible again.
  return "hide";
}

export function variantHideCatalogEligible(publishedProductCount: number) {
  return publishedProductCount <= 500;
}

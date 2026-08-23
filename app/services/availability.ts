export type AvailabilityStatus = "inStock" | "continueSelling" | "soldOut";
export type InventoryPolicy = "CONTINUE" | "DENY";

export interface AvailabilityLocationInput {
  locationId: string;
  locationName: string;
  fulfillsOnlineOrders: boolean;
  available: number;
}

export interface AvailabilityVariantInput {
  variantId: string;
  title: string;
  inventoryPolicy: InventoryPolicy;
  tracked: boolean;
  locations: AvailabilityLocationInput[];
}

export interface AvailabilityClassificationInput {
  variants: AvailabilityVariantInput[];
  tags: string[];
  excluded: boolean;
  sortContinueSellingAsOos: boolean;
  evaluatedAt?: Date;
  previousSoldOutAt?: Date | null;
}

export interface VariantAvailability extends AvailabilityVariantInput {
  status: AvailabilityStatus;
  onlineQuantity: number;
  totalQuantity: number;
}

export interface AvailabilityClassification {
  status: AvailabilityStatus;
  variants: VariantAvailability[];
  ignored: boolean;
  ignoreReason: "tag" | "excludedProduct" | null;
  soldOutAt: Date | null;
  evaluatedAt: Date;
}

const IGNORE_TAG = "inventex-ignore";

export function classifyProductAvailability(
  input: AvailabilityClassificationInput,
): AvailabilityClassification {
  const evaluatedAt = input.evaluatedAt ?? new Date();
  const variants = input.variants.map((variant) => {
    const onlineQuantity = variant.locations
      .filter((location) => location.fulfillsOnlineOrders)
      .reduce((sum, location) => sum + location.available, 0);
    const totalQuantity = variant.locations.reduce(
      (sum, location) => sum + location.available,
      0,
    );

    let status: AvailabilityStatus;
    if (!variant.tracked || onlineQuantity > 0) {
      status = "inStock";
    } else if (variant.inventoryPolicy === "CONTINUE") {
      status = input.sortContinueSellingAsOos ? "continueSelling" : "inStock";
    } else {
      status = "soldOut";
    }

    return { ...variant, status, onlineQuantity, totalQuantity };
  });

  const status: AvailabilityStatus = variants.some(
    (variant) => variant.status === "inStock",
  )
    ? "inStock"
    : variants.some((variant) => variant.status === "continueSelling")
      ? "continueSelling"
      : "soldOut";

  const ignoredByTag = input.tags.some(
    (tag) => tag.trim().toLowerCase() === IGNORE_TAG,
  );
  const ignoreReason = ignoredByTag
    ? "tag"
    : input.excluded
      ? "excludedProduct"
      : null;

  return {
    status,
    variants,
    ignored: ignoreReason !== null,
    ignoreReason,
    soldOutAt:
      status === "soldOut" ? (input.previousSoldOutAt ?? evaluatedAt) : null,
    evaluatedAt,
  };
}

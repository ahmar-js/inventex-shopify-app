export const BILLING_PLAN_NAMES = {
  STARTER: "Inventex Starter",
  GROWTH: "Inventex Growth",
  PRO: "Inventex Pro",
  ENTERPRISE: "Inventex Enterprise",
} as const;

export type BillingPlanName =
  (typeof BILLING_PLAN_NAMES)[keyof typeof BILLING_PLAN_NAMES];

export interface BillingPlanDefinition {
  name: BillingPlanName;
  amount: number;
  maxProducts: number | null;
}

export const BILLING_PLANS: readonly BillingPlanDefinition[] = [
  { name: BILLING_PLAN_NAMES.STARTER, amount: 9.99, maxProducts: 100 },
  { name: BILLING_PLAN_NAMES.GROWTH, amount: 14.99, maxProducts: 1_000 },
  { name: BILLING_PLAN_NAMES.PRO, amount: 19.99, maxProducts: 10_000 },
  {
    name: BILLING_PLAN_NAMES.ENTERPRISE,
    amount: 39.99,
    maxProducts: null,
  },
] as const;

export const BILLING_TRIAL_DAYS = 7;

export interface ShopPlanDetails {
  partnerDevelopment: boolean;
  shopifyPlus: boolean;
  publicDisplayName: string;
}

export interface SubscriptionDetails {
  id: string;
  name: string;
  status: string;
  test: boolean;
  trialDays: number;
  createdAt: string;
}

export interface BillingEntitlement {
  productCount: number;
  requiredPlan: BillingPlanDefinition;
  subscribedPlan: BillingPlanDefinition | null;
  subscription: SubscriptionDetails | null;
  developmentStore: boolean;
  accessAllowed: boolean;
  accessReason:
    | "FREE_DEVELOPMENT_STORE"
    | "ACTIVE_SUBSCRIPTION"
    | "PAYMENT_REQUIRED"
    | "PLAN_LIMIT_EXCEEDED";
}

export function requiredPlanForProductCount(productCount: number) {
  const safeCount = Math.max(0, Math.floor(productCount));
  return (
    BILLING_PLANS.find(
      ({ maxProducts }) => maxProducts === null || safeCount <= maxProducts,
    ) ?? BILLING_PLANS[BILLING_PLANS.length - 1]
  );
}

export function isFreeDevelopmentStore(plan: ShopPlanDetails) {
  const displayName = plan.publicDisplayName.trim().toLocaleLowerCase();
  return (
    plan.partnerDevelopment ||
    displayName === "development" ||
    displayName === "trial" ||
    (plan.shopifyPlus && displayName === "plus trial")
  );
}

export function isBillingPlanName(value: string): value is BillingPlanName {
  return BILLING_PLANS.some(({ name }) => name === value);
}

export function billingPlanCoversProducts(
  planName: BillingPlanName,
  productCount: number,
) {
  const plan = BILLING_PLANS.find(({ name }) => name === planName)!;
  return plan.maxProducts === null || productCount <= plan.maxProducts;
}

export function resolveBillingEntitlement(input: {
  productCount: number;
  shopPlan: ShopPlanDetails;
  subscriptions: SubscriptionDetails[];
}): BillingEntitlement {
  const productCount = Math.max(0, Math.floor(input.productCount));
  const requiredPlan = requiredPlanForProductCount(productCount);
  const developmentStore = isFreeDevelopmentStore(input.shopPlan);
  const recognized = input.subscriptions
    .filter(
      (subscription) =>
        subscription.status === "ACTIVE" &&
        isBillingPlanName(subscription.name) &&
        (developmentStore || !subscription.test),
    )
    .map((subscription) => ({
      subscription,
      plan: BILLING_PLANS.find(({ name }) => name === subscription.name)!,
    }))
    .sort(
      (left, right) => planCapacity(right.plan) - planCapacity(left.plan),
    );
  const active = recognized[0] ?? null;

  if (developmentStore) {
    return {
      productCount,
      requiredPlan,
      subscribedPlan: active?.plan ?? null,
      subscription: active?.subscription ?? null,
      developmentStore,
      accessAllowed: true,
      accessReason: "FREE_DEVELOPMENT_STORE",
    };
  }

  if (!active) {
    return {
      productCount,
      requiredPlan,
      subscribedPlan: null,
      subscription: null,
      developmentStore,
      accessAllowed: false,
      accessReason: "PAYMENT_REQUIRED",
    };
  }

  const accessAllowed = billingPlanCoversProducts(
    active.plan.name,
    productCount,
  );
  return {
    productCount,
    requiredPlan,
    subscribedPlan: active.plan,
    subscription: active.subscription,
    developmentStore,
    accessAllowed,
    accessReason: accessAllowed
      ? "ACTIVE_SUBSCRIPTION"
      : "PLAN_LIMIT_EXCEEDED",
  };
}

export function billingAccessMessage(access: {
  accessAllowed: boolean;
  accessReason: string;
  requiredPlan: string;
  productCount: number;
}) {
  if (access.accessAllowed) return null;
  if (access.accessReason === "PLAN_LIMIT_EXCEEDED") {
    return `Your ${access.productCount.toLocaleString()} active and draft products exceed the current plan. Upgrade to ${access.requiredPlan} to resume automation.`;
  }
  if (access.accessReason === "CHECK_FAILED") {
    return "Inventex could not verify the Shopify subscription. Automation is paused until billing can be checked again.";
  }
  return `Choose ${access.requiredPlan} or a higher plan before enabling automation.`;
}

function planCapacity(plan: BillingPlanDefinition) {
  return plan.maxProducts ?? Number.MAX_SAFE_INTEGER;
}

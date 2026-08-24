import type {
  ActionFunctionArgs,
  HeadersFunction,
  LoaderFunctionArgs,
} from "react-router";
import {
  Form,
  useActionData,
  useLoaderData,
  useNavigation,
  useRouteError,
} from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import { getBillingAccess } from "../services/billing.server";
import {
  BILLING_PLANS,
  BILLING_TRIAL_DAYS,
  billingPlanCoversProducts,
  isBillingPlanName,
} from "../services/billing";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const access = await getBillingAccess({ admin, session, force: true });
  return { access, plans: BILLING_PLANS, trialDays: BILLING_TRIAL_DAYS };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin, billing, session } = await authenticate.admin(request);
  const formData = await request.formData();
  const plan = String(formData.get("plan") ?? "");
  if (!isBillingPlanName(plan)) {
    return { success: false as const, error: "Choose a valid plan." };
  }

  const access = await getBillingAccess({ admin, session, force: true });
  if (access.developmentStore) {
    return {
      success: false as const,
      error: "This development or trial store already has free access.",
    };
  }
  if (!billingPlanCoversProducts(plan, access.productCount)) {
    return {
      success: false as const,
      error: `${plan} does not cover ${access.productCount.toLocaleString()} active and draft products.`,
    };
  }

  return billing.request({
    plan,
    isTest: false,
    returnUrl: new URL("/app/billing", request.url).toString(),
  });
};

export default function Billing() {
  const { access, plans, trialDays } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const selectedPlan = navigation.formData?.get("plan");

  return (
    <s-page heading="Plans" inlineSize="large">
      <s-link slot="breadcrumb-actions" href="/app">
        Dashboard
      </s-link>

      <s-stack direction="block" gap="large">
        <s-paragraph>
          Choose a plan based on your active and draft product count.
        </s-paragraph>

        {access.developmentStore ? (
          <s-banner tone="success">
            Free access is active for this {access.shopPlan ?? "development"}{" "}
            store.
          </s-banner>
        ) : access.accessAllowed ? (
          <s-banner tone="success">
            {access.subscribedPlan} is active. Inventex automation is running.
          </s-banner>
        ) : (
          <s-banner tone="warning">
            {access.accessReason === "PLAN_LIMIT_EXCEEDED"
              ? `Your current plan does not cover ${access.productCount.toLocaleString()} active and draft products.`
              : "A paid subscription is required before automation can run."}
          </s-banner>
        )}

        {actionData?.error && (
          <s-banner tone="critical">{actionData.error}</s-banner>
        )}

        <s-section heading="Available plans">
          <s-stack direction="block" gap="base">
            <s-paragraph>
              Your store has {access.productCount.toLocaleString()} active and
              draft products. Paid plans include a {trialDays}-day free trial.
            </s-paragraph>
            <s-grid
              gridTemplateColumns="repeat(auto-fit, minmax(210px, 1fr))"
              gap="base"
            >
              {plans.map((plan) => {
                const eligible = billingPlanCoversProducts(
                  plan.name,
                  access.productCount,
                );
                const current = access.subscribedPlan === plan.name;
                const loading =
                  navigation.state !== "idle" && selectedPlan === plan.name;
                return (
                  <s-box
                    key={plan.name}
                    padding="base"
                    borderWidth="base"
                    borderRadius="base"
                    minBlockSize="230px"
                  >
                    <s-stack direction="block" gap="base">
                      <s-stack
                        direction="inline"
                        gap="small"
                        alignItems="center"
                      >
                        <s-heading>
                          {plan.name.replace("Inventex ", "")}
                        </s-heading>
                        {current && <s-badge tone="success">Current</s-badge>}
                      </s-stack>
                      <s-heading>${plan.amount}/month</s-heading>
                      <s-text color="subdued">
                        {plan.maxProducts === null
                          ? "Unlimited products"
                          : `Up to ${plan.maxProducts.toLocaleString()} products`}
                      </s-text>
                      <Form method="post">
                        <input type="hidden" name="plan" value={plan.name} />
                        <s-button
                          type="submit"
                          variant={
                            eligible && !current ? "primary" : "secondary"
                          }
                          disabled={
                            !eligible || current || access.developmentStore
                          }
                          {...(loading ? { loading: true } : {})}
                        >
                          {current
                            ? "Current plan"
                            : eligible
                              ? "Choose plan"
                              : "Product limit exceeded"}
                        </s-button>
                      </Form>
                    </s-stack>
                  </s-box>
                );
              })}
            </s-grid>
          </s-stack>
        </s-section>
      </s-stack>
    </s-page>
  );
}

export function ErrorBoundary() {
  return boundary.error(useRouteError());
}

export const headers: HeadersFunction = (headersArgs) =>
  boundary.headers(headersArgs);

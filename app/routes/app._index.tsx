import type {
  ActionFunctionArgs,
  HeadersFunction,
  LoaderFunctionArgs,
} from "react-router";
import { Form, redirect, useFetcher, useLoaderData } from "react-router";
import { useEffect } from "react";
import { authenticate } from "../shopify.server";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { useAppBridge } from "@shopify/app-bridge-react";
import db from "../db.server";
import { enqueueHideCatalogScan, JOB_TYPES } from "../services/webhooks.server";
import { getBillingAccess } from "../services/billing.server";
import { billingAccessMessage } from "../services/billing";

const RUNNING_STATUSES = ["PENDING", "PROCESSING"] as const;

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const shop = session.shop;
  const [settings, alertSettings, billing] = await Promise.all([
    db.shopSettings.findUnique({ where: { shop } }),
    db.alertSettings.findUnique({ where: { shop } }),
    getBillingAccess({ admin, session, force: true }),
  ]);

  const [
    sortingCount,
    hiddenCount,
    hiddenVariantCount,
    errorCount,
    queuedAlertCount,
    sortingJobCount,
    hidingJobCount,
    deadLetterCount,
  ] = await Promise.all([
    db.collectionAutoSorting.count({ where: { shop, enabled: true } }),
    db.inventoryState.count({
      where: { shop, action: "HIDDEN", restored: false },
    }),
    db.variantInventoryState.count({ where: { shop, restored: false } }),
    db.inventoryState.count({ where: { shop, error: true } }),
    db.alertQueue.count({ where: { shop, processed: false } }),
    db.job.count({
      where: {
        shop,
        status: { in: [...RUNNING_STATUSES] },
        type: {
          in: [
            JOB_TYPES.ENABLE_COLLECTION_SORT,
            JOB_TYPES.DISABLE_COLLECTION_SORT,
            JOB_TYPES.UPDATE_COLLECTION_BASE_ORDER,
            JOB_TYPES.SORT_COLLECTION,
          ],
        },
      },
    }),
    db.job.count({
      where: {
        shop,
        status: { in: [...RUNNING_STATUSES] },
        type: {
          in: [
            JOB_TYPES.CATALOG_HIDE_SCAN,
            JOB_TYPES.HIDE_PRODUCT,
            JOB_TYPES.UNHIDE_PRODUCT,
            JOB_TYPES.REPUBLISH_HIDDEN_PRODUCTS,
            JOB_TYPES.VARIANT_HIDE_SCAN,
            JOB_TYPES.HIDE_VARIANT,
            JOB_TYPES.UNHIDE_VARIANT,
            JOB_TYPES.REPUBLISH_HIDDEN_VARIANTS,
          ],
        },
      },
    }),
    db.deadLetterJob.count({ where: { shop } }),
  ]);

  return {
    billing,
    onboardingCompleted: settings?.onboardingCompleted ?? false,
    onboardingChoice: settings?.onboardingChoice ?? null,
    sorting: { activeCount: sortingCount, runningJobs: sortingJobCount },
    hiding: {
      enabled: settings?.hideEnabled ?? false,
      hiddenCount,
      hiddenVariantCount,
      runningJobs: hidingJobCount,
    },
    alerts: {
      enabled: alertSettings?.lowStockEnabled ?? false,
      queuedCount: queuedAlertCount,
    },
    errorCount,
    deadLetterCount,
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const shop = session.shop;
  const formData = await request.formData();
  const action = String(formData.get("_action") ?? "scanNow");

  if (action === "chooseOnboarding") {
    const choice = formData.get("choice") === "SORT" ? "SORT" : "HIDE";
    await db.shopSettings.upsert({
      where: { shop },
      update: { onboardingChoice: choice, onboardingCompleted: true },
      create: { shop, onboardingChoice: choice, onboardingCompleted: true },
    });
    return redirect(choice === "SORT" ? "/app/sort-collection" : "/app/hide");
  }

  const billing = await getBillingAccess({ admin, session, force: true });
  if (!billing.accessAllowed) {
    return {
      scan: false,
      error: billingAccessMessage(billing) ?? "Automation requires a plan.",
    };
  }
  const settings = await db.shopSettings.findUnique({ where: { shop } });
  if (!settings?.hideEnabled) {
    return { scan: false, error: "Enable hiding before scanning." };
  }
  if (settings.hideJobId) {
    const activeJob = await db.job.findFirst({
      where: { id: settings.hideJobId, shop },
      select: { status: true },
    });
    if (activeJob?.status === "PENDING" || activeJob?.status === "PROCESSING") {
      return { scan: false, error: "A catalog hide job is already running." };
    }
  }
  const result = await enqueueHideCatalogScan(shop);
  await db.shopSettings.update({
    where: { shop },
    data: { hideJobId: result.job.id },
  });
  return { scan: true, queued: true };
};

export default function Dashboard() {
  const data = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const shopify = useAppBridge();
  const isScanning = fetcher.state !== "idle";

  useEffect(() => {
    if (fetcher.data && "scan" in fetcher.data && fetcher.data.scan) {
      shopify.toast.show("Catalog scan queued.");
    } else if (fetcher.data && "error" in fetcher.data) {
      shopify.toast.show(fetcher.data.error ?? "Catalog scan failed.", {
        isError: true,
      });
    }
  }, [fetcher.data, shopify]);

  const paused = !data.billing.accessAllowed;

  return (
    <s-page heading="Dashboard">
      <s-button
        slot="primary-action"
        variant="primary"
        onClick={() =>
          fetcher.submit({ _action: "scanNow" }, { method: "POST" })
        }
        {...(isScanning ? { loading: true } : {})}
        disabled={!data.hiding.enabled || paused}
      >
        Scan Now
      </s-button>

      {!data.onboardingCompleted && (
        <s-section heading="Set up Inventex">
          <s-paragraph>
            Choose the first automation you want to configure. Sorting and
            hiding remain independent, so you can enable both later.
          </s-paragraph>
          <s-stack direction="inline" gap="base">
            <s-box padding="base" borderWidth="base" borderRadius="base">
              <s-stack direction="block" gap="base">
                <s-heading>Sort sold-out products last</s-heading>
                <s-text color="subdued">
                  Choose collections and preserve their in-stock order.
                </s-text>
                <Form method="post">
                  <input
                    type="hidden"
                    name="_action"
                    value="chooseOnboarding"
                  />
                  <input type="hidden" name="choice" value="SORT" />
                  <s-button type="submit" variant="primary">
                    Set up sorting
                  </s-button>
                </Form>
              </s-stack>
            </s-box>
            <s-box padding="base" borderWidth="base" borderRadius="base">
              <s-stack direction="block" gap="base">
                <s-heading>Hide sold-out products</s-heading>
                <s-text color="subdued">
                  Unpublish sold-out products from Online Store only.
                </s-text>
                <Form method="post">
                  <input
                    type="hidden"
                    name="_action"
                    value="chooseOnboarding"
                  />
                  <input type="hidden" name="choice" value="HIDE" />
                  <s-button type="submit" variant="primary">
                    Set up hiding
                  </s-button>
                </Form>
              </s-stack>
            </s-box>
          </s-stack>
        </s-section>
      )}

      <s-section heading="Automation">
        <s-stack direction="inline" gap="base">
          <FeatureCard
            title="Sorting"
            status={
              paused && data.sorting.activeCount > 0
                ? "Paused"
                : data.sorting.runningJobs > 0
                  ? "Working"
                  : data.sorting.activeCount > 0
                    ? "On"
                    : "Off"
            }
            detail={`${data.sorting.activeCount} collection${data.sorting.activeCount === 1 ? "" : "s"} active`}
            href="/app/sort-collection"
          />
          <FeatureCard
            title="Hiding"
            status={
              paused && data.hiding.enabled
                ? "Paused"
                : data.hiding.runningJobs > 0
                  ? "Working"
                  : data.hiding.enabled
                    ? "On"
                    : "Off"
            }
            detail={`${data.hiding.hiddenCount} products and ${data.hiding.hiddenVariantCount} variants hidden`}
            href="/app/hide"
          />
          <FeatureCard
            title="Alerts"
            status={
              paused && data.alerts.enabled
                ? "Paused"
                : data.alerts.enabled
                  ? "On"
                  : "Off"
            }
            detail={`${data.alerts.queuedCount} digest alert${data.alerts.queuedCount === 1 ? "" : "s"} queued`}
            href="/app/alerts"
          />
        </s-stack>
      </s-section>

      <s-section slot="aside" heading="Plan">
        <s-stack direction="block" gap="small">
          <s-text type="strong">
            {data.billing.developmentStore
              ? "Free development access"
              : (data.billing.subscribedPlan ?? "No active plan")}
          </s-text>
          <s-text color="subdued">
            {data.billing.productCount.toLocaleString()} active and draft
            products
          </s-text>
          <s-link href="/app/billing">View plans</s-link>
        </s-stack>
      </s-section>

      {(data.errorCount > 0 || data.deadLetterCount > 0) && (
        <s-section slot="aside" heading="Needs attention">
          <s-stack direction="block" gap="small">
            <s-text tone="critical">
              {data.errorCount} automation error
              {data.errorCount === 1 ? "" : "s"}
            </s-text>
            <s-text tone="critical">
              {data.deadLetterCount} dead-letter job
              {data.deadLetterCount === 1 ? "" : "s"}
            </s-text>
          </s-stack>
          <s-link href="/app/logs">View activity logs</s-link>
        </s-section>
      )}
    </s-page>
  );
}

function FeatureCard(props: {
  title: string;
  status: string;
  detail: string;
  href: string;
}) {
  return (
    <s-box padding="base" borderWidth="base" borderRadius="base">
      <s-stack direction="block" gap="small">
        <s-heading>{props.title}</s-heading>
        <s-text type="strong">{props.status}</s-text>
        <s-text color="subdued">{props.detail}</s-text>
        <s-link href={props.href}>Manage</s-link>
      </s-stack>
    </s-box>
  );
}

export const headers: HeadersFunction = (headersArgs) =>
  boundary.headers(headersArgs);

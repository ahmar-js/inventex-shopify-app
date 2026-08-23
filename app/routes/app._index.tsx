import type {
  ActionFunctionArgs,
  HeadersFunction,
  LoaderFunctionArgs,
} from "react-router";
import { useLoaderData, useFetcher } from "react-router";
import { useEffect } from "react";
import { authenticate } from "../shopify.server";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { useAppBridge } from "@shopify/app-bridge-react";
import db from "../db.server";
import { scanExistingProducts } from "../services/inventory.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;

  const settings = await db.shopSettings.findUnique({ where: { shop } });

  const [hiddenCount, pushedDownCount, restoredCount, totalTracked, errorCount] =
    await Promise.all([
      db.inventoryState.count({
        where: { shop, action: "HIDDEN", restored: false },
      }),
      db.inventoryState.count({
        where: { shop, action: "PUSHED_DOWN", restored: false },
      }),
      db.inventoryState.count({
        where: { shop, restored: true },
      }),
      db.inventoryState.count({
        where: { shop },
      }),
      db.inventoryState.count({
        where: { shop, error: true },
      }),
    ]);

  return {
    enabled: settings?.enabled ?? false,
    strategy: settings?.strategy ?? "HIDE",
    restoreBehavior: settings?.restoreBehavior ?? "ALWAYS",
    hiddenCount,
    pushedDownCount,
    restoredCount,
    totalTracked,
    errorCount,
  };
};

// ─── Action: handle Scan Now ─────────────────────────────────

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session, admin } = await authenticate.admin(request);
  const shop = session.shop;

  const result = await scanExistingProducts(admin, shop);

  return {
    scan: true,
    processed: result.processed,
    affected: result.affected,
  };
};

export default function Dashboard() {
  const {
    enabled,
    strategy,
    restoreBehavior,
    hiddenCount,
    pushedDownCount,
    restoredCount,
    totalTracked,
    errorCount,
  } = useLoaderData<typeof loader>();

  const fetcher = useFetcher<typeof action>();
  const shopify = useAppBridge();
  const isScanning =
    fetcher.state === "submitting" || fetcher.state === "loading";

  useEffect(() => {
    if (fetcher.data?.scan) {
      shopify.toast.show(
        `Scan complete: ${fetcher.data.processed} products checked, ${fetcher.data.affected} updated`,
      );
    }
  }, [fetcher.data, shopify]);

  const strategyLabel = strategy === "HIDE" ? "Hide product" : "Push to bottom";
  const restoreLabel =
    restoreBehavior === "ALWAYS"
      ? "Always restore"
      : restoreBehavior === "CONDITIONAL"
        ? "Only if app modified"
        : "Do nothing";

  return (
    <s-page heading="Dashboard">
      <s-button
        slot="primary-action"
        variant="primary"
        onClick={() => fetcher.submit({}, { method: "POST" })}
        {...(isScanning ? { loading: true } : {})}
        {...(!enabled ? { disabled: true } : {})}
      >
        Scan Now
      </s-button>
      {/* ── Automation Status Banner ─────────────── */}
      <s-section heading="Automation Status">
        <s-box padding="base" borderWidth="base" borderRadius="base">
          <s-stack direction="block" gap="base">
            <s-stack direction="inline" gap="base">
              <s-text type="strong">Status:</s-text>
              <s-text>{enabled ? "Enabled" : "Disabled"}</s-text>
            </s-stack>
            <s-stack direction="inline" gap="base">
              <s-text type="strong">Strategy:</s-text>
              <s-text>{strategyLabel}</s-text>
            </s-stack>
            <s-stack direction="inline" gap="base">
              <s-text type="strong">Restore:</s-text>
              <s-text>{restoreLabel}</s-text>
            </s-stack>
            {!enabled && (
              <s-paragraph>
                Automation is disabled.{" "}
                <s-link href="/app/settings">Enable it in Settings</s-link> to
                start managing inventory visibility.
              </s-paragraph>
            )}
          </s-stack>
        </s-box>
      </s-section>

      {/* ── Quick Stats ──────────────────────────── */}
      <s-section heading="Quick Stats">
        <s-stack direction="inline" gap="base">
          <s-box padding="base" borderWidth="base" borderRadius="base">
            <s-stack direction="block" gap="small">
              <s-text color="subdued">Hidden Products</s-text>
              <s-heading>{hiddenCount}</s-heading>
            </s-stack>
          </s-box>
          <s-box padding="base" borderWidth="base" borderRadius="base">
            <s-stack direction="block" gap="small">
              <s-text color="subdued">Repositioned</s-text>
              <s-heading>{pushedDownCount}</s-heading>
            </s-stack>
          </s-box>
          <s-box padding="base" borderWidth="base" borderRadius="base">
            <s-stack direction="block" gap="small">
              <s-text color="subdued">Restored</s-text>
              <s-heading>{restoredCount}</s-heading>
            </s-stack>
          </s-box>
          <s-box padding="base" borderWidth="base" borderRadius="base">
            <s-stack direction="block" gap="small">
              <s-text color="subdued">Total Tracked</s-text>
              <s-heading>{totalTracked}</s-heading>
            </s-stack>
          </s-box>
          <s-box padding="base" borderWidth="base" borderRadius="base">
            <s-stack direction="block" gap="small">
              <s-text color="subdued">Errors</s-text>
              <s-heading>
                <s-text tone={errorCount > 0 ? "critical" : "auto"}>
                  {errorCount}
                </s-text>
              </s-heading>
              {errorCount > 0 && (
                <s-link href="/app/logs">View in Logs</s-link>
              )}
            </s-stack>
          </s-box>
        </s-stack>
      </s-section>

      {/* ── Sidebar ──────────────────────────────── */}
      <s-section slot="aside" heading="Quick Links">
        <s-unordered-list>
          <s-list-item>
            <s-link href="/app/settings">Settings</s-link>
          </s-list-item>
          <s-list-item>
            <s-link href="/app/logs">Activity Logs</s-link>
          </s-list-item>
        </s-unordered-list>
      </s-section>

      <s-section slot="aside" heading="How It Works">
        <s-paragraph>
          When a product's inventory reaches zero, the app automatically applies
          your chosen strategy. When inventory is replenished, the app restores
          the product based on your restore settings.
        </s-paragraph>
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};

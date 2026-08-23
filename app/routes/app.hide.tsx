import type {
  ActionFunctionArgs,
  HeadersFunction,
  LoaderFunctionArgs,
} from "react-router";
import { useEffect, useState } from "react";
import {
  useFetcher,
  useLoaderData,
  useRevalidator,
  useRouteError,
} from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { boundary } from "@shopify/shopify-app-react-router/server";
import db from "../db.server";
import { authenticate } from "../shopify.server";
import { handleHideAction } from "../services/hide-actions.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;
  const settings = await db.shopSettings.findUnique({ where: { shop } });
  const [lockJob, hiddenProducts, hiddenCount, excludedProducts] =
    await Promise.all([
      settings?.hideJobId
        ? db.job.findFirst({
            where: { id: settings.hideJobId, shop },
            select: { id: true, status: true, type: true },
          })
        : null,
      db.inventoryState.findMany({
        where: { shop, action: "HIDDEN", restored: false },
        orderBy: { modifiedAt: "desc" },
        take: 100,
        select: {
          productId: true,
          productTitle: true,
          productHandle: true,
          redirectId: true,
          modifiedAt: true,
          error: true,
          errorMessage: true,
        },
      }),
      db.inventoryState.count({
        where: { shop, action: "HIDDEN", restored: false },
      }),
      db.excludedProduct.findMany({
        where: { shop },
        orderBy: { createdAt: "asc" },
        select: { productId: true, productTitle: true },
      }),
    ]);

  return {
    hideEnabled: settings?.hideEnabled ?? false,
    hideDelayDays: settings?.hideDelayDays ?? 0,
    locked: lockJob?.status === "PENDING" || lockJob?.status === "PROCESSING",
    lockJobType: lockJob?.type ?? null,
    hiddenCount,
    hiddenProducts: hiddenProducts.map((product) => ({
      ...product,
      modifiedAt: product.modifiedAt.toISOString(),
    })),
    excludedProducts,
  };
};

export const action = ({ request }: ActionFunctionArgs) =>
  handleHideAction(request);

type HideActionData = Awaited<ReturnType<typeof handleHideAction>>;

export default function HideProducts() {
  const data = useLoaderData<typeof loader>();
  const settingsFetcher = useFetcher<HideActionData>();
  const ignoreFetcher = useFetcher<HideActionData>();
  const shopify = useAppBridge();
  const revalidator = useRevalidator();
  const [enabled, setEnabled] = useState(data.hideEnabled);

  useEffect(() => {
    if (!data.locked) return;
    const timer = window.setInterval(() => revalidator.revalidate(), 5_000);
    return () => window.clearInterval(timer);
  }, [data.locked, revalidator]);

  useEffect(() => {
    const result = settingsFetcher.data;
    if (!result) return;
    if (result.success) {
      shopify.toast.show(
        result.operation === "scan"
          ? "Hiding enabled; catalog scan queued."
          : result.operation === "republish"
            ? "Hiding disabled; restore job queued."
            : "Hide settings saved.",
      );
    } else {
      shopify.toast.show(
        "error" in result ? result.error : "Failed to save hide settings.",
        { isError: true },
      );
    }
  }, [settingsFetcher.data, shopify]);

  useEffect(() => {
    const result = ignoreFetcher.data;
    if (!result) return;
    shopify.toast.show(
      result.success
        ? "Ignore list updated."
        : "error" in result
          ? result.error
          : "Failed to update ignore list.",
      result.success ? undefined : { isError: true },
    );
  }, [ignoreFetcher.data, shopify]);

  const addIgnoredProducts = async () => {
    try {
      const selected = await shopify.resourcePicker({
        type: "product",
        action: "select",
        multiple: true,
      });
      if (!selected?.length) return;
      ignoreFetcher.submit(
        {
          _action: "addExcludedProducts",
          products: JSON.stringify(
            selected.map((product: { id: string; title: string }) => ({
              id: product.id,
              title: product.title,
            })),
          ),
        },
        { method: "POST" },
      );
    } catch {
      // Resource picker was closed.
    }
  };

  const settingsBusy = data.locked || settingsFetcher.state !== "idle";

  return (
    <s-page heading="Hide out-of-stock products">
      <s-link slot="breadcrumb-actions" href="/app">
        Dashboard
      </s-link>

      {data.locked && (
        <s-banner tone="info">
          Hide settings are locked while the catalog job is running. They will
          unlock automatically when the job finishes.
        </s-banner>
      )}

      <settingsFetcher.Form method="post">
        <input type="hidden" name="_action" value="saveHideSettings" />
        <input type="hidden" name="hideEnabled" value={String(enabled)} />
        <s-section heading="Online Store hiding">
          <s-stack direction="block" gap="base">
            <label style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <input
                type="checkbox"
                checked={enabled}
                disabled={settingsBusy}
                onChange={(event) => setEnabled(event.target.checked)}
              />
              <span style={{ fontWeight: 600 }}>
                Hide sold-out products from Online Store
              </span>
            </label>
            <label style={{ display: "grid", gap: 6, maxWidth: 280 }}>
              <span>Delay before hiding (days)</span>
              <input
                name="hideDelayDays"
                type="number"
                min="0"
                max="365"
                step="1"
                defaultValue={data.hideDelayDays}
                disabled={settingsBusy}
              />
            </label>
            <s-text color="subdued">
              Restocked products cancel pending hides and are restored
              automatically.
            </s-text>
          </s-stack>
        </s-section>

        <s-button
          slot="primary-action"
          type="submit"
          variant="primary"
          disabled={settingsBusy}
          {...(settingsFetcher.state !== "idle" ? { loading: true } : {})}
        >
          Save hide settings
        </s-button>
      </settingsFetcher.Form>

      <s-section heading="Ignored products">
        <s-stack direction="block" gap="base">
          <s-text color="subdued">
            Products selected here, or tagged inventex-ignore, are never hidden.
          </s-text>
          <s-button
            onClick={addIgnoredProducts}
            {...(ignoreFetcher.state !== "idle" ? { loading: true } : {})}
          >
            Add products
          </s-button>
          {data.excludedProducts.length === 0 ? (
            <s-text color="subdued">No products are on the ignore list.</s-text>
          ) : (
            <s-stack direction="block" gap="small">
              {data.excludedProducts.map((product) => (
                <s-box
                  key={product.productId}
                  padding="small"
                  borderWidth="base"
                  borderRadius="base"
                >
                  <s-stack direction="inline" gap="base">
                    <s-text>{product.productTitle}</s-text>
                    <s-button
                      variant="tertiary"
                      tone="critical"
                      onClick={() =>
                        ignoreFetcher.submit(
                          {
                            _action: "removeExcludedProduct",
                            productId: product.productId,
                          },
                          { method: "POST" },
                        )
                      }
                    >
                      Remove
                    </s-button>
                  </s-stack>
                </s-box>
              ))}
            </s-stack>
          )}
        </s-stack>
      </s-section>

      <s-section heading={`App-hidden products (${data.hiddenCount})`}>
        {data.hiddenProducts.length === 0 ? (
          <s-text color="subdued">Inventex has not hidden any products.</s-text>
        ) : (
          <s-stack direction="block" gap="small">
            {data.hiddenProducts.map((product) => (
              <s-box
                key={product.productId}
                padding="small"
                borderWidth="base"
                borderRadius="base"
              >
                <s-stack direction="block" gap="small">
                  <s-text type="strong">
                    {product.productTitle || product.productId}
                  </s-text>
                  <s-text color="subdued">
                    Hidden {new Date(product.modifiedAt).toLocaleString()}
                    {product.redirectId ? " · Redirect active" : ""}
                  </s-text>
                  {product.error && (
                    <s-text tone="critical">
                      {product.errorMessage ?? "Hide operation failed"}
                    </s-text>
                  )}
                </s-stack>
              </s-box>
            ))}
          </s-stack>
        )}
      </s-section>

      <s-section slot="aside" heading="Uninstall behavior">
        <s-paragraph>
          Uninstalling Inventex does not republish products. The inventex-hidden
          tag and redirects remain so the merchant keeps control.
        </s-paragraph>
        <s-paragraph>
          Configure hidden-product redirects in{" "}
          <s-link href="/app/settings">Settings</s-link>.
        </s-paragraph>
      </s-section>
    </s-page>
  );
}

export function ErrorBoundary() {
  return boundary.error(useRouteError());
}

export const headers: HeadersFunction = (headersArgs) =>
  boundary.headers(headersArgs);

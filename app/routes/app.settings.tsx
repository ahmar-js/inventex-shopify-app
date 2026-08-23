import type {
  ActionFunctionArgs,
  HeadersFunction,
  LoaderFunctionArgs,
} from "react-router";
import { useEffect, useState } from "react";
import {
  Form,
  useActionData,
  useLoaderData,
  useNavigation,
  useRouteError,
} from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { boundary } from "@shopify/shopify-app-react-router/server";
import db from "../db.server";
import { authenticate } from "../shopify.server";
import { normalizeRedirectMode, normalizeRedirectPath } from "../services/hide";
import {
  cancelAllPendingVariantHides,
  enqueueRepublishHiddenVariants,
  enqueueVariantHideScan,
} from "../services/webhooks.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const settings = await db.shopSettings.findUnique({
    where: { shop: session.shop },
  });
  const lockJob = settings?.hideJobId
    ? await db.job.findFirst({
        where: { id: settings.hideJobId, shop: session.shop },
        select: { status: true },
      })
    : null;
  const variantLockJob = settings?.variantHideJobId
    ? await db.job.findFirst({
        where: { id: settings.variantHideJobId, shop: session.shop },
        select: { status: true },
      })
    : null;
  const hiddenVariantCount = await db.variantInventoryState.count({
    where: { shop: session.shop, restored: false },
  });
  return {
    autoSortNewCollections: settings?.autoSortNewCollections ?? true,
    sortContinueSellingAsOos: settings?.sortContinueSellingAsOos ?? false,
    redirectMode: settings?.redirectMode ?? "none",
    redirectPath: settings?.redirectPath ?? "/",
    hideSettingsLocked:
      lockJob?.status === "PENDING" || lockJob?.status === "PROCESSING",
    variantHideEnabled: settings?.variantHideEnabled ?? false,
    variantHideEligible: settings?.variantHideEligible ?? false,
    variantHideCatalogCount: settings?.variantHideCatalogCount ?? null,
    variantHideSettingsLocked:
      variantLockJob?.status === "PENDING" ||
      variantLockJob?.status === "PROCESSING",
    hiddenVariantCount,
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;
  const formData = await request.formData();
  const redirectMode = normalizeRedirectMode(
    String(formData.get("redirectMode") ?? "none"),
  );
  let redirectPath = String(formData.get("redirectPath") ?? "/");
  try {
    if (redirectMode === "custom") {
      redirectPath = normalizeRedirectPath(redirectPath);
    }
  } catch (error) {
    return {
      success: false as const,
      error: error instanceof Error ? error.message : String(error),
    };
  }

  const current = await db.shopSettings.findUnique({ where: { shop } });
  if (current?.hideJobId) {
    const lockJob = await db.job.findFirst({
      where: { id: current.hideJobId, shop },
      select: { status: true },
    });
    if (lockJob?.status === "PENDING" || lockJob?.status === "PROCESSING") {
      return {
        success: false as const,
        error: "Settings are locked while the catalog hide job runs.",
      };
    }
  }
  if (current?.variantHideJobId) {
    const lockJob = await db.job.findFirst({
      where: { id: current.variantHideJobId, shop },
      select: { status: true },
    });
    if (lockJob?.status === "PENDING" || lockJob?.status === "PROCESSING") {
      return {
        success: false as const,
        error: "Settings are locked while the variant catalog job runs.",
      };
    }
  }

  const variantHideEnabled = formData.get("variantHideEnabled") === "true";
  const variantSettingChanged =
    variantHideEnabled !== (current?.variantHideEnabled ?? false);

  await db.shopSettings.upsert({
    where: { shop },
    create: {
      shop,
      autoSortNewCollections: formData.get("autoSortNewCollections") === "true",
      sortContinueSellingAsOos:
        formData.get("sortContinueSellingAsOos") === "true",
      redirectMode,
      redirectPath,
      variantHideEnabled,
      variantHideEligible: false,
    },
    update: {
      autoSortNewCollections: formData.get("autoSortNewCollections") === "true",
      sortContinueSellingAsOos:
        formData.get("sortContinueSellingAsOos") === "true",
      redirectMode,
      redirectPath,
      variantHideEnabled,
      ...(variantHideEnabled ? {} : { variantHideEligible: false }),
    },
  });
  if (variantSettingChanged) {
    if (variantHideEnabled) {
      const result = await enqueueVariantHideScan(shop);
      await db.shopSettings.update({
        where: { shop },
        data: {
          variantHideEligible: false,
          variantHideCatalogCount: null,
          variantHideJobId: result.job.id,
        },
      });
    } else {
      await cancelAllPendingVariantHides(shop);
      const result = await enqueueRepublishHiddenVariants(shop);
      await db.shopSettings.update({
        where: { shop },
        data: { variantHideEligible: false, variantHideJobId: result.job.id },
      });
    }
  }
  return { success: true as const };
};

export default function Settings() {
  const data = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const shopify = useAppBridge();
  const [autoSortNew, setAutoSortNew] = useState(data.autoSortNewCollections);
  const [separateContinue, setSeparateContinue] = useState(
    data.sortContinueSellingAsOos,
  );
  const [redirectMode, setRedirectMode] = useState(data.redirectMode);
  const [variantHideEnabled, setVariantHideEnabled] = useState(
    data.variantHideEnabled,
  );
  const busy =
    navigation.state !== "idle" ||
    data.hideSettingsLocked ||
    data.variantHideSettingsLocked;

  useEffect(() => {
    if (!actionData) return;
    shopify.toast.show(
      actionData.success ? "Settings saved." : actionData.error,
      actionData.success ? undefined : { isError: true },
    );
  }, [actionData, shopify]);

  return (
    <Form method="post">
      <s-page heading="Settings">
        <s-link slot="breadcrumb-actions" href="/app">
          Dashboard
        </s-link>
        <s-button
          slot="primary-action"
          type="submit"
          variant="primary"
          disabled={busy}
          {...(navigation.state !== "idle" ? { loading: true } : {})}
        >
          Save
        </s-button>

        {data.hideSettingsLocked && (
          <s-banner tone="info">
            Redirect settings are locked until the current catalog hide job
            finishes.
          </s-banner>
        )}
        {data.variantHideSettingsLocked && (
          <s-banner tone="info">
            Variant hide settings are locked while the catalog job finishes.
          </s-banner>
        )}
        {data.variantHideEnabled &&
          data.variantHideCatalogCount !== null &&
          !data.variantHideEligible && (
            <s-banner tone="warning">
              Variant hiding is paused because the Online Store has more than
              500 published products.
            </s-banner>
          )}

        <s-section heading="Collection sorting">
          <s-stack direction="block" gap="base">
            <input
              type="hidden"
              name="autoSortNewCollections"
              value={String(autoSortNew)}
            />
            <label
              style={{ display: "flex", alignItems: "flex-start", gap: 8 }}
            >
              <input
                type="checkbox"
                checked={autoSortNew}
                disabled={busy}
                onChange={(event) => setAutoSortNew(event.target.checked)}
              />
              <span>
                <strong>Auto-sort new collections</strong>
                <br />
                Automatically enable Inventex sorting for newly created
                collections.
              </span>
            </label>

            <input
              type="hidden"
              name="sortContinueSellingAsOos"
              value={String(separateContinue)}
            />
            <label
              style={{ display: "flex", alignItems: "flex-start", gap: 8 }}
            >
              <input
                type="checkbox"
                checked={separateContinue}
                disabled={busy}
                onChange={(event) => setSeparateContinue(event.target.checked)}
              />
              <span>
                <strong>Separate continue-selling products</strong>
                <br />
                Sort them after in-stock products and before sold-out products.
              </span>
            </label>
          </s-stack>
        </s-section>

        <s-section heading="Hidden product redirects">
          <s-stack direction="block" gap="base">
            <label style={{ display: "grid", gap: 6, maxWidth: 380 }}>
              <span>Redirect behavior</span>
              <select
                name="redirectMode"
                value={redirectMode}
                disabled={busy}
                onChange={(event) => setRedirectMode(event.target.value)}
              >
                <option value="none">None</option>
                <option value="home">Home page</option>
                <option value="custom">Custom same-store path</option>
              </select>
            </label>
            {redirectMode === "custom" ? (
              <label style={{ display: "grid", gap: 6, maxWidth: 380 }}>
                <span>Custom path</span>
                <input
                  name="redirectPath"
                  defaultValue={data.redirectPath}
                  placeholder="/collections/all"
                  disabled={busy}
                />
              </label>
            ) : (
              <input
                type="hidden"
                name="redirectPath"
                value={data.redirectPath}
              />
            )}
            <s-text color="subdued">
              Redirects are created only for products hidden by Inventex and
              deleted when those products are restored.
            </s-text>
          </s-stack>
        </s-section>

        <s-section heading="Variant hiding (beta)">
          <s-stack direction="block" gap="base">
            <input
              type="hidden"
              name="variantHideEnabled"
              value={String(variantHideEnabled)}
            />
            <label style={{ display: "flex", alignItems: "flex-start", gap: 8 }}>
              <input
                type="checkbox"
                checked={variantHideEnabled}
                disabled={busy}
                onChange={(event) =>
                  setVariantHideEnabled(event.target.checked)
                }
              />
              <span>
                <strong>Hide sold-out variants</strong>
                <br />
                Unpublish only sold-out variants from the Online Store and
                republish them on restock. Products with an available variant
                stay published.
              </span>
            </label>
            <s-text color="subdued">
              Available for catalogs with up to 500 published products.
              Currently hidden by Inventex: {data.hiddenVariantCount} variants.
            </s-text>
          </s-stack>
        </s-section>
      </s-page>
    </Form>
  );
}

export function ErrorBoundary() {
  return boundary.error(useRouteError());
}

export const headers: HeadersFunction = (headersArgs) =>
  boundary.headers(headersArgs);

import type {
  ActionFunctionArgs,
  HeadersFunction,
  LoaderFunctionArgs,
} from "react-router";
import { useLoaderData, useNavigation, useFetcher, useActionData, Form } from "react-router";
import { authenticate } from "../shopify.server";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { useAppBridge } from "@shopify/app-bridge-react";
import { useEffect, useRef } from "react";
import db from "../db.server";

// ─── Loader: fetch current settings ─────────────────────────

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;

  const settings = await db.shopSettings.findUnique({ where: { shop } });

  const collectionRules = await db.collectionRule.findMany({
    where: { shop },
    orderBy: { createdAt: "asc" },
  });

  const excludedProducts = await db.excludedProduct.findMany({
    where: { shop },
    orderBy: { createdAt: "asc" },
  });

  return {
    strategy: settings?.strategy ?? "HIDE",
    restoreBehavior: settings?.restoreBehavior ?? "ALWAYS",
    enabled: settings?.enabled ?? false,
    collectionRules: collectionRules.map((r: any) => ({
      collectionId: r.collectionId,
      collectionTitle: r.collectionTitle,
    })),
    excludedProducts: excludedProducts.map((p: any) => ({
      productId: p.productId,
      productTitle: p.productTitle,
    })),
  };
};

// ─── Action: persist settings ────────────────────────────────

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;
  const formData = await request.formData();
  const _action = formData.get("_action") as string | null;

  // ── Add collections via resource picker ──
  if (_action === "addCollections") {
    const collectionsJson = formData.get("collections") as string;
    const collections: Array<{ id: string; title: string }> =
      JSON.parse(collectionsJson);

    for (const col of collections) {
      await db.collectionRule.upsert({
        where: { shop_collectionId: { shop, collectionId: col.id } },
        create: { shop, collectionId: col.id, collectionTitle: col.title },
        update: { collectionTitle: col.title },
      });
    }

    return {
      success: true,
      _action: "addCollections" as const,
      count: collections.length,
    };
  }

  // ── Remove a single collection rule ──
  if (_action === "removeCollection") {
    const collectionId = formData.get("collectionId") as string;
    await db.collectionRule.deleteMany({
      where: { shop, collectionId },
    });
    return { success: true, _action: "removeCollection" as const };
  }

  // ── Add excluded products via resource picker ──
  if (_action === "addExcludedProducts") {
    const productsJson = formData.get("products") as string;
    const products: Array<{ id: string; title: string }> =
      JSON.parse(productsJson);

    for (const prod of products) {
      await db.excludedProduct.upsert({
        where: { shop_productId: { shop, productId: prod.id } },
        create: { shop, productId: prod.id, productTitle: prod.title },
        update: { productTitle: prod.title },
      });
    }

    return {
      success: true,
      _action: "addExcludedProducts" as const,
      count: products.length,
    };
  }

  // ── Remove a single excluded product ──
  if (_action === "removeExcludedProduct") {
    const productId = formData.get("productId") as string;
    await db.excludedProduct.deleteMany({
      where: { shop, productId },
    });
    return { success: true, _action: "removeExcludedProduct" as const };
  }

  // ── Default: save settings ──
  const strategy = formData.get("strategy") as string;
  const restoreBehavior = formData.get("restoreBehavior") as string;
  const enabled = formData.get("enabled") === "true";

  // Check if automation is being enabled for the first time
  const current = await db.shopSettings.findUnique({ where: { shop } });
  const wasEnabled = current?.enabled ?? false;

  await db.shopSettings.upsert({
    where: { shop },
    create: { shop, strategy, restoreBehavior, enabled },
    update: { strategy, restoreBehavior, enabled },
  });

  // Auto-scan when toggling ON (first enable or re-enable)
  if (enabled && !wasEnabled) {
    return { success: true, triggerScan: true };
  }

  return { success: true };
};

// ─── Component ───────────────────────────────────────────────

export default function Settings() {
  const { strategy, restoreBehavior, enabled, collectionRules, excludedProducts } =
    useLoaderData<typeof loader>();
  const navigation = useNavigation();
  const collectionFetcher = useFetcher();
  const productFetcher = useFetcher();
  const scanFetcher = useFetcher();
  const shopify = useAppBridge();
  const isSaving = navigation.state === "submitting";

  // Show toast on successful save + trigger auto-scan if needed
  const lastNavState = useRef(navigation.state);
  const settingsActionData = useActionData<typeof action>();
  useEffect(() => {
    if (lastNavState.current === "submitting" && navigation.state === "idle") {
      shopify.toast.show("Settings saved");
    }
    lastNavState.current = navigation.state;
  }, [navigation.state, shopify]);

  // Auto-scan when save returns triggerScan flag
  const scanFired = useRef(false);
  useEffect(() => {
    const data = settingsActionData as any;
    if (data?.triggerScan && !scanFired.current) {
      scanFired.current = true;
      shopify.toast.show("Automation enabled — scanning existing products…");
      scanFetcher.submit({}, { method: "POST", action: "/app?index" });
    }
    if (!data?.triggerScan) {
      scanFired.current = false;
    }
  }, [settingsActionData, scanFetcher, shopify]);

  // Watch for triggerScan flag from form submission (via actionData)
  const actionData = navigation.formData
    ? undefined
    : (navigation as any)?.data;

  // Auto-scan: when the form returns triggerScan, fire the scan
  const scanTriggered = useRef(false);
  useEffect(() => {
    // We detect triggerScan via the page revalidation after save
    // Simpler approach: use scanFetcher to POST to dashboard endpoint
  }, []);

  // Show toast on collection add/remove
  useEffect(() => {
    const data = collectionFetcher.data as any;
    if (!data) return;
    if (data._action === "addCollections") {
      shopify.toast.show(`Added ${data.count} collection(s)`);
    } else if (data._action === "removeCollection") {
      shopify.toast.show("Collection removed");
    }
  }, [collectionFetcher.data, shopify]);

  // Show toast on product exclude add/remove
  useEffect(() => {
    const data = productFetcher.data as any;
    if (!data) return;
    if (data._action === "addExcludedProducts") {
      shopify.toast.show(`Excluded ${data.count} product(s)`);
    } else if (data._action === "removeExcludedProduct") {
      shopify.toast.show("Product removed from exclusions");
    }
  }, [productFetcher.data, shopify]);

  // Show toast when auto-scan completes
  useEffect(() => {
    const data = scanFetcher.data as any;
    if (data?.scan) {
      shopify.toast.show(
        `Auto-scan complete: ${data.processed} products checked, ${data.affected} updated`,
      );
    }
  }, [scanFetcher.data, shopify]);

  const handleAddCollections = async () => {
    try {
      const selected = await shopify.resourcePicker({
        type: "collection",
        action: "select",
        multiple: true,
      });

      if (!selected || selected.length === 0) return;

      collectionFetcher.submit(
        {
          _action: "addCollections",
          collections: JSON.stringify(
            selected.map((s: any) => ({ id: s.id, title: s.title })),
          ),
        },
        { method: "POST" },
      );
    } catch {
      // User cancelled the picker
    }
  };

  const handleRemoveCollection = (collectionId: string) => {
    collectionFetcher.submit(
      {
        _action: "removeCollection",
        collectionId,
      },
      { method: "POST" },
    );
  };

  const handleAddExcludedProducts = async () => {
    try {
      const selected = await shopify.resourcePicker({
        type: "product",
        action: "select",
        multiple: true,
      });

      if (!selected || selected.length === 0) return;

      productFetcher.submit(
        {
          _action: "addExcludedProducts",
          products: JSON.stringify(
            selected.map((s: any) => ({ id: s.id, title: s.title })),
          ),
        },
        { method: "POST" },
      );
    } catch {
      // User cancelled the picker
    }
  };

  const handleRemoveExcludedProduct = (productId: string) => {
    productFetcher.submit(
      {
        _action: "removeExcludedProduct",
        productId,
      },
      { method: "POST" },
    );
  };

  return (
    <Form method="post">
      <s-page heading="Settings">
        <s-link slot="breadcrumb-actions" href="/app">
          Dashboard
        </s-link>
        <s-button
          slot="primary-action"
          variant="primary"
          type="submit"
          {...(isSaving ? { loading: true } : {})}
        >
          Save
        </s-button>

        {/* ── Automation toggle ───────────────────────── */}
        <s-section heading="Automation">
          <s-paragraph>
            Enable or disable inventory automation for your store.
          </s-paragraph>
          <s-box padding="base" borderWidth="base" borderRadius="base">
            <label
              style={{ display: "flex", alignItems: "center", gap: "8px" }}
            >
              <input
                type="hidden"
                name="enabled"
                value={enabled ? "true" : "false"}
              />
              <input
                type="checkbox"
                defaultChecked={enabled}
                onChange={(e) => {
                  const hidden = e.target
                    .previousElementSibling as HTMLInputElement;
                  hidden.value = e.target.checked ? "true" : "false";
                }}
              />
              <s-text type="strong">
                Enable inventory automation
              </s-text>
            </label>
          </s-box>
        </s-section>

        {/* ── Collection Scope ────────────────────────── */}
        <s-section heading="Collection Scope">
          <s-paragraph>
            Choose which collections the automation applies to. If no
            collections are selected, automation applies to all products in
            your store.
          </s-paragraph>
          <s-box padding="base" borderWidth="base" borderRadius="base">
            <s-stack direction="block" gap="base">
              <s-button
                onClick={handleAddCollections}
                {...(collectionFetcher.state !== "idle"
                  ? { loading: true }
                  : {})}
              >
                Add collections
              </s-button>

              {collectionRules.length > 0 ? (
                <s-stack direction="block" gap="small">
                  {collectionRules.map((rule: any) => (
                    <s-box
                      key={rule.collectionId}
                      padding="small"
                      borderWidth="base"
                      borderRadius="base"
                    >
                      <s-stack direction="inline" gap="base">
                        <s-text type="strong">{rule.collectionTitle}</s-text>
                        <s-button
                          variant="tertiary"
                          tone="critical"
                          onClick={() =>
                            handleRemoveCollection(rule.collectionId)
                          }
                        >
                          Remove
                        </s-button>
                      </s-stack>
                    </s-box>
                  ))}
                </s-stack>
              ) : (
                <s-text color="subdued">
                  No collections selected — automation applies to all products.
                </s-text>
              )}
            </s-stack>
          </s-box>
        </s-section>

        {/* ── Excluded Products ───────────────────────── */}
        <s-section heading="Excluded Products">
          <s-paragraph>
            Products listed here will never be hidden or pushed down,
            even if they go out of stock.
          </s-paragraph>
          <s-box padding="base" borderWidth="base" borderRadius="base">
            <s-stack direction="block" gap="base">
              <s-button
                onClick={handleAddExcludedProducts}
                {...(productFetcher.state !== "idle"
                  ? { loading: true }
                  : {})}
              >
                Add products
              </s-button>

              {excludedProducts.length > 0 ? (
                <s-stack direction="block" gap="small">
                  {excludedProducts.map((prod: any) => (
                    <s-box
                      key={prod.productId}
                      padding="small"
                      borderWidth="base"
                      borderRadius="base"
                    >
                      <s-stack direction="inline" gap="base">
                        <s-text type="strong">{prod.productTitle}</s-text>
                        <s-button
                          variant="tertiary"
                          tone="critical"
                          onClick={() =>
                            handleRemoveExcludedProduct(prod.productId)
                          }
                        >
                          Remove
                        </s-button>
                      </s-stack>
                    </s-box>
                  ))}
                </s-stack>
              ) : (
                <s-text color="subdued">
                  No products excluded — all products are subject to automation.
                </s-text>
              )}
            </s-stack>
          </s-box>
        </s-section>

        {/* ── Out-of-Stock Strategy ───────────────────── */}
        <s-section heading="Out-of-Stock Strategy">
          <s-paragraph>
            Choose what happens when a product's inventory reaches zero.
          </s-paragraph>
          <s-box padding="base" borderWidth="base" borderRadius="base">
            <s-stack direction="block" gap="base">
              <label
                style={{ display: "flex", alignItems: "flex-start", gap: "8px" }}
              >
                <input
                  type="radio"
                  name="strategy"
                  value="HIDE"
                  defaultChecked={strategy === "HIDE"}
                />
                <s-stack direction="block" gap="small">
                  <s-text type="strong">Hide product</s-text>
                  <s-text color="subdued">
                    Unpublish the product from your Online Store sales channel.
                  </s-text>
                </s-stack>
              </label>
              <label
                style={{ display: "flex", alignItems: "flex-start", gap: "8px" }}
              >
                <input
                  type="radio"
                  name="strategy"
                  value="PUSH_DOWN"
                  defaultChecked={strategy === "PUSH_DOWN"}
                />
                <s-stack direction="block" gap="small">
                  <s-text type="strong">Push to bottom</s-text>
                  <s-text color="subdued">
                    Move the product to the bottom of all its collections.
                  </s-text>
                </s-stack>
              </label>
            </s-stack>
          </s-box>
        </s-section>

        {/* ── Restore Behavior ────────────────────────── */}
        <s-section heading="Restock Behavior">
          <s-paragraph>
            Choose what happens when a product comes back in stock.
          </s-paragraph>
          <s-box padding="base" borderWidth="base" borderRadius="base">
            <s-stack direction="block" gap="base">
              <label
                style={{ display: "flex", alignItems: "flex-start", gap: "8px" }}
              >
                <input
                  type="radio"
                  name="restoreBehavior"
                  value="ALWAYS"
                  defaultChecked={restoreBehavior === "ALWAYS"}
                />
                <s-stack direction="block" gap="small">
                  <s-text type="strong">Always restore</s-text>
                  <s-text color="subdued">
                    Republish or reposition the product whenever it's back in
                    stock, regardless of how it was hidden.
                  </s-text>
                </s-stack>
              </label>
              <label
                style={{ display: "flex", alignItems: "flex-start", gap: "8px" }}
              >
                <input
                  type="radio"
                  name="restoreBehavior"
                  value="CONDITIONAL"
                  defaultChecked={restoreBehavior === "CONDITIONAL"}
                />
                <s-stack direction="block" gap="small">
                  <s-text type="strong">Only if app modified it</s-text>
                  <s-text color="subdued">
                    Only restore products that were originally hidden or moved by
                    this app.
                  </s-text>
                </s-stack>
              </label>
              <label
                style={{ display: "flex", alignItems: "flex-start", gap: "8px" }}
              >
                <input
                  type="radio"
                  name="restoreBehavior"
                  value="NONE"
                  defaultChecked={restoreBehavior === "NONE"}
                />
                <s-stack direction="block" gap="small">
                  <s-text type="strong">Do nothing</s-text>
                  <s-text color="subdued">
                    Never automatically restore. You'll manage restocking
                    manually.
                  </s-text>
                </s-stack>
              </label>
            </s-stack>
          </s-box>
        </s-section>

        {/* ── Sidebar ─────────────────────────────────── */}
        <s-section slot="aside" heading="About Settings">
          <s-paragraph>
            These settings control how the app manages your inventory
            visibility. Changes are applied to future inventory events only.
          </s-paragraph>
          <s-paragraph>
            Products that were already modified will retain their current state
            until their inventory changes again.
          </s-paragraph>
        </s-section>
      </s-page>
    </Form>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};

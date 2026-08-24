import type {
  ActionFunctionArgs,
  HeadersFunction,
  LoaderFunctionArgs,
} from "react-router";
import { useFetcher, useLoaderData, useNavigate } from "react-router";
import { useEffect, useRef, useState } from "react";
import { useAppBridge } from "@shopify/app-bridge-react";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { handleCollectionSortAction } from "../services/collection-sort-actions.server";
import { instrumentAdminApi } from "../services/observability.server";

interface CollectionsQueryResponse {
  data?: {
    collections?: {
      edges: Array<{
        cursor: string;
        node: {
          id: string;
          title: string;
          sortOrder: string;
          productsCount?: { count: number } | null;
          ruleSet?: unknown;
        };
      }>;
      pageInfo: {
        hasNextPage: boolean;
        hasPreviousPage: boolean;
        startCursor: string | null;
        endCursor: string | null;
      };
    };
  };
}

interface ShopifyModalElement extends HTMLElement {
  show(): void;
  hide(): void;
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin: rawAdmin, session } = await authenticate.admin(request);
  const shop = session.shop;
  const admin = instrumentAdminApi(rawAdmin, shop);
  const url = new URL(request.url);
  const cursor = url.searchParams.get("cursor") ?? null;

  const response = await admin.graphql(
    `#graphql
      query getCollections($cursor: String) {
        collections(first: 50, after: $cursor) {
          edges {
            cursor
            node {
              id
              title
              sortOrder
              productsCount { count }
              ruleSet { rules { column } }
            }
          }
          pageInfo {
            hasNextPage
            hasPreviousPage
            startCursor
            endCursor
          }
        }
      }`,
    { variables: { cursor } },
  );

  const json = (await response.json()) as CollectionsQueryResponse;
  const edges = json.data?.collections?.edges ?? [];
  const pageInfo = json.data?.collections?.pageInfo;
  const collections = edges.map((edge) => ({
    id: edge.node.id,
    cursor: edge.cursor,
    title: edge.node.title,
    sortOrder: edge.node.sortOrder,
    productsCount: edge.node.productsCount?.count ?? 0,
    type: edge.node.ruleSet ? ("smart" as const) : ("custom" as const),
  }));

  const collectionIds = collections.map((collection) => collection.id);
  const sortingRows = await db.collectionAutoSorting.findMany({
    where: { shop, collectionId: { in: collectionIds } },
    select: { collectionId: true, enabled: true, baseSortOrder: true },
  });
  const autoSortingMap: Record<string, string> = {};
  const baseSortOrderMap: Record<string, string> = {};
  for (const row of sortingRows) {
    autoSortingMap[row.collectionId] = row.enabled ? "enabled" : "disabled";
    if (row.enabled) baseSortOrderMap[row.collectionId] = row.baseSortOrder;
  }

  return {
    collections,
    autoSortingMap,
    baseSortOrderMap,
    pageInfo: {
      hasNextPage: pageInfo?.hasNextPage ?? false,
      hasPreviousPage: pageInfo?.hasPreviousPage ?? false,
      endCursor: pageInfo?.endCursor ?? null,
    },
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  return handleCollectionSortAction(request);
};

const SORT_ORDER_LABELS: Record<string, string> = {
  ALPHA_ASC: "A-Z",
  ALPHA_DESC: "Z-A",
  BEST_SELLING: "Best selling",
  CREATED: "Oldest first",
  CREATED_DESC: "Newest first",
  MANUAL: "Manual",
  PRICE_ASC: "Price: low to high",
  PRICE_DESC: "Price: high to low",
};

type PendingChange = {
  collectionId: string;
  collectionTitle: string;
  oldOrder: string;
  newOrder: string;
  autoSortingEnabled: boolean;
} | null;

type ActionData =
  | {
      _action: "changeSortOrder";
      success: boolean;
      collectionId: string;
      sortOrder?: string;
      error?: string;
    }
  | {
      _action: "setAutoSorting";
      success: boolean;
      collectionId?: string;
      enabled?: boolean;
      error?: string;
    }
  | {
      _action: "enableAllAutoSorting";
      success: boolean;
      count?: number;
      error?: string;
    };

function elementValue(event: Event) {
  return (event.currentTarget as HTMLElement & { value: string }).value;
}

export default function SortCollection() {
  const { collections, pageInfo, autoSortingMap, baseSortOrderMap } =
    useLoaderData<typeof loader>();
  const fetcher = useFetcher<ActionData>();
  const autoFetcher = useFetcher<ActionData>();
  const navigate = useNavigate();
  const shopify = useAppBridge();
  const modalRef = useRef<ShopifyModalElement>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [pendingChange, setPendingChange] = useState<PendingChange>(null);
  const [processingIds, setProcessingIds] = useState<Set<string>>(new Set());
  const [autoSorting, setAutoSorting] = useState<Record<string, string>>(() =>
    Object.fromEntries(
      collections.map((collection) => [
        collection.id,
        autoSortingMap[collection.id] ?? "disabled",
      ]),
    ),
  );
  const [sortOrderOverride, setSortOrderOverride] = useState<
    Record<string, string>
  >(() =>
    Object.fromEntries(
      collections.map((collection) => [
        collection.id,
        baseSortOrderMap[collection.id] ?? collection.sortOrder,
      ]),
    ),
  );
  const submittingRef = useRef<{
    id: string;
    title: string;
    newOrder: string;
  } | null>(null);
  const previousSortState = useRef("idle");
  const previousAutoState = useRef("idle");

  useEffect(() => {
    const previous = previousSortState.current;
    previousSortState.current = fetcher.state;
    if (previous === "idle" || fetcher.state !== "idle" || !fetcher.data)
      return;

    const result = fetcher.data;
    if (result._action !== "changeSortOrder") return;
    const submitted = submittingRef.current;
    if (result.success && result.sortOrder) {
      setSortOrderOverride((current) => ({
        ...current,
        [result.collectionId]: result.sortOrder!,
      }));
      setAutoSorting((current) => ({
        ...current,
        [result.collectionId]: "enabled",
      }));
      const label = SORT_ORDER_LABELS[result.sortOrder] ?? result.sortOrder;
      shopify.toast.show(
        `Base order for "${submitted?.title ?? "collection"}" queued as "${label}".`,
      );
    } else if (!result.success) {
      shopify.toast.show(result.error ?? "Failed to update the base order.", {
        isError: true,
      });
    }
    setProcessingIds((current) => {
      const next = new Set(current);
      next.delete(result.collectionId);
      return next;
    });
    submittingRef.current = null;
  }, [fetcher.data, fetcher.state, shopify]);

  useEffect(() => {
    const previous = previousAutoState.current;
    previousAutoState.current = autoFetcher.state;
    if (
      previous === "idle" ||
      autoFetcher.state !== "idle" ||
      !autoFetcher.data
    ) {
      return;
    }

    const result = autoFetcher.data;
    if (result._action === "setAutoSorting") {
      if (result.success) {
        shopify.toast.show(
          `Auto sorting ${result.enabled ? "enable" : "disable"} queued.`,
        );
      } else {
        shopify.toast.show(result.error ?? "Failed to update auto sorting.", {
          isError: true,
        });
      }
    } else if (result._action === "enableAllAutoSorting") {
      if (result.success) {
        shopify.toast.show(
          `Auto sorting enabled for ${result.count ?? "all"} collections.`,
        );
      } else {
        shopify.toast.show(result.error ?? "Failed to enable auto sorting.", {
          isError: true,
        });
      }
    }
  }, [autoFetcher.data, autoFetcher.state, shopify]);

  const requestSortChange = (
    collection: { id: string; title: string },
    newOrder: string,
  ) => {
    const oldOrder = sortOrderOverride[collection.id] ?? "";
    if (newOrder === oldOrder) return;
    setPendingChange({
      collectionId: collection.id,
      collectionTitle: collection.title,
      oldOrder,
      newOrder,
      autoSortingEnabled:
        (autoSorting[collection.id] ?? "disabled") === "enabled",
    });
    modalRef.current?.show();
  };

  const handleCancel = () => {
    modalRef.current?.hide();
    setPendingChange(null);
  };

  const handleConfirm = () => {
    if (!pendingChange) return;
    const { collectionId, collectionTitle, newOrder, autoSortingEnabled } =
      pendingChange;
    modalRef.current?.hide();
    setPendingChange(null);
    if (!autoSortingEnabled) {
      setAutoSorting((current) => ({
        ...current,
        [collectionId]: "enabled",
      }));
    }
    setProcessingIds((current) => new Set([...current, collectionId]));
    submittingRef.current = {
      id: collectionId,
      title: collectionTitle,
      newOrder,
    };
    fetcher.submit(
      { collectionId, sortOrder: newOrder },
      { method: "POST", action: "/app/sort-collection" },
    );
  };

  const handleAutoSortingChange = (collectionId: string, value: string) => {
    setAutoSorting((current) => ({ ...current, [collectionId]: value }));
    autoFetcher.submit(
      {
        _action: "setAutoSorting",
        collectionId,
        enabled: String(value === "enabled"),
        baseSortOrder:
          sortOrderOverride[collectionId] ??
          collections.find((collection) => collection.id === collectionId)
            ?.sortOrder ??
          "MANUAL",
      },
      { method: "POST", action: "/app/sort-collection" },
    );
  };

  const enableAllAutoSorting = () => {
    setAutoSorting(
      Object.fromEntries(
        collections.map((collection) => [collection.id, "enabled"]),
      ),
    );
    autoFetcher.submit(
      { _action: "enableAllAutoSorting" },
      { method: "POST", action: "/app/sort-collection" },
    );
  };

  const displayRows = collections.filter((collection) =>
    collection.title.toLowerCase().includes(searchQuery.toLowerCase()),
  );
  const nextHref = pageInfo.hasNextPage
    ? `/app/sort-collection?cursor=${pageInfo.endCursor}`
    : null;
  const previousHref = pageInfo.hasPreviousPage ? "/app/sort-collection" : null;

  return (
    <>
      <ui-modal id="sc-sort-modal" ref={modalRef}>
        <ui-title-bar title="Change base order?">
          <button
            {...({
              variant: "primary",
            } as unknown as React.ButtonHTMLAttributes<HTMLButtonElement>)}
            onClick={handleConfirm}
          >
            Update order
          </button>
          <button onClick={handleCancel}>Cancel</button>
        </ui-title-bar>
        {pendingChange ? (
          <s-box padding="base">
            <s-stack direction="block" gap="base">
              <s-box padding="base" borderWidth="base" borderRadius="base">
                <s-stack direction="block" gap="small">
                  <s-text color="subdued">Collection</s-text>
                  <s-text type="strong">{pendingChange.collectionTitle}</s-text>
                </s-stack>
              </s-box>
              <s-grid
                gridTemplateColumns="1fr auto 1fr"
                gap="base"
                alignItems="center"
              >
                <s-box padding="base" borderWidth="base" borderRadius="base">
                  <s-stack direction="block" gap="small">
                    <s-text color="subdued">Current order</s-text>
                    <s-text type="strong">
                      {SORT_ORDER_LABELS[pendingChange.oldOrder] ??
                        pendingChange.oldOrder}
                    </s-text>
                  </s-stack>
                </s-box>
                <s-text color="subdued">to</s-text>
                <s-box padding="base" borderWidth="base" borderRadius="base">
                  <s-stack direction="block" gap="small">
                    <s-text color="subdued">New order</s-text>
                    <s-text type="strong">
                      {SORT_ORDER_LABELS[pendingChange.newOrder] ??
                        pendingChange.newOrder}
                    </s-text>
                  </s-stack>
                </s-box>
              </s-grid>
              <s-banner
                tone={pendingChange.autoSortingEnabled ? "info" : "warning"}
              >
                {pendingChange.autoSortingEnabled
                  ? "Inventex will use this as the base order while Shopify remains Manual."
                  : "Confirming will enable auto sorting and use this as the base order."}
              </s-banner>
            </s-stack>
          </s-box>
        ) : null}
      </ui-modal>

      <s-page heading="Sort collections" inlineSize="large">
        <s-link slot="breadcrumb-actions" href="/app">
          Dashboard
        </s-link>
        <s-button
          slot="primary-action"
          variant="primary"
          loading={autoFetcher.state !== "idle"}
          onClick={enableAllAutoSorting}
        >
          Enable sorting for all
        </s-button>

        <s-paragraph>
          Keep available products first without changing Shopify&apos;s collection
          sort type from Manual.
        </s-paragraph>

        <s-banner tone="info" heading="Shopify stays set to Manual">
          Base order controls the order of available products. Inventex places
          continue-selling and sold-out products after them.
        </s-banner>

        <s-section heading="Collections" padding="none">
          {collections.length === 0 ? (
            <s-box padding="large" background="subdued">
              <s-stack direction="block" gap="small" alignItems="center">
                <s-heading>No collections found</s-heading>
                <s-paragraph>
                  Create a collection in Shopify, then return here.
                </s-paragraph>
              </s-stack>
            </s-box>
          ) : (
            <s-table
              variant="auto"
              paginate={pageInfo.hasNextPage || pageInfo.hasPreviousPage}
              hasPreviousPage={pageInfo.hasPreviousPage}
              hasNextPage={pageInfo.hasNextPage}
              onPreviousPage={() =>
                previousHref ? navigate(previousHref) : undefined
              }
              onNextPage={() => (nextHref ? navigate(nextHref) : undefined)}
            >
              <s-search-field
                slot="filters"
                label="Search collections"
                labelAccessibilityVisibility="exclusive"
                placeholder="Search collections"
                value={searchQuery}
                onInput={(event) => setSearchQuery(elementValue(event))}
              />
              <s-table-header-row>
                <s-table-header listSlot="primary">Collection</s-table-header>
                <s-table-header listSlot="inline">Auto sorting</s-table-header>
                <s-table-header listSlot="labeled">Base order</s-table-header>
                <s-table-header listSlot="secondary" format="numeric">
                  Products
                </s-table-header>
              </s-table-header-row>
              <s-table-body>
                {displayRows.map((collection) => (
                  <s-table-row key={collection.id}>
                    <s-table-cell>
                      <s-stack direction="block" gap="small">
                        <s-text type="strong">{collection.title}</s-text>
                        <s-badge
                          tone={
                            collection.type === "smart" ? "info" : "neutral"
                          }
                        >
                          {collection.type === "smart" ? "Smart" : "Custom"}
                        </s-badge>
                      </s-stack>
                    </s-table-cell>
                    <s-table-cell>
                      <s-select
                        label={`Auto sorting for ${collection.title}`}
                        labelAccessibilityVisibility="exclusive"
                        value={autoSorting[collection.id] ?? "disabled"}
                        onChange={(event) =>
                          handleAutoSortingChange(
                            collection.id,
                            elementValue(event),
                          )
                        }
                      >
                        <s-option value="enabled">Enabled</s-option>
                        <s-option value="disabled">Disabled</s-option>
                      </s-select>
                    </s-table-cell>
                    <s-table-cell>
                      {processingIds.has(collection.id) ? (
                        <s-badge tone="info">Applying</s-badge>
                      ) : (
                        <s-select
                          label={`Base order for ${collection.title}`}
                          labelAccessibilityVisibility="exclusive"
                          value={
                            sortOrderOverride[collection.id] ??
                            collection.sortOrder
                          }
                          onChange={(event) =>
                            requestSortChange(collection, elementValue(event))
                          }
                        >
                          {Object.entries(SORT_ORDER_LABELS).map(
                            ([value, label]) => (
                              <s-option key={value} value={value}>
                                {label}
                              </s-option>
                            ),
                          )}
                        </s-select>
                      )}
                    </s-table-cell>
                    <s-table-cell>{collection.productsCount}</s-table-cell>
                  </s-table-row>
                ))}
              </s-table-body>
            </s-table>
          )}

          {collections.length > 0 && displayRows.length === 0 ? (
            <s-box padding="large" background="subdued">
              <s-paragraph>No collections match “{searchQuery}”.</s-paragraph>
            </s-box>
          ) : null}
        </s-section>
      </s-page>
    </>
  );
}

export const headers: HeadersFunction = (args) => boundary.headers(args);

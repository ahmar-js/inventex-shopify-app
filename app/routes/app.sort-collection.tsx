import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useLoaderData, Link, useFetcher } from "react-router";
import { useState, useEffect, useRef } from "react";
import { authenticate } from "../shopify.server";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { useAppBridge } from "@shopify/app-bridge-react";
import db from "../db.server";

// ─── Loader ──────────────────────────────────────────────────

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const shop = session.shop;

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
            productsCount {
              count
            }
            ruleSet {
              rules {
                column
              }
            }
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

  const json = await response.json();
  const edges: any[] = json.data?.collections?.edges ?? [];
  const pageInfo = json.data?.collections?.pageInfo ?? {};

  const collections = edges.map((edge: any) => ({
    id: edge.node.id as string,
    cursor: edge.cursor as string,
    title: edge.node.title as string,
    sortOrder: edge.node.sortOrder as string,
    productsCount: (edge.node.productsCount?.count ?? 0) as number,
    type: edge.node.ruleSet ? ("smart" as const) : ("custom" as const),
  }));

  // Load persisted Auto Sorting states for this page's collections from DB
  const collectionIds = collections.map((c) => c.id);
  const autoSortingRows = await db.collectionAutoSorting.findMany({
    where: { shop, collectionId: { in: collectionIds } },
    select: { collectionId: true, enabled: true },
  });
  // Build a map: collectionId -> "enabled"|"disabled". Absent row = disabled (opt-in model)
  const autoSortingMap: Record<string, string> = {};
  for (const row of autoSortingRows) {
    autoSortingMap[row.collectionId] = row.enabled ? "enabled" : "disabled";
  }

  return {
    collections,
    autoSortingMap,
    pageInfo: {
      hasNextPage: pageInfo.hasNextPage ?? false,
      hasPreviousPage: pageInfo.hasPreviousPage ?? false,
      endCursor: pageInfo.endCursor ?? null,
    },
  };
};

// ─── Action ──────────────────────────────────────────────────

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const shop     = session.shop;
  const formData = await request.formData();
  const _action  = formData.get("_action") as string | null;

  // ── setAutoSorting: persist a single collection's toggle ──────────────
  if (_action === "setAutoSorting") {
    const collectionId = formData.get("collectionId") as string;
    const enabled      = formData.get("enabled") === "true";
    try {
      await db.collectionAutoSorting.upsert({
        where:  { shop_collectionId: { shop, collectionId } },
        update: { enabled },
        create: { shop, collectionId, enabled },
      });
      return { _action: "setAutoSorting" as const, success: true, collectionId, enabled };
    } catch {
      return { _action: "setAutoSorting" as const, success: false, collectionId, error: "Failed to save auto sorting setting." };
    }
  }

  // ── enableAllAutoSorting: enable every collection on this page ─────────
  if (_action === "enableAllAutoSorting") {
    const collectionIds: string[] = JSON.parse((formData.get("collectionIds") as string) ?? "[]");
    try {
      await db.$transaction(
        collectionIds.map((cid) =>
          db.collectionAutoSorting.upsert({
            where:  { shop_collectionId: { shop, collectionId: cid } },
            update: { enabled: true },
            create: { shop, collectionId: cid, enabled: true },
          }),
        ),
      );
      return { _action: "enableAllAutoSorting" as const, success: true, count: collectionIds.length };
    } catch {
      return { _action: "enableAllAutoSorting" as const, success: false, error: "Failed to enable auto sorting for all collections." };
    }
  }

  // ── changeSortOrder (default) ──────────────────────────────────────────
  const collectionId = formData.get("collectionId") as string;
  const sortOrder    = formData.get("sortOrder")    as string;

  if (!collectionId || !sortOrder) {
    return { _action: "changeSortOrder" as const, success: false, error: "Missing required fields.", collectionId: collectionId ?? "" };
  }

  try {
    const response = await admin.graphql(
      `#graphql
      mutation collectionUpdate($input: CollectionInput!) {
        collectionUpdate(input: $input) {
          collection { id sortOrder }
          userErrors  { field message }
        }
      }`,
      { variables: { input: { id: collectionId, sortOrder } } },
    );

    const json       = await response.json();
    const userErrors = (json.data?.collectionUpdate?.userErrors ?? []) as { field: string[]; message: string }[];

    if (userErrors.length > 0) {
      return { _action: "changeSortOrder" as const, success: false, error: userErrors[0].message, collectionId };
    }

    // Also persist that auto sorting is now enabled for this collection
    await db.collectionAutoSorting.upsert({
      where:  { shop_collectionId: { shop, collectionId } },
      update: { enabled: true },
      create: { shop, collectionId, enabled: true },
    });

    return { _action: "changeSortOrder" as const, success: true, collectionId, sortOrder };
  } catch {
    return { _action: "changeSortOrder" as const, success: false, error: "Failed to connect to Shopify. Please try again.", collectionId };
  }
};

// ─── Helpers ─────────────────────────────────────────────────

const SORT_ORDER_LABELS: Record<string, string> = {
  ALPHA_ASC: "A–Z",
  ALPHA_DESC: "Z–A",
  BEST_SELLING: "Best selling",
  CREATED: "Oldest first",
  CREATED_DESC: "Newest first",
  MANUAL: "Manual",
  PRICE_ASC: "Price: low to high",
  PRICE_DESC: "Price: high to low",
};

function sortOrderLabel(order: string) {
  return SORT_ORDER_LABELS[order] ?? order;
}

// ─── Component ───────────────────────────────────────────────

type SortField = "title" | "sortOrder" | "productsCount";

type PendingChange = {
  collectionId: string;
  collectionTitle: string;
  oldOrder: string;
  newOrder: string;
  autoSortingEnabled: boolean;
} | null;

type ActionData =
  | { _action: "changeSortOrder"; success: boolean; collectionId: string; sortOrder?: string; error?: string }
  | { _action: "setAutoSorting";   success: boolean; collectionId?: string; enabled?: boolean; error?: string }
  | { _action: "enableAllAutoSorting"; success: boolean; count?: number; error?: string };

/** Injected CSS — hover/focus/spinner states only (modal & toasts handled by Shopify) */
const TABLE_STYLES = `
  .sc-table tbody tr { transition: background-color 0.12s ease; }
  .sc-table tbody tr:hover td { background-color: #eef3ff !important; }
  .sc-th-sort { transition: background-color 0.12s ease; cursor: pointer; }
  .sc-th-sort:hover { background-color: #ecedef !important; }
  .sc-search { transition: border-color 0.15s, box-shadow 0.15s; }
  .sc-search:focus { border-color: #458fff !important; box-shadow: 0 0 0 3px rgba(69,143,255,0.18) !important; outline: none; }
  .sc-select { transition: border-color 0.15s, box-shadow 0.15s; }
  .sc-select:hover { border-color: #8c9196; }
  .sc-select:focus { outline: none; border-color: #458fff; box-shadow: 0 0 0 3px rgba(69,143,255,0.18); }
  .sc-btn-page { display: inline-flex; align-items: center; gap: 6px; padding: 8px 16px; border: 1px solid #c9cccf; border-radius: 8px; background: #fff; font-size: 14px; font-weight: 500; color: #3a3d42; cursor: pointer; transition: background 0.12s, border-color 0.12s; text-decoration: none; }
  .sc-btn-page:hover { background: #f6f6f7; border-color: #8c9196; }
  .sc-btn-page[aria-disabled="true"] { opacity: 0.45; pointer-events: none; }
  @keyframes sc-spin { to { transform: rotate(360deg); } }
  .sc-spinner { width: 15px; height: 15px; border: 2px solid #e1e3e5; border-top-color: #458fff; border-radius: 50%; animation: sc-spin 0.65s linear infinite; display: inline-block; flex-shrink: 0; vertical-align: middle; }
`;

export default function SortCollection() {
  const { collections, pageInfo, autoSortingMap } = useLoaderData<typeof loader>();
  const fetcher      = useFetcher<ActionData>();   // sort order changes
  const autoFetcher  = useFetcher<ActionData>();   // auto sorting toggle changes
  const shopify      = useAppBridge();
  const modalRef     = useRef<HTMLElement>(null);

  // ── State ─────────────────────────────────────────────────
  const [searchQuery, setSearchQuery]     = useState("");
  const [sortField, setSortField]         = useState<SortField | null>(null);
  const [sortDir, setSortDir]             = useState<"asc" | "desc">("asc");
  const [selected, setSelected]           = useState<Set<string>>(new Set());
  const [pendingChange, setPendingChange] = useState<PendingChange>(null);
  const [processingIds, setProcessingIds] = useState<Set<string>>(new Set());

  // Seed autoSorting from DB values returned by the loader
  const [autoSorting, setAutoSorting] = useState<Record<string, string>>(
    () => Object.fromEntries(
      collections.map((c) => [c.id, autoSortingMap[c.id] ?? "disabled"]),
    ),
  );
  const [sortOrderOverride, setSortOrderOverride] = useState<Record<string, string>>(
    () => Object.fromEntries(collections.map((c) => [c.id, c.sortOrder])),
  );

  // Refs for fetcher transition tracking
  const submittingRef       = useRef<{ id: string; title: string; newOrder: string } | null>(null);
  const prevStateRef        = useRef<string>("idle");
  const prevAutoStateRef    = useRef<string>("idle");

  // ── Fetcher response handler ──────────────────────────────
  useEffect(() => {
    const prev = prevStateRef.current;
    prevStateRef.current = fetcher.state;

    if (prev !== "idle" && fetcher.state === "idle" && fetcher.data) {
      const data = fetcher.data as ActionData;
      if (data._action !== "changeSortOrder") return;
      const info = submittingRef.current;

      if (data.success && data.sortOrder) {
        setSortOrderOverride((p) => ({ ...p, [data.collectionId]: data.sortOrder! }));
        setAutoSorting((p) => ({ ...p, [data.collectionId]: "enabled" }));
        const label = SORT_ORDER_LABELS[data.sortOrder] ?? data.sortOrder;
        shopify.toast.show(
          `Sort order for "${info?.title ?? "collection"}" updated to "${label}".`,
        );
      } else if (!data.success) {
        shopify.toast.show(
          data.error ?? "Failed to update sort order. Please try again.",
          { isError: true },
        );
      }

      setProcessingIds((p) => { const s = new Set(p); s.delete(data.collectionId); return s; });
      submittingRef.current = null;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fetcher.state, fetcher.data]);

  // ── Auto Sorting fetcher response handler ─────────────────
  useEffect(() => {
    const prev = prevAutoStateRef.current;
    prevAutoStateRef.current = autoFetcher.state;

    if (prev !== "idle" && autoFetcher.state === "idle" && autoFetcher.data) {
      const data = autoFetcher.data as ActionData;
      if (data._action === "setAutoSorting" && !data.success) {
        shopify.toast.show(data.error ?? "Failed to save auto sorting setting.", { isError: true });
      } else if (data._action === "enableAllAutoSorting") {
        if (data.success) {
          shopify.toast.show(
            `Auto Sorting enabled for ${data.count ?? "all"} collection${(data.count ?? 0) !== 1 ? "s" : ""}.`,
          );
        } else {
          shopify.toast.show(data.error ?? "Failed to enable auto sorting.", { isError: true });
        }
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoFetcher.state, autoFetcher.data]);

  // ── Column sort ──────────────────────────────────────────
  const handleSort = (field: SortField) => {
    if (sortField === field) setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    else { setSortField(field); setSortDir("asc"); }
  };
  const sortIcon = (field: SortField) =>
    sortField !== field ? " ↕" : sortDir === "asc" ? " ↑" : " ↓";

  // ── Sorting Type dropdown → open confirmation ─────────────
  const requestSortChange = (
    col: { id: string; title: string },
    newOrder: string,
  ) => {
    const oldOrder = sortOrderOverride[col.id] ?? "";
    if (newOrder === oldOrder) return;

    // Always open the confirmation modal so the change is saved to Shopify
    // (Shopify is the source of truth — local state alone won’t survive a refresh)
    setPendingChange({
      collectionId: col.id,
      collectionTitle: col.title,
      oldOrder,
      newOrder,
      autoSortingEnabled: (autoSorting[col.id] ?? "enabled") === "enabled",
    });
    (modalRef.current as any)?.show();
  };

  // ── Confirmed — submit to Shopify ─────────────────────────
  const handleCancel = () => {
    (modalRef.current as any)?.hide();
    setPendingChange(null);
  };

  const handleConfirm = () => {
    if (!pendingChange) return;
    const { collectionId, collectionTitle, newOrder, autoSortingEnabled } = pendingChange;
    (modalRef.current as any)?.hide();
    setPendingChange(null);
    // Optimistically reflect auto-enable in local state (server also enables it in the action)
    if (!autoSortingEnabled) {
      setAutoSorting((prev) => ({ ...prev, [collectionId]: "enabled" }));
    }
    setProcessingIds((p) => new Set([...p, collectionId]));
    submittingRef.current = { id: collectionId, title: collectionTitle, newOrder };
    // No _action field: server falls through to the changeSortOrder branch
    fetcher.submit(
      { collectionId, sortOrder: newOrder },
      { method: "POST", action: "/app/sort-collection" },
    );
  };

  // ── Auto Sorting toggle ─────────────────────────────────
  const handleAutoSortingChange = (collectionId: string, value: string) => {
    setAutoSorting((prev) => ({ ...prev, [collectionId]: value }));
    autoFetcher.submit(
      { _action: "setAutoSorting", collectionId, enabled: String(value === "enabled") },
      { method: "POST", action: "/app/sort-collection" },
    );
  };

  // ── Enable Auto Sorting for all collections ────────────
  const enableAllAutoSorting = () => {
    setAutoSorting(Object.fromEntries(collections.map((c) => [c.id, "enabled"])));
    autoFetcher.submit(
      { _action: "enableAllAutoSorting", collectionIds: JSON.stringify(collections.map((c) => c.id)) },
      { method: "POST", action: "/app/sort-collection" },
    );
  };

  // ── Filter + sort ─────────────────────────────────────────
  const filtered = collections.filter((c) =>
    c.title.toLowerCase().includes(searchQuery.toLowerCase()),
  );
  const displayRows = [...filtered].sort((a, b) => {
    if (!sortField) return 0;
    let cmp = 0;
    if (sortField === "title")              cmp = a.title.localeCompare(b.title);
    else if (sortField === "sortOrder")     cmp = a.sortOrder.localeCompare(b.sortOrder);
    else if (sortField === "productsCount") cmp = a.productsCount - b.productsCount;
    return sortDir === "asc" ? cmp : -cmp;
  });

  // ── Checkbox helpers ─────────────────────────────────────
  const allIds      = displayRows.map((c) => c.id);
  const allChecked  = allIds.length > 0 && allIds.every((id) => selected.has(id));
  const someChecked = allIds.some((id) => selected.has(id));
  const toggleAll   = () => setSelected(allChecked ? new Set() : new Set(allIds));
  const toggleRow   = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });

  const nextHref = pageInfo.hasNextPage
    ? `/app/sort-collection?cursor=${pageInfo.endCursor}` : null;
  const prevHref = pageInfo.hasPreviousPage ? `/app/sort-collection` : null;

  // ── Style helpers ─────────────────────────────────────────
  const cellBg = (id: string, idx: number) =>
    selected.has(id) ? "#ebf3ff" : idx % 2 === 1 ? "#fafafa" : "#ffffff";

  const cellStyle = (id: string, idx: number, extra?: React.CSSProperties): React.CSSProperties => ({
    padding: "15px 18px",
    borderBottom: "1px solid #f0f1f3",
    verticalAlign: "middle",
    background: cellBg(id, idx),
    ...extra,
  });

  const selectStyle = (color?: string): React.CSSProperties => ({
    padding: "6px 10px",
    borderRadius: "7px",
    border: "1px solid #d2d5d8",
    fontSize: "13px",
    background: "#fff",
    cursor: "pointer",
    color: color ?? "#1a1c1e",
    fontWeight: 500,
    width: "100%",
    appearance: "auto" as React.CSSProperties["appearance"],
  });

  return (
    <>
      <style dangerouslySetInnerHTML={{ __html: TABLE_STYLES }} />

      {/* ── Shopify confirmation modal ─────────────────────────
           ui-modal is rendered by Shopify Admin; content uses
           native Polaris s-* web components. Buttons inside
           ui-title-bar become the modal footer automatically.
      ────────────────────────────────────────────────────── */}
      <ui-modal id="sc-sort-modal" ref={modalRef}>
        <ui-title-bar title="Change Sorting Order?">
          <button {...({ variant: "primary" } as any)} onClick={handleConfirm}>Update Sorting</button>
          <button onClick={handleCancel}>Cancel</button>
        </ui-title-bar>

        {/* Modal body — only rendered after user picks a new order */}
        {pendingChange && (
          <div style={{ padding: "20px" }}>
            <s-stack direction="block" gap="base">

              {/* Collection name */}
              <s-box padding="base" borderWidth="base" borderRadius="base">
                <s-stack direction="block" gap="small">
                  <s-text color="subdued">Collection</s-text>
                  <s-text type="strong">{pendingChange.collectionTitle}</s-text>
                </s-stack>
              </s-box>

              {/* From → To */}
              <s-stack direction="inline" gap="base">
                <s-box padding="base" borderWidth="base" borderRadius="base">
                  <s-stack direction="block" gap="small">
                    <s-text color="subdued">Current order</s-text>
                    <s-text type="strong">
                      {SORT_ORDER_LABELS[pendingChange.oldOrder] ?? pendingChange.oldOrder}
                    </s-text>
                  </s-stack>
                </s-box>

                <div style={{ display: "flex", alignItems: "center", padding: "0 2px", color: "#8c9196", fontSize: "18px" }}>→</div>

                <s-box padding="base" borderWidth="base" borderRadius="base">
                  <s-stack direction="block" gap="small">
                    <s-text color="subdued">New order</s-text>
                    <s-text type="strong">
                      {SORT_ORDER_LABELS[pendingChange.newOrder] ?? pendingChange.newOrder}
                    </s-text>
                  </s-stack>
                </s-box>
              </s-stack>

              {/* Auto-sorting context banner */}
              <s-banner tone={pendingChange.autoSortingEnabled ? "info" : "warning"}>
                <s-text>
                  {pendingChange.autoSortingEnabled
                    ? "The new sort order will be saved to Shopify immediately and managed automatically going forward."
                    : "Auto Sorting is currently disabled. Confirming will save the new sort order to Shopify and also re-enable Auto Sorting for this collection."}
                </s-text>
              </s-banner>

            </s-stack>
          </div>
        )}
      </ui-modal>

      <s-page heading="Sort Collections">
        {/* Full-width wrapper — bleeds beyond s-page's internal side padding */}
        <div style={{ width: "calc(100% + 64px)", marginLeft: "-32px" }}>

          {/* ── Toolbar ──────────────────────────────────── */}
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: "12px",
              padding: "0 32px 18px",
              flexWrap: "wrap",
            }}
          >
            {/* Search input with icon */}
            <div style={{ position: "relative", flex: "1", maxWidth: "440px", minWidth: "220px" }}>
              <svg
                xmlns="http://www.w3.org/2000/svg"
                width="16" height="16" viewBox="0 0 24 24"
                fill="none" stroke="#8c9196" strokeWidth="2"
                strokeLinecap="round" strokeLinejoin="round"
                style={{ position: "absolute", left: "11px", top: "50%", transform: "translateY(-50%)", pointerEvents: "none" }}
              >
                <circle cx="11" cy="11" r="8" />
                <line x1="21" y1="21" x2="16.65" y2="16.65" />
              </svg>
              <input
                type="search"
                className="sc-search"
                placeholder="Search collections…"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                style={{
                  width: "100%",
                  padding: "9px 12px 9px 34px",
                  border: "1px solid #c9cccf",
                  borderRadius: "9px",
                  fontSize: "14px",
                  background: "#fff",
                  boxSizing: "border-box",
                  color: "#1a1c1e",
                }}
              />
            </div>

            {/* Selection badge */}
            {selected.size > 0 && (
              <div
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: "8px",
                  padding: "7px 14px",
                  borderRadius: "20px",
                  background: "#e8f0fe",
                  color: "#1a5fcc",
                  fontSize: "13px",
                  fontWeight: 600,
                  whiteSpace: "nowrap",
                }}
              >
                {selected.size} collection{selected.size !== 1 ? "s" : ""} selected
                <button
                  onClick={() => setSelected(new Set())}
                  aria-label="Clear selection"
                  style={{ background: "none", border: "none", cursor: "pointer", padding: "0 0 0 2px", color: "#1a5fcc", fontSize: "17px", lineHeight: 1, fontWeight: 400 }}
                >×</button>
              </div>
            )}

            {/* Result count */}
            {searchQuery && (
              <span style={{ fontSize: "13px", color: "#6d7175", whiteSpace: "nowrap" }}>
                {displayRows.length} result{displayRows.length !== 1 ? "s" : ""}
              </span>
            )}

            {/* Enable All button — pushed to the right */}
            <div style={{ marginLeft: "auto" }}>
              <s-button
                variant="primary"
                onClick={enableAllAutoSorting}
              >
                Enable Sorting for All
              </s-button>
            </div>
          </div>

          {/* ── Table card ───────────────────────────────── */}
          {collections.length === 0 ? (
            <div style={{ padding: "0 32px" }}>
              <div
                style={{
                  padding: "48px 24px",
                  textAlign: "center",
                  background: "#fff",
                  borderRadius: "12px",
                  boxShadow: "0 1px 3px rgba(0,0,0,0.07), 0 0 0 1px rgba(0,0,0,0.05)",
                  color: "#6d7175",
                  fontSize: "14px",
                }}
              >
                No collections found in your store.
              </div>
            </div>
          ) : (
            <div style={{ padding: "0 32px" }}>
              <div
                style={{
                  background: "#fff",
                  borderRadius: "12px",
                  boxShadow: "0 1px 3px rgba(0,0,0,0.07), 0 0 0 1px rgba(0,0,0,0.05)",
                  overflow: "hidden",
                  marginBottom: "20px",
                }}
              >
                <div style={{ overflowX: "auto" }}>
                  <table
                    className="sc-table"
                    style={{
                      width: "100%",
                      borderCollapse: "collapse",
                      fontSize: "14px",
                      tableLayout: "fixed",
                      minWidth: "720px",
                    }}
                  >
                    <colgroup>
                      <col style={{ width: "52px" }} />
                      <col />
                      <col style={{ width: "142px" }} />
                      <col style={{ width: "200px" }} />
                      <col style={{ width: "140px" }} />
                    </colgroup>
                    <thead>
                      <tr style={{ background: "#f7f8fa", borderBottom: "1px solid #e8eaec" }}>
                        {/* Select-all checkbox */}
                        <th style={{ padding: "13px 18px", textAlign: "center" }}>
                          <input
                            type="checkbox"
                            checked={allChecked}
                            ref={(el) => { if (el) el.indeterminate = someChecked && !allChecked; }}
                            onChange={toggleAll}
                            aria-label="Select all"
                            style={{ cursor: "pointer", width: "15px", height: "15px", accentColor: "#458fff" }}
                          />
                        </th>

                        {/* Collection Name — sortable */}
                        <th
                          className="sc-th-sort"
                          onClick={() => handleSort("title")}
                          style={{ padding: "13px 18px", fontWeight: 600, fontSize: "12px", color: "#6d7175", letterSpacing: "0.04em", textTransform: "uppercase", userSelect: "none", whiteSpace: "nowrap" }}
                        >
                          Collection Name{sortIcon("title")}
                        </th>

                        {/* Auto Sorting */}
                        <th style={{ padding: "13px 18px", fontWeight: 600, fontSize: "12px", color: "#6d7175", letterSpacing: "0.04em", textTransform: "uppercase", whiteSpace: "nowrap" }}>
                          Auto Sorting
                        </th>

                        {/* Sorting Type — sortable */}
                        <th
                          className="sc-th-sort"
                          onClick={() => handleSort("sortOrder")}
                          style={{ padding: "13px 18px", fontWeight: 600, fontSize: "12px", color: "#6d7175", letterSpacing: "0.04em", textTransform: "uppercase", userSelect: "none", whiteSpace: "nowrap" }}
                        >
                          Sorting Type{sortIcon("sortOrder")}
                        </th>

                        {/* Products — sortable */}
                        <th
                          className="sc-th-sort"
                          onClick={() => handleSort("productsCount")}
                          style={{ padding: "13px 32px", fontWeight: 600, fontSize: "12px", color: "#6d7175", letterSpacing: "0.04em", textTransform: "uppercase", textAlign: "left", userSelect: "none", whiteSpace: "nowrap" }}
                        >
                          Products{sortIcon("productsCount")}
                        </th>
                      </tr>
                    </thead>

                    <tbody>
                      {displayRows.length === 0 ? (
                        <tr>
                          <td colSpan={5} style={{ padding: "52px 18px", textAlign: "center", color: "#8c9196", fontSize: "14px" }}>
                            No collections match &ldquo;{searchQuery}&rdquo;
                          </td>
                        </tr>
                      ) : (
                        displayRows.map((col, idx) => (
                          <tr key={col.id}>
                            {/* Checkbox */}
                            <td style={{ ...cellStyle(col.id, idx), textAlign: "center" }}>
                              <input
                                type="checkbox"
                                checked={selected.has(col.id)}
                                onChange={() => toggleRow(col.id)}
                                aria-label={`Select ${col.title}`}
                                style={{ cursor: "pointer", width: "15px", height: "15px", accentColor: "#458fff" }}
                              />
                            </td>

                            {/* Collection name + type badge */}
                            <td style={cellStyle(col.id, idx)}>
                              <div style={{ fontWeight: 600, color: "#1a1c1e", marginBottom: "5px", lineHeight: "1.3" }}>
                                {col.title}
                              </div>
                              <span
                                style={{
                                  display: "inline-flex",
                                  alignItems: "center",
                                  padding: "2px 8px",
                                  borderRadius: "20px",
                                  fontSize: "11px",
                                  fontWeight: 600,
                                  letterSpacing: "0.03em",
                                  textTransform: "uppercase",
                                  background: col.type === "smart" ? "#e6f4ea" : "#f3f4f6",
                                  color:     col.type === "smart" ? "#2e7d32" : "#6d7175",
                                }}
                              >
                                {col.type === "smart" ? "Smart" : "Custom"}
                              </span>
                            </td>

                            {/* Auto Sorting dropdown */}
                            <td style={cellStyle(col.id, idx)}>
                              <select
                                className="sc-select"
                                value={autoSorting[col.id] ?? "disabled"}
                                onChange={(e) => handleAutoSortingChange(col.id, e.target.value)}
                                style={selectStyle(
                                  (autoSorting[col.id] ?? "disabled") === "enabled" ? "#027a5f" : "#6d7175",
                                )}
                              >
                                <option value="enabled">● Enabled</option>
                                <option value="disabled">○ Disabled</option>
                              </select>
                            </td>

                            {/* Sorting Type dropdown — shows spinner while processing */}
                            <td style={cellStyle(col.id, idx)}>
                              {processingIds.has(col.id) ? (
                                <div style={{ display: "flex", alignItems: "center", gap: "9px", color: "#458fff", fontSize: "13px", fontWeight: 500 }}>
                                  <span className="sc-spinner" />
                                  <span>Applying…</span>
                                </div>
                              ) : (
                                <select
                                  className="sc-select"
                                  value={sortOrderOverride[col.id] ?? col.sortOrder}
                                  onChange={(e) => requestSortChange(col, e.target.value)}
                                  style={selectStyle()}
                                >
                                  {Object.entries(SORT_ORDER_LABELS).map(([val, label]) => (
                                    <option key={val} value={val}>{label}</option>
                                  ))}
                                </select>
                              )}
                            </td>

                            {/* Product count */}
                            <td style={cellStyle(col.id, idx, { textAlign: "center", fontVariantNumeric: "tabular-nums", fontWeight: 500, color: "#3a3d42" })}>
                              {col.productsCount}
                            </td>
                          </tr>
                        ))
                      )}
                    </tbody>
                  </table>
                </div>
              </div>

              {/* ── Pagination ──────────────────────────────── */}
              {(pageInfo.hasNextPage || pageInfo.hasPreviousPage) && (
                <div style={{ display: "flex", justifyContent: "center", alignItems: "center", gap: "10px", paddingBottom: "8px" }}>
                  {prevHref ? (
                    <Link to={prevHref} className="sc-btn-page">← Previous</Link>
                  ) : (
                    <span className="sc-btn-page" aria-disabled="true">← Previous</span>
                  )}
                  {nextHref ? (
                    <Link to={nextHref} className="sc-btn-page">Next →</Link>
                  ) : (
                    <span className="sc-btn-page" aria-disabled="true">Next →</span>
                  )}
                </div>
              )}
            </div>
          )}
        </div>
      </s-page>
    </>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};

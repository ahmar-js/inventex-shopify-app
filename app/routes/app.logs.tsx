import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useLoaderData, Link } from "react-router";
import { authenticate } from "../shopify.server";
import { boundary } from "@shopify/shopify-app-react-router/server";
import db from "../db.server";

const PER_PAGE = 25;

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;

  const url = new URL(request.url);
  const page = Math.max(1, parseInt(url.searchParams.get("page") ?? "1", 10));

  const [total, logs] = await Promise.all([
    db.inventoryState.count({ where: { shop } }),
    db.inventoryState.findMany({
      where: { shop },
      orderBy: { modifiedAt: "desc" },
      skip: (page - 1) * PER_PAGE,
      take: PER_PAGE,
    }),
  ]);

  const totalPages = Math.max(1, Math.ceil(total / PER_PAGE));

  return {
    page,
    totalPages,
    total,
    logs: logs.map((log) => ({
      id: log.id,
      productId: log.productId,
      action: log.action,
      restored: log.restored,
      error: log.error,
      errorMessage: log.errorMessage ?? null,
      modifiedAt: log.modifiedAt.toISOString(),
      restoredAt: log.restoredAt?.toISOString() ?? null,
    })),
  };
};

export default function Logs() {
  const { logs, page, totalPages, total } = useLoaderData<typeof loader>();

  const prevHref = page > 1 ? `/app/logs?page=${page - 1}` : null;
  const nextHref = page < totalPages ? `/app/logs?page=${page + 1}` : null;

  return (
    <s-page heading="Activity Logs">
      <s-link slot="breadcrumb-actions" href="/app">
        Dashboard
      </s-link>

      <s-section heading="Recent Activity">
        {logs.length === 0 ? (
          <s-box
            padding="base"
            borderWidth="base"
            borderRadius="base"
            background="subdued"
          >
            <s-text color="subdued">
              No activity recorded yet. Logs will appear here once inventory
              automation is active and processes its first event.
            </s-text>
          </s-box>
        ) : (
          <s-stack direction="block" gap="base">
            <s-box borderWidth="base" borderRadius="base">
              <table
                style={{
                  width: "100%",
                  borderCollapse: "collapse",
                  fontSize: "14px",
                }}
              >
                <thead>
                  <tr
                    style={{
                      borderBottom: "1px solid #e1e3e5",
                      textAlign: "left",
                    }}
                  >
                    <th style={{ padding: "12px" }}>Product ID</th>
                    <th style={{ padding: "12px" }}>Action</th>
                    <th style={{ padding: "12px" }}>Status</th>
                    <th style={{ padding: "12px" }}>Modified</th>
                    <th style={{ padding: "12px" }}>Restored</th>
                  </tr>
                </thead>
                <tbody>
                  {logs.map((log) => (
                    <tr
                      key={log.id}
                      style={{
                        borderBottom: "1px solid #f1f2f3",
                        background: log.error ? "#fff4f4" : undefined,
                      }}
                    >
                      <td style={{ padding: "12px" }}>
                        <s-text>
                          {log.productId.replace(
                            "gid://shopify/Product/",
                            "#",
                          )}
                        </s-text>
                      </td>
                      <td style={{ padding: "12px" }}>
                        <s-text>
                          {log.action === "HIDDEN" ? "Hidden" : "Pushed down"}
                        </s-text>
                      </td>
                      <td style={{ padding: "12px" }}>
                        {log.error ? (
                          <s-stack direction="block" gap="small">
                            <s-text tone="critical">Error</s-text>
                            {log.errorMessage && (
                              <s-text color="subdued">
                                {log.errorMessage}
                              </s-text>
                            )}
                          </s-stack>
                        ) : (
                          <s-text tone={log.restored ? "success" : "caution"}>
                            {log.restored ? "Restored" : "Active"}
                          </s-text>
                        )}
                      </td>
                      <td style={{ padding: "12px" }}>
                        <s-text color="subdued">
                          {new Date(log.modifiedAt).toLocaleString()}
                        </s-text>
                      </td>
                      <td style={{ padding: "12px" }}>
                        <s-text color="subdued">
                          {log.restoredAt
                            ? new Date(log.restoredAt).toLocaleString()
                            : "—"}
                        </s-text>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </s-box>

            {/* ── Pagination controls ──────────────────────── */}
            <s-stack direction="inline" gap="base">
              {prevHref ? (
                <Link to={prevHref}>
                  <s-button variant="secondary">← Previous</s-button>
                </Link>
              ) : (
                <s-button variant="secondary" disabled>
                  ← Previous
                </s-button>
              )}

              <s-text color="subdued">
                Page {page} of {totalPages} ({total} total)
              </s-text>

              {nextHref ? (
                <Link to={nextHref}>
                  <s-button variant="secondary">Next →</s-button>
                </Link>
              ) : (
                <s-button variant="secondary" disabled>
                  Next →
                </s-button>
              )}
            </s-stack>
          </s-stack>
        )}
      </s-section>

      <s-section slot="aside" heading="About Logs">
        <s-paragraph>
          Each entry shows the product affected, the action taken by the app,
          whether it has been restored, and the timestamps.
        </s-paragraph>
        <s-paragraph>
          Rows highlighted in red indicate an error occurred. The error message
          is shown below the status label.
        </s-paragraph>
        <s-paragraph>Showing {PER_PAGE} entries per page.</s-paragraph>
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};

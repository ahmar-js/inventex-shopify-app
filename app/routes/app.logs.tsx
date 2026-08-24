import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useLoaderData, useNavigate } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import db from "../db.server";

const PER_PAGE = 25;

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;
  const url = new URL(request.url);
  const page = Math.max(1, parseInt(url.searchParams.get("page") ?? "1", 10));

  const [total, logs, deadLetters, events, metrics] = await Promise.all([
    db.inventoryState.count({ where: { shop } }),
    db.inventoryState.findMany({
      where: { shop },
      orderBy: { modifiedAt: "desc" },
      skip: (page - 1) * PER_PAGE,
      take: PER_PAGE,
    }),
    db.deadLetterJob.findMany({
      where: { shop },
      orderBy: { failedAt: "desc" },
      take: 10,
    }),
    db.operationalEvent.findMany({
      where: { shop, level: "ERROR" },
      orderBy: { createdAt: "desc" },
      take: 10,
    }),
    db.shopifyApiMetric.findMany({
      where: { shop },
      orderBy: { bucketStart: "desc" },
      take: 25,
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
    deadLetters: deadLetters.map((job) => ({
      id: job.id,
      jobId: job.jobId,
      type: job.type,
      attempts: job.attempts,
      lastError: job.lastError,
      failedAt: job.failedAt.toISOString(),
    })),
    events: events.map((event) => ({
      id: event.id,
      source: event.source,
      message: event.message,
      createdAt: event.createdAt.toISOString(),
    })),
    metrics: metrics.map((metric) => ({
      id: metric.id,
      operation: metric.operation,
      outcome: metric.outcome,
      count: metric.count,
      averageDurationMs:
        metric.count > 0
          ? Math.round(Number(metric.totalDurationMs) / metric.count)
          : 0,
      maxDurationMs: metric.maxDurationMs,
      bucketStart: metric.bucketStart.toISOString(),
    })),
  };
};

function formatDate(value: string | null) {
  if (!value) return "Not restored";
  return new Intl.DateTimeFormat("en", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

export default function Logs() {
  const { logs, page, totalPages, total, deadLetters, events, metrics } =
    useLoaderData<typeof loader>();
  const navigate = useNavigate();
  const previousHref = page > 1 ? `/app/logs?page=${page - 1}` : null;
  const nextHref = page < totalPages ? `/app/logs?page=${page + 1}` : null;

  return (
    <s-page heading="Activity logs" inlineSize="large">
      <s-link slot="breadcrumb-actions" href="/app">
        Dashboard
      </s-link>

      <s-stack direction="block" gap="large">
        <s-paragraph>
          Review inventory actions and monitor background processing health.
        </s-paragraph>

        <s-section heading="Inventory activity">
          {logs.length === 0 ? (
            <s-box padding="large" background="subdued">
              <s-stack direction="block" gap="small" alignItems="center">
                <s-heading>No activity yet</s-heading>
                <s-paragraph>
                  Inventory actions will appear after an automation processes a
                  product.
                </s-paragraph>
              </s-stack>
            </s-box>
          ) : (
            <s-table
              variant="auto"
              paginate={totalPages > 1}
              hasPreviousPage={page > 1}
              hasNextPage={page < totalPages}
              onPreviousPage={() =>
                previousHref ? navigate(previousHref) : undefined
              }
              onNextPage={() => (nextHref ? navigate(nextHref) : undefined)}
            >
              <s-table-header-row>
                <s-table-header listSlot="primary">Product</s-table-header>
                <s-table-header listSlot="kicker">Action</s-table-header>
                <s-table-header listSlot="inline">Status</s-table-header>
                <s-table-header listSlot="secondary">Modified</s-table-header>
                <s-table-header listSlot="labeled">Restored</s-table-header>
              </s-table-header-row>
              <s-table-body>
                {logs.map((log) => (
                  <s-table-row key={log.id}>
                    <s-table-cell>
                      {log.productId.replace("gid://shopify/Product/", "#")}
                    </s-table-cell>
                    <s-table-cell>
                      {log.action === "HIDDEN" ? "Hidden" : "Pushed down"}
                    </s-table-cell>
                    <s-table-cell>
                      <s-stack direction="block" gap="small">
                        <s-badge
                          tone={
                            log.error
                              ? "critical"
                              : log.restored
                                ? "success"
                                : "warning"
                          }
                        >
                          {log.error
                            ? "Error"
                            : log.restored
                              ? "Restored"
                              : "Active"}
                        </s-badge>
                        {log.errorMessage ? (
                          <s-text color="subdued">{log.errorMessage}</s-text>
                        ) : null}
                      </s-stack>
                    </s-table-cell>
                    <s-table-cell>{formatDate(log.modifiedAt)}</s-table-cell>
                    <s-table-cell>{formatDate(log.restoredAt)}</s-table-cell>
                  </s-table-row>
                ))}
              </s-table-body>
            </s-table>
          )}
          {logs.length > 0 ? (
            <s-box padding="base">
              <s-text color="subdued">
                Page {page} of {totalPages} · {total} total entries
              </s-text>
            </s-box>
          ) : null}
        </s-section>

        <s-section heading="Failed jobs">
          {deadLetters.length === 0 ? (
            <s-box padding="base" background="subdued">
              <s-paragraph>No jobs have exhausted their retries.</s-paragraph>
            </s-box>
          ) : (
            <s-table variant="auto">
              <s-table-header-row>
                <s-table-header listSlot="primary">Job type</s-table-header>
                <s-table-header listSlot="inline" format="numeric">
                  Attempts
                </s-table-header>
                <s-table-header listSlot="secondary">Failed</s-table-header>
                <s-table-header listSlot="labeled">Last error</s-table-header>
              </s-table-header-row>
              <s-table-body>
                {deadLetters.map((job) => (
                  <s-table-row key={job.id}>
                    <s-table-cell>
                      <s-stack direction="block" gap="small">
                        <s-text type="strong">{job.type}</s-text>
                        <s-text color="subdued">{job.jobId}</s-text>
                      </s-stack>
                    </s-table-cell>
                    <s-table-cell>{job.attempts}</s-table-cell>
                    <s-table-cell>{formatDate(job.failedAt)}</s-table-cell>
                    <s-table-cell>
                      <s-text tone="critical">
                        {job.lastError ?? "No error message recorded"}
                      </s-text>
                    </s-table-cell>
                  </s-table-row>
                ))}
              </s-table-body>
            </s-table>
          )}
        </s-section>

        <s-section heading="Operational errors">
          {events.length === 0 ? (
            <s-box padding="base" background="subdued">
              <s-paragraph>No operational errors recorded.</s-paragraph>
            </s-box>
          ) : (
            <s-table variant="auto">
              <s-table-header-row>
                <s-table-header listSlot="primary">Source</s-table-header>
                <s-table-header listSlot="secondary">Time</s-table-header>
                <s-table-header listSlot="labeled">Message</s-table-header>
              </s-table-header-row>
              <s-table-body>
                {events.map((event) => (
                  <s-table-row key={event.id}>
                    <s-table-cell>{event.source}</s-table-cell>
                    <s-table-cell>{formatDate(event.createdAt)}</s-table-cell>
                    <s-table-cell>
                      <s-text tone="critical">{event.message}</s-text>
                    </s-table-cell>
                  </s-table-row>
                ))}
              </s-table-body>
            </s-table>
          )}
        </s-section>

        <s-section heading="Shopify API health">
          {metrics.length === 0 ? (
            <s-box padding="base" background="subdued">
              <s-paragraph>No measured API calls yet.</s-paragraph>
            </s-box>
          ) : (
            <s-table variant="auto">
              <s-table-header-row>
                <s-table-header listSlot="primary">Operation</s-table-header>
                <s-table-header listSlot="inline">Outcome</s-table-header>
                <s-table-header listSlot="labeled" format="numeric">
                  Calls
                </s-table-header>
                <s-table-header listSlot="labeled" format="numeric">
                  Average
                </s-table-header>
                <s-table-header listSlot="secondary">Measured</s-table-header>
              </s-table-header-row>
              <s-table-body>
                {metrics.map((metric) => (
                  <s-table-row key={metric.id}>
                    <s-table-cell>{metric.operation}</s-table-cell>
                    <s-table-cell>
                      <s-badge
                        tone={
                          metric.outcome === "SUCCESS" ? "success" : "warning"
                        }
                      >
                        {metric.outcome}
                      </s-badge>
                    </s-table-cell>
                    <s-table-cell>{metric.count}</s-table-cell>
                    <s-table-cell>
                      {metric.averageDurationMs} ms (max {metric.maxDurationMs}{" "}
                      ms)
                    </s-table-cell>
                    <s-table-cell>
                      {formatDate(metric.bucketStart)}
                    </s-table-cell>
                  </s-table-row>
                ))}
              </s-table-body>
            </s-table>
          )}
        </s-section>
      </s-stack>
    </s-page>
  );
}

export const headers: HeadersFunction = (args) => boundary.headers(args);

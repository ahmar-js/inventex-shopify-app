import type { Prisma } from "@prisma/client";
import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";
import db from "../db.server";
import { logger } from "./logger.server";

type ApiOutcome = "SUCCESS" | "ERROR" | "THROTTLED";
const instrumentedAdmins = new WeakSet<object>();

export function instrumentAdminApi(
  admin: AdminApiContext,
  shop: string,
): AdminApiContext {
  if (instrumentedAdmins.has(admin)) return admin;
  const measuredAdmin: AdminApiContext = {
    graphql: (async (operation, options) => {
      const startedAt = Date.now();
      let outcome: ApiOutcome = "SUCCESS";
      try {
        return await admin.graphql(operation, options);
      } catch (error) {
        outcome = isThrottleError(error) ? "THROTTLED" : "ERROR";
        throw error;
      } finally {
        await recordShopifyApiMetric({
          shop,
          operation: graphqlOperationName(String(operation)),
          outcome,
          durationMs: Date.now() - startedAt,
        });
      }
    }) as AdminApiContext["graphql"],
  };
  instrumentedAdmins.add(measuredAdmin);
  return measuredAdmin;
}

export async function captureOperationalError(input: {
  shop: string;
  source: string;
  message: string;
  error?: unknown;
  context?: Record<string, unknown>;
}) {
  const context = sanitizeContext({
    ...input.context,
    ...(input.error === undefined
      ? {}
      : { error: serializeError(input.error) }),
  });

  try {
    await db.operationalEvent.create({
      data: {
        shop: input.shop,
        level: "ERROR",
        source: input.source,
        message: input.message.slice(0, 1_000),
        context: context as Prisma.InputJsonValue,
      },
    });
  } catch (error) {
    logger.error("Operational event persistence failed", {
      shop: input.shop,
      reason: input.source,
      error,
    });
  }
}

export function graphqlOperationName(document: string) {
  return (
    document.match(/\b(?:query|mutation)\s+([_A-Za-z][_0-9A-Za-z]*)/)?.[1] ??
    "anonymous"
  );
}

async function recordShopifyApiMetric(input: {
  shop: string;
  operation: string;
  outcome: ApiOutcome;
  durationMs: number;
}) {
  const bucketStart = new Date();
  bucketStart.setUTCSeconds(0, 0);
  const durationMs = Math.max(0, Math.round(input.durationMs));

  try {
    await db.$executeRaw`
      INSERT INTO "ShopifyApiMetric"
        ("shop", "operation", "outcome", "bucketStart", "count", "totalDurationMs", "maxDurationMs", "updatedAt")
      VALUES
        (${input.shop}, ${input.operation}, ${input.outcome}, ${bucketStart}, 1, ${BigInt(durationMs)}, ${durationMs}, NOW())
      ON CONFLICT ("shop", "operation", "outcome", "bucketStart")
      DO UPDATE SET
        "count" = "ShopifyApiMetric"."count" + 1,
        "totalDurationMs" = "ShopifyApiMetric"."totalDurationMs" + EXCLUDED."totalDurationMs",
        "maxDurationMs" = GREATEST("ShopifyApiMetric"."maxDurationMs", EXCLUDED."maxDurationMs"),
        "updatedAt" = NOW()
    `;
  } catch (error) {
    logger.warn("Shopify API metric persistence failed", {
      shop: input.shop,
      reason: input.operation,
      error,
    });
  }
}

function isThrottleError(error: unknown) {
  if (!error || typeof error !== "object") return false;
  const candidate = error as {
    status?: number;
    statusCode?: number;
    code?: string;
    message?: string;
    response?: { status?: number };
  };
  return (
    candidate.status === 429 ||
    candidate.statusCode === 429 ||
    candidate.response?.status === 429 ||
    candidate.code === "THROTTLED" ||
    /\b(?:429|THROTTLED)\b/i.test(candidate.message ?? "")
  );
}

function serializeError(error: unknown) {
  return error instanceof Error
    ? { name: error.name, message: error.message }
    : { message: String(error) };
}

function sanitizeContext(value: Record<string, unknown>) {
  return JSON.parse(
    JSON.stringify(value, (key, item) =>
      /access.?token|api.?secret|authorization/i.test(key)
        ? "[REDACTED]"
        : item,
    ),
  ) as Record<string, unknown>;
}

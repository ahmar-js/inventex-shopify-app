import type { ActionFunctionArgs } from "react-router";
import {
  authorizeCronRequest,
  jsonResponse,
} from "../services/cron-auth.server";
import { runJobBatch } from "../services/jobs.server";
import { logger } from "../services/logger.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const unauthorized = authorizeCronRequest(request);
  if (unauthorized) return unauthorized;

  try {
    const result = await runJobBatch();
    logger.info("Job cron completed", {
      processed: result.processed,
      failed: result.failed,
      deferred: result.deferred,
    });
    return jsonResponse({ ok: true, ...result });
  } catch (error) {
    logger.error("Job cron failed", { error });
    return jsonResponse({ ok: false, error: "Job worker failed" }, 500);
  }
};

export const loader = () => jsonResponse({ error: "Method not allowed" }, 405);

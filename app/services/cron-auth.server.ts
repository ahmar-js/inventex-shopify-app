import { logger } from "./logger.server";

export function authorizeCronRequest(request: Request): Response | null {
  const secret = process.env.CRON_SECRET;

  if (!secret) {
    if (process.env.NODE_ENV === "production") {
      logger.error("Cron request rejected because CRON_SECRET is not configured");
      return jsonResponse({ error: "Cron is not configured" }, 503);
    }

    logger.warn("CRON_SECRET is not set; allowing cron request outside production");
    return null;
  }

  const authorization = request.headers.get("Authorization") ?? "";
  const provided = authorization.startsWith("Bearer ")
    ? authorization.slice(7)
    : "";

  if (!constantTimeEqual(provided, secret)) {
    return jsonResponse({ error: "Unauthorized" }, 401);
  }

  return null;
}

export function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function constantTimeEqual(a: string, b: string): boolean {
  const maxLength = Math.max(a.length, b.length);
  let difference = a.length === b.length ? 0 : 1;

  for (let index = 0; index < maxLength; index++) {
    difference |= (a.charCodeAt(index) || 0) ^ (b.charCodeAt(index) || 0);
  }

  return difference === 0;
}

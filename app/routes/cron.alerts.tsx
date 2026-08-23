/**
 * POST /cron/alerts
 *
 * Flushes the AlertQueue — groups pending DAILY/WEEKLY alerts by shop,
 * checks whether each shop is due for a digest, and sends it.
 *
 * Secured by a bearer token so only your cron service can call it.
 * Set the env var:  CRON_SECRET=<a long random string>
 *
 * Example cron (cron-job.org / EasyCron / Render cron jobs):
 *   URL:    https://your-app.fly.dev/cron/alerts
 *   Method: POST
 *   Header: Authorization: Bearer <CRON_SECRET>
 *   Schedule: every 30 minutes (so the ±30-min window in alerts.server works)
 */

import type { ActionFunctionArgs } from "react-router";
import { flushAlertQueue } from "../services/alerts.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  // ── Authorization ──────────────────────────────────────────
  const cronSecret = process.env.CRON_SECRET;

  if (!cronSecret) {
    console.warn("[cron/alerts] CRON_SECRET not set — endpoint is unprotected.");
  } else {
    const authHeader = request.headers.get("Authorization") ?? "";
    const provided   = authHeader.startsWith("Bearer ")
      ? authHeader.slice(7)
      : null;

    // Constant-time comparison to prevent timing attacks
    if (!provided || !timingSafeEqual(provided, cronSecret)) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status:  401,
        headers: { "Content-Type": "application/json" },
      });
    }
  }

  // ── Flush queue ────────────────────────────────────────────
  try {
    const result = await flushAlertQueue();
    console.log(`[cron/alerts] Flushed ${result.processed} queued alert(s).`);

    return new Response(
      JSON.stringify({ ok: true, processed: result.processed }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  } catch (err: any) {
    console.error("[cron/alerts] Flush failed:", err);
    return new Response(
      JSON.stringify({ ok: false, error: err?.message ?? "Unknown error" }),
      { status: 500, headers: { "Content-Type": "application/json" } },
    );
  }
};

// Only allow POST
export const loader = () =>
  new Response(JSON.stringify({ error: "Method not allowed" }), {
    status:  405,
    headers: { "Content-Type": "application/json" },
  });

// ─── Helpers ─────────────────────────────────────────────────

/**
 * Constant-time string comparison to prevent timing-based attacks.
 * Uses XOR-based comparison so the time taken doesn't reveal the secret length.
 */
function timingSafeEqual(a: string, b: string): boolean {
  // Pad the shorter string so length doesn't leak which side is shorter
  const maxLen = Math.max(a.length, b.length);
  let result   = a.length === b.length ? 0 : 1; // fail-fast if lengths differ

  for (let i = 0; i < maxLen; i++) {
    const ca = a.charCodeAt(i) || 0;
    const cb = b.charCodeAt(i) || 0;
    // bitwise OR accumulates differences without short-circuiting
    result |= ca ^ cb;
  }

  return result === 0;
}

import assert from "node:assert/strict";
import test from "node:test";
import {
  hasTag,
  hideAutomationDecision,
  hideRunAfter,
  normalizeRedirectPath,
  redirectTarget,
} from "../app/services/hide.ts";

test("hide delay is calculated from the original sold-out transition", () => {
  const soldOutAt = new Date("2026-08-20T12:00:00.000Z");
  assert.equal(
    hideRunAfter(soldOutAt, 0).toISOString(),
    soldOutAt.toISOString(),
  );
  assert.equal(
    hideRunAfter(soldOutAt, 3).toISOString(),
    "2026-08-23T12:00:00.000Z",
  );
});

test("restock, continue-selling, and ignored products never hide", () => {
  for (const input of [
    { status: "inStock", ignored: false },
    { status: "continueSelling", ignored: false },
    { status: "soldOut", ignored: true },
  ]) {
    assert.equal(
      hideAutomationDecision({
        hideEnabled: true,
        activelyHidden: false,
        ...input,
      }),
      "none",
    );
    assert.equal(
      hideAutomationDecision({
        hideEnabled: true,
        activelyHidden: true,
        ...input,
      }),
      "unhide",
    );
  }
});

test("sold-out products hide only while automation is enabled", () => {
  assert.equal(
    hideAutomationDecision({
      hideEnabled: true,
      status: "soldOut",
      ignored: false,
      activelyHidden: false,
    }),
    "hide",
  );
  assert.equal(
    hideAutomationDecision({
      hideEnabled: false,
      status: "soldOut",
      ignored: false,
      activelyHidden: true,
    }),
    "unhide",
  );
});

test("redirects are limited to safe same-store paths", () => {
  assert.equal(redirectTarget("none", "/collections/all"), null);
  assert.equal(redirectTarget("home", "/collections/all"), "/");
  assert.equal(
    redirectTarget("custom", " /collections/all "),
    "/collections/all",
  );
  assert.throws(() => normalizeRedirectPath("https://example.com"));
  assert.throws(() => normalizeRedirectPath("//example.com"));
});

test("Inventex tags are detected case-insensitively", () => {
  assert.equal(hasTag(["Inventex-Hidden"], "inventex-hidden"), true);
  assert.equal(hasTag(["Other"], "inventex-hidden"), false);
});

import assert from "node:assert/strict";
import { test } from "vitest";
import {
  variantHideCatalogEligible,
  variantHideDecision,
} from "../app/services/variant-hide.ts";

const decision = (overrides = {}) =>
  variantHideDecision({
    enabled: true,
    eligible: true,
    ignored: false,
    status: "soldOut",
    activelyHidden: false,
    ...overrides,
  });

test("only sold-out variants are hidden", () => {
  assert.equal(decision(), "hide");
  assert.equal(decision({ status: "inStock" }), "none");
  assert.equal(decision({ status: "continueSelling" }), "none");
});

test("restock and continue-selling restore app-hidden variants", () => {
  assert.equal(decision({ status: "inStock", activelyHidden: true }), "unhide");
  assert.equal(
    decision({ status: "continueSelling", activelyHidden: true }),
    "unhide",
  );
});

test("disabled, ignored, or ineligible automation restores owned variants", () => {
  assert.equal(decision({ enabled: false, activelyHidden: true }), "unhide");
  assert.equal(decision({ ignored: true, activelyHidden: true }), "unhide");
  assert.equal(decision({ eligible: false, activelyHidden: true }), "unhide");
});

test("variant hide beta limit is 500 published products", () => {
  assert.equal(variantHideCatalogEligible(500), true);
  assert.equal(variantHideCatalogEligible(501), false);
});

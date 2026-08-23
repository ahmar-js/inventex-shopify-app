import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

const source = await readFile(
  new URL("../app/services/availability.ts", import.meta.url),
  "utf8",
);
const transpiled = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.ESNext,
    target: ts.ScriptTarget.ES2022,
  },
}).outputText;
const { classifyProductAvailability } = await import(
  `data:text/javascript;base64,${Buffer.from(transpiled).toString("base64")}`
);

const online = (available, name = "Warehouse") => ({
  locationId: `gid://shopify/Location/${name}`,
  locationName: name,
  fulfillsOnlineOrders: true,
  available,
});

const posOnly = (available) => ({
  locationId: "gid://shopify/Location/POS-only",
  locationName: "POS only",
  fulfillsOnlineOrders: false,
  available,
});

const variant = (overrides = {}) => ({
  variantId: "gid://shopify/ProductVariant/1",
  title: "Default Title",
  inventoryPolicy: "DENY",
  tracked: true,
  locations: [online(0)],
  ...overrides,
});

const classify = (overrides = {}) =>
  classifyProductAvailability({
    variants: [variant()],
    tags: [],
    excluded: false,
    sortContinueSellingAsOos: false,
    evaluatedAt: new Date("2026-08-23T00:00:00.000Z"),
    ...overrides,
  });

test("one in-stock variant keeps a multi-variant product in stock", () => {
  const result = classify({
    variants: [
      variant(),
      variant({ variantId: "variant-2", locations: [online(2)] }),
    ],
  });
  assert.equal(result.status, "inStock");
  assert.equal(result.variants[1].onlineQuantity, 2);
});

test("stock at a POS location that fulfills online orders counts", () => {
  const result = classify({
    variants: [
      variant({ locations: [online(0), online(3, "POS and online pickup")] }),
    ],
  });
  assert.equal(result.status, "inStock");
  assert.equal(result.variants[0].onlineQuantity, 3);
});

test("stock at a POS-only location does not count as online availability", () => {
  const result = classify({
    variants: [variant({ locations: [online(0), posOnly(5)] })],
  });
  assert.equal(result.status, "soldOut");
  assert.equal(result.variants[0].onlineQuantity, 0);
  assert.equal(result.variants[0].totalQuantity, 5);
});

test("continue-selling is available by default and separate when configured", () => {
  const variants = [variant({ inventoryPolicy: "CONTINUE" })];
  assert.equal(classify({ variants }).status, "inStock");
  assert.equal(
    classify({ variants, sortContinueSellingAsOos: true }).status,
    "continueSelling",
  );
});

test("inventex-ignore tag sets the ignore flag case-insensitively", () => {
  const result = classify({ tags: ["Seasonal", "Inventex-Ignore"] });
  assert.equal(result.ignored, true);
  assert.equal(result.ignoreReason, "tag");
});

test("ExcludedProduct sets the ignore flag", () => {
  const result = classify({ excluded: true });
  assert.equal(result.ignored, true);
  assert.equal(result.ignoreReason, "excludedProduct");
});

test("untracked inventory is always treated as in stock", () => {
  const result = classify({
    variants: [variant({ tracked: false, locations: [] })],
  });
  assert.equal(result.status, "inStock");
});

test("soldOutAt starts once and is preserved while the product remains sold out", () => {
  const previous = new Date("2026-08-20T00:00:00.000Z");
  const result = classify({ previousSoldOutAt: previous });
  assert.equal(result.status, "soldOut");
  assert.equal(result.soldOutAt.toISOString(), previous.toISOString());
});

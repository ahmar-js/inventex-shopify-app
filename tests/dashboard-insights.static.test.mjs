import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const source = readFileSync(
  new URL("../app/routes/app._index.tsx", import.meta.url),
  "utf8",
);

describe("dashboard insights", () => {
  it("uses real shop-scoped inventory data", () => {
    expect(source).toContain("db.productAvailabilityState.count");
    expect(source).toContain('status: "soldOut"');
    expect(source).toContain('status: "continueSelling"');
    expect(source).toContain('action: "PUSHED_DOWN"');
    expect(source).toContain("restoredAt: { gte: sevenDaysAgo }");
    expect(source).toContain("db.excludedProduct.count({ where: { shop } })");
  });

  it("shows useful metrics and a prioritized recommendation", () => {
    expect(source).toContain('heading="Store insights"');
    expect(source).toContain('label="Sold-out detected"');
    expect(source).toContain('label="Sorted down now"');
    expect(source).toContain('label="Restocked in 7 days"');
    expect(source).toContain('label="Ignored products"');
    expect(source).toContain("function DashboardRecommendation");
  });
});

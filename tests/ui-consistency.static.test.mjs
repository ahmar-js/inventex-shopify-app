import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const route = (name) =>
  readFileSync(new URL(`../app/routes/${name}`, import.meta.url), "utf8");

describe("Shopify-native UI", () => {
  it("keeps the requested navigation order", () => {
    const source = route("app.tsx");
    const labels = [
      "Dashboard",
      "Sort Collections",
      "Hide Products",
      "Alerts",
      "Plans",
      "Activity Logs",
      "Settings",
    ];
    const positions = labels.map((label) =>
      source.indexOf(`>${label}</s-link>`),
    );

    expect(positions.every((position) => position >= 0)).toBe(true);
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
  });

  it("uses responsive Shopify tables for collection sorting and logs", () => {
    for (const file of ["app.sort-collection.tsx", "app.logs.tsx"]) {
      const source = route(file);
      expect(source).toMatch(/<s-table[\s\S]*?variant="auto"/);
      expect(source).not.toMatch(/<table[\s>]/);
    }
  });

  it("does not inject custom page styles", () => {
    const files = [
      "app._index.tsx",
      "app.alerts.tsx",
      "app.billing.tsx",
      "app.hide.tsx",
      "app.logs.tsx",
      "app.settings.tsx",
      "app.sort-collection.tsx",
    ];

    for (const file of files) {
      const source = route(file);
      expect(source).not.toContain("dangerouslySetInnerHTML");
      expect(source).not.toMatch(/<style[\s>]/);
    }
  });
});

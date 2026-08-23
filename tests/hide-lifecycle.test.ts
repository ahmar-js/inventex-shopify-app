import assert from "node:assert/strict";
import { beforeEach, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  settingsFind: vi.fn(),
  settingsUpsert: vi.fn(),
  inventoryFind: vi.fn(),
  inventoryUpsert: vi.fn(),
  inventoryUpdate: vi.fn(),
  inventoryUpdateMany: vi.fn(),
  excludedFind: vi.fn(),
}));

vi.mock("../app/db.server", () => ({
  default: {
    shopSettings: {
      findUnique: mocks.settingsFind,
      upsert: mocks.settingsUpsert,
    },
    inventoryState: {
      findUnique: mocks.inventoryFind,
      upsert: mocks.inventoryUpsert,
      update: mocks.inventoryUpdate,
      updateMany: mocks.inventoryUpdateMany,
    },
    excludedProduct: { findUnique: mocks.excludedFind },
  },
}));

vi.mock("../app/services/webhooks.server", () => ({
  cancelPendingProductHide: vi.fn(),
  enqueueHideProduct: vi.fn(),
  enqueueProductEvaluation: vi.fn(),
  enqueueUnhideProduct: vi.fn(),
}));

vi.mock("../app/services/logger.server", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import {
  hideProductFromOnlineStore,
  unhideProductToOnlineStore,
} from "../app/services/hide.server";

const response = (body: unknown) =>
  new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
  });

beforeEach(() => {
  for (const mock of Object.values(mocks)) mock.mockReset();
  mocks.inventoryUpsert.mockResolvedValue({});
  mocks.inventoryUpdate.mockResolvedValue({});
  mocks.inventoryUpdateMany.mockResolvedValue({ count: 0 });
  mocks.settingsUpsert.mockResolvedValue({});
});

test("hide and restock reverse Online Store publication, tag, and redirect", async () => {
  const graphql = vi.fn(
    async (
      document: string,
      options?: {
        variables: {
          input?: Array<{ publicationId: string }>;
          urlRedirect?: { path: string; target: string };
          [key: string]: unknown;
        };
      },
    ) => {
      void options;
      if (document.includes("inventexProductHideContext")) {
        return response({
          data: {
            product: {
              id: "gid://shopify/Product/1",
              title: "Test product",
              handle: "test-product",
              tags: graphql.mock.calls.length < 5 ? [] : ["inventex-hidden"],
              publishedOnPublication: graphql.mock.calls.length < 5,
            },
          },
        });
      }
      if (document.includes("inventexUnpublishOnlineStore")) {
        return response({ data: { publishableUnpublish: { userErrors: [] } } });
      }
      if (document.includes("inventexAddHiddenTag")) {
        return response({ data: { tagsAdd: { userErrors: [] } } });
      }
      if (document.includes("inventexCreateProductRedirect")) {
        return response({
          data: {
            urlRedirectCreate: {
              urlRedirect: { id: "gid://shopify/UrlRedirect/1" },
              userErrors: [],
            },
          },
        });
      }
      if (document.includes("inventexPublishOnlineStore")) {
        return response({ data: { publishablePublish: { userErrors: [] } } });
      }
      if (document.includes("inventexDeleteProductRedirect")) {
        return response({
          data: { urlRedirectDelete: { userErrors: [] } },
        });
      }
      if (document.includes("inventexRemoveHiddenTag")) {
        return response({ data: { tagsRemove: { userErrors: [] } } });
      }
      throw new Error(`Unexpected GraphQL operation: ${document}`);
    },
  );
  const admin = { graphql } as never;

  mocks.settingsFind
    .mockResolvedValueOnce({
      hideEnabled: true,
      redirectMode: "custom",
      redirectPath: "/collections/all",
    })
    .mockResolvedValueOnce({
      onlineStorePublicationId: "gid://shopify/Publication/online-store",
    })
    .mockResolvedValueOnce({
      onlineStorePublicationId: "gid://shopify/Publication/online-store",
    });
  mocks.inventoryFind.mockResolvedValueOnce(null).mockResolvedValueOnce({
    action: "HIDDEN",
    restored: false,
    redirectId: "gid://shopify/UrlRedirect/1",
  });
  mocks.excludedFind.mockResolvedValue(null);

  const hidden = await hideProductFromOnlineStore(
    admin,
    "alpha.myshopify.com",
    "gid://shopify/Product/1",
  );
  const restored = await unhideProductToOnlineStore(
    admin,
    "alpha.myshopify.com",
    "gid://shopify/Product/1",
  );

  assert.deepEqual(hidden, {
    changed: true,
    redirectId: "gid://shopify/UrlRedirect/1",
  });
  assert.deepEqual(restored, { changed: true });
  const operations = graphql.mock.calls.map(
    ([document]) => document.match(/\b(?:query|mutation)\s+(\w+)/)?.[1],
  );
  assert.deepEqual(operations, [
    "inventexProductHideContext",
    "inventexUnpublishOnlineStore",
    "inventexAddHiddenTag",
    "inventexCreateProductRedirect",
    "inventexProductHideContext",
    "inventexPublishOnlineStore",
    "inventexDeleteProductRedirect",
    "inventexRemoveHiddenTag",
  ]);
  const unpublishVariables = graphql.mock.calls[1]?.[1]?.variables;
  assert.ok(unpublishVariables);
  assert.deepEqual(unpublishVariables.input, [
    { publicationId: "gid://shopify/Publication/online-store" },
  ]);
  const redirect = graphql.mock.calls[3]?.[1]?.variables.urlRedirect;
  assert.ok(redirect);
  assert.equal(redirect.path, "/products/test-product");
  assert.equal(redirect.target, "/collections/all");
  assert.ok(
    mocks.inventoryUpdate.mock.calls.some(
      ([input]) => input.data.redirectId === null,
    ),
  );
  assert.ok(
    mocks.inventoryUpdate.mock.calls.some(
      ([input]) => input.data.restored === true,
    ),
  );
});

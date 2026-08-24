import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { Outlet, useLoaderData, useRouteError } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { AppProvider } from "@shopify/shopify-app-react-router/react";

import { authenticate } from "../shopify.server";
import { getBillingAccess } from "../services/billing.server";
import { billingAccessMessage } from "../services/billing";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const billing = await getBillingAccess({ admin, session });

  // eslint-disable-next-line no-undef
  return {
    apiKey: process.env.SHOPIFY_API_KEY || "",
    billing,
    billingMessage: billingAccessMessage(billing),
  };
};

export default function App() {
  const { apiKey, billing, billingMessage } = useLoaderData<typeof loader>();

  return (
    <AppProvider apiKey={apiKey}>
      <s-app-nav>
        <s-link href="/app">Dashboard</s-link>
        <s-link href="/app/sort-collection">Sort Collections</s-link>
        <s-link href="/app/hide">Hide Products</s-link>
        <s-link href="/app/alerts">Alerts</s-link>
        <s-link href="/app/billing">Plans</s-link>
        <s-link href="/app/logs">Activity Logs</s-link>
        <s-link href="/app/settings">Settings</s-link>
      </s-app-nav>
      {!billing.accessAllowed && (
        <s-box padding="base">
          <s-banner tone="warning">
            {billingMessage} <s-link href="/app/billing">View plans</s-link>
          </s-banner>
        </s-box>
      )}
      <Outlet />
    </AppProvider>
  );
}

// Shopify needs React Router to catch some thrown responses, so that their headers are included in the response.
export function ErrorBoundary() {
  return boundary.error(useRouteError());
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};

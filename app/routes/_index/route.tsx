import type { LoaderFunctionArgs, MetaFunction } from "react-router";
import { redirect } from "react-router";

import styles from "../../public-page.module.css";

export const meta: MetaFunction = () => [
  { title: "Inventex — Inventory automation for Shopify" },
  {
    name: "description",
    content:
      "Sort and hide sold-out Shopify products and receive inventory alerts.",
  },
];

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const url = new URL(request.url);

  if (url.searchParams.get("shop")) {
    throw redirect(`/app?${url.searchParams.toString()}`);
  }

  return null;
};

export default function App() {
  return (
    <main className={styles.page}>
      <div className={styles.content}>
        <h1>Keep sold-out products under control</h1>
        <p>
          Inventex automatically sorts unavailable products last, hides them
          from the Online Store when you choose, and sends inventory alerts.
        </p>
        <ul className={styles.features}>
          <li>
            <strong>Collection sorting</strong>
            <br />
            Keep available products first while preserving your chosen order.
          </li>
          <li>
            <strong>Safe product hiding</strong>
            <br />
            Unpublish from Online Store only, with optional redirects and
            automatic restoration.
          </li>
          <li>
            <strong>Stock alerts</strong>
            <br />
            Receive batched, daily, or weekly low-stock notifications.
          </li>
        </ul>
        <p>
          Install and open Inventex from its Shopify App Store listing or from
          the Apps section of your Shopify admin.
        </p>
        <footer className={styles.footer}>
          <a href="/privacy">Privacy policy</a>
          <a href="/support">Support</a>
        </footer>
      </div>
    </main>
  );
}

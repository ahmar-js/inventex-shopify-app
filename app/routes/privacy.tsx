import type { MetaFunction } from "react-router";
import { useLoaderData } from "react-router";
import styles from "../public-page.module.css";

export const meta: MetaFunction = () => [
  { title: "Privacy Policy — Inventex" },
  { name: "description", content: "Inventex privacy policy." },
];

export const loader = () => ({
  supportEmail: process.env.SUPPORT_EMAIL?.trim() || null,
});

export default function PrivacyPolicy() {
  const { supportEmail } = useLoaderData<typeof loader>();

  return (
    <main className={styles.page}>
      <article className={styles.content}>
        <h1>Inventex Privacy Policy</h1>
        <p>Last updated: August 23, 2026</p>

        <h2>Information we process</h2>
        <p>
          Inventex processes the Shopify store domain, authenticated app session
          data, product, variant, collection, inventory, location, publication,
          redirect, billing, and automation data required to provide its
          features. If stock alerts are enabled, we also store the recipient
          email addresses supplied by the merchant. Operational logs contain
          resource identifiers and errors, never Shopify access tokens.
        </p>
        <p>
          Inventex does not require buyer profile or payment-card data and does
          not track storefront visitors.
        </p>

        <h2>How we use information</h2>
        <p>
          We use this information only to authenticate the store, evaluate
          availability, sort collections, publish or unpublish catalog items,
          manage redirects, send configured alerts, enforce billing, diagnose
          failures, and protect the service.
        </p>

        <h2>Service providers and disclosure</h2>
        <p>
          Information is shared only with Shopify and the infrastructure,
          database, monitoring, and email-delivery providers needed to operate
          Inventex. We do not sell merchant or customer data.
        </p>

        <h2>Retention and deletion</h2>
        <p>
          Store data is retained while the app is installed and as needed to
          provide the service. After uninstall, Shopify sends the mandatory
          shop-redaction request and Inventex deletes shop-scoped application,
          session, job, alert, inventory, billing, and operational records.
          Provider backups may remain for their limited backup-retention period.
        </p>

        <h2>Security and merchant choices</h2>
        <p>
          We use authenticated Shopify sessions, least-purpose scopes, isolated
          shop data, and restricted production secrets. Merchants can disable
          automation, change alert recipients, or uninstall the app. Shopify
          privacy webhooks are used to process access and deletion requests.
        </p>

        <h2>Contact</h2>
        <p>
          Questions or privacy requests can be sent through the support contact
          on the Inventex Shopify App Store listing
          {supportEmail ? (
            <>
              {" "}
              or to <a href={`mailto:${supportEmail}`}>{supportEmail}</a>
            </>
          ) : null}
          .
        </p>

        <footer className={styles.footer}>
          <a href="/">Inventex</a>
          <a href="/support">Support</a>
        </footer>
      </article>
    </main>
  );
}

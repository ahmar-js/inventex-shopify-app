import type { MetaFunction } from "react-router";
import { useLoaderData } from "react-router";
import styles from "../public-page.module.css";

export const meta: MetaFunction = () => [
  { title: "Support — Inventex" },
  { name: "description", content: "Get support for Inventex." },
];

export const loader = () => ({
  supportEmail: process.env.SUPPORT_EMAIL?.trim() || null,
});

export default function Support() {
  const { supportEmail } = useLoaderData<typeof loader>();

  return (
    <main className={styles.page}>
      <article className={styles.content}>
        <h1>Inventex Support</h1>
        <p>
          Include your myshopify.com store domain, the affected product or
          collection, what you expected, and the approximate time of the issue.
          Never send an Admin API access token.
        </p>
        {supportEmail ? (
          <p>
            Email <a href={`mailto:${supportEmail}`}>{supportEmail}</a>.
          </p>
        ) : (
          <p>
            Contact us using the support link on the Inventex Shopify App Store
            listing.
          </p>
        )}
        <footer className={styles.footer}>
          <a href="/">Inventex</a>
          <a href="/privacy">Privacy policy</a>
        </footer>
      </article>
    </main>
  );
}

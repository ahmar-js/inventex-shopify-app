# Inventex App Store readiness

This checklist records repository evidence and the manual work that must be
completed against the production deployment and Shopify Partner Dashboard.

## Production listing values

- Set `SHOPIFY_APP_URL` to the final HTTPS origin.
- Replace `https://example.com` in `shopify.app.toml` with that origin and set
  the production OAuth callback before running `shopify app deploy`.
- Set `SUPPORT_EMAIL` and use the same monitored address in the App Store
  listing and emergency developer contact.
- Privacy policy URL: `${SHOPIFY_APP_URL}/privacy`.
- Support URL: `${SHOPIFY_APP_URL}/support`.
- Published language: English only.
- Sales channel requirement: Online Store is required for hide, redirects, and
  variant-hide; sorting and alerts still run without a theme integration.
- Add accurate pricing and the seven-day trial only in Shopify's pricing fields.

The privacy policy is a technical starting point, not legal advice. Review it
for the business entity, physical address, hosting regions, subprocessors, and
applicable retention rules before submission.

## Built for Shopify / App Store technical checklist

- [x] Embedded app and latest App Bridge loaded by the Shopify React Router
      `AppProvider`.
- [x] Session-token and token-exchange authentication from Shopify's template.
- [x] No manual shop-domain installation form or blocking off-platform login.
- [x] GraphQL Admin API only; app and webhook API version are `2026-07`.
- [x] Shopify admin UI uses Polaris web components.
- [x] Mandatory compliance webhooks and shop-scoped deletion exist.
- [x] Background Shopify work is queued, throttled, retried, and dead-lettered.
- [x] Per-shop Shopify API latency/outcome metrics and operational errors are
      visible under Activity Logs.
- [x] Public privacy and support routes exist.
- [ ] Replace the placeholder production application and redirect URLs in TOML.
- [ ] Confirm every requested scope with reviewer instructions and screenshots.
- [ ] Run desktop and mobile accessibility/UI review with production data.
- [ ] Confirm Web Vitals targets in the Partner Dashboard after enough traffic.
- [ ] Add an English demo screencast with setup and core feature testing steps.
- [ ] Add current test credentials/instructions and emergency developer contact.
- [ ] Complete Shopify's automated Distribution checks and submit for review.
- [ ] Meet Shopify's merchant-utility prerequisites before applying for the
      separate Built for Shopify status.

## Screenshot capture list

Capture actual UI from the staging store; do not use mock or generated screens.
Crop out browser chrome and desktop backgrounds, remove store/customer-sensitive
data, and make every image show a distinct feature. Do not include prices,
testimonials, statistics, guarantees, or Shopify trademarks as decoration.

1. `01-dashboard.png` — dashboard automation cards and onboarding complete.
2. `02-collection-sorting.png` — enabled mixed-stock collection using Manual.
3. `03-hide-products.png` — hide settings, redirect choice, and ignored product.
4. `04-inventory-alerts.png` — configured immediate/digest alert settings.
5. `05-activity-operations.png` — activity with healthy API metrics and no
   merchant-sensitive identifiers.

Store final captures in `docs/screenshots/` and upload them through the App Store
listing editor. The repository intentionally does not contain fabricated
screenshots.

## Staging acceptance run

Use a dedicated collection and products whose inventory can safely be changed.
Record the product, collection, timestamps, job IDs, and screenshots in the
release ticket.

- [ ] Fresh install creates Session, default settings, and billing state.
- [ ] Enable sort; sell out a product; cron processes evaluation and sort; the
      product moves to the bottom while Shopify still reports Manual order.
- [ ] Restock the product; cron restores its saved in-stock position.
- [ ] Enable hide with a redirect; sell out a product; verify Online Store-only
      unpublish, `inventex-hidden` tag, and redirect.
- [ ] Restock; verify publication, tag removal, and redirect deletion.
- [ ] Open alerts preview and verify immediate, daily, and weekly examples.
- [ ] Deliver a duplicate webhook and verify only one job is persisted.
- [ ] Uninstall; verify sessions are removed and no product is republished.
- [ ] Deliver authenticated `shop/redact`; verify all shop-owned tables are
      empty, including dead letters, metrics, alerts, jobs, settings, and sessions.

This run is a release gate. Unit/CI success does not replace it.

declare module "*.css";

// ── Shopify App Bridge web components ────────────────────────
declare namespace JSX {
  interface IntrinsicElements {
    "ui-modal":     React.DetailedHTMLProps<React.HTMLAttributes<HTMLElement>, HTMLElement> & { id?: string; };
    "ui-title-bar": React.DetailedHTMLProps<React.HTMLAttributes<HTMLElement>, HTMLElement> & { title?: string; };
  }
}

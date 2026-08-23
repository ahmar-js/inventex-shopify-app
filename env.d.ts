/// <reference types="vite/client" />
/// <reference types="@react-router/node" />

declare namespace NodeJS {
  interface ProcessEnv {
    /** Resend API key — required for email sending */
    RESEND_API_KEY?: string;
    /** Verified sender address shown in alert emails */
    ALERT_FROM_EMAIL?: string;
    /** Bearer token that protects the POST /cron/alerts endpoint */
    CRON_SECRET?: string;
  }
}

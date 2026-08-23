import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useLoaderData, useActionData, useNavigation, useRouteError, Form } from "react-router";
import { useState, useEffect, useRef } from "react";
import { authenticate } from "../shopify.server";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { useAppBridge } from "@shopify/app-bridge-react";
import db from "../db.server";

// ─── Loader ──────────────────────────────────────────────────

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session, admin } = await authenticate.admin(request);
  const shop = session.shop;

  // Fetch the store's primary email from Shopify
  let primaryEmail = "";
  try {
    const res  = await admin.graphql(`#graphql
      query { shop { email } }`);
    const json = await res.json();
    primaryEmail = json.data?.shop?.email ?? "";
  } catch {
    // Non-fatal — fall back to empty string
  }

  const settings = await db.alertSettings.findUnique({ where: { shop } });

  // If the merchant has never saved an email list, seed it with the primary email
  const alertEmails = settings?.alertEmails ?? primaryEmail;

  return {
    lowStockEnabled:    settings?.lowStockEnabled    ?? false,
    alertFrequency:     settings?.alertFrequency     ?? "IMMEDIATE",
    alertEmails,
    dailyAlertHour:     settings?.dailyAlertHour     ?? 9,
    dailyAlertAmPm:     settings?.dailyAlertAmPm     ?? "AM",
    dailyAlertTimezone: settings?.dailyAlertTimezone ?? "America/New_York",
    alertOnLowStock:    settings?.alertOnLowStock    ?? true,
    lowStockThreshold:  settings?.lowStockThreshold  ?? 5,
    alertOnOutOfStock:  settings?.alertOnOutOfStock  ?? true,
    stockCheckLevel:    settings?.stockCheckLevel    ?? "PRODUCT",
  };
};

// ─── Action ──────────────────────────────────────────────────

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop     = session.shop;
  const formData = await request.formData();

  const lowStockEnabled    = formData.get("lowStockEnabled") === "true";
  const alertFrequency     = formData.get("alertFrequency") as string;
  const alertEmails        = ((formData.get("alertEmails") as string) ?? "").trim();
  const dailyAlertHour     = Math.max(1, Math.min(12, parseInt((formData.get("dailyAlertHour") as string) ?? "9", 10) || 9));
  const dailyAlertAmPm     = formData.get("dailyAlertAmPm") === "PM" ? "PM" : "AM";
  const dailyAlertTimezone = (formData.get("dailyAlertTimezone") as string) || "America/New_York";
  const alertOnLowStock    = formData.get("alertOnLowStock") === "true";
  const rawThreshold       = parseInt((formData.get("lowStockThreshold") as string) ?? "5", 10);
  const lowStockThreshold  = isNaN(rawThreshold) ? 5 : Math.max(1, Math.min(5000, rawThreshold));
  const alertOnOutOfStock  = formData.get("alertOnOutOfStock") === "true";
  const rawLevel           = (formData.get("stockCheckLevel") as string) ?? "PRODUCT";
  const stockCheckLevel    = rawLevel === "VARIANT" ? "VARIANT" : "PRODUCT";

  // Must have at least one alert type when alerts are enabled
  if (lowStockEnabled && !alertOnLowStock && !alertOnOutOfStock) {
    return { success: false, error: "Please select at least one alert type (low stock or out of stock)." };
  }

  // Validate emails
  if (alertEmails) {
    const parts = alertEmails.split(",").map((e) => e.trim()).filter(Boolean);
    if (parts.length > 5) {
      return { success: false, error: "You can add up to 5 email addresses." };
    }
    const emailRe = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    const invalid = parts.filter((e) => !emailRe.test(e));
    if (invalid.length > 0) {
      return {
        success: false,
        error: `Invalid email address${invalid.length > 1 ? "es" : ""}: ${invalid.join(", ")}.`,
      };
    }
  }

  // Normalise: trim each address and re-join
  const normalised = alertEmails
    ? alertEmails.split(",").map((e) => e.trim()).filter(Boolean).join(", ")
    : "";

  try {
    await db.alertSettings.upsert({
      where:  { shop },
      update: { lowStockEnabled, alertFrequency, alertEmails: normalised, dailyAlertHour, dailyAlertAmPm, dailyAlertTimezone, alertOnLowStock, lowStockThreshold, alertOnOutOfStock, stockCheckLevel },
      create: { shop, lowStockEnabled, alertFrequency, alertEmails: normalised, dailyAlertHour, dailyAlertAmPm, dailyAlertTimezone, alertOnLowStock, lowStockThreshold, alertOnOutOfStock, stockCheckLevel },
    });
    return { success: true };
  } catch {
    return { success: false, error: "Failed to save alert settings." };
  }
};

// ─── Shared headers ──────────────────────────────────────────

export const headers: HeadersFunction = (args) => boundary.headers(args);

// ─── Helpers ─────────────────────────────────────────────────

const FREQUENCY_OPTIONS = [
  {
    value: "IMMEDIATE",
    label: "Immediately",
    description:
      "Get notified the moment a product goes out of stock or falls below your threshold. Best for stores where stockouts need urgent attention.",
  },
  {
    value: "DAILY",
    label: "Once per day",
    description:
      "Receive one email at your chosen time each day listing all products that went out of stock or fell to a low stock level.",
  },
  {
    value: "WEEKLY",
    label: "Weekly digest",
    description:
      "Get a weekly roundup every Monday morning with all low stock and out-of-stock products from the past 7 days.",
  },
] as const;

// ─── Timezones ───────────────────────────────────────────────

const TIMEZONES: { group: string; zones: { value: string; label: string }[] }[] = [
  {
    group: "UTC",
    zones: [
      { value: "UTC", label: "UTC (+00:00)" },
    ],
  },
  {
    group: "Americas",
    zones: [
      { value: "America/New_York",    label: "Eastern Time — New York (ET)" },
      { value: "America/Chicago",     label: "Central Time — Chicago (CT)" },
      { value: "America/Denver",      label: "Mountain Time — Denver (MT)" },
      { value: "America/Phoenix",     label: "Mountain Time — Phoenix (no DST)" },
      { value: "America/Los_Angeles", label: "Pacific Time — Los Angeles (PT)" },
      { value: "America/Anchorage",   label: "Alaska Time — Anchorage (AKT)" },
      { value: "Pacific/Honolulu",    label: "Hawaii Time — Honolulu (HST)" },
      { value: "America/Toronto",     label: "Eastern Time — Toronto" },
      { value: "America/Vancouver",   label: "Pacific Time — Vancouver" },
      { value: "America/Mexico_City", label: "Central Time — Mexico City" },
      { value: "America/Sao_Paulo",   label: "Brasília Time — São Paulo (BRT)" },
      { value: "America/Argentina/Buenos_Aires", label: "Argentina Time — Buenos Aires (ART)" },
      { value: "America/Bogota",      label: "Colombia Time — Bogotá (COT)" },
      { value: "America/Lima",        label: "Peru Time — Lima (PET)" },
      { value: "America/Santiago",    label: "Chile Time — Santiago (CLT)" },
    ],
  },
  {
    group: "Europe & Africa",
    zones: [
      { value: "Europe/London",    label: "GMT/BST — London" },
      { value: "Europe/Dublin",    label: "GMT/IST — Dublin" },
      { value: "Europe/Lisbon",    label: "WET/WEST — Lisbon" },
      { value: "Europe/Paris",     label: "CET/CEST — Paris" },
      { value: "Europe/Berlin",    label: "CET/CEST — Berlin" },
      { value: "Europe/Amsterdam", label: "CET/CEST — Amsterdam" },
      { value: "Europe/Madrid",    label: "CET/CEST — Madrid" },
      { value: "Europe/Rome",      label: "CET/CEST — Rome" },
      { value: "Europe/Zurich",    label: "CET/CEST — Zurich" },
      { value: "Europe/Stockholm", label: "CET/CEST — Stockholm" },
      { value: "Europe/Warsaw",    label: "CET/CEST — Warsaw" },
      { value: "Europe/Athens",    label: "EET/EEST — Athens" },
      { value: "Europe/Helsinki",  label: "EET/EEST — Helsinki" },
      { value: "Europe/Istanbul",  label: "TRT (+03:00) — Istanbul" },
      { value: "Europe/Moscow",    label: "MSK (+03:00) — Moscow" },
      { value: "Africa/Cairo",     label: "EET (+02:00) — Cairo" },
      { value: "Africa/Johannesburg", label: "SAST (+02:00) — Johannesburg" },
      { value: "Africa/Lagos",     label: "WAT (+01:00) — Lagos" },
      { value: "Africa/Nairobi",   label: "EAT (+03:00) — Nairobi" },
    ],
  },
  {
    group: "Asia & Pacific",
    zones: [
      { value: "Asia/Dubai",       label: "GST (+04:00) — Dubai" },
      { value: "Asia/Karachi",     label: "PKT (+05:00) — Karachi" },
      { value: "Asia/Kolkata",     label: "IST (+05:30) — Mumbai / Delhi" },
      { value: "Asia/Dhaka",       label: "BST (+06:00) — Dhaka" },
      { value: "Asia/Bangkok",     label: "ICT (+07:00) — Bangkok" },
      { value: "Asia/Jakarta",     label: "WIB (+07:00) — Jakarta" },
      { value: "Asia/Singapore",   label: "SGT (+08:00) — Singapore" },
      { value: "Asia/Hong_Kong",   label: "HKT (+08:00) — Hong Kong" },
      { value: "Asia/Shanghai",    label: "CST (+08:00) — Shanghai / Beijing" },
      { value: "Asia/Seoul",       label: "KST (+09:00) — Seoul" },
      { value: "Asia/Tokyo",       label: "JST (+09:00) — Tokyo" },
      { value: "Australia/Perth",  label: "AWST (+08:00) — Perth" },
      { value: "Australia/Adelaide", label: "ACST/ACDT (+09:30) — Adelaide" },
      { value: "Australia/Sydney", label: "AEST/AEDT (+10:00) — Sydney" },
      { value: "Australia/Brisbane", label: "AEST (+10:00) — Brisbane" },
      { value: "Pacific/Auckland", label: "NZST/NZDT (+12:00) — Auckland" },
    ],
  },
];

// ─── Email validation (client-side) ─────────────────────────

function validateEmailsInput(raw: string): string | null {
  if (!raw.trim()) return null;
  const parts = raw.split(",").map((e) => e.trim()).filter(Boolean);
  if (parts.length > 5) return "You can add up to 5 email addresses.";
  const emailRe = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  const invalid = parts.filter((e) => !emailRe.test(e));
  if (invalid.length > 0)
    return `Invalid email address${invalid.length > 1 ? "es" : ""}: ${invalid.join(", ")}.`;
  return null;
}

function countEmails(raw: string): number {
  return raw.trim() ? raw.split(",").map((e) => e.trim()).filter(Boolean).length : 0;
}

// ─── Styles ──────────────────────────────────────────────────

const PAGE_STYLES = `
  .al-toggle-card { display: flex; align-items: flex-start; gap: 14px; padding: 16px 18px; border-radius: 10px; border: 1.5px solid #e1e3e5; background: #fff; cursor: pointer; transition: border-color 0.15s, background 0.15s; }
  .al-toggle-card:hover { border-color: #c1c9d2; background: #fafbfc; }
  .al-toggle-card.active { border-color: #458fff; background: #f0f7ff; }
  .al-freq-card { display: flex; align-items: flex-start; gap: 12px; padding: 14px 16px; border-radius: 9px; border: 1.5px solid #e1e3e5; background: #fff; cursor: pointer; transition: border-color 0.15s, background 0.15s; }
  .al-freq-card:hover { border-color: #c1c9d2; }
  .al-freq-card.selected { border-color: #458fff; background: #f4f9ff; }
  .al-freq-card input[type="radio"] { margin-top: 3px; flex-shrink: 0; accent-color: #458fff; width: 16px; height: 16px; }
  .al-toggle-card input[type="checkbox"] { margin-top: 3px; flex-shrink: 0; accent-color: #458fff; width: 17px; height: 17px; cursor: pointer; }
  .al-saving { opacity: 0.6; pointer-events: none; }
  @keyframes al-fade-in { from { opacity: 0; transform: translateY(-6px); } to { opacity: 1; transform: translateY(0); } }
  @keyframes spin { to { transform: rotate(360deg); } }
  .al-section-appear { animation: al-fade-in 0.2s ease forwards; }
  .al-badge { display: inline-flex; align-items: center; gap: 5px; padding: 3px 10px; border-radius: 20px; font-size: 12px; font-weight: 600; }
  .al-badge-on  { background: #d4edda; color: #195f2e; }
  .al-badge-off { background: #f0f1f3; color: #6d7175; }
  .al-email-input { width: 100%; padding: 9px 12px; border: 1.5px solid #c9cccf; border-radius: 8px; font-size: 14px; color: #1a1c1e; background: #fff; box-sizing: border-box; transition: border-color 0.15s, box-shadow 0.15s; }
  .al-email-input:focus { outline: none; border-color: #458fff; box-shadow: 0 0 0 3px rgba(69,143,255,0.18); }
  .al-email-input.error { border-color: #d72c0d; box-shadow: 0 0 0 3px rgba(215,44,13,0.12); }
  .al-email-counter { font-size: 12px; font-weight: 500; }
  .al-email-counter.ok   { color: #6d7175; }
  .al-email-counter.warn { color: #d72c0d; }
  .al-error-text { font-size: 13px; color: #d72c0d; margin-top: 6px; }
  .al-time-panel { margin-top: 12px; padding: 14px 16px; background: #f7f9fc; border-radius: 8px; border: 1px solid #e1e3e5; }
  .al-time-row { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
  .al-time-select { padding: 7px 10px; border: 1.5px solid #c9cccf; border-radius: 7px; font-size: 14px; color: #1a1c1e; background: #fff; cursor: pointer; transition: border-color 0.15s; appearance: auto; }
  .al-time-select:focus { outline: none; border-color: #458fff; box-shadow: 0 0 0 3px rgba(69,143,255,0.18); }
  .al-tz-select { padding: 7px 10px; border: 1.5px solid #c9cccf; border-radius: 7px; font-size: 14px; color: #1a1c1e; background: #fff; cursor: pointer; transition: border-color 0.15s; appearance: auto; min-width: 240px; flex: 1; }
  .al-tz-select:focus { outline: none; border-color: #458fff; box-shadow: 0 0 0 3px rgba(69,143,255,0.18); }
  .al-time-label { font-size: 13px; color: #6d7175; white-space: nowrap; }
  .al-time-sep { font-size: 15px; color: #6d7175; font-weight: 600; }
  .al-check-card { display: flex; align-items: flex-start; gap: 12px; padding: 14px 16px; border-radius: 9px; border: 1.5px solid #e1e3e5; background: #fff; cursor: pointer; transition: border-color 0.15s, background 0.15s; }
  .al-check-card:hover { border-color: #c1c9d2; }
  .al-check-card.selected { border-color: #458fff; background: #f4f9ff; }
  .al-check-card input[type="checkbox"] { margin-top: 3px; flex-shrink: 0; accent-color: #458fff; width: 16px; height: 16px; }
  .al-threshold-row { display: flex; align-items: center; gap: 10px; margin-top: 10px; flex-wrap: wrap; }
  .al-threshold-input { width: 90px; padding: 7px 10px; border: 1.5px solid #c9cccf; border-radius: 7px; font-size: 14px; color: #1a1c1e; background: #fff; text-align: center; transition: border-color 0.15s, box-shadow 0.15s; }
  .al-threshold-input:focus { outline: none; border-color: #458fff; box-shadow: 0 0 0 3px rgba(69,143,255,0.18); }
  .al-threshold-input.error { border-color: #d72c0d; }
  .al-threshold-hint { font-size: 12px; color: #6d7175; }
  .al-radio-card { display: flex; align-items: flex-start; gap: 12px; padding: 14px 16px; border-radius: 9px; border: 1.5px solid #e1e3e5; background: #fff; cursor: pointer; transition: border-color 0.15s, background 0.15s; }
  .al-radio-card:hover { border-color: #c1c9d2; }
  .al-radio-card.selected { border-color: #458fff; background: #f4f9ff; }
  .al-radio-card input[type="radio"] { margin-top: 3px; flex-shrink: 0; accent-color: #458fff; width: 16px; height: 16px; }
  .al-preview-box { display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 16px 18px; border-radius: 10px; border: 1.5px dashed #c1c9d2; background: #f8f9fa; flex-wrap: wrap; }
  .al-preview-btn { display: inline-flex; align-items: center; gap: 8px; padding: 9px 18px; border-radius: 8px; border: 1.5px solid #458fff; background: #fff; color: #458fff; font-size: 14px; font-weight: 600; cursor: pointer; transition: background 0.15s, color 0.15s; white-space: nowrap; }
  .al-preview-btn:hover { background: #458fff; color: #fff; }
  .al-preview-btn:disabled { opacity: 0.55; cursor: not-allowed; }
  .al-preview-btn svg { flex-shrink: 0; }
`;

// ─── Component ───────────────────────────────────────────────

export default function Alerts() {
  const {
    lowStockEnabled: initialEnabled,
    alertFrequency: initialFreq,
    alertEmails: initialEmails,
    dailyAlertHour: initialHour,
    dailyAlertAmPm: initialAmPm,
    dailyAlertTimezone: initialTz,
    alertOnLowStock: initialAlertOnLowStock,
    lowStockThreshold: initialThreshold,
    alertOnOutOfStock: initialAlertOnOutOfStock,
    stockCheckLevel: initialStockCheckLevel,
  } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const shopify    = useAppBridge();

  const [lowStockEnabled,    setLowStockEnabled]    = useState(initialEnabled);
  const [alertFrequency,     setAlertFrequency]     = useState(initialFreq);
  const [emailsInput,        setEmailsInput]        = useState(initialEmails);
  const [emailError,         setEmailError]         = useState<string | null>(null);
  const [dailyAlertHour,     setDailyAlertHour]     = useState(initialHour);
  const [dailyAlertAmPm,     setDailyAlertAmPm]     = useState(initialAmPm);
  const [dailyAlertTimezone, setDailyAlertTimezone] = useState(initialTz);
  const [alertOnLowStock,    setAlertOnLowStock]    = useState(initialAlertOnLowStock);
  const [lowStockThreshold,  setLowStockThreshold]  = useState(String(initialThreshold));
  const [thresholdError,     setThresholdError]     = useState<string | null>(null);
  const [alertOnOutOfStock,  setAlertOnOutOfStock]  = useState(initialAlertOnOutOfStock);
  const [stockCheckLevel,    setStockCheckLevel]    = useState(initialStockCheckLevel);

  const [isSendingPreview, setIsSendingPreview] = useState(false);

  const lastNavState = useRef(navigation.state);

  // ── Toast on save ────────────────────────────────────────
  useEffect(() => {
    if (lastNavState.current === "submitting" && navigation.state === "idle") {
      if ((actionData as any)?.success === false) {
        shopify.toast.show(
          (actionData as any).error ?? "Failed to save. Please try again.",
          { isError: true },
        );
      } else {
        shopify.toast.show("Alert settings saved.");
      }
    }
    lastNavState.current = navigation.state;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [navigation.state]);

  // ── Send preview email using session token ─────────────────
  const handleSendPreview = async () => {
    setIsSendingPreview(true);
    try {
      const idToken = await shopify.idToken();
      const res = await fetch("/app/alerts/preview", {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "Authorization": `Bearer ${idToken}`,
        },
        body: "_action=send_preview",
      });

      // If the server redirected us to the login page (HTML), surface that clearly
      const contentType = res.headers.get("content-type") ?? "";
      if (!contentType.includes("application/json")) {
        const text = await res.text();
        console.error("[preview] Non-JSON response:", res.status, text.slice(0, 500));
        shopify.toast.show(`Auth error (${res.status}) — check console`, { isError: true });
        return;
      }

      const data = await res.json();
      if (data.previewSent) {
        shopify.toast.show(`Preview sent to ${data.previewEmails}`);
      } else {
        shopify.toast.show(data.previewError ?? "Failed to send preview", { isError: true });
      }
    } catch (err: any) {
      console.error("[preview] fetch error:", err);
      shopify.toast.show(`Preview failed: ${err?.message ?? String(err)}`, { isError: true });
    } finally {
      setIsSendingPreview(false);
    }
  };

  // ── Client-side validation before submit ─────────────────
  const handleSubmit = (e: React.FormEvent<HTMLFormElement>) => {
    let blocked = false;

    const emailErr = validateEmailsInput(emailsInput);
    setEmailError(emailErr);
    if (emailErr) blocked = true;

    if (alertOnLowStock) {
      const n = parseInt(lowStockThreshold, 10);
      if (isNaN(n) || n < 1 || n > 5000) {
        setThresholdError("Enter a number between 1 and 5,000.");
        blocked = true;
      } else {
        setThresholdError(null);
      }
    } else {
      setThresholdError(null);
    }

    if (blocked) e.preventDefault();
  };

  const isSaving   = navigation.state === "submitting";
  const emailCount = countEmails(emailsInput);

  return (
    <>
      <style dangerouslySetInnerHTML={{ __html: PAGE_STYLES }} />

      <Form method="post" onSubmit={handleSubmit}>
        {/* Hidden inputs carry controlled-state values on submit */}
        <input type="hidden" name="lowStockEnabled"    value={String(lowStockEnabled)} />
        <input type="hidden" name="alertFrequency"     value={alertFrequency} />
        <input type="hidden" name="dailyAlertHour"     value={String(dailyAlertHour)} />
        <input type="hidden" name="dailyAlertAmPm"     value={dailyAlertAmPm} />
        <input type="hidden" name="dailyAlertTimezone" value={dailyAlertTimezone} />
        <input type="hidden" name="alertOnLowStock"    value={String(alertOnLowStock)} />
        <input type="hidden" name="lowStockThreshold"  value={lowStockThreshold} />
        <input type="hidden" name="alertOnOutOfStock"  value={String(alertOnOutOfStock)} />
        <input type="hidden" name="stockCheckLevel"    value={stockCheckLevel} />

        <s-page heading="Alerts">
          <s-link slot="breadcrumb-actions" href="/app">Dashboard</s-link>

          {/* Shopify native Save button in the top-bar */}
          <s-button
            slot="primary-action"
            variant="primary"
            type="submit"
            {...(isSaving ? { loading: true } : {})}
          >
            Save
          </s-button>

          {/* ── Low Stock Alerts ─────────────────────────── */}
          <s-section heading="Low Stock Alerts">
            <s-paragraph>
              Receive email notifications when products in your store go out of
              stock or fall below a set quantity threshold.
            </s-paragraph>

            <s-box>
              <label
                className={[
                  "al-toggle-card",
                  lowStockEnabled ? "active" : "",
                  isSaving ? "al-saving" : "",
                ].join(" ")}
              >
                <input
                  type="checkbox"
                  checked={lowStockEnabled}
                  onChange={() => setLowStockEnabled((v) => !v)}
                />
                <div style={{ flex: 1 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: "10px", marginBottom: "4px" }}>
                    <s-text type="strong">Enable low stock alerts</s-text>
                    <span className={lowStockEnabled ? "al-badge al-badge-on" : "al-badge al-badge-off"}>
                      {lowStockEnabled ? "On" : "Off"}
                    </span>
                  </div>
                  <s-text color="subdued">
                    When enabled, Inventex will monitor inventory levels across
                    your store and send alerts according to your chosen frequency
                    below.
                  </s-text>
                </div>
              </label>
            </s-box>
          </s-section>

          {/* ── Alert Frequency (conditional) ────────────── */}
          {lowStockEnabled && (
            <s-section heading="Alert Frequency">
              <s-paragraph>
                You can get the alerts immediately when a product gets sold out
                or falls under a set threshold, or you can get a daily or weekly
                summary — whichever fits your workflow best.
              </s-paragraph>

              <s-box>
                <s-stack direction="block" gap="small">
                  {FREQUENCY_OPTIONS.map((opt) => {
                    const isSelected = alertFrequency === opt.value;
                    return (
                      <div key={opt.value}>
                        <label
                          className={[
                            "al-freq-card",
                            isSelected ? "selected" : "",
                            isSaving ? "al-saving" : "",
                          ].join(" ")}
                        >
                          <input
                            type="radio"
                            value={opt.value}
                            checked={isSelected}
                            onChange={() => setAlertFrequency(opt.value)}
                          />
                          <s-stack direction="block" gap="small">
                            <s-text type="strong">{opt.label}</s-text>
                            <s-text color="subdued">{opt.description}</s-text>
                          </s-stack>
                        </label>

                        {/* Time + timezone picker — only for Once per day */}
                        {opt.value === "DAILY" && isSelected && (
                          <div className="al-time-panel">
                            <div style={{ marginBottom: "10px" }}>
                              <s-text type="strong">Send email at</s-text>
                            </div>
                            <div className="al-time-row">
                              {/* Hour */}
                              <select
                                className="al-time-select"
                                value={dailyAlertHour}
                                onChange={(e) => setDailyAlertHour(Number(e.target.value))}
                                aria-label="Hour"
                              >
                                {[1,2,3,4,5,6,7,8,9,10,11,12].map((h) => (
                                  <option key={h} value={h}>{String(h).padStart(2, "0")}</option>
                                ))}
                              </select>

                              <span className="al-time-sep">:</span>

                              {/* Minutes fixed at :00 */}
                              <select className="al-time-select" defaultValue="00" aria-label="Minutes" disabled>
                                <option value="00">00</option>
                              </select>

                              {/* AM / PM */}
                              <select
                                className="al-time-select"
                                value={dailyAlertAmPm}
                                onChange={(e) => setDailyAlertAmPm(e.target.value)}
                                aria-label="AM or PM"
                              >
                                <option value="AM">AM</option>
                                <option value="PM">PM</option>
                              </select>

                              <span className="al-time-label">in</span>

                              {/* Timezone */}
                              <select
                                className="al-tz-select"
                                value={dailyAlertTimezone}
                                onChange={(e) => setDailyAlertTimezone(e.target.value)}
                                aria-label="Timezone"
                              >
                                {TIMEZONES.map((group) => (
                                  <optgroup key={group.group} label={group.group}>
                                    {group.zones.map((z) => (
                                      <option key={z.value} value={z.value}>{z.label}</option>
                                    ))}
                                  </optgroup>
                                ))}
                              </select>
                            </div>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </s-stack>
              </s-box>
            </s-section>
          )}

          {/* ── Check stock value for (conditional) ────────── */}
          {lowStockEnabled && (
            <s-section heading="Check stock value for">
              <s-paragraph>
                Select if you want to receive alerts for products or each product
                variant separately.
              </s-paragraph>

              <s-box>
                <s-stack direction="block" gap="small">

                  <label className={["al-radio-card", stockCheckLevel === "PRODUCT" ? "selected" : ""].join(" ")}>
                    <input
                      type="radio"
                      name="_stockCheckLevel"
                      value="PRODUCT"
                      checked={stockCheckLevel === "PRODUCT"}
                      onChange={() => setStockCheckLevel("PRODUCT")}
                    />
                    <s-stack direction="block" gap="small">
                      <s-text type="strong">Product</s-text>
                      <s-text color="subdued">
                        Alert when the combined inventory across all variants of a
                        product crosses the threshold.
                      </s-text>
                    </s-stack>
                  </label>

                  <label className={["al-radio-card", stockCheckLevel === "VARIANT" ? "selected" : ""].join(" ")}>
                    <input
                      type="radio"
                      name="_stockCheckLevel"
                      value="VARIANT"
                      checked={stockCheckLevel === "VARIANT"}
                      onChange={() => setStockCheckLevel("VARIANT")}
                    />
                    <s-stack direction="block" gap="small">
                      <s-text type="strong">Each product variant</s-text>
                      <s-text color="subdued">
                        Alert when any individual variant’s inventory crosses the
                        threshold — useful for products with sizes or colours.
                      </s-text>
                    </s-stack>
                  </label>

                </s-stack>
              </s-box>
            </s-section>
          )}

          {/* ── Which Email to Send (conditional) ──────────── */}
          {lowStockEnabled && (
            <s-section heading="Which Email to Send">
              <s-paragraph>
                We can send you an alert when a product is sold out or when the
                stock goes under a set threshold. You can enable one or both.
              </s-paragraph>

              <s-box>
                <s-stack direction="block" gap="small">

                  {/* Low stock option */}
                  <label className={["al-check-card", alertOnLowStock ? "selected" : ""].join(" ")}>
                    <input
                      type="checkbox"
                      checked={alertOnLowStock}
                      onChange={() => setAlertOnLowStock((v) => !v)}
                    />
                    <div style={{ flex: 1 }}>
                      <s-text type="strong">Low stock alert</s-text>
                      <s-text color="subdued">
                        Send an alert when a product’s inventory falls to or
                        below your threshold quantity.
                      </s-text>

                      {alertOnLowStock && (
                        <div
                          className="al-threshold-row"
                          onClick={(e) => e.preventDefault()}
                        >
                          <span className="al-threshold-hint">Alert when stock is at or below</span>
                          <input
                            type="number"
                            className={["al-threshold-input", thresholdError ? "error" : ""].join(" ")}
                            min={1}
                            max={5000}
                            placeholder="5"
                            value={lowStockThreshold}
                            onChange={(e) => {
                              setLowStockThreshold(e.target.value);
                              if (thresholdError) setThresholdError(null);
                            }}
                            onBlur={(e) => {
                              if (e.target.value === "" || Number(e.target.value) < 1) {
                                setLowStockThreshold("5");
                                setThresholdError(null);
                              }
                            }}
                            aria-label="Low stock threshold"
                          />
                          <span className="al-threshold-hint">units &nbsp;(max 5,000)</span>
                        </div>
                      )}
                      {thresholdError && (
                        <p className="al-error-text" role="alert">{thresholdError}</p>
                      )}
                    </div>
                  </label>

                  {/* Out of stock option */}
                  <label className={["al-check-card", alertOnOutOfStock ? "selected" : ""].join(" ")}>
                    <input
                      type="checkbox"
                      checked={alertOnOutOfStock}
                      onChange={() => setAlertOnOutOfStock((v) => !v)}
                    />
                    <s-stack direction="block" gap="small">
                      <s-text type="strong">Out of stock alert</s-text>
                      <s-text color="subdued">
                        Send an alert when a product’s inventory reaches exactly
                        zero — it’s completely sold out.
                      </s-text>
                    </s-stack>
                  </label>

                </s-stack>
              </s-box>
            </s-section>
          )}

          {/* ── Send Emails To (conditional) ─────────────── */}
          {lowStockEnabled && (
            <s-section heading="Send Emails To">
              <s-paragraph>
                You can send alert emails to up to 5 email addresses. Separate
                multiple addresses with a comma.
              </s-paragraph>

              <s-box>
                <div>
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "6px" }}>
                    <s-text type="strong">Email addresses</s-text>
                    <span className={emailCount > 5 ? "al-email-counter warn" : "al-email-counter ok"}>
                      {emailCount} / 5
                    </span>
                  </div>
                  <input
                    type="text"
                    name="alertEmails"
                    className={["al-email-input", emailError ? "error" : ""].join(" ")}
                    placeholder="you@example.com, colleague@example.com"
                    value={emailsInput}
                    onChange={(e) => {
                      setEmailsInput(e.target.value);
                      if (emailError) setEmailError(null);
                    }}
                    aria-describedby="al-email-hint al-email-error"
                  />
                  {emailError && (
                    <p id="al-email-error" className="al-error-text" role="alert">
                      {emailError}
                    </p>
                  )}
                  <p id="al-email-hint" style={{ fontSize: "12px", color: "#6d7175", marginTop: "5px" }}>
                    Separate multiple addresses with a comma.
                  </p>
                </div>
              </s-box>
            </s-section>
          )}

          {/* ── Send Preview Email (conditional) ─────────── */}
          {lowStockEnabled && (
            <s-section heading="Send a Preview Email">
              <s-paragraph>
                Send yourself a test email to see exactly what your recipients
                will receive. Uses your saved settings and recipient list.
                Save your changes first before sending the preview.
              </s-paragraph>

              <s-box>
                <div className="al-preview-box">
                  <div>
                    <s-text type="strong">Test your alert email</s-text>
                    <p style={{ fontSize: "13px", color: "#6d7175", margin: "4px 0 0" }}>
                      A realistic sample email will be sent to your saved recipient(s).
                    </p>
                  </div>
                  <div>
                    <button
                      type="button"
                      className="al-preview-btn"
                      disabled={isSendingPreview}
                      onClick={handleSendPreview}
                    >
                      {isSendingPreview ? (
                        <>
                          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{ animation: "spin 0.8s linear infinite" }}>
                            <path d="M21 12a9 9 0 1 1-6-8.5"/>
                          </svg>
                          Sending…
                        </>
                      ) : (
                        <>
                          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                            <line x1="22" y1="2" x2="11" y2="13"/>
                            <polygon points="22 2 15 22 11 13 2 9 22 2"/>
                          </svg>
                          Send Preview Email
                        </>
                      )}
                    </button>
                  </div>
                </div>
              </s-box>
            </s-section>
          )}
        </s-page>
      </Form>
    </>
  );
}

export function ErrorBoundary() {
  return boundary.error(useRouteError());
}

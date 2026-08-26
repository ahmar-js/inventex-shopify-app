import type {
  ActionFunctionArgs,
  HeadersFunction,
  LoaderFunctionArgs,
} from "react-router";
import {
  Form,
  useActionData,
  useLoaderData,
  useNavigation,
  useRouteError,
} from "react-router";
import { useEffect, useRef, useState } from "react";
import { useAppBridge } from "@shopify/app-bridge-react";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { getBillingAccess } from "../services/billing.server";
import { billingAccessMessage } from "../services/billing";
import { instrumentAdminApi } from "../services/observability.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session, admin: rawAdmin } = await authenticate.admin(request);
  const shop = session.shop;
  const admin = instrumentAdminApi(rawAdmin, shop);

  let primaryEmail = "";
  try {
    const response = await admin.graphql(`#graphql
      query InventexAlertShopEmail { shop { email } }`);
    const json = await response.json();
    primaryEmail = json.data?.shop?.email ?? "";
  } catch {
    // The merchant can enter a recipient if Shopify's shop query is unavailable.
  }

  const settings = await db.alertSettings.findUnique({ where: { shop } });

  return {
    lowStockEnabled: settings?.lowStockEnabled ?? false,
    alertFrequency: settings?.alertFrequency ?? "IMMEDIATE",
    alertEmails: settings?.alertEmails ?? primaryEmail,
    dailyAlertHour: settings?.dailyAlertHour ?? 9,
    dailyAlertAmPm: settings?.dailyAlertAmPm ?? "AM",
    dailyAlertTimezone: settings?.dailyAlertTimezone ?? "America/New_York",
    weeklyDigestDay: settings?.weeklyDigestDay ?? 1,
    alertOnLowStock: settings?.alertOnLowStock ?? true,
    lowStockThreshold: settings?.lowStockThreshold ?? 5,
    alertOnOutOfStock: settings?.alertOnOutOfStock ?? true,
    stockCheckLevel: settings?.stockCheckLevel ?? "PRODUCT",
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const shop = session.shop;
  const formData = await request.formData();

  const lowStockEnabled = formData.get("lowStockEnabled") === "true";
  const rawFrequency = formData.get("alertFrequency");
  const alertFrequency =
    rawFrequency === "DAILY" || rawFrequency === "WEEKLY"
      ? rawFrequency
      : "IMMEDIATE";
  const alertEmails = ((formData.get("alertEmails") as string) ?? "").trim();
  const dailyAlertHour = Math.max(
    1,
    Math.min(
      12,
      parseInt((formData.get("dailyAlertHour") as string) ?? "9", 10) || 9,
    ),
  );
  const dailyAlertAmPm = formData.get("dailyAlertAmPm") === "PM" ? "PM" : "AM";
  const dailyAlertTimezone =
    (formData.get("dailyAlertTimezone") as string) || "America/New_York";
  const weeklyDigestDay = Math.max(
    0,
    Math.min(
      6,
      parseInt((formData.get("weeklyDigestDay") as string) ?? "1", 10) || 0,
    ),
  );
  const alertOnLowStock = formData.get("alertOnLowStock") === "true";
  const rawThreshold = parseInt(
    (formData.get("lowStockThreshold") as string) ?? "5",
    10,
  );
  const lowStockThreshold = Number.isNaN(rawThreshold)
    ? 5
    : Math.max(1, Math.min(5000, rawThreshold));
  const alertOnOutOfStock = formData.get("alertOnOutOfStock") === "true";
  const stockCheckLevel =
    formData.get("stockCheckLevel") === "VARIANT" ? "VARIANT" : "PRODUCT";

  if (lowStockEnabled) {
    const billing = await getBillingAccess({ admin, session, force: true });
    if (!billing.accessAllowed) {
      return {
        success: false,
        error: billingAccessMessage(billing) ?? "Automation requires a plan.",
      };
    }
  }

  if (lowStockEnabled && !alertOnLowStock && !alertOnOutOfStock) {
    return {
      success: false,
      error: "Select at least one alert type: low stock or out of stock.",
    };
  }

  if (alertEmails) {
    const recipients = alertEmails
      .split(",")
      .map((email) => email.trim())
      .filter(Boolean);
    if (recipients.length > 5) {
      return { success: false, error: "You can add up to 5 email addresses." };
    }
    const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    const invalid = recipients.filter((email) => !emailPattern.test(email));
    if (invalid.length > 0) {
      return {
        success: false,
        error: `Invalid email address${invalid.length > 1 ? "es" : ""}: ${invalid.join(", ")}.`,
      };
    }
  }

  const normalizedEmails = alertEmails
    ? alertEmails
        .split(",")
        .map((email) => email.trim())
        .filter(Boolean)
        .join(", ")
    : "";

  try {
    const data = {
      lowStockEnabled,
      alertFrequency,
      alertEmails: normalizedEmails,
      dailyAlertHour,
      dailyAlertAmPm,
      dailyAlertTimezone,
      weeklyDigestDay,
      alertOnLowStock,
      lowStockThreshold,
      alertOnOutOfStock,
      stockCheckLevel,
    };
    await db.alertSettings.upsert({
      where: { shop },
      update: data,
      create: { shop, ...data },
    });
    return { success: true };
  } catch {
    return { success: false, error: "Failed to save alert settings." };
  }
};

export const headers: HeadersFunction = (args) => boundary.headers(args);

const FREQUENCY_OPTIONS = [
  {
    value: "IMMEDIATE",
    label: "Within a few minutes",
    description:
      "Group changes for two minutes, then send one email containing every alert.",
  },
  {
    value: "DAILY",
    label: "Daily digest",
    description: "Send one summary each day at the selected local time.",
  },
  {
    value: "WEEKLY",
    label: "Weekly digest",
    description: "Send one summary each week on the selected day and time.",
  },
] as const;

const WEEKDAYS = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];

const TIMEZONES = [
  {
    group: "UTC",
    zones: [{ value: "UTC", label: "UTC (+00:00)" }],
  },
  {
    group: "Americas",
    zones: [
      { value: "America/New_York", label: "Eastern Time - New York" },
      { value: "America/Chicago", label: "Central Time - Chicago" },
      { value: "America/Denver", label: "Mountain Time - Denver" },
      { value: "America/Phoenix", label: "Mountain Time - Phoenix" },
      { value: "America/Los_Angeles", label: "Pacific Time - Los Angeles" },
      { value: "America/Anchorage", label: "Alaska Time - Anchorage" },
      { value: "Pacific/Honolulu", label: "Hawaii Time - Honolulu" },
      { value: "America/Toronto", label: "Eastern Time - Toronto" },
      { value: "America/Vancouver", label: "Pacific Time - Vancouver" },
      { value: "America/Mexico_City", label: "Central Time - Mexico City" },
      { value: "America/Sao_Paulo", label: "Brasilia Time - Sao Paulo" },
      {
        value: "America/Argentina/Buenos_Aires",
        label: "Argentina Time - Buenos Aires",
      },
      { value: "America/Bogota", label: "Colombia Time - Bogota" },
      { value: "America/Lima", label: "Peru Time - Lima" },
      { value: "America/Santiago", label: "Chile Time - Santiago" },
    ],
  },
  {
    group: "Europe and Africa",
    zones: [
      { value: "Europe/London", label: "London" },
      { value: "Europe/Dublin", label: "Dublin" },
      { value: "Europe/Lisbon", label: "Lisbon" },
      { value: "Europe/Paris", label: "Paris" },
      { value: "Europe/Berlin", label: "Berlin" },
      { value: "Europe/Amsterdam", label: "Amsterdam" },
      { value: "Europe/Madrid", label: "Madrid" },
      { value: "Europe/Rome", label: "Rome" },
      { value: "Europe/Zurich", label: "Zurich" },
      { value: "Europe/Stockholm", label: "Stockholm" },
      { value: "Europe/Warsaw", label: "Warsaw" },
      { value: "Europe/Athens", label: "Athens" },
      { value: "Europe/Helsinki", label: "Helsinki" },
      { value: "Europe/Istanbul", label: "Istanbul" },
      { value: "Europe/Moscow", label: "Moscow" },
      { value: "Africa/Cairo", label: "Cairo" },
      { value: "Africa/Johannesburg", label: "Johannesburg" },
      { value: "Africa/Lagos", label: "Lagos" },
      { value: "Africa/Nairobi", label: "Nairobi" },
    ],
  },
  {
    group: "Asia and Pacific",
    zones: [
      { value: "Asia/Dubai", label: "Dubai" },
      { value: "Asia/Karachi", label: "Karachi" },
      { value: "Asia/Kolkata", label: "Mumbai / Delhi" },
      { value: "Asia/Dhaka", label: "Dhaka" },
      { value: "Asia/Bangkok", label: "Bangkok" },
      { value: "Asia/Jakarta", label: "Jakarta" },
      { value: "Asia/Singapore", label: "Singapore" },
      { value: "Asia/Hong_Kong", label: "Hong Kong" },
      { value: "Asia/Shanghai", label: "Shanghai / Beijing" },
      { value: "Asia/Seoul", label: "Seoul" },
      { value: "Asia/Tokyo", label: "Tokyo" },
      { value: "Australia/Perth", label: "Perth" },
      { value: "Australia/Adelaide", label: "Adelaide" },
      { value: "Australia/Sydney", label: "Sydney" },
      { value: "Australia/Brisbane", label: "Brisbane" },
      { value: "Pacific/Auckland", label: "Auckland" },
    ],
  },
];

function formElement(event: Event) {
  return event.currentTarget as HTMLElement & {
    checked: boolean;
    value: string;
    values: string[];
  };
}

function validateEmailsInput(raw: string): string | null {
  if (!raw.trim()) return null;
  const recipients = raw
    .split(",")
    .map((email) => email.trim())
    .filter(Boolean);
  if (recipients.length > 5) return "You can add up to 5 email addresses.";
  const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  const invalid = recipients.filter((email) => !emailPattern.test(email));
  return invalid.length > 0
    ? `Invalid email address${invalid.length > 1 ? "es" : ""}: ${invalid.join(", ")}.`
    : null;
}

function countEmails(raw: string): number {
  return raw.trim()
    ? raw
        .split(",")
        .map((email) => email.trim())
        .filter(Boolean).length
    : 0;
}

export default function Alerts() {
  const data = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const shopify = useAppBridge();

  const [lowStockEnabled, setLowStockEnabled] = useState(data.lowStockEnabled);
  const [alertFrequency, setAlertFrequency] = useState(data.alertFrequency);
  const [emailsInput, setEmailsInput] = useState(data.alertEmails);
  const [emailError, setEmailError] = useState<string | null>(null);
  const [dailyAlertHour, setDailyAlertHour] = useState(data.dailyAlertHour);
  const [dailyAlertAmPm, setDailyAlertAmPm] = useState(data.dailyAlertAmPm);
  const [dailyAlertTimezone, setDailyAlertTimezone] = useState(
    data.dailyAlertTimezone,
  );
  const [weeklyDigestDay, setWeeklyDigestDay] = useState(data.weeklyDigestDay);
  const [alertOnLowStock, setAlertOnLowStock] = useState(data.alertOnLowStock);
  const [lowStockThreshold, setLowStockThreshold] = useState(
    String(data.lowStockThreshold),
  );
  const [thresholdError, setThresholdError] = useState<string | null>(null);
  const [alertOnOutOfStock, setAlertOnOutOfStock] = useState(
    data.alertOnOutOfStock,
  );
  const [stockCheckLevel, setStockCheckLevel] = useState(data.stockCheckLevel);
  const [isSendingPreview, setIsSendingPreview] = useState(false);
  const lastNavigationState = useRef(navigation.state);

  useEffect(() => {
    if (
      lastNavigationState.current === "submitting" &&
      navigation.state === "idle"
    ) {
      if (actionData?.success === false) {
        shopify.toast.show(
          actionData.error ?? "Failed to save. Please try again.",
          { isError: true },
        );
      } else {
        shopify.toast.show("Alert settings saved.");
      }
    }
    lastNavigationState.current = navigation.state;
  }, [actionData, navigation.state, shopify]);

  const handleSendPreview = async () => {
    setIsSendingPreview(true);
    try {
      const idToken = await shopify.idToken();
      const response = await fetch("/app/alerts/preview", {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Authorization: `Bearer ${idToken}`,
        },
        body: "_action=send_preview",
      });
      const contentType = response.headers.get("content-type") ?? "";
      if (!contentType.includes("application/json")) {
        console.error("[preview] Non-JSON response", {
          status: response.status,
        });
        shopify.toast.show(`Authentication error (${response.status}).`, {
          isError: true,
        });
        return;
      }
      const result = (await response.json()) as {
        previewSent?: boolean;
        previewEmails?: string;
        previewError?: string;
      };
      if (result.previewSent) {
        shopify.toast.show(`Preview sent to ${result.previewEmails}`);
      } else {
        shopify.toast.show(result.previewError ?? "Failed to send preview.", {
          isError: true,
        });
      }
    } catch (error: unknown) {
      console.error("[preview] Request failed", {
        message: error instanceof Error ? error.message : String(error),
      });
      shopify.toast.show("Preview email could not be sent.", { isError: true });
    } finally {
      setIsSendingPreview(false);
    }
  };

  const handleSubmit = (event: React.FormEvent<HTMLFormElement>) => {
    let blocked = false;
    const nextEmailError = validateEmailsInput(emailsInput);
    setEmailError(nextEmailError);
    if (nextEmailError) blocked = true;

    if (alertOnLowStock) {
      const quantity = parseInt(lowStockThreshold, 10);
      if (Number.isNaN(quantity) || quantity < 1 || quantity > 5000) {
        setThresholdError("Enter a number between 1 and 5,000.");
        blocked = true;
      } else {
        setThresholdError(null);
      }
    } else {
      setThresholdError(null);
    }

    if (blocked) event.preventDefault();
  };

  const isSaving = navigation.state === "submitting";
  const emailCount = countEmails(emailsInput);

  return (
    <Form method="post" onSubmit={handleSubmit}>
      <input
        type="hidden"
        name="lowStockEnabled"
        value={String(lowStockEnabled)}
      />
      <input type="hidden" name="alertFrequency" value={alertFrequency} />
      <input
        type="hidden"
        name="dailyAlertHour"
        value={String(dailyAlertHour)}
      />
      <input type="hidden" name="dailyAlertAmPm" value={dailyAlertAmPm} />
      <input
        type="hidden"
        name="dailyAlertTimezone"
        value={dailyAlertTimezone}
      />
      <input
        type="hidden"
        name="weeklyDigestDay"
        value={String(weeklyDigestDay)}
      />
      <input
        type="hidden"
        name="alertOnLowStock"
        value={String(alertOnLowStock)}
      />
      <input type="hidden" name="lowStockThreshold" value={lowStockThreshold} />
      <input
        type="hidden"
        name="alertOnOutOfStock"
        value={String(alertOnOutOfStock)}
      />
      <input type="hidden" name="stockCheckLevel" value={stockCheckLevel} />
      <input type="hidden" name="alertEmails" value={emailsInput} />

      <s-page heading="Alerts" inlineSize="base">
        <s-link slot="breadcrumb-actions" href="/app">
          Dashboard
        </s-link>
        <s-button
          slot="primary-action"
          variant="primary"
          type="submit"
          loading={isSaving}
        >
          Save settings
        </s-button>

        <s-stack direction="block" gap="large">
          <s-paragraph>
            Choose which inventory changes matter and when your team should hear
            about them.
          </s-paragraph>

          {actionData?.success === false ? (
            <s-banner tone="critical" heading="Settings were not saved">
              {actionData.error}
            </s-banner>
          ) : null}

          <s-section heading="Email alerts">
            <s-stack direction="block" gap="base">
              <s-stack direction="inline" gap="small" alignItems="center">
                <s-badge tone={lowStockEnabled ? "success" : "neutral"}>
                  {lowStockEnabled ? "On" : "Off"}
                </s-badge>
              </s-stack>
              <s-checkbox
                label="Enable inventory email alerts"
                details="Monitor products and send notifications using the rules below."
                checked={lowStockEnabled}
                disabled={isSaving}
                onChange={(event) =>
                  setLowStockEnabled(formElement(event).checked)
                }
              />
            </s-stack>
          </s-section>

          {lowStockEnabled ? (
            <>
              <s-section heading="Delivery schedule">
                <s-stack direction="block" gap="base">
                  <s-choice-list
                    label="Alert frequency"
                    values={[alertFrequency]}
                    onChange={(event) =>
                      setAlertFrequency(
                        formElement(event).values[0] ?? "IMMEDIATE",
                      )
                    }
                  >
                    {FREQUENCY_OPTIONS.map((option) => (
                      <s-choice key={option.value} value={option.value}>
                        {option.label}
                        <s-text slot="details" color="subdued">
                          {option.description}
                        </s-text>
                      </s-choice>
                    ))}
                  </s-choice-list>

                  {alertFrequency !== "IMMEDIATE" ? (
                    <s-grid
                      gridTemplateColumns="repeat(auto-fit, minmax(140px, 1fr))"
                      gap="base"
                    >
                      {alertFrequency === "WEEKLY" ? (
                        <s-select
                          label="Weekday"
                          value={String(weeklyDigestDay)}
                          onChange={(event) =>
                            setWeeklyDigestDay(Number(formElement(event).value))
                          }
                        >
                          {WEEKDAYS.map((day, index) => (
                            <s-option key={day} value={String(index)}>
                              {day}
                            </s-option>
                          ))}
                        </s-select>
                      ) : null}
                      <s-select
                        label="Hour"
                        value={String(dailyAlertHour)}
                        onChange={(event) =>
                          setDailyAlertHour(Number(formElement(event).value))
                        }
                      >
                        {Array.from(
                          { length: 12 },
                          (_, index) => index + 1,
                        ).map((hour) => (
                          <s-option key={hour} value={String(hour)}>
                            {String(hour).padStart(2, "0")}:00
                          </s-option>
                        ))}
                      </s-select>
                      <s-select
                        label="Period"
                        value={dailyAlertAmPm}
                        onChange={(event) =>
                          setDailyAlertAmPm(formElement(event).value)
                        }
                      >
                        <s-option value="AM">AM</s-option>
                        <s-option value="PM">PM</s-option>
                      </s-select>
                      <s-select
                        label="Timezone"
                        value={dailyAlertTimezone}
                        onChange={(event) =>
                          setDailyAlertTimezone(formElement(event).value)
                        }
                      >
                        {TIMEZONES.map((group) => (
                          <s-option-group key={group.group} label={group.group}>
                            {group.zones.map((zone) => (
                              <s-option key={zone.value} value={zone.value}>
                                {zone.label}
                              </s-option>
                            ))}
                          </s-option-group>
                        ))}
                      </s-select>
                    </s-grid>
                  ) : null}
                </s-stack>
              </s-section>

              <s-section heading="Inventory rules">
                <s-stack direction="block" gap="base">
                  <s-choice-list
                    label="Evaluate inventory by"
                    values={[stockCheckLevel]}
                    onChange={(event) =>
                      setStockCheckLevel(
                        formElement(event).values[0] ?? "PRODUCT",
                      )
                    }
                  >
                    <s-choice value="PRODUCT">
                      Product
                      <s-text slot="details" color="subdued">
                        Use combined inventory across all variants.
                      </s-text>
                    </s-choice>
                    <s-choice value="VARIANT">
                      Each variant
                      <s-text slot="details" color="subdued">
                        Evaluate sizes, colors, and other variants separately.
                      </s-text>
                    </s-choice>
                  </s-choice-list>

                  <s-divider />

                  <s-checkbox
                    label="Low stock"
                    details="Notify when inventory reaches or falls below the threshold."
                    checked={alertOnLowStock}
                    onChange={(event) =>
                      setAlertOnLowStock(formElement(event).checked)
                    }
                  />
                  {alertOnLowStock ? (
                    <s-number-field
                      label="Low-stock threshold"
                      value={lowStockThreshold}
                      min={1}
                      max={5000}
                      suffix="units"
                      error={thresholdError ?? undefined}
                      onInput={(event) => {
                        setLowStockThreshold(formElement(event).value);
                        setThresholdError(null);
                      }}
                    />
                  ) : null}
                  <s-checkbox
                    label="Out of stock"
                    details="Notify when inventory reaches zero."
                    checked={alertOnOutOfStock}
                    onChange={(event) =>
                      setAlertOnOutOfStock(formElement(event).checked)
                    }
                  />
                </s-stack>
              </s-section>

              <s-section heading="Recipients">
                <s-text-field
                  label="Email addresses"
                  details={`${emailCount} of 5 recipients. Separate addresses with commas.`}
                  value={emailsInput}
                  placeholder="you@example.com, colleague@example.com"
                  error={emailError ?? undefined}
                  onInput={(event) => {
                    setEmailsInput(formElement(event).value);
                    setEmailError(null);
                  }}
                />
              </s-section>

              <s-section heading="Preview email">
                <s-stack direction="block" gap="base">
                  <s-paragraph>
                    Save your settings first, then send a sample summary to the
                    saved recipients.
                  </s-paragraph>
                  <s-stack direction="inline">
                    <s-button
                      type="button"
                      loading={isSendingPreview}
                      onClick={handleSendPreview}
                    >
                      Send preview email
                    </s-button>
                  </s-stack>
                </s-stack>
              </s-section>
            </>
          ) : null}
        </s-stack>
      </s-page>
    </Form>
  );
}

export function ErrorBoundary() {
  return boundary.error(useRouteError());
}

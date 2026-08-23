import type { ActionFunctionArgs } from "react-router";
import {
  authenticateAndEnqueueWebhook,
  JOB_TYPES,
} from "../services/webhooks.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  await authenticateAndEnqueueWebhook(
    request,
    JOB_TYPES.APP_SUBSCRIPTIONS_UPDATE,
  );
  return new Response();
};

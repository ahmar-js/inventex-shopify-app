type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogContext {
  shop?: string;
  jobId?: string;
  webhookId?: string;
  topic?: string;
  jobType?: string;
  productId?: string;
  inventoryItemId?: string;
  collectionId?: string;
  productCount?: number;
  sortOrder?: string;
  attempts?: number;
  delayMs?: number;
  runAfter?: Date;
  reason?: string;
  processed?: number;
  failed?: number;
  deferred?: number;
  error?: unknown;
}

function serializeError(error: unknown) {
  if (error instanceof Error) {
    return { name: error.name, message: error.message };
  }
  return { message: String(error) };
}

function write(level: LogLevel, message: string, context: LogContext = {}) {
  const { error, ...safeContext } = context;
  const entry = {
    timestamp: new Date().toISOString(),
    level,
    message,
    ...safeContext,
    ...(error === undefined ? {} : { error: serializeError(error) }),
  };

  const output = JSON.stringify(entry);
  if (level === "error") console.error(output);
  else if (level === "warn") console.warn(output);
  else console.log(output);
}

export const logger = {
  debug: (message: string, context?: LogContext) =>
    write("debug", message, context),
  info: (message: string, context?: LogContext) =>
    write("info", message, context),
  warn: (message: string, context?: LogContext) =>
    write("warn", message, context),
  error: (message: string, context?: LogContext) =>
    write("error", message, context),
};

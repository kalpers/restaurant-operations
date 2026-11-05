export type LogEntry = {
  severity: "info" | "warn" | "error";
  module: string;
  operation: string;
  message: string;
  requestId?: string;
  entityId?: string;
  errorName?: string;
  errorCode?: string;
};

/**
 * Structured technical logs, separate from business audit events. Callers pass named
 * fields only, so credentials and driver messages have no route into a log line.
 */
export function writeLog(entry: LogEntry): void {
  const line = JSON.stringify(entry);

  if (entry.severity === "error") {
    console.error(line);
  } else {
    console.log(line);
  }
}

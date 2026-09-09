// Minimal structured logging. The relayer's whole job is submitting transactions on someone's
// behalf, so "which call, with what, and what came back" is the thing you always want when a
// recovery misbehaves — including the full revert reason, which is what actually identifies the
// problem when a UserOp or contract call fails.
const started = Date.now();

function stamp(): string {
  const t = ((Date.now() - started) / 1000).toFixed(1).padStart(6);
  return `[+${t}s]`;
}

function fmt(value: unknown): string {
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "object" && value !== null) {
    return JSON.stringify(value, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
  }
  return String(value);
}

export function logInfo(scope: string, message: string, detail?: Record<string, unknown>) {
  const extra = detail ? ` ${Object.entries(detail).map(([k, v]) => `${k}=${fmt(v)}`).join(" ")}` : "";
  console.log(`${stamp()} ${scope} ${message}${extra}`);
}

/**
 * Errors get the whole thing, not just `.message`. viem nests the useful part (the decoded custom
 * error, the revert data) in `shortMessage`/`metaMessages`/`cause`, and a one-line summary
 * routinely drops exactly the detail that identifies the failure.
 */
export function logError(scope: string, message: string, err: unknown) {
  console.error(`${stamp()} ${scope} ERROR ${message}`);
  const e = err as {
    shortMessage?: string;
    metaMessages?: string[];
    details?: string;
    message?: string;
    cause?: unknown;
    stack?: string;
  };
  if (e?.shortMessage) console.error(`    ${e.shortMessage}`);
  else if (e?.message) console.error(`    ${e.message.split("\n")[0]}`);
  for (const meta of e?.metaMessages ?? []) console.error(`    ${meta}`);
  if (e?.details) console.error(`    details: ${e.details}`);
  const cause = e?.cause as { shortMessage?: string; message?: string } | undefined;
  if (cause?.shortMessage ?? cause?.message) {
    console.error(`    cause: ${cause.shortMessage ?? cause.message?.split("\n")[0]}`);
  }
  if (process.env.LOG_STACKS === "1" && e?.stack) console.error(e.stack);
}

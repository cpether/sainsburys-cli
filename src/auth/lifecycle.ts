/** Cleanup is active only while this process owns local state or a browser. */
type Cleanup = () => Promise<void>;
const resources = new Set<Cleanup>();
let stopping = false;
const interruption = new AbortController();
let pendingWrites = 0;
export interface InterruptionResult {
  signal: "SIGINT" | "SIGTERM";
  exitCode: 130 | 143;
  outcome: "unknown" | "cancelled";
}
type InterruptionReporter = (result: InterruptionResult) => void | Promise<void>;
let reporter: InterruptionReporter | undefined;

export function isStopping(): boolean { return stopping; }

/** Keep this scope open until a mutation's authoritative readback has been checked. */
export function beginUnverifiedWrite(): () => void {
  throwIfInterrupted();
  pendingWrites++;
  let finished = false;
  return () => {
    if (!finished) { finished = true; pendingWrites--; }
  };
}

/** CLI reporting is opt-in; importing the library does not write tool results. */
export function installInterruptionReporter(report: InterruptionReporter): () => void {
  const previous = reporter;
  const unregister = registerCleanup(async () => {});
  reporter = report;
  return () => {
    if (reporter === report) reporter = previous;
    unregister();
  };
}

export function throwIfInterrupted(): void {
  if (stopping) throw new Error("Operation interrupted; inspect current state before retrying a write.");
}

export function interruptionSignal(): AbortSignal { return interruption.signal; }

async function stop(signal: "SIGINT" | "SIGTERM"): Promise<void> {
  const code = signal === "SIGINT" ? 130 : 143;
  if (stopping) { process.exit(code); }
  // Snapshot before abort listeners or normal error handlers can finish a write scope.
  const result: InterruptionResult = { signal, exitCode: code, outcome: pendingWrites > 0 ? "unknown" : "cancelled" };
  const cleanups = [...resources].reverse();
  stopping = true;
  let reported: Promise<void>;
  try { reported = Promise.resolve(reporter?.(result)); }
  catch { reported = Promise.resolve(); }
  interruption.abort();
  await reported.catch(() => { process.stderr.write("Could not write the interruption result.\n"); });
  // Newer resources depend on older ones: close browsers before releasing profile locks.
  for (const cleanup of cleanups) {
    try { await cleanup(); }
    catch { process.stderr.write("Local state cleanup failed; run auth logout after this process exits.\n"); }
  }
  process.exit(code);
}

const onInterrupt = () => { void stop("SIGINT"); };
const onTerminate = () => { void stop("SIGTERM"); };

/** Call the returned function after normal cleanup, including failures. Cleanup must be idempotent. */
export function registerCleanup(cleanup: Cleanup): () => void {
  throwIfInterrupted();
  if (resources.size === 0) {
    process.on("SIGINT", onInterrupt);
    process.on("SIGTERM", onTerminate);
  }
  resources.add(cleanup);
  return () => {
    resources.delete(cleanup);
    if (resources.size === 0 && !stopping) {
      process.off("SIGINT", onInterrupt);
      process.off("SIGTERM", onTerminate);
    }
  };
}

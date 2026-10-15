/** Cleanup is active only while this process owns local state or a browser. */
type Cleanup = () => Promise<void>;
const resources = new Set<Cleanup>();
let stopping = false;
const interruption = new AbortController();

export function throwIfInterrupted(): void {
  if (stopping) throw new Error("Operation interrupted; inspect current state before retrying a write.");
}

export function interruptionSignal(): AbortSignal { return interruption.signal; }

async function stop(signal: "SIGINT" | "SIGTERM"): Promise<void> {
  const code = signal === "SIGINT" ? 130 : 143;
  if (stopping) { process.exit(code); }
  stopping = true;
  interruption.abort();
  // Newer resources depend on older ones: close browsers before releasing profile locks.
  for (const cleanup of [...resources].reverse()) {
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

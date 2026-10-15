import { isStopping, type InterruptionResult } from "../auth/lifecycle.js";
let resultWritten = false;
/** JSON stdout carries one result; stderr only carries redacted human errors. */
export type Format = "json" | "text";
export interface OutputContext { format: Format; }
/** Escape terminal controls while keeping JSON strings recoverable by JSON.parse. */
function terminalSafe(value: string): string {
  return value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, character => `\\u${character.charCodeAt(0).toString(16).padStart(4,"0")}`);
}
export function printData(ctx:OutputContext,data:unknown,textFn:()=>string):void {
  if (isStopping()) return;
  resultWritten = true;
  process.stdout.write(terminalSafe(ctx.format==="json"?JSON.stringify(data,null,2):textFn())+"\n");
}
export function printText(ctx:OutputContext,text:string):void { if(!isStopping() && ctx.format!=="json")process.stdout.write(terminalSafe(text)+"\n"); }
export function exitCodeFor(err:unknown):number {
  const name=err instanceof Error?err.name:"";
  if(name==="AuthError")return 2;
  if(name==="UnknownOutcomeError" || name==="BasketApplyError")return 5;
  if(["ApiError","ResponseValidationError","RequestTimeoutError","RequestCancelledError","ValidationError"].includes(name))return 3;
  return 1;
}
export function printError(err:unknown):void {
  if (isStopping()) return;
  resultWritten = true;
  const message=err instanceof Error?err.message:"Operation failed";
  if(process.argv.includes("--json")) {
    const detail = err && typeof err === "object" ? err as Record<string,unknown> : {};
    process.stdout.write(terminalSafe(JSON.stringify({ok:false,error:{code:err instanceof Error?err.name:"Error",message},
      ...(detail.outcome ? {outcome:detail.outcome} : exitCodeFor(err)===5 ? {outcome:"unknown"} : {}),
      ...(typeof detail.verifiedChanges === "number" ? {verifiedChanges:detail.verifiedChanges} : {}),
      ...readbackDetail(detail.readbackFailure)}))+"\n");
  }
  else process.stderr.write(terminalSafe(`error: ${message}\n`));
}
/** Emit only fixed diagnostic categories and numeric status, never underlying errors. */
function readbackDetail(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object") return {};
  const detail = value as Record<string, unknown>;
  if (typeof detail.category !== "string" || !["authentication", "http", "network", "local_state", "timeout", "cancelled", "validation", "unknown"].includes(detail.category)) return {};
  const status = detail.httpStatus;
  return { readbackFailure: { category: detail.category,
    ...(typeof status === "number" && Number.isInteger(status) && status >= 100 && status <= 599 ? { httpStatus: status } : {}) } };
}
export function formatMoney(value:number|undefined):string {return value===undefined||value===null?"-":`£${value.toFixed(2)}`;}
export function shortDate(iso:string|undefined):string {return iso?iso.replace("T"," ").replace(/Z$/," UTC"):"-";}

/** The lifecycle invokes this before cleanup; subsequent normal results are suppressed. */
export function printInterruption(result: InterruptionResult): Promise<void> {
  if (resultWritten) return Promise.resolve();
  resultWritten = true;
  const message = result.outcome === "unknown"
    ? "Operation interrupted with an unverified basket write. Inspect the current basket before retrying."
    : "Operation interrupted before any unverified basket write.";
  const json = process.argv.includes("--json");
  const text = json
    ? JSON.stringify({ok:false,error:{code:"InterruptedError",message},outcome:result.outcome}) + "\n"
    : `error: ${message}\n`;
  return new Promise(done => { (json ? process.stdout : process.stderr).write(text, () => done()); });
}

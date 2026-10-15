/** JSON stdout carries one result; stderr only carries redacted human errors. */
export type Format = "json" | "text";
export interface OutputContext { format: Format; }
/** Escape terminal controls while keeping JSON strings recoverable by JSON.parse. */
function terminalSafe(value: string): string {
  return value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, character => `\\u${character.charCodeAt(0).toString(16).padStart(4,"0")}`);
}
export function printData(ctx:OutputContext,data:unknown,textFn:()=>string):void {
  process.stdout.write(terminalSafe(ctx.format==="json"?JSON.stringify(data,null,2):textFn())+"\n");
}
export function printText(ctx:OutputContext,text:string):void { if(ctx.format!=="json")process.stdout.write(terminalSafe(text)+"\n"); }
export function exitCodeFor(err:unknown):number {
  const name=err instanceof Error?err.name:"";
  if(name==="AuthError")return 2;
  if(name==="UnknownOutcomeError" || name==="BasketApplyError")return 5;
  if(["ApiError","ResponseValidationError","RequestTimeoutError","RequestCancelledError","ValidationError"].includes(name))return 3;
  return 1;
}
export function printError(err:unknown):void {
  const message=err instanceof Error?err.message:"Operation failed";
  if(process.argv.includes("--json")) {
    const detail = err && typeof err === "object" ? err as Record<string,unknown> : {};
    process.stdout.write(terminalSafe(JSON.stringify({ok:false,error:{code:err instanceof Error?err.name:"Error",message},
      ...(detail.outcome ? {outcome:detail.outcome} : exitCodeFor(err)===5 ? {outcome:"unknown"} : {}),
      ...(typeof detail.verifiedChanges === "number" ? {verifiedChanges:detail.verifiedChanges} : {})}))+"\n");
  }
  else process.stderr.write(terminalSafe(`error: ${message}\n`));
}
export function formatMoney(value:number|undefined):string {return value===undefined||value===null?"-":`£${value.toFixed(2)}`;}
export function shortDate(iso:string|undefined):string {return iso?iso.replace("T"," ").replace(/Z$/," UTC"):"-";}

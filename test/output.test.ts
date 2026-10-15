import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { printData } from "../src/cli/output.js";

test("retailer text cannot send terminal control sequences through text or JSON output",()=>{
  const writes:string[]=[];
  const capture=mock.method(process.stdout,"write",(chunk:unknown)=>{writes.push(String(chunk));return true;});
  const name="Retailer\u001b]52;c;clipboard\u0007\u009b31m";
  try {
    printData({format:"text"},{name},()=>name);
    printData({format:"json"},{name},()=>name);
  } finally {capture.mock.restore();}
  assert.equal(writes.length,2);
  for(const output of writes){assert.ok(!output.includes("\u001b"));assert.ok(!output.includes("\u009b"));assert.ok(!output.includes("\u0007"));}
  assert.deepEqual(JSON.parse(writes[1]!),{name});
});

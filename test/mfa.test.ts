import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as mfa from "../src/auth/mfa-providers.js";

describe("manual MFA", () => {
  it("exports instructions only, with no bridge or code collection API", () => {
    assert.deepEqual(Object.keys(mfa), ["MFA_INSTRUCTIONS"]);
    assert.match(mfa.MFA_INSTRUCTIONS, /directly in the local browser/);
  });
});

import { it } from "node:test";
import assert from "node:assert/strict";
import { deleteKeychainPassword, hasKeychainPassword, keychainPassword, storeKeychainPassword } from "../src/auth/keychain.js";

it("never touches the Keychain when automatic sign-in is switched off", async () => {
  // The test isolation preloader sets SAINSBURYS_AUTO_SIGN_IN=off for every test process.
  assert.equal(process.env.SAINSBURYS_AUTO_SIGN_IN, "off");
  assert.equal(await keychainPassword("dummy@example.invalid"), undefined);
  assert.equal(await hasKeychainPassword("dummy@example.invalid"), false);
  assert.equal(await deleteKeychainPassword("dummy@example.invalid"), false);
  await assert.rejects(storeKeychainPassword("dummy@example.invalid"), /SAINSBURYS_AUTO_SIGN_IN=off/);
});

/**
 * X-Hub-Signature-256 verification.
 *
 *   bun test tests/
 */
import { expect, test } from "bun:test";
import { signGitHub, verifyGitHubSignature } from "../server/signature.ts";

const secret = "It's a Secret to Everybody";
const body = "Hello, World!";

test("matches GitHub's published test vector", () => {
  // From GitHub's "Validating webhook deliveries" docs.
  expect(signGitHub(secret, body)).toBe(
    "sha256=757107ea0eb2509fc211221cce984b8a37570b6d7586c22c46f4379c8b043e17",
  );
  expect(verifyGitHubSignature(secret, body, signGitHub(secret, body))).toBe(true);
});

test("rejects missing, malformed, wrong-secret and tampered signatures", () => {
  const good = signGitHub(secret, body);
  expect(verifyGitHubSignature(secret, body, null)).toBe(false);
  expect(verifyGitHubSignature(secret, body, "")).toBe(false);
  expect(verifyGitHubSignature(secret, body, good.replace("sha256=", "sha1="))).toBe(false);
  expect(verifyGitHubSignature(secret, body, "sha256=abc")).toBe(false);
  expect(verifyGitHubSignature("other", body, good)).toBe(false);
  expect(verifyGitHubSignature(secret, body + " ", good)).toBe(false);
});

test("an empty secret never verifies, even against its own signature", () => {
  expect(verifyGitHubSignature("", body, signGitHub("", body))).toBe(false);
});

test("verifies raw bytes, so re-serialized JSON does not pass", () => {
  const raw = '{"a":1,"b":"\\u00e9"}';
  const sig = signGitHub(secret, raw);
  expect(verifyGitHubSignature(secret, new TextEncoder().encode(raw), sig)).toBe(true);
  expect(verifyGitHubSignature(secret, JSON.stringify(JSON.parse(raw)), sig)).toBe(false);
});

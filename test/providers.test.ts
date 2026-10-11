import { test } from "node:test";
import assert from "node:assert/strict";
import { classify } from "../src/providers/types.ts";

test("E6: provider policy and auth errors are classified from the body, not just the status", () => {
  // Bodies as observed in LIVE-001 (2026-10-11); the probe did not record the
  // HTTP statuses, so those here are placeholders.
  assert.equal(classify(503, '{\n\t"error": "infringing_file",\n\t"error_code": 35\n}').kind, "policy");
  assert.equal(
    classify(403, '{"success":false,"error":"AUTH_ERROR","detail":"An error occurred while verifying your token."}').kind,
    "auth",
  );
  assert.equal(classify(500, "not json").kind, "transient");
  assert.equal(classify(500, "null").kind, "transient");
  assert.equal(classify(429, "").kind, "rate-limited");
});

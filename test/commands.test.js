import test from "node:test";
import assert from "node:assert/strict";

import { parseAskcodexRawCommand, validateAskcodexIsolationConfig } from "../index.ts";

test("parseAskcodexRawCommand maps canonical commands", () => {
  assert.deepEqual(parseAskcodexRawCommand(""), { action: "help" });
  assert.deepEqual(parseAskcodexRawCommand("help"), { action: "help" });
  assert.deepEqual(parseAskcodexRawCommand("status"), { action: "status" });
  assert.deepEqual(parseAskcodexRawCommand("new"), { action: "new" });
  assert.deepEqual(parseAskcodexRawCommand("new /home/dvk"), { action: "new", cwd: "/home/dvk" });
  assert.deepEqual(parseAskcodexRawCommand("stop"), { action: "stop" });
  assert.deepEqual(parseAskcodexRawCommand("reset"), { action: "reset" });
  assert.deepEqual(parseAskcodexRawCommand("handoff"), { action: "handoff" });
  assert.deepEqual(parseAskcodexRawCommand("resume"), { action: "resume" });
});

test("parseAskcodexRawCommand rejects removed command names", () => {
  const removed = ["start", "ensure", "kill", "list", "slash"];
  for (const cmd of removed) {
    const parsed = parseAskcodexRawCommand(cmd);
    assert.equal("error" in parsed, true);
  }
});

test("parseAskcodexRawCommand defaults to send for free-form prompts", () => {
  assert.deepEqual(parseAskcodexRawCommand("show me the failing tests"), {
    action: "send",
    message: "show me the failing tests",
  });
  // Non-absolute `new ...` is treated as prompt text.
  assert.deepEqual(parseAskcodexRawCommand("new parser strategy"), {
    action: "send",
    message: "new parser strategy",
  });
});

test("validateAskcodexIsolationConfig requires explicit isolated codexHome/defaultCwd", () => {
  const missing = validateAskcodexIsolationConfig({});
  assert.equal(missing.ok, false);
  assert.match(missing.error, /codexHome/);

  const defaultHome = validateAskcodexIsolationConfig({
    codexHome: "~/.cache/askcodex-codex-home",
    defaultCwd: "/tmp/askcodex-workspace",
  });
  assert.equal(defaultHome.ok, false);
  assert.match(defaultHome.error, /shared default/);

  const valid = validateAskcodexIsolationConfig({
    codexHome: "/tmp/askcodex-home",
    defaultCwd: "/tmp/askcodex-workspace",
  });
  assert.deepEqual(valid, { ok: true });
});

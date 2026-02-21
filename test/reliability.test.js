import test from "node:test";
import assert from "node:assert/strict";

import { __internals } from "../index.ts";

test("normalizePendingTurn fills delivery key and retry defaults", () => {
  const pending = __internals.normalizePendingTurn(
    "agent:main:discord:channel:123",
    {
      turnId: "turn-1",
      mode: "jsonl",
      sentAt: 1000,
      quietMs: 4000,
    },
    5000,
  );

  assert.equal(pending.turnId, "turn-1");
  assert.equal(pending.mode, "jsonl");
  assert.equal(pending.retryCount, 0);
  assert.equal(typeof pending.deliveryKey, "string");
  assert.ok(pending.deliveryKey.includes("turn-1"));
});

test("normalizePendingTurn clamps quietMs to allowed bounds", () => {
  const low = __internals.normalizePendingTurn(
    "agent:main:discord:channel:123",
    { turnId: "turn-low", mode: "jsonl", sentAt: 1000, quietMs: 1 },
    5000,
  );
  const high = __internals.normalizePendingTurn(
    "agent:main:discord:channel:123",
    { turnId: "turn-high", mode: "jsonl", sentAt: 1000, quietMs: 999999 },
    5000,
  );

  assert.equal(low.quietMs, 1000);
  assert.equal(high.quietMs, 30000);
});

test("computeRetryDelayMs grows exponentially", () => {
  const d0 = __internals.computeRetryDelayMs(0, 0);
  const d1 = __internals.computeRetryDelayMs(1, 0);
  const d2 = __internals.computeRetryDelayMs(2, 0);

  assert.equal(d0, 1000);
  assert.equal(d1, 2000);
  assert.equal(d2, 4000);
});

test("schedulePendingRetry increments retry count and sets next attempt", () => {
  const pending = __internals.normalizePendingTurn(
    "agent:main:discord:channel:123",
    {
      turnId: "turn-2",
      mode: "jsonl",
      sentAt: 1000,
      quietMs: 5000,
      retryCount: 0,
      deliveryKey: "k2",
    },
    5000,
  );
  const next = __internals.schedulePendingRetry(pending, 10_000);

  assert.equal(next.retryCount, 1);
  assert.equal(next.lastAttemptAt, 10_000);
  assert.ok(next.nextAttemptAt > 10_000);
});

test("isPendingAlreadyDelivered dedupes by delivery key", () => {
  const pending = __internals.normalizePendingTurn(
    "agent:main:discord:channel:123",
    {
      turnId: "turn-3",
      mode: "jsonl",
      sentAt: 1000,
      deliveryKey: "k3",
    },
    5000,
  );

  assert.equal(
    __internals.isPendingAlreadyDelivered(
      {
        version: 1,
        sessionKey: "agent:main:discord:channel:123",
        agentId: "main",
        createdAt: 0,
        updatedAt: 0,
        codex: {},
        lastDelivered: {
          turnId: "different-turn",
          deliveryKey: "k3",
          deliveredAt: 1,
        },
      },
      pending,
    ),
    true,
  );
});

test("computePendingAttemptDelayMs respects nextAttemptAt", () => {
  const pending = __internals.normalizePendingTurn(
    "agent:main:discord:channel:123",
    {
      turnId: "turn-4",
      mode: "jsonl",
      sentAt: 1000,
      quietMs: 5000,
      nextAttemptAt: 15000,
    },
    5000,
  );

  const delay = __internals.computePendingAttemptDelayMs(pending, 12000, 5000);
  assert.equal(delay, 3000);
});

test("computeJsonlReadBaseOffset prefers the most advanced known offset", () => {
  const base = __internals.computeJsonlReadBaseOffset({
    pendingJsonlOffset: 1200,
    lastJsonlOffset: 9200,
    fileSize: 10000,
    lookbackBytes: 4096,
  });
  assert.equal(base, 9200);
});

test("computeJsonlReadBaseOffset ignores stale oversized offsets and uses tail window", () => {
  const base = __internals.computeJsonlReadBaseOffset({
    pendingJsonlOffset: 250000,
    lastJsonlOffset: 260000,
    fileSize: 238200,
    lookbackBytes: 4096,
  });
  assert.equal(base, 234104);
});

test("computeJsonlReadBaseOffset falls back to tail window when no offsets are known", () => {
  const base = __internals.computeJsonlReadBaseOffset({
    fileSize: 238200,
    lookbackBytes: 4096,
  });
  assert.equal(base, 234104);
});

test("shouldInitializeJsonlOffsetOnSessionDiscovery avoids EOF baseline during pending turns", () => {
  assert.equal(
    __internals.shouldInitializeJsonlOffsetOnSessionDiscovery({
      existingOffset: undefined,
      hasPendingTurn: true,
    }),
    false,
  );

  assert.equal(
    __internals.shouldInitializeJsonlOffsetOnSessionDiscovery({
      existingOffset: undefined,
      hasPendingTurn: false,
    }),
    true,
  );

  assert.equal(
    __internals.shouldInitializeJsonlOffsetOnSessionDiscovery({
      existingOffset: 4096,
      hasPendingTurn: false,
    }),
    false,
  );
});

test("shouldContinueWaitingForJsonl keeps waiting after hard timeout while output is still active", () => {
  assert.equal(
    __internals.shouldContinueWaitingForJsonl({
      sessionExited: false,
      elapsedMs: 310000,
      silenceMs: 2000,
      softWaitMs: 90000,
      hardWaitMs: 300000,
    }),
    true,
  );
});

test("shouldContinueWaitingForJsonl stops waiting when output is silent past hard timeout", () => {
  assert.equal(
    __internals.shouldContinueWaitingForJsonl({
      sessionExited: false,
      elapsedMs: 310000,
      silenceMs: 310000,
      softWaitMs: 90000,
      hardWaitMs: 300000,
    }),
    false,
  );
});

test("shouldContinueWaitingForJsonl keeps existing pty-exit grace behavior", () => {
  assert.equal(
    __internals.shouldContinueWaitingForJsonl({
      sessionExited: true,
      elapsedMs: 60000,
      silenceMs: 1000,
      softWaitMs: 90000,
      hardWaitMs: 300000,
    }),
    true,
  );
  assert.equal(
    __internals.shouldContinueWaitingForJsonl({
      sessionExited: true,
      elapsedMs: 95000,
      silenceMs: 1000,
      softWaitMs: 90000,
      hardWaitMs: 300000,
    }),
    false,
  );
});

test("pickAssistantDeliveryTextFromJsonlObjects prefers explicit final answer", () => {
  const picked = __internals.pickAssistantDeliveryTextFromJsonlObjects([
    {
      timestamp: "2026-02-14T07:32:25.992Z",
      type: "response_item",
      payload: {
        type: "message",
        role: "assistant",
        phase: "commentary",
        content: [{ type: "output_text", text: "intermediate status" }],
      },
    },
    {
      timestamp: "2026-02-14T07:33:40.000Z",
      type: "response_item",
      payload: {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "generic assistant text" }],
      },
    },
    {
      timestamp: "2026-02-14T07:33:45.832Z",
      type: "response_item",
      payload: {
        type: "message",
        role: "assistant",
        phase: "final_answer",
        content: [{ type: "output_text", text: "final answer text" }],
      },
    },
  ]);

  assert.equal(picked.text, "final answer text");
  assert.equal(picked.sawAny, true);
  assert.equal(picked.sawFinalAnswer, true);
});

test("pickAssistantDeliveryTextFromJsonlObjects waits for task_complete before using generic text", () => {
  const withoutCompletion = __internals.pickAssistantDeliveryTextFromJsonlObjects([
    {
      timestamp: "2026-02-14T07:33:40.000Z",
      type: "response_item",
      payload: {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "generic assistant text" }],
      },
    },
  ]);

  assert.equal(withoutCompletion.text, "");
  assert.equal(withoutCompletion.sawAny, true);
  assert.equal(withoutCompletion.sawTaskComplete, false);

  const withCompletion = __internals.pickAssistantDeliveryTextFromJsonlObjects([
    {
      timestamp: "2026-02-14T07:33:40.000Z",
      type: "response_item",
      payload: {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "generic assistant text" }],
      },
    },
    {
      timestamp: "2026-02-14T07:33:45.832Z",
      type: "event_msg",
      payload: { type: "task_complete" },
    },
  ]);

  assert.equal(withCompletion.text, "generic assistant text");
  assert.equal(withCompletion.sawTaskComplete, true);
});

test("applyOperationalGuardToPrompt prepends safety block for send actions", () => {
  const out = __internals.applyOperationalGuardToPrompt("please clean it up", "send");
  assert.match(out, /\[askcodex operational safety\]/);
  assert.match(out, /Do not stop, restart, or kill the OpenClaw gateway process\/service/);
  assert.match(out, /please clean it up$/);
});

test("applyOperationalGuardToPrompt leaves slash actions unchanged", () => {
  const out = __internals.applyOperationalGuardToPrompt("/status", "slash");
  assert.equal(out, "/status");
});

test("applyOperationalGuardToPrompt does not duplicate existing safety block", () => {
  const guarded = __internals.applyOperationalGuardToPrompt("inspect setup", "send");
  const out = __internals.applyOperationalGuardToPrompt(guarded, "send");
  const occurrences = (out.match(/\[askcodex operational safety\]/g) ?? []).length;
  assert.equal(occurrences, 1);
});

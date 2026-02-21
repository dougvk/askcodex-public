import test from 'node:test';
import assert from 'node:assert/strict';

import {
  inferDeliveryHintFromSessionKey,
  inferSlackDeliveryFromSessionKey,
  normalizeDeliveryHintForSessionKey,
  extractAssistantOutputTextFromCodexJsonlEntry,
} from '../lib.js';

test('inferDeliveryHintFromSessionKey: discord channel', () => {
  const hint = inferDeliveryHintFromSessionKey('agent:main:discord:channel:123');
  assert.deepEqual(hint, { channel: 'discord', to: 'channel:123' });
});

test('inferDeliveryHintFromSessionKey: telegram group', () => {
  const hint = inferDeliveryHintFromSessionKey('agent:main:telegram:group:-100123');
  assert.deepEqual(hint, { channel: 'telegram', to: 'telegram:-100123' });
});

test('inferDeliveryHintFromSessionKey: telegram topic', () => {
  const hint = inferDeliveryHintFromSessionKey('agent:main:telegram:group:-100123:topic:77');
  assert.deepEqual(hint, {
    channel: 'telegram',
    to: 'telegram:-100123',
    threadId: 77,
    messageThreadId: 77,
  });
});

test('inferSlackDeliveryFromSessionKey: channel', () => {
  const hint = inferSlackDeliveryFromSessionKey('agent:main:slack:channel:C1');
  assert.deepEqual(hint, { channel: 'slack', to: 'channel:C1' });
});

test('inferSlackDeliveryFromSessionKey: thread', () => {
  const hint = inferSlackDeliveryFromSessionKey('agent:main:slack:channel:C1:thread:111.222');
  assert.deepEqual(hint, {
    channel: 'slack',
    to: 'channel:C1',
    threadId: '111.222',
    messageThreadId: '111.222',
  });
});

test('inferSlackDeliveryFromSessionKey: group', () => {
  const hint = inferSlackDeliveryFromSessionKey('agent:main:slack:group:G1');
  assert.deepEqual(hint, { channel: 'slack', to: 'channel:G1' });
});

test('inferSlackDeliveryFromSessionKey: dm', () => {
  const hint = inferSlackDeliveryFromSessionKey('agent:main:slack:dm:U123');
  assert.deepEqual(hint, { channel: 'slack', to: 'user:U123' });
});

test('normalizeDeliveryHintForSessionKey: infer slack target from sessionKey when to is slash:*', () => {
  const out = normalizeDeliveryHintForSessionKey(
    { channel: 'slack', to: 'slash:U123' },
    'agent:main:slack:channel:C1:thread:111.222',
  );
  assert.deepEqual(out, {
    channel: 'slack',
    to: 'channel:C1',
    threadId: '111.222',
    messageThreadId: '111.222',
  });
});

test('normalizeDeliveryHintForSessionKey: infer discord target from sessionKey when to is missing', () => {
  const out = normalizeDeliveryHintForSessionKey(
    { channel: 'discord' },
    'agent:main:discord:channel:999',
  );
  assert.deepEqual(out, { channel: 'discord', to: 'channel:999' });
});

test('extractAssistantOutputTextFromCodexJsonlEntry: assistant output_text extracted', () => {
  const entry = {
    type: 'response_item',
    payload: {
      type: 'message',
      role: 'assistant',
      content: [
        { type: 'output_text', text: 'Hello' },
        { type: 'output_text', text: 'World' },
      ],
    },
  };
  assert.deepEqual(extractAssistantOutputTextFromCodexJsonlEntry(entry), ['Hello', 'World']);
});

test('extractAssistantOutputTextFromCodexJsonlEntry: non-assistant ignored', () => {
  const entry = {
    type: 'response_item',
    payload: {
      type: 'message',
      role: 'user',
      content: [{ type: 'input_text', text: 'hi' }],
    },
  };
  assert.deepEqual(extractAssistantOutputTextFromCodexJsonlEntry(entry), []);
});

test('extractAssistantOutputTextFromCodexJsonlEntry: commentary phase ignored', () => {
  const entry = {
    type: 'response_item',
    payload: {
      type: 'message',
      role: 'assistant',
      phase: 'commentary',
      content: [{ type: 'output_text', text: 'intermediate status update' }],
    },
  };
  assert.deepEqual(extractAssistantOutputTextFromCodexJsonlEntry(entry), []);
});

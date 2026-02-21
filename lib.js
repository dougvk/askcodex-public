// Shared helpers for askcodex plugin.
// Keep plain JS so it can be imported without TS loaders.

export function normalizeDeliveryHint(value) {
  if (!value) return null;
  const channel = typeof value.channel === "string" ? value.channel.trim() : "";
  const accountId = typeof value.accountId === "string" ? value.accountId.trim() : "";
  let to = typeof value.to === "string" ? value.to.trim() : "";

  const threadIdRaw = value.threadId;
  const messageThreadIdRaw = value.messageThreadId;
  const isForumRaw = value.isForum;

  const normalizeThreadId = (raw) => {
    if (raw == null) return undefined;
    if (typeof raw === "number") return Number.isFinite(raw) ? Math.trunc(raw) : undefined;
    if (typeof raw === "string") {
      const t = raw.trim();
      return t ? t : undefined;
    }
    return undefined;
  };

  const threadId = normalizeThreadId(threadIdRaw);
  const messageThreadId = normalizeThreadId(messageThreadIdRaw);
  const isForum = typeof isForumRaw === "boolean" ? isForumRaw : undefined;

  // Telegram: sanitize slash:NN values
  if (channel === "telegram" && to) {
    const m = /^slash:(\d+)$/.exec(to);
    if (m?.[1]) to = `telegram:${m[1]}`;
  }

  // Discord: a slash interaction id is not an outbound target
  if (channel === "discord" && /^slash:\d+$/.test(to)) {
    to = "";
  }

  // Slack: a slash trigger id is not an outbound target
  if (channel === "slack" && /^slash:[^:]+$/.test(to)) {
    to = "";
  }

  if (!channel && !to && !accountId && threadId == null && messageThreadId == null && isForum == null) {
    return null;
  }

  const out = {};
  if (channel) out.channel = channel;
  if (to) out.to = to;
  if (accountId) out.accountId = accountId;
  if (threadId !== undefined) out.threadId = threadId;
  if (messageThreadId !== undefined) out.messageThreadId = messageThreadId;
  if (isForum !== undefined) out.isForum = isForum;
  return out;
}

export function inferDiscordToFromSessionKey(sessionKey) {
  // Common form: agent:<agentId>:discord:channel:<channelId>
  const m = /:discord:channel:(\d+)$/.exec(sessionKey);
  if (m?.[1]) return `channel:${m[1]}`;
  return null;
}

export function inferTelegramDeliveryFromSessionKey(sessionKey) {
  // Common form for telegram groups: agent:<agentId>:telegram:group:<chatId>
  // For topics: agent:<agentId>:telegram:group:<chatId>:topic:<topicId>
  const m = /:telegram:group:([^:]+)(?::topic:(\d+))?$/.exec(sessionKey);
  if (!m?.[1]) return null;
  const chatId = m[1];
  const topicId = m[2] ? Number.parseInt(m[2], 10) : undefined;
  if (topicId != null && Number.isFinite(topicId)) {
    return {
      channel: "telegram",
      to: `telegram:${chatId}`,
      threadId: topicId,
      messageThreadId: topicId,
    };
  }
  return { channel: "telegram", to: `telegram:${chatId}` };
}

export function inferSlackDeliveryFromSessionKey(sessionKey) {
  // Common forms:
  // - agent:<agentId>:slack:channel:<channelId>
  // - agent:<agentId>:slack:channel:<channelId>:thread:<threadTs>
  // - agent:<agentId>:slack:group:<channelId>
  // - agent:<agentId>:slack:dm:<userId>
  const threadMatch = /:slack:(channel|group):([^:]+)(?::thread:([^:]+))?$/.exec(sessionKey);
  if (threadMatch?.[1] && threadMatch?.[2]) {
    const channelId = threadMatch[2];
    const threadTs = threadMatch[3] ? threadMatch[3].trim() : "";
    if (threadTs) {
      return {
        channel: "slack",
        to: `channel:${channelId}`,
        threadId: threadTs,
        messageThreadId: threadTs,
      };
    }
    return { channel: "slack", to: `channel:${channelId}` };
  }

  const dmMatch = /:slack:dm:([^:]+)$/.exec(sessionKey);
  if (dmMatch?.[1]) {
    // For Slack DMs, the outbound adapter expects `user:<id>`.
    return { channel: "slack", to: `user:${dmMatch[1]}` };
  }

  return null;
}

export function inferDeliveryHintFromSessionKey(sessionKey) {
  const discordTo = inferDiscordToFromSessionKey(sessionKey);
  if (discordTo) return { channel: "discord", to: discordTo };
  const telegram = inferTelegramDeliveryFromSessionKey(sessionKey);
  if (telegram) return telegram;
  const slack = inferSlackDeliveryFromSessionKey(sessionKey);
  if (slack) return slack;
  return null;
}

export function normalizeDeliveryHintForSessionKey(value, sessionKey) {
  const normalized = normalizeDeliveryHint(value);
  if (!normalized) return null;

  if (normalized.channel === "discord") {
    if (!normalized.to || /^slash:\d+$/.test(normalized.to)) {
      const inferred = inferDiscordToFromSessionKey(sessionKey);
      if (inferred) {
        return { ...normalized, channel: "discord", to: inferred };
      }
    }
  }

  if (normalized.channel === "telegram") {
    if (!normalized.to || /^slash:\d+$/.test(normalized.to)) {
      const inferred = inferTelegramDeliveryFromSessionKey(sessionKey);
      if (inferred) {
        return { ...normalized, ...inferred, ...(normalized.accountId ? { accountId: normalized.accountId } : {}) };
      }
    }

    const inferred = inferTelegramDeliveryFromSessionKey(sessionKey);
    if (inferred?.messageThreadId != null) {
      return {
        ...normalized,
        messageThreadId: inferred.messageThreadId,
        threadId: inferred.threadId ?? inferred.messageThreadId,
      };
    }
  }

  if (normalized.channel === "slack") {
    if (!normalized.to || /^slash:[^:]+$/.test(normalized.to)) {
      const inferred = inferSlackDeliveryFromSessionKey(sessionKey);
      if (inferred) {
        return { ...normalized, ...inferred, ...(normalized.accountId ? { accountId: normalized.accountId } : {}) };
      }
    }

    // If sessionKey includes a thread id, persist it.
    const inferred = inferSlackDeliveryFromSessionKey(sessionKey);
    if (inferred?.messageThreadId != null) {
      return {
        ...normalized,
        messageThreadId: inferred.messageThreadId,
        threadId: inferred.threadId ?? inferred.messageThreadId,
      };
    }
  }

  return normalized;
}

// --- JSONL parsing helpers ---

export function extractAssistantOutputTextFromCodexJsonlEntry(obj) {
  // Expected schema:
  // { type: "response_item", payload: { type: "message", role: "assistant", content: [{type:"output_text", text:"..."}] } }
  if (!obj || typeof obj !== "object") return [];
  if (obj.type !== "response_item") return [];
  const payload = obj.payload;
  if (!payload || typeof payload !== "object") return [];
  if (payload.type !== "message") return [];
  if (payload.role !== "assistant") return [];
  const phase = typeof payload.phase === "string" ? payload.phase.trim().toLowerCase() : "";
  // Skip in-progress commentary updates; only final assistant output should be delivered.
  if (phase === "commentary") return [];
  const content = Array.isArray(payload.content) ? payload.content : [];
  const out = [];
  for (const item of content) {
    if (item && typeof item === "object" && item.type === "output_text" && typeof item.text === "string") {
      if (item.text.trim()) out.push(item.text);
    }
  }
  return out;
}

export function extractTaskCompleteTextFromCodexJsonlEntry(obj) {
  if (!obj || typeof obj !== "object") return "";
  if (obj.type !== "event_msg") return "";
  const payload = obj.payload;
  if (!payload || typeof payload !== "object") return "";
  if (payload.type !== "task_complete") return "";
  const text = typeof payload.last_agent_message === "string" ? payload.last_agent_message.trim() : "";
  return text;
}

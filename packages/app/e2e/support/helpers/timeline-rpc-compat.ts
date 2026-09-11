// COMPAT(timelineSubscribeAndFetch): added in v0.7.2, remove after 2027-03-01.
//
// This fork bootstraps a viewed timeline with the combined `agent.timeline.subscribe_and_fetch`
// RPC: one message that both registers the subscription and returns the first page. Upstream only
// ever emits `agent.timeline.set_subscription.request` followed by `fetch_agent_timeline_request`,
// so every upstream e2e gate matches those two types literally and sees nothing on this fork.
// These helpers let a gate accept either wire shape without caring which one the daemon chose.

type UnknownRecord = Record<string, unknown>;

function asRecord(value: unknown): UnknownRecord | null {
  return value && typeof value === "object" ? (value as UnknownRecord) : null;
}

/**
 * The fetch-shaped request carried by a session message, whether it arrived as a bare
 * `fetch_agent_timeline_request` or nested in the combined subscribe-and-fetch request.
 */
export function asTimelineFetchRequest(sessionMessage: unknown): UnknownRecord | null {
  const message = asRecord(sessionMessage);
  if (!message) return null;
  if (message.type === "fetch_agent_timeline_request") return message;
  if (message.type === "agent.timeline.subscribe_and_fetch.request") return asRecord(message.fetch);
  return null;
}

/**
 * The fetch-response payload carried by a session message, unwrapping the combined
 * subscribe-and-fetch response when the fork's bootstrap RPC was used.
 */
export function asTimelineFetchResponsePayload(
  sessionMessage: unknown,
  payload: unknown,
): UnknownRecord | null {
  const message = asRecord(sessionMessage);
  if (!message) return null;
  if (message.type === "fetch_agent_timeline_response") return asRecord(payload);
  if (message.type === "agent.timeline.subscribe_and_fetch.response") {
    return asRecord(asRecord(payload)?.timeline);
  }
  return null;
}

/** True when the message acknowledges a timeline subscription in either wire shape. */
export function isTimelineSubscriptionResponse(type: unknown): boolean {
  return (
    type === "agent.timeline.set_subscription.response" ||
    type === "agent.timeline.subscribe_and_fetch.response"
  );
}

/** True when the message delivers a timeline page in either wire shape. */
export function isTimelineFetchResponse(type: unknown): boolean {
  return (
    type === "fetch_agent_timeline_response" ||
    type === "agent.timeline.subscribe_and_fetch.response"
  );
}

/** Narrows an unknown cursor field to `{ epoch, seq }` without asserting a shape. */
export function asTimelineCursor(value: unknown): { epoch: string; seq: number } | null {
  if (!value || typeof value !== "object") return null;
  if (!("epoch" in value) || !("seq" in value)) return null;
  const { epoch, seq } = value;
  return typeof epoch === "string" && typeof seq === "number" ? { epoch, seq } : null;
}

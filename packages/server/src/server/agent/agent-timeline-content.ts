import type { AgentTimelineItem } from "./agent-sdk-types.js";
import type { JsonValue } from "@getpaseo/protocol/agent-types";

const TOOL_CALL_CONTENT_MAX_LENGTH = 64 * 1024;
export const PLUGIN_TIMELINE_DATA_MAX_BYTES = 64 * 1024;

export function assertPluginTimelineDataSize(data: JsonValue): void {
  const serializedBytes = Buffer.byteLength(JSON.stringify(data), "utf8");
  if (serializedBytes > PLUGIN_TIMELINE_DATA_MAX_BYTES) {
    throw new Error(`Plugin timeline item data exceeds ${PLUGIN_TIMELINE_DATA_MAX_BYTES} bytes`);
  }
}

// V8 `slice` can return a sliced string that keeps the whole source alive, so a 64 KiB prefix could pin megabytes of tool output for the life of the timeline.
function truncateDetached(value: string, maxLength: number): string {
  return JSON.parse(JSON.stringify(value.slice(0, maxLength))) as string;
}

function limitFailedShellError(item: AgentTimelineItem): AgentTimelineItem {
  if (
    item.type !== "tool_call" ||
    item.detail.type !== "shell" ||
    item.status !== "failed" ||
    typeof item.error !== "object" ||
    item.error === null ||
    !("content" in item.error) ||
    typeof item.error.content !== "string" ||
    item.error.content.length <= TOOL_CALL_CONTENT_MAX_LENGTH
  ) {
    return item;
  }
  return {
    ...item,
    error: {
      ...item.error,
      content: truncateDetached(item.error.content, TOOL_CALL_CONTENT_MAX_LENGTH),
    },
  };
}

function limitPlainText(item: AgentTimelineItem): AgentTimelineItem {
  if (
    item.type !== "tool_call" ||
    item.detail.type !== "plain_text" ||
    typeof item.detail.text !== "string" ||
    item.detail.text.length <= TOOL_CALL_CONTENT_MAX_LENGTH
  ) {
    return item;
  }
  return {
    ...item,
    detail: {
      ...item.detail,
      text: truncateDetached(item.detail.text, TOOL_CALL_CONTENT_MAX_LENGTH),
    },
  };
}

export function limitAgentTimelineItemContent(item: AgentTimelineItem): AgentTimelineItem {
  item = limitFailedShellError(item);
  item = limitPlainText(item);
  if (
    item.type !== "tool_call" ||
    item.detail.type !== "shell" ||
    typeof item.detail.output !== "string"
  ) {
    return item;
  }
  if (item.detail.output.length <= TOOL_CALL_CONTENT_MAX_LENGTH) {
    return item;
  }
  return {
    ...item,
    detail: {
      ...item.detail,
      output: truncateDetached(item.detail.output, TOOL_CALL_CONTENT_MAX_LENGTH),
    },
  };
}

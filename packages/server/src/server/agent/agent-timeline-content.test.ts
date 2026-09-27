import { describe, expect, test } from "vitest";

import { limitAgentTimelineItemContent } from "./agent-timeline-content.js";

describe("agent timeline content", () => {
  test("limits terminal input to the tool-call content budget", () => {
    const oversizedInput = "x".repeat(64 * 1024 + 1);

    const item = limitAgentTimelineItemContent({
      type: "tool_call",
      callId: "terminal-session-4242",
      name: "terminal",
      status: "completed",
      error: null,
      detail: {
        type: "plain_text",
        text: oversizedInput,
        icon: "square_terminal",
      },
    });

    expect(item).toEqual({
      type: "tool_call",
      callId: "terminal-session-4242",
      name: "terminal",
      status: "completed",
      error: null,
      detail: {
        type: "plain_text",
        text: "x".repeat(64 * 1024),
        icon: "square_terminal",
      },
    });
  });

  test("truncates content landing in the middle of a surrogate pair preserving exact code units across all paths", () => {
    const budget = 64 * 1024;
    // 65535 ascii chars followed by a 2-code-unit emoji (\uD83D\uDE00).
    // The cut at 65536 lands between the high surrogate \uD83D and low surrogate \uDE00.
    const splitSurrogateInput = "a".repeat(budget - 1) + "\uD83D\uDE00-trailing-content";
    const expected = splitSurrogateInput.slice(0, budget);

    const shellOutputItem = limitAgentTimelineItemContent({
      type: "tool_call",
      callId: "call-shell",
      name: "shell",
      status: "completed",
      error: null,
      detail: {
        type: "shell",
        command: "cat large.txt",
        output: splitSurrogateInput,
      },
    });

    const plainTextItem = limitAgentTimelineItemContent({
      type: "tool_call",
      callId: "call-plain-text",
      name: "terminal",
      status: "completed",
      error: null,
      detail: {
        type: "plain_text",
        text: splitSurrogateInput,
      },
    });

    const failedShellItem = limitAgentTimelineItemContent({
      type: "tool_call",
      callId: "call-failed-shell",
      name: "shell",
      status: "failed",
      error: {
        message: "Command failed",
        content: splitSurrogateInput,
      },
      detail: {
        type: "shell",
        command: "bad_cmd",
        output: "error",
      },
    });

    expect(shellOutputItem).toEqual({
      type: "tool_call",
      callId: "call-shell",
      name: "shell",
      status: "completed",
      error: null,
      detail: {
        type: "shell",
        command: "cat large.txt",
        output: expected,
      },
    });

    expect(plainTextItem).toEqual({
      type: "tool_call",
      callId: "call-plain-text",
      name: "terminal",
      status: "completed",
      error: null,
      detail: {
        type: "plain_text",
        text: expected,
      },
    });

    expect(failedShellItem).toEqual({
      type: "tool_call",
      callId: "call-failed-shell",
      name: "shell",
      status: "failed",
      error: {
        message: "Command failed",
        content: expected,
      },
      detail: {
        type: "shell",
        command: "bad_cmd",
        output: "error",
      },
    });
  });
});

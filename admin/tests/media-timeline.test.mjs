import assert from "node:assert/strict";
import { test } from "node:test";
import { build } from "esbuild";
const bundle = await build({
  entryPoints: ["shared/conversation-timeline.ts"],
  bundle: true,
  write: false,
  platform: "node",
  format: "cjs",
});
const module = { exports: {} };
new Function("module", "exports", bundle.outputFiles[0].text)(
  module,
  module.exports,
);
const { projectConversationTimeline } = module.exports;
const photoId = "1e730267-11bb-46f0-8127-540e806a2f61";
function caption(sequence, text, startMs, endMs) {
  return {
    sequence,
    caption: {
      id: `caption-${sequence}`,
      voiceId: "voice",
      sequence,
      role: "assistant",
      text,
      startMs,
      endMs,
      createdAt: "2026-10-06T09:00:00.000Z",
    },
  };
}
function event(part) {
  return {
    sequence: 2,
    message: {
      id: "media-event",
      role: "context",
      status: "complete",
      parts: [{ type: "media", version: 1, ...part }],
      createdAt: "2026-10-06T09:00:00.000Z",
    },
  };
}
test("passive photo rename and job status events do not split a spoken sentence", () => {
  for (const part of [
    {
      kind: "renamed",
      windowId: photoId,
      previousTitle: "Kitchen",
      title: "Nursery",
    },
    { kind: "outcome", jobId: photoId, status: "completed" },
    { kind: "visualization", jobId: photoId, customerIntent: false },
  ]) {
    const timeline = projectConversationTimeline([
      caption(1, "Here's your ", 0, 400),
      event(part),
      caption(3, "preview.", 450, 700),
    ]);
    const spoken = timeline.filter((message) => message.role === "assistant");
    assert.equal(spoken.length, 1);
    assert.equal(
      spoken[0].parts.find((part) => part.type === "voice").text,
      "Here's your preview.",
    );
    assert.ok(timeline.some((message) => message.id === "media-event"));
  }
});

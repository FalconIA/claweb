import { describe, expect, it } from "vitest";
import { buildInboundCtx } from "./build-ctx.js";

function makeRuntime() {
  return {
    channel: {
      reply: {
        finalizeInboundContext: (ctx: unknown) => ctx,
      },
    },
  };
}

describe("buildInboundCtx", () => {
  it("does not append visible channel notes to BodyForAgent", async () => {
    const ctx = (await buildInboundCtx({
      runtime: makeRuntime() as any,
      channel: "claweb",
      accountId: "default",
      sessionKey: "claweb:default:user:1",
      userId: "1",
      text: "你好",
      messageId: "msg-1",
      timestamp: 123,
    })) as Record<string, unknown>;

    expect(ctx.BodyForAgent).toBe("你好");
    expect(String(ctx.BodyForAgent)).not.toContain("[CLAWeb channel note]");
    expect(String(ctx.BodyForAgent)).not.toContain("MEDIA:<path-or-url>");
  });
});

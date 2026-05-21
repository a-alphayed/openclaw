import { Command } from "commander";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { setActivePluginRegistry } from "../../../plugins/runtime.js";
import {
  createChannelTestPluginBase,
  createTestRegistry,
} from "../../../test-utils/channel-plugins.js";
import type { MessageCliHelpers } from "./helpers.js";
import { registerMessageThreadCommands } from "./register.thread.js";

function createHelpers(runMessageAction: MessageCliHelpers["runMessageAction"]): MessageCliHelpers {
  return {
    withMessageBase: (command) => command.option("--channel <channel>", "Channel"),
    withMessageTarget: (command) => command.option("-t, --target <dest>", "Target"),
    withRequiredMessageTarget: (command) => command.requiredOption("-t, --target <dest>", "Target"),
    runMessageAction,
  };
}

function firstMessageActionCall(runMessageAction: { mock: { calls: unknown[][] } }) {
  return runMessageAction.mock.calls[0] as [string, Record<string, unknown>] | undefined;
}

describe("registerMessageThreadCommands", () => {
  const runMessageAction = vi.fn(
    async (_action: string, _opts: Record<string, unknown>) => undefined,
  );

  beforeEach(() => {
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "topic-chat",
          source: "test",
          plugin: {
            ...createChannelTestPluginBase({ id: "topic-chat", label: "Topic chat" }),
            actions: {
              resolveCliActionRequest: ({
                action,
                args,
              }: {
                action: string;
                args: Record<string, unknown>;
              }) => {
                if (action !== "thread-create") {
                  return null;
                }
                const { threadName, ...rest } = args;
                return {
                  action: "topic-create",
                  args: {
                    ...rest,
                    name: threadName,
                  },
                };
              },
            },
          },
        },
        {
          pluginId: "plain-chat",
          source: "test",
          plugin: createChannelTestPluginBase({ id: "plain-chat", label: "Plain chat" }),
        },
      ]),
    );
    runMessageAction.mockClear();
  });

  it("routes plugin-remapped thread create actions through channel hooks", async () => {
    const message = new Command().exitOverride();
    registerMessageThreadCommands(message, createHelpers(runMessageAction));

    await message.parseAsync(
      [
        "thread",
        "create",
        "--channel",
        " topic-chat ",
        "-t",
        "room-1",
        "--thread-name",
        "Build Updates",
        "-m",
        "hello",
      ],
      { from: "user" },
    );

    const remappedCall = firstMessageActionCall(runMessageAction);
    expect(remappedCall?.[0]).toBe("topic-create");
    expect(remappedCall?.[1]?.channel).toBe(" topic-chat ");
    expect(remappedCall?.[1]?.target).toBe("room-1");
    expect(remappedCall?.[1]?.name).toBe("Build Updates");
    expect(remappedCall?.[1]?.message).toBe("hello");
    expect(remappedCall?.[1]).not.toHaveProperty("threadName");
  });

  it("keeps default thread create params when the channel does not remap the action", async () => {
    const message = new Command().exitOverride();
    registerMessageThreadCommands(message, createHelpers(runMessageAction));

    await message.parseAsync(
      [
        "thread",
        "create",
        "--channel",
        "plain-chat",
        "-t",
        "channel:123",
        "--thread-name",
        "Build Updates",
        "-m",
        "hello",
      ],
      { from: "user" },
    );

    const defaultCall = firstMessageActionCall(runMessageAction);
    expect(defaultCall?.[0]).toBe("thread-create");
    expect(defaultCall?.[1]?.channel).toBe("plain-chat");
    expect(defaultCall?.[1]?.target).toBe("channel:123");
    expect(defaultCall?.[1]?.threadName).toBe("Build Updates");
    expect(defaultCall?.[1]?.message).toBe("hello");
    expect(defaultCall?.[1]).not.toHaveProperty("name");
  });

  it("routes thread member commands to message actions", async () => {
    const message = new Command().exitOverride();
    registerMessageThreadCommands(message, createHelpers(runMessageAction));

    await message.parseAsync(
      [
        "thread",
        "bind-session",
        "--channel",
        "discord",
        "--thread-id",
        "thread-123",
        "--channel-id",
        "parent-789",
        "--target-session-key",
        "agent:malik:explicit:review",
        "--agent-id",
        "malik",
        "--label",
        "Malik review",
        "--workflow-id",
        "WF-123",
      ],
      { from: "user" },
    );

    expect(runMessageAction).toHaveBeenLastCalledWith(
      "thread-bind-session",
      expect.objectContaining({
        channel: "discord",
        threadId: "thread-123",
        channelId: "parent-789",
        targetSessionKey: "agent:malik:explicit:review",
        agentId: "malik",
        label: "Malik review",
        workflowId: "WF-123",
      }),
    );

    await message.parseAsync(
      [
        "thread",
        "add-member",
        "--channel",
        "discord",
        "--thread-id",
        "thread-123",
        "--user-id",
        "user-456",
      ],
      { from: "user" },
    );

    expect(runMessageAction).toHaveBeenLastCalledWith(
      "thread-member-add",
      expect.objectContaining({
        channel: "discord",
        threadId: "thread-123",
        userId: "user-456",
      }),
    );

    await message.parseAsync(
      [
        "thread",
        "remove-member",
        "--channel",
        "discord",
        "--thread-id",
        "thread-123",
        "--user-id",
        "user-456",
      ],
      { from: "user" },
    );

    expect(runMessageAction).toHaveBeenLastCalledWith(
      "thread-member-remove",
      expect.objectContaining({
        channel: "discord",
        threadId: "thread-123",
        userId: "user-456",
      }),
    );
  });
});

import { defineChannelPluginEntry } from "openclaw/plugin-sdk/channel-core";
import { clawebPlugin, injectPluginRuntime } from "./src/channel.js";

export default defineChannelPluginEntry({
  id: "claweb",
  name: "CLAWeb",
  description: "OpenClaw Web Channel plugin",
  plugin: clawebPlugin,
  setRuntime: injectPluginRuntime,
});

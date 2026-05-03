import { defineSetupPluginEntry } from "openclaw/plugin-sdk/channel-core";
import { clawebPlugin } from "./src/channel.js";

export default defineSetupPluginEntry(clawebPlugin);

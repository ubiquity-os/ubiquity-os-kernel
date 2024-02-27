import { PluginChain } from "./config";

export type PluginChainState = {
  currentPlugin: number;
  pluginChain: PluginChain;
};

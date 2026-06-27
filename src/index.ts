/**
 * agent-shell — public API
 */

export { AgentShellBridge } from "./bridge.js";
export type {
	AgentCommandConfig,
	AgentPreset,
	ResolvedAgentConfig,
	AgentShellConfig,
} from "./config.js";
export {
	BUILT_IN_AGENTS,
	BRIDGE_COMMANDS,
	defaultConfig,
	defaultStorageDir,
	listBuiltInAgents,
	parseAgentCommand,
	resolveAgentSelection,
	resolveCommandAliases,
	resolveCommandNames,
	validateCommandAliases,
	validateInstanceName,
} from "./config.js";
export {
	sendFileMessage,
	sendImageMessage,
	sendTextMessage,
	splitText,
} from "./weixin/send.js";
export type {
	UploadedWeixinMedia,
	WeixinMediaSendOpts,
	WeixinSendOpts,
} from "./weixin/send.js";

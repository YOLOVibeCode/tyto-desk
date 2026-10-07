export {
  AGENT_BROWSER_CONFIG_FILE,
  AGENT_POLICY_FILE,
  FORBIDDEN_AGENT_BROWSER_KEYS,
  agentBrowserConfig,
  agentPolicy,
  cdpUrl,
  type AgentPolicy,
} from "./agents/agent-browser.ts";
export { base64Decode } from "./bytes/base64.ts";
export { sha256 } from "./bytes/sha256.ts";
export {
  FORBIDDEN_CHROME_SWITCHES,
  FORBIDDEN_CHROME_SWITCH_VALUES,
  chromeArgs,
  chromeDefaultDirs,
  type ChromeArgsInput,
  type ChromeArgsRefusal,
  type ChromeArgsResult,
} from "./chrome/args.ts";
export { allocateDeskPorts } from "./config/allocate.ts";
export { newDeskConfig, platformSupported, type NewConfigInput } from "./config/defaults.ts";
export { loadOrCreateConfig, type LoadOrCreateInput, type LoadOrCreateResult } from "./config/load.ts";
export {
  DESK_PORT_MAX,
  DESK_PORT_MIN,
  MIN_CHROME_MAJOR,
  parseDeskConfig,
  serializeDeskConfig,
  type AgentPolicyMode,
  type ConfigParse,
  type ConfigProblem,
  type DeskConfig,
  type FocusGuard,
} from "./config/schema.ts";
export { daemonEnvironment } from "./env/daemon-env.ts";
export type { Env } from "./env/env.ts";
export { shellEnv, type AgentVariables, type ShellEnvInput } from "./env/shell-env.ts";
export { DESK_EXTENSION_ID, DESK_EXTENSION_ORIGIN, NATIVE_HOST_NAME } from "./extension/desk-extension.ts";
export { extensionIdFromKey } from "./extension/extension-id.ts";
export { renderManifest, type RenderManifestInput, type RenderManifestResult } from "./extension/manifest.ts";
export { nativeHostLauncher, nativeHostManifest } from "./extension/native-host.ts";
export {
  nextRenderState,
  parseRenderState,
  serializeRenderState,
  type RenderSource,
  type RenderState,
} from "./extension/render-state.ts";
export { guiAllowed } from "./gui/gui-allowed.ts";
export { FILES_SHA256, formatFilesSha256, parseFilesSha256 } from "./install/files-sha256.ts";
export { installVersion, type InstallInput, type InstallPorts, type InstallResult } from "./install/install.ts";
export {
  nextInstalled,
  parseInstalled,
  serializeInstalled,
  type Installed,
  type InstalledVersion,
} from "./install/installed.ts";
export { deskLauncher, hostLauncher, terminalBinary } from "./install/launchers.ts";
export { prepareFiles, type PreparedFiles } from "./launch/files.ts";
export {
  FIRST_RUN_PREFS,
  launch,
  type ChromePorts,
  type LaunchFailure,
  type LaunchInput,
  type LaunchPorts,
  type LaunchResult,
} from "./launch/launch.ts";
export { ensurePanel, type PanelResult } from "./launch/panel.ts";
export { pollUntil } from "./launch/poll.ts";
export { applyChromeSettings, BACKGROUND_MODE_WARNING } from "./launch/settings.ts";
export { QUIT_ALL_QUESTION, quit, type QuitInput, type QuitPorts, type QuitResult } from "./quit/quit.ts";
export { SETTINGS_PREFS } from "./ports/chrome-settings.ts";
export { confirmToQuitOn } from "./chrome/local-state.ts";
export { httpGuard, type HttpGuardRequest, type HttpGuardResult } from "./net/http-guard.ts";
export { DAEMON_START_MS, startHost, type DaemonCommand, type HostInput, type HostStart } from "./nmhost/host.ts";
export { PanelController, type PanelPorts } from "./panel/panel-controller.ts";
export type * from "./ports/index.ts";
export {
  ERROR_TEXT,
  IN_DATA_MAX,
  PROTOCOL_MAX,
  PROTOCOL_MIN,
  errorMessage,
  isPaneId,
  parseClientMessage,
  parseDaemonMessage,
  type ClientKind,
  type ClientMessage,
  type DaemonMessage,
  type Detached,
  type ErrorCode,
  type ErrorMessage,
  type Exit,
  type ExtCall,
  type ExtOp,
  type ExtResult,
  type Hello,
  type HelloReply,
  type In,
  type List,
  type Notice,
  type Open,
  type Out,
  type PaneListEntry,
  type PaneSummary,
  type Panes,
  type Resize,
  type Shutdown,
  type Snapshot,
} from "./protocol/messages.ts";
export {
  NATIVE_FRAME_MAX,
  NativeFrameDecoder,
  encodeNativeFrame,
  type DecodeResult,
  type EncodeResult,
} from "./protocol/native-messaging.ts";
export {
  NDJSON_LINE_MAX,
  NdjsonLineDecoder,
  encodeNdjsonLine,
  type LineDecodeResult,
  type LineEncodeResult,
} from "./protocol/ndjson.ts";
export { WIRE_DATA_MAX, WIRE_MESSAGE_MAX, jsonStringBytes, splitForWire } from "./protocol/split.ts";
export {
  AGENT_VARIABLE_NAMES,
  TMUX_DESK_LINE,
  agentGate,
  paneEnvironment,
  type AgentGate,
  type PaneEnvironmentInput,
} from "./pty/agent-env.ts";
export { Daemon, type DaemonPorts, type PaneShell } from "./ptyd/daemon.ts";
export { planPaneShell, type PaneShellInput } from "./ptyd/pane-shell.ts";
export { BRANCH_SLUG_MAX, branchSlug } from "./release/branch-slug.ts";
export {
  classifyBuild,
  type BuildChannel,
  type BuildClassification,
  type BuildPublish,
  type BuildRefusal,
  type ClassifyBuildInput,
  type LiveSuite,
} from "./release/classify-build.ts";
export { DESK_COMPAT, type DeskCompat } from "./release/compat.ts";
export { isLatestRelease } from "./release/latest.ts";
export {
  compareSemver,
  compareVersions,
  isBaseVersion,
  parseSemver,
  releaseTagVersion,
  type Semver,
} from "./release/semver.ts";
export { Backoff } from "./time/backoff.ts";
export { parseVersionInfo, versionLine, type VersionInfo } from "./version/version-info.ts";
export { WorkerController, type WorkerPorts } from "./worker/worker-controller.ts";

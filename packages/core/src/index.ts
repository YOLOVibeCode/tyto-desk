export {
  AGENT_BROWSER_CONFIG_FILE,
  AGENT_POLICY_FILE,
  FORBIDDEN_AGENT_BROWSER_KEYS,
  agentBrowserConfig,
  agentPolicy,
  cdpUrl,
  type AgentPolicy,
} from "./agents/agent-browser.ts";
export { detachAgents, detachEnvironment, listAgents } from "./agents/sessions.ts";
export { restoreKeyWarning } from "./agents/restore-warning.ts";
export { DESK_SKILL, skillAllowedTools } from "./agents/skill.ts";
export { addTmuxLine, type TmuxLinePorts } from "./install/tmux-line.ts";
export { DESK_APP_IDENTIFIER, LOGIN_AGENT_LABEL, WEB_ACCESS_DESK_STEP, installExtras, type ExtrasPorts, type ManagedFile } from "./install/extras.ts";
export { pauseAgents, policyModeOf, resumeAgents, setAgentPolicy, type AgentControlPorts, type AgentControlResult } from "./agents/controls.ts";
export { base64Decode } from "./bytes/base64.ts";
export { sha256, sha256Hex } from "./bytes/sha256.ts";
export {
  FORBIDDEN_CHROME_SWITCHES,
  FORBIDDEN_CHROME_SWITCH_VALUES,
  chromeArgs,
  chromeDefaultDirs,
  type ChromeArgsInput,
  type ChromeArgsRefusal,
  type ChromeArgsResult,
} from "./chrome/args.ts";
export { allocateDeskPort, allocateDeskPorts } from "./config/allocate.ts";
export { newGuardedPort, type NewPortPorts } from "./config/new-port.ts";
export { ensureWatch, type WatchStartPorts } from "./launch/watch-start.ts";
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
export { daemonEnvironment, watchEnvironment } from "./env/daemon-env.ts";
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
export { classifyLaunch, listenerIsDesk, singletonState, staleLockToClear } from "./launch/classify.ts";
export type { LaunchDecision, LaunchFacts, SingletonState } from "./launch/classify.ts";
export { prepareFiles, type PreparedFiles } from "./launch/files.ts";
export {
  FIRST_RUN_PREFS,
  WATCH_WARNING,
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
export { ChromeWatch, runWatch, type WatchInput, type WatchPorts } from "./watch/watch.ts";
export { RESTART_QUESTION, daemonRestart, deskStatus, type StatusPorts } from "./status/status.ts";
export { QUIT_ALL_QUESTION, quit, type QuitInput, type QuitPorts, type QuitResult } from "./quit/quit.ts";
export { SETTINGS_PREFS } from "./ports/chrome-settings.ts";
export { confirmToQuitOn } from "./chrome/local-state.ts";
export { filterTargetList, guardedVersion, routeGatewayHttp, type GatewayRoute } from "./gateway/http.ts";
export { GatewayConnection, HiddenTargets, focusGuardOn, isDeskUrl, type FocusCheck, type GatewayStep, type TargetFacts } from "./gateway/policy.ts";
export { LAYOUT_BYTES_MAX, LAYOUT_DEPTH_MAX, LAYOUT_VERSION, TABS_MAX, checkLayout, defaultLayout, parseStoredLayout, type Layout, type LayoutNode, type LayoutTab } from "./layout/layout.ts";
export type { LogEvent } from "./log/events.ts";
export { SecretRedactor } from "./log/redactor.ts";
export { EscapeTail } from "./term/escape-tail.ts";
export { ModeTracker } from "./term/modes.ts";
export { sanitizePaste } from "./term/paste.ts";
export { httpGuard, type HttpGuardRequest, type HttpGuardResult } from "./net/http-guard.ts";
export { DAEMON_START_MS, hostStateFor, startHost, type DaemonCommand, type HostInput, type HostStart } from "./nmhost/host.ts";
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

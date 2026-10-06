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
export type { Env } from "./env/env.ts";
export { shellEnv, type AgentVariables, type ShellEnvInput } from "./env/shell-env.ts";
export { extensionIdFromKey } from "./extension/extension-id.ts";
export { guiAllowed } from "./gui/gui-allowed.ts";
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
export { httpGuard, type HttpGuardRequest, type HttpGuardResult } from "./net/http-guard.ts";
export type { ConfigStore, PortProbe, Random } from "./ports/index.ts";
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

import { DESK_EXTENSION_ORIGIN, NATIVE_HOST_NAME } from "./desk-extension.ts";

/** Where install puts the host's launcher, under `~/.desk`. */
export function nativeHostLauncher(deskHome: string): string {
  return `${deskHome.replace(/\/+$/, "")}/bin/desk-nmhost`;
}

/**
 * The Desk native-host manifest (docs/IMPLEMENTATION.md §8), in the Desk profile's `NativeMessagingHosts`, which the
 * main Chrome never reads: the launcher under `~/.desk/bin`, and the Desk extension as the only allowed origin.
 */
export function nativeHostManifest(deskHome: string): string {
  const manifest = {
    name: NATIVE_HOST_NAME,
    description: "Tyto Desk terminal relay",
    path: nativeHostLauncher(deskHome),
    type: "stdio",
    allowed_origins: [DESK_EXTENSION_ORIGIN],
  };
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

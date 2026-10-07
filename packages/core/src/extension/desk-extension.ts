/**
 * The Desk extension's id: what Chrome derives from the `key` in packages/extension/manifest.json (an RSA-2048 public
 * key generated once; its private half was never kept, docs/IMPLEMENTATION.md §9). The native host's manifest allows
 * only this origin, and the build fails unless `extensionIdFromKey(manifest.key)` equals it (§18).
 */
export const DESK_EXTENSION_ID = "nmnljgjkacmplpfllopodplgmpjogdbf";

/** The caller origin Chrome passes the native host, and the only one its manifest allows. */
export const DESK_EXTENSION_ORIGIN = `chrome-extension://${DESK_EXTENSION_ID}/`;

/** The native-messaging host's name (§8): `<user-data-dir>/NativeMessagingHosts/com.noctusoft.desk.json`. */
export const NATIVE_HOST_NAME = "com.noctusoft.desk";

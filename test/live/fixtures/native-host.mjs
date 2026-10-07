// @ts-check
/**
 * The live suite's native-messaging echo host, ported from the 2026-10-06 prototype (nmhost/host.mjs). Chrome starts it
 * with the caller's origin as its first argument; it answers the first message with that message and its own
 * arguments, then exits. It frames with core's native-messaging codec, as desk-nmhost will (Node strips the types).
 */
import { NativeFrameDecoder, encodeNativeFrame } from "../../../packages/core/src/index.ts";

const decoder = new NativeFrameDecoder();
process.stdin.on("data", (/** @type {Buffer} */ chunk) => {
  const result = decoder.push(chunk);
  if (!result.ok) process.exit(1);
  const [frame] = result.frames;
  if (frame === undefined) return;
  const message = JSON.parse(new TextDecoder().decode(frame));
  const reply = encodeNativeFrame(new TextEncoder().encode(JSON.stringify({ echo: message, argv: process.argv.slice(2) })));
  if (!reply.ok) process.exit(1);
  process.stdout.write(reply.frame, () => process.exit(0));
});
process.stdin.on("end", () => process.exit(0));

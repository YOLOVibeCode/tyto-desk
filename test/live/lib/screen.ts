import { readFile } from "node:fs/promises";
import { crc32, deflateSync } from "node:zlib";
import { FRAMEBUFFER } from "../../../scripts/lib/live.mjs";

/** The whole Xvfb screen, as RGB. */
export type Screen = { width: number; height: number; rgb(x: number, y: number): [number, number, number] };

/**
 * Reads the screen from Xvfb's framebuffer file (`-fbdir`, an XWD dump the X server keeps current): what is actually
 * drawn, Chrome's own window chrome and side panel included, which no CDP screenshot shows. XWD headers are 25
 * big-endian 32-bit fields; the pixels follow the header, the window name and the colormap, in the byte order the
 * header names, and the masks say where red, green and blue are.
 */
export async function readScreen(path: string = FRAMEBUFFER): Promise<Screen> {
  const data = await readFile(path);
  const field = (index: number) => data.readUInt32BE(index * 4);
  const headerSize = field(0);
  const [format, width, height, byteOrder, bitsPerPixel, bytesPerLine] = [field(2), field(4), field(5), field(7), field(11), field(12)];
  const [redMask, greenMask, blueMask, colors] = [field(14), field(15), field(16), field(19)];
  if (format !== 2 || bitsPerPixel !== 32) throw new Error(`unexpected XWD framebuffer: format ${format}, ${bitsPerPixel} bits per pixel`);
  const pixels = headerSize + colors * 12;
  const channel = (value: number, mask: number) => {
    const shift = Math.log2(mask & -mask);
    return (value & mask) >>> shift;
  };
  return {
    width,
    height,
    rgb(x, y) {
      const at = pixels + y * bytesPerLine + x * 4;
      const value = byteOrder === 0 ? data.readUInt32LE(at) : data.readUInt32BE(at);
      return [channel(value, redMask), channel(value, greenMask), channel(value, blueMask)];
    },
  };
}

/** The longest run of `row`'s pixels within `tolerance` of `color`, as [first x, last x], or null. */
export function longestRun(screen: Screen, row: number, color: [number, number, number], tolerance = 2): [number, number] | null {
  let best: [number, number] | null = null;
  let start = -1;
  for (let x = 0; x <= screen.width; x += 1) {
    const matches =
      x < screen.width && screen.rgb(x, row).every((value, i) => Math.abs(value - (color[i] ?? 0)) <= tolerance);
    if (matches && start < 0) start = x;
    if (!matches && start >= 0) {
      if (best === null || x - 1 - start > best[1] - best[0]) best = [start, x - 1];
      start = -1;
    }
  }
  return best;
}

/** The screen as a PNG (8-bit RGB, no filter), for test-results/. */
export function screenPng(screen: Screen): Buffer {
  const raw = Buffer.alloc(screen.height * (1 + screen.width * 3));
  for (let y = 0; y < screen.height; y += 1) {
    const line = y * (1 + screen.width * 3);
    for (let x = 0; x < screen.width; x += 1) {
      const [r, g, b] = screen.rgb(x, y);
      raw[line + 1 + x * 3] = r;
      raw[line + 2 + x * 3] = g;
      raw[line + 3 + x * 3] = b;
    }
  }
  const chunk = (type: string, body: Buffer) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(body.length);
    const typed = Buffer.concat([Buffer.from(type, "latin1"), body]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(typed));
    return Buffer.concat([length, typed, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(screen.width, 0);
  header.writeUInt32BE(screen.height, 4);
  header.writeUInt8(8, 8);
  header.writeUInt8(2, 9);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

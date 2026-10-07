import { request } from "node:http";

/** What Chrome answered on its own DevTools HTTP endpoint. */
export type RawAnswer = { status: number; contentType: string | undefined; body: Buffer };

/** §6.6: a request to Chrome's port gets 5 s. */
const RAW_MS = 5_000;

/**
 * One request to the Desk Chrome's raw port on 127.0.0.1, with Chrome's own Host (`127.0.0.1:<port>`) and no Origin, as
 * Chrome requires; `null` when nothing answered in time.
 */
export function rawRequest(rawPort: number, method: string, path: string): Promise<RawAnswer | null> {
  return new Promise((resolve) => {
    const req = request(
      { host: "127.0.0.1", port: rawPort, method, path, headers: { host: `127.0.0.1:${rawPort}` }, signal: AbortSignal.timeout(RAW_MS) },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => resolve({ status: res.statusCode ?? 502, contentType: res.headers["content-type"], body: Buffer.concat(chunks) }));
        res.on("error", () => resolve(null));
      },
    );
    req.on("error", () => resolve(null));
    req.end();
  });
}

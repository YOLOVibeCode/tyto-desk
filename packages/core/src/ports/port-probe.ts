/** Whether a loopback TCP port can be taken right now. Adapter: packages/node (`node:net`, 127.0.0.1). */
export interface PortProbe {
  isFree(port: number): Promise<boolean>;
}

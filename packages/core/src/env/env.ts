/** Environment variables as a plain record. Core never reads `process.env`; callers pass what they have. */
export type Env = Readonly<Record<string, string | undefined>>;

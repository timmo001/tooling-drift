import { createRequire } from "node:module";
import { Schema } from "effect";

const Manifest = Schema.Struct({ version: Schema.String });

/** The package version shown by `tooling-drift --version`, read from package.json. */
export const version = Schema.decodeUnknownSync(Manifest)(
  createRequire(import.meta.url)("../package.json"),
).version;

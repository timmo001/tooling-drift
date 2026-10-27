import { Effect, FileSystem, Path, Schema } from "effect";
import { Yaml } from "effect/encoding";

/** The file at a repository root that records its reviewed tool releases. */
export const TOOLING_FILE = "tooling.yml";

/** One tool the repository depends on, with the release last reviewed. */
export const Tool = Schema.Struct({
  /** GitHub repository whose releases are tracked, as `owner/name`. */
  repo: Schema.String,
  /** Release tag last reviewed. */
  reviewed: Schema.String,
  /**
   * Pattern a tag must match to count, read from the repository's tags rather
   * than its latest GitHub release. For repositories that release several
   * packages, or tag versions without releases.
   */
  tags: Schema.optionalKey(Schema.String),
  /**
   * Follow prereleases too, such as release candidates, read from the
   * repository's tags. A prerelease gives way to its stable version once that
   * is tagged.
   */
  prereleases: Schema.optionalKey(Schema.Boolean),
  /** Command run with the tag to refresh what the repository derives from the tool. */
  update: Schema.optionalKey(Schema.String),
  /** Files a pin move touches; any other change is a change to the derived contract. */
  pins: Schema.optionalKey(Schema.Array(Schema.String)),
  /** One line for the pull request on what to review. */
  review: Schema.optionalKey(Schema.String),
});

export interface Tool extends Schema.Schema.Type<typeof Tool> {}

export const ToolingFile = Schema.Struct({
  /** GitHub login assigned to every pull request. */
  assignee: Schema.optionalKey(Schema.String),
  /** Workflow files dispatched on a branch after a push; defaults to ci.yml. */
  dispatch: Schema.optionalKey(Schema.Array(Schema.String)),
  tools: Schema.Array(Tool),
});

export interface ToolingFile extends Schema.Schema.Type<typeof ToolingFile> {}

export class ToolingFileError extends Schema.TaggedError<ToolingFileError>()(
  "ToolingFileError",
  { message: Schema.String },
) {}

const repositoryPattern = /^[\w.-]+\/[\w.-]+$/;

const isPattern = (source: string) => {
  try {
    new RegExp(source);

    return true;
  } catch {
    return false;
  }
};

/** Decode tooling.yml text, rejecting malformed or repeated repositories. */
export const decodeToolingFile = Effect.fn("Tooling.decode")(function* (
  text: string,
) {
  const value = yield* Effect.try({
    try: () => Yaml.parse(text),
    catch: (cause) =>
      new ToolingFileError({
        message: `${TOOLING_FILE} is not valid YAML: ${String(cause)}`,
      }),
  });

  const file = yield* Schema.decodeUnknownEffect(ToolingFile)(value).pipe(
    Effect.mapError(
      (cause) =>
        new ToolingFileError({
          message: `${TOOLING_FILE} does not match the expected shape: ${String(cause)}`,
        }),
    ),
  );

  const seen = new Set<string>();

  for (const tool of file.tools) {
    if (!repositoryPattern.test(tool.repo))
      return yield* new ToolingFileError({
        message: `${TOOLING_FILE}: ${JSON.stringify(tool.repo)} is not an owner/name repository`,
      });

    if (tool.tags !== undefined && !isPattern(tool.tags))
      return yield* new ToolingFileError({
        message: `${TOOLING_FILE}: ${tool.repo} tags ${JSON.stringify(tool.tags)} is not a valid pattern`,
      });

    const key = tool.repo.toLowerCase();

    if (seen.has(key))
      return yield* new ToolingFileError({
        message: `${TOOLING_FILE}: ${tool.repo} is listed more than once`,
      });

    seen.add(key);
  }

  return file;
});

export const toolingFilePath = (root: string) =>
  Effect.map(Path.Path, (path) => path.join(root, TOOLING_FILE));

export const readToolingFile = Effect.fn("Tooling.read")(function* (
  root: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const file = yield* toolingFilePath(root);

  const text = yield* fs.readFileString(file).pipe(
    Effect.mapError(
      (cause) =>
        new ToolingFileError({
          message: `Could not read ${file}: ${String(cause)}`,
        }),
    ),
  );

  return yield* decodeToolingFile(text);
});

const sameRepository = (a: string, b: string) =>
  a.toLowerCase() === b.toLowerCase();

/**
 * Rewrite one tool's `reviewed` line and leave everything else as written,
 * comments included. Returns the text unchanged when the tool is absent.
 */
export const recordReviewed = (text: string, repo: string, tag: string) => {
  let current: string | undefined;

  return text
    .split("\n")
    .map((line) => {
      const start = /^\s*-\s*repo:\s*(?<repo>.*?)\s*$/.exec(line)?.groups?.repo;

      if (start !== undefined) {
        current = start.replace(/^"|"$/g, "");

        return line;
      }

      const prefix = /^(?<prefix>\s+reviewed:\s*).*$/.exec(line)?.groups
        ?.prefix;

      return prefix !== undefined &&
        current !== undefined &&
        sameRepository(current, repo)
        ? `${prefix}${tag}`
        : line;
    })
    .join("\n");
};

/** Record a tool's reviewed tag in tooling.yml, checking the result reads back. */
export const writeReviewed = Effect.fn("Tooling.writeReviewed")(function* (
  root: string,
  repo: string,
  tag: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const file = yield* toolingFilePath(root);

  const text = yield* fs.readFileString(file).pipe(
    Effect.mapError(
      (cause) =>
        new ToolingFileError({
          message: `Could not read ${file}: ${String(cause)}`,
        }),
    ),
  );

  const updated = recordReviewed(text, repo, tag);
  const decoded = yield* decodeToolingFile(updated);

  const tool = decoded.tools.find((entry) => sameRepository(entry.repo, repo));

  if (!tool || tool.reviewed !== tag)
    return yield* new ToolingFileError({
      message: `Could not record ${repo} ${tag} in ${TOOLING_FILE}; is the tool listed with a reviewed line?`,
    });

  yield* fs.writeFileString(file, updated).pipe(
    Effect.mapError(
      (cause) =>
        new ToolingFileError({
          message: `Could not write ${file}: ${String(cause)}`,
        }),
    ),
  );
});

/** Find a tool by repository, matched without case. */
export const findTool = (file: ToolingFile, repo: string) =>
  file.tools.find((tool) => sameRepository(tool.repo, repo));

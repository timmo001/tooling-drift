import { Console, Effect, Option } from "effect";
import { Argument, Command, Flag } from "effect/cli";
import { Git } from "./git.js";
import { ToolingDrift, renderStatusLine } from "./tooling-drift.js";

const repositoryRoot = Effect.gen(function* () {
  const git = yield* Git;

  return yield* git.root(process.cwd());
});

const statusCommand = Command.make(
  "status",
  {
    json: Flag.Boolean("json").pipe(
      Flag.withDefault(false),
      Flag.withDescription("Print the report as JSON"),
    ),
  },
  ({ json }) =>
    Effect.gen(function* () {
      const drift = yield* ToolingDrift;
      const report = yield* drift.status(yield* repositoryRoot);

      if (json) yield* Console.log(JSON.stringify(report, null, 2));
      else
        for (const item of report.items)
          yield* Console.log(renderStatusLine(item));

      if (report.behind) process.exitCode = 1;
    }),
).pipe(
  Command.withDescription(
    "Compare each tool's reviewed release with its latest; exit 1 when one is behind",
  ),
);

const updateCommand = Command.make(
  "update",
  {
    repo: Argument.String("repo").pipe(
      Argument.withDescription("Tool repository as owner/name"),
    ),
    tag: Argument.String("tag").pipe(
      Argument.withDescription("Release tag to review at"),
    ),
  },
  ({ repo, tag }) =>
    Effect.gen(function* () {
      const drift = yield* ToolingDrift;
      yield* drift.update(yield* repositoryRoot, repo, tag);
    }),
).pipe(
  Command.withDescription(
    "Run the tool's update command at a release, then record it as reviewed",
  ),
);

const publishCommand = Command.make(
  "publish",
  {
    repo: Flag.String("repo").pipe(
      Flag.optional,
      Flag.withDescription("Only this tool repository"),
    ),
  },
  ({ repo }) =>
    Effect.gen(function* () {
      const drift = yield* ToolingDrift;
      yield* drift.publish(yield* repositoryRoot, Option.getOrUndefined(repo));
    }),
).pipe(
  Command.withDescription(
    "Update every tool behind its latest release and open or refresh its pull request",
  ),
);

export const toolingDriftCommand = Command.make("tooling-drift", {}).pipe(
  Command.withDescription(
    "Keep a repository reviewed against the releases of the tools it depends on",
  ),
  Command.withSubcommands([statusCommand, updateCommand, publishCommand]),
);

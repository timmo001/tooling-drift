import {
  Config,
  Console,
  Context,
  Effect,
  FileSystem,
  Layer,
  Match,
  Path,
  Result,
  Schema,
} from "effect";
import {
  TOOLING_FILE,
  type Tool,
  type ToolingFile,
  ToolingFileError,
  findTool,
  readToolingFile,
  writeReviewed,
} from "./config.js";
import {
  branchName,
  isPinOnly,
  pullRequestBody,
  pullRequestTitle,
} from "./drift.js";
import { Git, type GitError } from "./git.js";
import { GitHub, type GitHubError } from "./github.js";
import { type ProcessError, Processes } from "./processes.js";

export class ToolingDriftError extends Schema.TaggedError<ToolingDriftError>()(
  "ToolingDriftError",
  { message: Schema.String },
) {}

export interface StatusItem {
  readonly repo: string;
  readonly reviewed: string;
  readonly latest: string | null;
  readonly url: string | null;
  readonly state: "up-to-date" | "release-available" | "error";
  readonly reason?: string;
}

export interface StatusReport {
  readonly items: readonly StatusItem[];
  /** A tool is behind its latest release, or its release could not be read. */
  readonly behind: boolean;
}

export const renderStatusLine = (item: StatusItem) =>
  Match.value(item.state).pipe(
    Match.when(
      "up-to-date",
      () => `${item.repo}: up to date at ${item.reviewed}`,
    ),
    Match.when(
      "release-available",
      () => `${item.repo}: ${item.reviewed} -> ${item.latest}`,
    ),
    Match.when(
      "error",
      () => `${item.repo}: could not read the latest release (${item.reason})`,
    ),
    Match.exhaustive,
  );

export type UpdateError = ToolingDriftError | ToolingFileError | ProcessError;

export type PublishError = UpdateError | GitError | GitHubError;

/** The drift workflow over one repository checkout. */
export interface ToolingDriftInterface {
  /** Compare every tool's reviewed release with the latest. */
  readonly status: (
    root: string,
  ) => Effect.Effect<StatusReport, ToolingFileError>;
  /** Run a tool's update command at a tag, then record the tag as reviewed. */
  readonly update: (
    root: string,
    repo: string,
    tag: string,
  ) => Effect.Effect<void, UpdateError>;
  /**
   * Update every tool behind its latest release, or one, and open or refresh
   * its pull request. Leaves the checkout where it started.
   */
  readonly publish: (
    root: string,
    only?: string,
  ) => Effect.Effect<void, PublishError>;
}

export class ToolingDrift extends Context.Service<
  ToolingDrift,
  ToolingDriftInterface
>()("@timmo001/tooling-drift/ToolingDrift") {}

const sameRepository = (a: string, b: string) =>
  a.toLowerCase() === b.toLowerCase();

const splitCommand = (command: string) =>
  command.trim().split(/\s+/).filter(Boolean);

export const make: Effect.Effect<
  ToolingDrift["Service"],
  never,
  Git | GitHub | Processes | FileSystem.FileSystem | Path.Path
> = Effect.gen(function* () {
  const git = yield* Git;
  const github = yield* GitHub;
  const processes = yield* Processes;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  // Pull requests opened with GITHUB_TOKEN cannot trigger pull_request
  // workflows, so by default CI is dispatched on the branch.
  const dispatch = yield* Config.Boolean("TOOLING_DRIFT_DISPATCH").pipe(
    Config.withDefault(true),
    Effect.orDie,
  );

  const onActions = yield* Config.String("GITHUB_ACTIONS").pipe(
    Config.withDefault(""),
    Effect.map((value) => value === "true"),
    Effect.orDie,
  );

  const withServices = <A, E>(
    effect: Effect.Effect<A, E, FileSystem.FileSystem | Path.Path>,
  ) =>
    effect.pipe(
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(Path.Path, path),
    );

  const statusItem = Effect.fn("ToolingDrift.statusItem")(function* (
    tool: Tool,
  ) {
    const release = yield* Effect.result(github.latestRelease(tool.repo));

    if (Result.isFailure(release))
      return {
        repo: tool.repo,
        reviewed: tool.reviewed,
        latest: null,
        url: null,
        state: "error",
        reason: release.failure.message,
      } satisfies StatusItem;

    return {
      repo: tool.repo,
      reviewed: tool.reviewed,
      latest: release.success.tag,
      url: release.success.url,
      state:
        release.success.tag === tool.reviewed
          ? "up-to-date"
          : "release-available",
    } satisfies StatusItem;
  });

  const status = Effect.fn("ToolingDrift.status")(function* (root: string) {
    const file = yield* withServices(readToolingFile(root));

    const items = yield* Effect.forEach(file.tools, statusItem, {
      concurrency: 4,
    });

    return {
      items,
      behind: items.some((item) => item.state !== "up-to-date"),
    } satisfies StatusReport;
  });

  const requireTool = Effect.fn("ToolingDrift.requireTool")(function* (
    file: ToolingFile,
    repo: string,
  ) {
    const tool = findTool(file, repo);

    return (
      tool ??
      (yield* new ToolingDriftError({
        message: `${repo} is not listed in ${TOOLING_FILE}`,
      }))
    );
  });

  /** Run the tool's update command with the tag, then record the tag. */
  const runUpdate = Effect.fn("ToolingDrift.runUpdate")(function* (
    root: string,
    tool: Tool,
    tag: string,
  ) {
    if (tool.update !== undefined) {
      const parts = splitCommand(tool.update);
      const command = parts.at(0);
      const args = parts.slice(1);

      if (command === undefined)
        return yield* new ToolingDriftError({
          message: `${tool.repo} has an empty update command`,
        });

      const code = yield* processes.inherit(command, [...args, tag], root);

      if (code !== 0)
        return yield* new ToolingDriftError({
          message: `${tool.update} ${tag} exited with code ${code}`,
        });
    }

    yield* withServices(writeReviewed(root, tool.repo, tag));
  });

  const update = Effect.fn("ToolingDrift.update")(function* (
    root: string,
    repo: string,
    tag: string,
  ) {
    const file = yield* withServices(readToolingFile(root));
    const tool = yield* requireTool(file, repo);
    yield* runUpdate(root, tool, tag);
    yield* Console.log(`Reviewed ${tool.repo} at ${tag}`);
  });

  interface PublishContext {
    readonly root: string;
    readonly file: ToolingFile;
    readonly repository: string;
    readonly base: string;
  }

  const publishTool = Effect.fn("ToolingDrift.publishTool")(function* (
    context: PublishContext,
    tool: Tool,
    tag: string,
  ) {
    const { root, repository, base } = context;
    const branch = branchName(tool.repo);

    yield* git.createBranch(root, branch, `origin/${base}`);
    yield* runUpdate(root, tool, tag);
    const changed = yield* git.stageAll(root);

    if (changed.length === 0) {
      yield* Console.log(`${tool.repo}: nothing changed at ${tag}`);

      return;
    }

    const pinOnly = isPinOnly(tool, changed);
    const title = pullRequestTitle(tool, tag, changed);
    const body = pullRequestBody(tool, tag, changed);
    yield* git.commit(root, title);

    const existing = yield* github.openPullRequest(repository, base, branch);

    if (
      existing &&
      existing.title === title &&
      (yield* git.sameAsRemote(root, branch))
    ) {
      yield* Console.log(
        `${tool.repo}: pull request #${existing.number} already carries ${title}`,
      );

      return;
    }

    yield* git.forcePush(root, branch);

    const url = yield* github.upsertPullRequest(
      {
        repository,
        base,
        head: branch,
        title,
        body,
        assignee: context.file.assignee,
      },
      existing,
    );

    if (pinOnly)
      yield* github
        .enableSquashAutoMerge(repository, url)
        .pipe(
          Effect.catch((error) =>
            Console.warn(
              `::warning::Could not enable auto-merge on ${url}; merge it by hand (${error.message})`,
            ),
          ),
        );
    else if (existing)
      yield* github.disableAutoMerge(repository, url).pipe(Effect.ignore);

    if (dispatch)
      for (const workflow of context.file.dispatch ?? ["ci.yml"])
        yield* github.dispatchWorkflow(repository, workflow, branch);

    yield* Console.log(`${tool.repo}: published ${title} at ${url}`);
  });

  const publish = Effect.fn("ToolingDrift.publish")(function* (
    root: string,
    only?: string,
  ) {
    if (!(yield* git.isClean(root)))
      return yield* new ToolingDriftError({
        message: "The working tree has changes; commit or stash them first",
      });

    const file = yield* withServices(readToolingFile(root));

    if (only !== undefined) yield* requireTool(file, only);

    if (onActions)
      yield* git.configureIdentity(
        root,
        "github-actions[bot]",
        "41898282+github-actions[bot]@users.noreply.github.com",
      );

    const { name: repository, defaultBranch: base } =
      yield* github.currentRepository(root);

    if (!(yield* git.fetch(root, base)))
      return yield* new ToolingDriftError({
        message: `Could not fetch ${base} from origin`,
      });

    const start = yield* git.checkout(root);
    const context: PublishContext = { root, file, repository, base };

    const work = Effect.gen(function* () {
      for (const tool of file.tools) {
        if (only !== undefined && !sameRepository(tool.repo, only)) continue;

        const latest = yield* github.latestRelease(tool.repo);

        if (latest.tag === tool.reviewed) {
          yield* Console.log(`${tool.repo}: up to date at ${tool.reviewed}`);
          continue;
        }

        yield* publishTool(context, tool, latest.tag);
      }
    });

    yield* work.pipe(
      Effect.ensuring(git.restore(root, start).pipe(Effect.ignore)),
    );
  });

  return ToolingDrift.of({ status, update, publish });
});

export const layerWithoutDependencies = Layer.effect(ToolingDrift, make);

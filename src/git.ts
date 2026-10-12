import { Context, Effect, Layer, Schema } from "effect";
import { Processes } from "./processes.js";

export class GitError extends Schema.TaggedError<GitError>()("GitError", {
  command: Schema.String,
  exitCode: Schema.Int,
  stderr: Schema.String,
}) {}

/** Where a publish run started, so it can return there. */
export interface Checkout {
  /** Branch name, or `HEAD` when detached. */
  readonly ref: string;
  readonly sha: string;
}

/** The git operations a publish run needs, over one repository checkout. */
export interface GitInterface {
  /** Root of the repository containing a directory. */
  readonly root: (cwd: string) => Effect.Effect<string, GitError>;
  readonly isClean: (root: string) => Effect.Effect<boolean, GitError>;
  readonly configureIdentity: (
    root: string,
    name: string,
    email: string,
  ) => Effect.Effect<void, GitError>;
  /** Fetch a ref from origin; false when origin has no such ref. */
  readonly fetch: (
    root: string,
    ref: string,
  ) => Effect.Effect<boolean, GitError>;
  readonly checkout: (root: string) => Effect.Effect<Checkout, GitError>;
  /** Create or reset a branch at a start point and switch to it. */
  readonly createBranch: (
    root: string,
    branch: string,
    from: string,
  ) => Effect.Effect<void, GitError>;
  /** Stage every change and return the staged paths. */
  readonly stageAll: (
    root: string,
  ) => Effect.Effect<readonly string[], GitError>;
  readonly commit: (
    root: string,
    message: string,
  ) => Effect.Effect<void, GitError>;
  /** Whether HEAD's tree equals origin's copy of a branch. */
  readonly sameAsRemote: (
    root: string,
    branch: string,
  ) => Effect.Effect<boolean, GitError>;
  readonly forcePush: (
    root: string,
    branch: string,
  ) => Effect.Effect<void, GitError>;
  /** Discard uncommitted changes and return to a checkout. */
  readonly restore: (
    root: string,
    checkout: Checkout,
  ) => Effect.Effect<void, GitError>;
  /** Tag names of a GitHub repository, read without cloning it. */
  readonly remoteTags: (
    root: string,
    repo: string,
  ) => Effect.Effect<readonly string[], GitError>;
}

export class Git extends Context.Service<Git, GitInterface>()(
  "@timmo001/tooling-drift/Git",
) {}

export const make: Effect.Effect<Git["Service"], never, Processes> = Effect.gen(
  function* () {
    const processes = yield* Processes;

    const run = Effect.fn("Git.run")(function* (
      cwd: string,
      args: readonly string[],
    ) {
      const result = yield* processes.capture("git", args, cwd).pipe(
        Effect.mapError(
          (error) =>
            new GitError({
              command: error.command,
              exitCode: error.exitCode,
              stderr: error.stderr,
            }),
        ),
      );

      if (result.exitCode !== 0)
        return yield* new GitError({
          command: `git ${args.join(" ")}`,
          exitCode: result.exitCode,
          stderr: result.stderr,
        });

      return result.stdout.trim();
    });

    const exitCode = (cwd: string, args: readonly string[]) =>
      processes.capture("git", args, cwd).pipe(
        Effect.map((result) => result.exitCode),
        Effect.mapError(
          (error) =>
            new GitError({
              command: error.command,
              exitCode: error.exitCode,
              stderr: error.stderr,
            }),
        ),
      );

    const root = Effect.fn("Git.root")(function* (cwd: string) {
      return yield* run(cwd, ["rev-parse", "--show-toplevel"]);
    });

    const isClean = Effect.fn("Git.isClean")(function* (root: string) {
      return (yield* run(root, ["status", "--porcelain"])) === "";
    });

    const configureIdentity = Effect.fn("Git.configureIdentity")(function* (
      root: string,
      name: string,
      email: string,
    ) {
      yield* run(root, ["config", "user.name", name]);
      yield* run(root, ["config", "user.email", email]);
    });

    const fetch = Effect.fn("Git.fetch")(function* (root: string, ref: string) {
      return (yield* exitCode(root, ["fetch", "--quiet", "origin", ref])) === 0;
    });

    const checkout = Effect.fn("Git.checkout")(function* (root: string) {
      return {
        ref: yield* run(root, ["rev-parse", "--abbrev-ref", "HEAD"]),
        sha: yield* run(root, ["rev-parse", "HEAD"]),
      } satisfies Checkout;
    });

    const createBranch = Effect.fn("Git.createBranch")(function* (
      root: string,
      branch: string,
      from: string,
    ) {
      yield* run(root, ["switch", "--quiet", "--force-create", branch, from]);
    });

    const stageAll = Effect.fn("Git.stageAll")(function* (root: string) {
      yield* run(root, ["add", "-A"]);

      return (yield* run(root, ["diff", "--cached", "--name-only"]))
        .split("\n")
        .filter(Boolean);
    });

    const commit = Effect.fn("Git.commit")(function* (
      root: string,
      message: string,
    ) {
      yield* run(root, ["commit", "--quiet", "-m", message]);
    });

    const sameAsRemote = Effect.fn("Git.sameAsRemote")(function* (
      root: string,
      branch: string,
    ) {
      if (!(yield* fetch(root, branch))) return false;

      return (
        (yield* exitCode(root, [
          "diff",
          "--quiet",
          `origin/${branch}`,
          "HEAD",
          "--",
        ])) === 0
      );
    });

    const forcePush = Effect.fn("Git.forcePush")(function* (
      root: string,
      branch: string,
    ) {
      yield* run(root, [
        "push",
        "--force",
        "--quiet",
        "origin",
        `HEAD:refs/heads/${branch}`,
      ]);
    });

    const restore = Effect.fn("Git.restore")(function* (
      root: string,
      checkout: Checkout,
    ) {
      yield* run(root, ["reset", "--quiet", "--hard"]);
      yield* checkout.ref === "HEAD"
        ? run(root, ["switch", "--quiet", "--detach", checkout.sha])
        : run(root, ["switch", "--quiet", checkout.ref]);
    });

    const remoteTags = Effect.fn("Git.remoteTags")(function* (
      root: string,
      repo: string,
    ) {
      const output = yield* run(root, [
        "ls-remote",
        "--tags",
        "--refs",
        `https://github.com/${repo}.git`,
      ]);

      return output
        .split("\n")
        .flatMap((line) => line.split("\trefs/tags/").slice(1));
    });

    return Git.of({
      root,
      isClean,
      configureIdentity,
      fetch,
      checkout,
      createBranch,
      stageAll,
      commit,
      sameAsRemote,
      forcePush,
      restore,
      remoteTags,
    });
  },
);

export const layerWithoutDependencies = Layer.effect(Git, make);

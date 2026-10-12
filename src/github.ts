import {
  Gh,
  type GhError,
  PullRequest,
  Release,
  Repository,
  Workflow,
} from "@timmo001/effect-gh";
import { Context, Effect, Layer, Match, Schema } from "effect";

export class GitHubError extends Schema.TaggedError<GitHubError>()(
  "GitHubError",
  { operation: Schema.String, message: Schema.String },
) {}

export interface LatestRelease {
  readonly tag: string;
  readonly url: string;
}

export interface CurrentRepository {
  /** `owner/name`. */
  readonly name: string;
  readonly defaultBranch: string;
}

export interface PullRequestRef {
  readonly number: number;
  readonly title: string;
  readonly url: string;
}

export interface PullRequestContent {
  readonly repository: string;
  readonly base: string;
  readonly head: string;
  readonly title: string;
  readonly body: string;
  readonly assignee: string | undefined;
}

/** The GitHub operations a drift run needs; the production layer runs them through gh. */
export interface GitHubInterface {
  readonly latestRelease: (
    repo: string,
  ) => Effect.Effect<LatestRelease, GitHubError>;
  /** The repository the working directory belongs to. */
  readonly currentRepository: (
    cwd: string,
  ) => Effect.Effect<CurrentRepository, GitHubError>;
  /** The open pull request from a branch into the base, if any. */
  readonly openPullRequest: (
    repository: string,
    base: string,
    head: string,
  ) => Effect.Effect<PullRequestRef | undefined, GitHubError>;
  /** Open the pull request, or retitle and rewrite the existing one; returns its URL. */
  readonly upsertPullRequest: (
    content: PullRequestContent,
    existing: PullRequestRef | undefined,
  ) => Effect.Effect<string, GitHubError>;
  readonly enableSquashAutoMerge: (
    repository: string,
    url: string,
  ) => Effect.Effect<void, GitHubError>;
  readonly disableAutoMerge: (
    repository: string,
    url: string,
  ) => Effect.Effect<void, GitHubError>;
  readonly dispatchWorkflow: (
    repository: string,
    workflow: string,
    ref: string,
  ) => Effect.Effect<void, GitHubError>;
}

export class GitHub extends Context.Service<GitHub, GitHubInterface>()(
  "@timmo001/tooling-drift/GitHub",
) {}

/** One line on why a gh operation failed. */
const describeGhError = (error: GhError) =>
  Match.value(error).pipe(
    Match.tags({
      GhCommandError: (failure) =>
        failure.stderr.trim() || `gh exited with code ${failure.exitCode}`,
      GhTimeoutError: (failure) => `gh timed out after ${failure.timeoutMs}ms`,
      GhDecodeError: (failure) =>
        `gh output did not decode: ${String(failure.cause)}`,
      GhPlatformError: (failure) =>
        `gh could not start: ${String(failure.cause)}`,
      GhOutputLimitError: (failure) =>
        `gh output passed ${failure.limitBytes} bytes`,
      GhInvalidOptionsError: (failure) => String(failure.cause),
    }),
    Match.exhaustive,
  );

export const make: Effect.Effect<GitHub["Service"], never, Gh> = Effect.gen(
  function* () {
    const gh = yield* Gh;

    const operation = <A>(
      name: string,
      effect: Effect.Effect<A, GhError, Gh>,
    ) =>
      effect.pipe(
        Effect.provideService(Gh, gh),
        Effect.mapError(
          (error) =>
            new GitHubError({
              operation: name,
              message: describeGhError(error),
            }),
        ),
      );

    const latestRelease = Effect.fn("GitHub.latestRelease")(function* (
      repo: string,
    ) {
      const release = yield* operation(
        "gh release view",
        Release.view({ repo, fields: ["tagName", "url"] }),
      );

      return { tag: release.tagName, url: release.url } satisfies LatestRelease;
    });

    const currentRepository = Effect.fn("GitHub.currentRepository")(function* (
      cwd: string,
    ) {
      const repository = yield* operation(
        "gh repo view",
        Repository.view(undefined, { cwd }),
      );

      if (!repository.defaultBranchRef)
        return yield* new GitHubError({
          operation: "gh repo view",
          message: `${repository.nameWithOwner} has no default branch`,
        });

      return {
        name: repository.nameWithOwner,
        defaultBranch: repository.defaultBranchRef.name,
      } satisfies CurrentRepository;
    });

    const openPullRequest = Effect.fn("GitHub.openPullRequest")(function* (
      repository: string,
      base: string,
      head: string,
    ) {
      const pulls = yield* operation(
        "gh pr list",
        PullRequest.query({
          repository,
          base,
          head,
          state: "open",
          limit: 1,
          fields: ["number", "title", "url"],
        }),
      );

      return pulls.at(0);
    });

    const upsertPullRequest = Effect.fn("GitHub.upsertPullRequest")(function* (
      content: PullRequestContent,
      existing: PullRequestRef | undefined,
    ) {
      const assignees = content.assignee ? [content.assignee] : [];

      if (existing) {
        yield* operation(
          "gh pr edit",
          PullRequest.edit(existing.number, {
            repository: content.repository,
            title: content.title,
            body: content.body,
            addAssignees: assignees,
          }),
        );

        return existing.url;
      }

      return (yield* operation(
        "gh pr create",
        PullRequest.create({
          repository: content.repository,
          base: content.base,
          head: content.head,
          title: content.title,
          body: content.body,
          assignees,
        }),
      )).url;
    });

    const enableSquashAutoMerge = Effect.fn("GitHub.enableSquashAutoMerge")(
      function* (repository: string, url: string) {
        yield* operation(
          "gh pr merge --auto",
          PullRequest.merge(url, { repository, method: "squash", auto: true }),
        );
      },
    );

    const disableAutoMerge = Effect.fn("GitHub.disableAutoMerge")(function* (
      repository: string,
      url: string,
    ) {
      yield* operation(
        "gh pr merge --disable-auto",
        PullRequest.disableAutoMerge(url, { repository }),
      );
    });

    const dispatchWorkflow = Effect.fn("GitHub.dispatchWorkflow")(function* (
      repository: string,
      workflow: string,
      ref: string,
    ) {
      yield* operation(
        "gh workflow run",
        Workflow.dispatch({ repo: repository, workflow, ref }),
      );
    });

    return GitHub.of({
      latestRelease,
      currentRepository,
      openPullRequest,
      upsertPullRequest,
      enableSquashAutoMerge,
      disableAutoMerge,
      dispatchWorkflow,
    });
  },
);

/** Keeps the effect-gh `Gh` requirement for the composition root to provide. */
export const layerWithoutDependencies = Layer.effect(GitHub, make);

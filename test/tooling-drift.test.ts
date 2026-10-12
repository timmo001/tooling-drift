import { afterAll, beforeAll, expect, test } from "bun:test";
import { NodeServices } from "@effect/platform-node";
import { Effect, FileSystem, Layer, Path } from "effect";
import { Git, type GitInterface } from "../src/git.js";
import {
  GitHub,
  type GitHubInterface,
  type PullRequestRef,
} from "../src/github.js";
import { Processes, type ProcessesInterface } from "../src/processes.js";
import {
  ToolingDrift,
  layerWithoutDependencies,
} from "../src/tooling-drift.js";

const toolingFile = `---
assignee: timmo001
tools:
  - repo: cli/cli
    reviewed: v2.89.0
    update: refresh
    review: Check the snapshot.
  - repo: herdrdev/herdr
    reviewed: v0.9.2
`;

interface World {
  readonly latest: Record<string, string>;
  readonly tags: Record<string, readonly string[]>;
  readonly existing: PullRequestRef | undefined;
  readonly staged: readonly string[];
  readonly sameAsRemote: boolean;
  readonly updateExitCode: number;
  readonly calls: string[];
}

const world = (overrides: Partial<World> = {}): World => ({
  latest: { "cli/cli": "v2.102.0", "herdrdev/herdr": "v0.9.3" },
  tags: {},
  existing: undefined,
  staged: ["tooling.yml"],
  sameAsRemote: false,
  updateExitCode: 0,
  calls: [],
  ...overrides,
});

const layers = (w: World) => {
  const git: GitInterface = {
    root: () => Effect.succeed("/repo"),
    isClean: () => Effect.succeed(true),
    configureIdentity: () => Effect.void,
    fetch: () => Effect.succeed(true),
    checkout: () => Effect.succeed({ ref: "main", sha: "abc" }),
    createBranch: (_root, branch) =>
      Effect.sync(() => {
        w.calls.push(`branch ${branch}`);
      }),
    stageAll: () => Effect.succeed(w.staged),
    commit: (_root, message) =>
      Effect.sync(() => {
        w.calls.push(`commit ${message}`);
      }),
    sameAsRemote: () => Effect.succeed(w.sameAsRemote),
    forcePush: (_root, branch) =>
      Effect.sync(() => {
        w.calls.push(`push ${branch}`);
      }),
    restore: (_root, checkout) =>
      Effect.sync(() => {
        w.calls.push(`restore ${checkout.ref}`);
      }),
    remoteTags: (_root, repo) => Effect.succeed(w.tags[repo] ?? []),
  };

  const github: GitHubInterface = {
    latestRelease: (repo) =>
      Effect.succeed({
        tag: w.latest[repo] ?? "v0",
        url: `https://example/${repo}`,
      }),
    currentRepository: () =>
      Effect.succeed({ name: "timmo001/example", defaultBranch: "main" }),
    openPullRequest: () => Effect.succeed(w.existing),
    upsertPullRequest: (content, existing) =>
      Effect.sync(() => {
        if (existing) w.calls.push(`edit ${content.title}`);
        else if (content.draft) w.calls.push(`create draft ${content.title}`);
        else w.calls.push(`create ${content.title}`);

        return "https://example/pull/7";
      }),
    enableSquashAutoMerge: (_repository, url) =>
      Effect.sync(() => {
        w.calls.push(`auto-merge ${url}`);
      }),
    disableAutoMerge: (_repository, url) =>
      Effect.sync(() => {
        w.calls.push(`disable-auto-merge ${url}`);
      }),
    dispatchWorkflow: (_repository, workflow, ref) =>
      Effect.sync(() => {
        w.calls.push(`dispatch ${workflow} ${ref}`);
      }),
  };

  const processes: ProcessesInterface = {
    capture: () => Effect.succeed({ stdout: "", stderr: "", exitCode: 0 }),
    inherit: (command, args) =>
      Effect.sync(() => {
        w.calls.push(`run ${command} ${args.join(" ")}`);

        return w.updateExitCode;
      }),
  };

  return layerWithoutDependencies.pipe(
    Layer.provide([
      Layer.succeed(Git, Git.of(git)),
      Layer.succeed(GitHub, GitHub.of(github)),
      Layer.succeed(Processes, Processes.of(processes)),
      NodeServices.layer,
    ]),
  );
};

let root = "";

const files = <A, E>(
  effect: Effect.Effect<A, E, FileSystem.FileSystem | Path.Path>,
) => Effect.runPromise(effect.pipe(Effect.provide(NodeServices.layer)));

beforeAll(async () => {
  root = await files(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;

      return yield* fs.makeTempDirectory({ prefix: "tooling-drift-" });
    }),
  );
});

afterAll(() =>
  files(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      yield* fs.remove(root, { recursive: true });
    }),
  ),
);

const writeToolingFile = (text = toolingFile) =>
  files(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      yield* fs.writeFileString(path.join(root, "tooling.yml"), text);
    }),
  );

const reviewedTags = () =>
  files(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const text = yield* fs.readFileString(path.join(root, "tooling.yml"));

      return [...text.matchAll(/reviewed: (\S+)/g)].map((match) => match[1]);
    }),
  );

const publish = (w: World, only?: string) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const drift = yield* ToolingDrift;
      yield* drift.publish(root, only);
    }).pipe(Effect.provide(layers(w))),
  );

test("a pin-only update gets auto-merge and a review tool gets a draft review pull request", async () => {
  await writeToolingFile();

  const w = world();

  await publish(w);

  expect(w.calls).toEqual([
    "branch tooling/cli-cli",
    "run refresh v2.102.0",
    "commit [Pin-only] Update cli/cli to v2.102.0",
    "push tooling/cli-cli",
    "create [Pin-only] Update cli/cli to v2.102.0",
    "auto-merge https://example/pull/7",
    "dispatch ci.yml tooling/cli-cli",
    "branch tooling/herdrdev-herdr",
    "commit Update herdrdev/herdr to v0.9.3",
    "push tooling/herdrdev-herdr",
    "create draft Update herdrdev/herdr to v0.9.3",
    "dispatch ci.yml tooling/herdrdev-herdr",
    "restore main",
  ]);
  expect(await reviewedTags()).toEqual(["v2.102.0", "v0.9.3"]);
});

test("a changed derived file turns an existing pin-only pull request into a review", async () => {
  await writeToolingFile();

  const w = world({
    staged: ["tooling.yml", "tooling/gh/api.txt"],
    existing: {
      number: 7,
      title: "[Pin-only] Update cli/cli to v2.102.0",
      url: "https://example/pull/7",
    },
  });

  await publish(w, "cli/cli");

  expect(w.calls).toContain("edit Update cli/cli to v2.102.0");
  expect(w.calls).toContain("disable-auto-merge https://example/pull/7");
  expect(w.calls).not.toContain("auto-merge https://example/pull/7");
});

test("a pull request already carrying the same title and tree is left alone", async () => {
  await writeToolingFile();

  const w = world({
    sameAsRemote: true,
    existing: {
      number: 7,
      title: "[Pin-only] Update cli/cli to v2.102.0",
      url: "https://example/pull/7",
    },
  });

  await publish(w, "cli/cli");

  expect(w.calls.filter((call) => call.startsWith("push"))).toEqual([]);
  expect(w.calls.filter((call) => call.startsWith("create"))).toEqual([]);
});

test("a failed update command fails the run and the checkout is restored", async () => {
  await writeToolingFile();

  const w = world({ updateExitCode: 1 });

  const error = await publish(w, "cli/cli").then(
    () => undefined,
    (cause: unknown) => cause,
  );

  expect(String(error)).toContain("exited with code 1");
  expect(w.calls.at(-1)).toBe("restore main");
  expect(await reviewedTags()).toEqual(["v2.89.0", "v0.9.2"]);
});

test("status reports tools behind the latest release", async () => {
  await writeToolingFile();

  const w = world({
    latest: { "cli/cli": "v2.89.0", "herdrdev/herdr": "v0.9.3" },
  });

  const report = await Effect.runPromise(
    Effect.gen(function* () {
      const drift = yield* ToolingDrift;

      return yield* drift.status(root);
    }).pipe(Effect.provide(layers(w))),
  );

  expect(report.behind).toBe(true);
  expect(report.items.map((item) => item.state)).toEqual([
    "up-to-date",
    "release-available",
  ]);
});

test("a tool with a tags pattern follows its newest matching tag, not the latest release", async () => {
  await writeToolingFile(`---
tools:
  - repo: anomalyco/opencode
    reviewed: v2.0.26
    tags: ^v2\\.
`);

  const w = world({
    latest: { "anomalyco/opencode": "v1.19.0" },
    tags: { "anomalyco/opencode": ["v1.19.0", "v2.0.26", "v2.0.27"] },
  });

  const report = await Effect.runPromise(
    Effect.gen(function* () {
      const drift = yield* ToolingDrift;

      return yield* drift.status(root);
    }).pipe(Effect.provide(layers(w))),
  );

  expect(report.items.map((item) => item.latest)).toEqual(["v2.0.27"]);
});

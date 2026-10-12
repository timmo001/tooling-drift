#!/usr/bin/env node
import { NodeRuntime, NodeServices } from "@effect/platform-node";
import { layer as ghLayer } from "@timmo001/effect-gh";
import { Effect, Layer } from "effect";
import { CliConfig, CliError, Command } from "effect/cli";
import { toolingDriftCommand } from "./cli.js";
import * as Git from "./git.js";
import * as GitHub from "./github.js";
import * as Processes from "./processes.js";
import * as ToolingDrift from "./tooling-drift.js";
import { version } from "./version.js";

const processesLayer = Processes.layerWithoutDependencies.pipe(
  Layer.provide(NodeServices.layer),
);

const gitLayer = Git.layerWithoutDependencies.pipe(
  Layer.provide(processesLayer),
);

const githubLayer = GitHub.layerWithoutDependencies.pipe(
  Layer.provide(ghLayer().pipe(Layer.provide(NodeServices.layer))),
);

const toolingDriftLayer = ToolingDrift.layerWithoutDependencies.pipe(
  Layer.provide([gitLayer, githubLayer, processesLayer, NodeServices.layer]),
);

const applicationLayer = Layer.mergeAll(
  toolingDriftLayer,
  gitLayer,
  NodeServices.layer,
  CliConfig.layer(),
);

const program = Command.runWith(toolingDriftCommand, { version })(
  process.argv.slice(2),
).pipe(
  Effect.provide(applicationLayer),
  Effect.catch((error) =>
    Effect.sync(() => {
      if (!CliError.isCliError(error))
        console.error(
          error instanceof Error ? error.message || error.name : String(error),
        );

      process.exitCode = 1;
    }),
  ),
);

NodeRuntime.runMain(program, { disableErrorReporting: true });

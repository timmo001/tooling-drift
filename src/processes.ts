import { Context, Effect, Layer, Schema, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

export class ProcessError extends Schema.TaggedError<ProcessError>()(
  "ProcessError",
  {
    command: Schema.String,
    exitCode: Schema.Int,
    stderr: Schema.String,
  },
) {}

export interface ProcessResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

/** Child processes the tool starts: git, and the update commands from tooling.yml. */
export interface ProcessesInterface {
  /** Run a command and capture its output; a non-zero exit is a result, not a failure. */
  readonly capture: (
    command: string,
    args: readonly string[],
    cwd: string,
  ) => Effect.Effect<ProcessResult, ProcessError>;
  /** Run a command with the terminal's stdio and return its exit code. */
  readonly inherit: (
    command: string,
    args: readonly string[],
    cwd: string,
  ) => Effect.Effect<number, ProcessError>;
}

export class Processes extends Context.Service<Processes, ProcessesInterface>()(
  "@timmo001/tooling-drift/Processes",
) {}

const collectText = (stream: Stream.Stream<Uint8Array, unknown>) =>
  stream.pipe(
    Stream.decodeText(),
    Stream.runFold(
      () => "",
      (all, chunk) => all + chunk,
    ),
  );

const label = (command: string, args: readonly string[]) =>
  `${command} ${args.join(" ")}`;

export const make: Effect.Effect<
  Processes["Service"],
  never,
  ChildProcessSpawner.ChildProcessSpawner
> = Effect.gen(function* () {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

  const capture = Effect.fn("Processes.capture")(function* (
    command: string,
    args: readonly string[],
    cwd: string,
  ) {
    return yield* Effect.scoped(
      Effect.gen(function* () {
        const handle = yield* spawner.spawn(
          ChildProcess.make(command, args, {
            cwd,
            extendEnv: true,
            stdin: "ignore",
          }),
        );

        const [stdout, stderr, exitCode] = yield* Effect.all(
          [
            collectText(handle.stdout),
            collectText(handle.stderr),
            handle.exitCode,
          ],
          { concurrency: "unbounded" },
        );

        return {
          stdout,
          stderr: stderr.trim(),
          exitCode: Number(exitCode),
        } satisfies ProcessResult;
      }).pipe(
        Effect.mapError(
          (cause) =>
            new ProcessError({
              command: label(command, args),
              exitCode: -1,
              stderr: String(cause),
            }),
        ),
      ),
    );
  });

  const inherit = Effect.fn("Processes.inherit")(function* (
    command: string,
    args: readonly string[],
    cwd: string,
  ) {
    const code = yield* spawner
      .exitCode(
        ChildProcess.make(command, args, {
          cwd,
          extendEnv: true,
          stdin: "inherit",
          stdout: "inherit",
          stderr: "inherit",
        }),
      )
      .pipe(
        Effect.mapError(
          (cause) =>
            new ProcessError({
              command: label(command, args),
              exitCode: -1,
              stderr: String(cause),
            }),
        ),
      );

    return Number(code);
  });

  return Processes.of({ capture, inherit });
});

/** Keeps the spawner requirement for the composition root to provide. */
export const layerWithoutDependencies = Layer.effect(Processes, make);

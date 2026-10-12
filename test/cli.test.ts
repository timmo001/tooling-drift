import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";

const bin = fileURLToPath(new URL("../src/bin.ts", import.meta.url));

const run = async (...args: string[]) => {
  const process = Bun.spawn(["bun", bin, ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });

  const [stdout, stderr, code] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ]);

  return { stdout, stderr, code };
};

test("the CLI lists its commands and version", async () => {
  const help = await run("--help");

  expect(help.code).toBe(0);
  expect(help.stdout).toContain("status");
  expect(help.stdout).toContain("update");
  expect(help.stdout).toContain("publish");

  const version = await run("--version");

  expect(version.code).toBe(0);
  expect(version.stdout).toContain("0.1.0");
});

test("update needs a repository and a tag", async () => {
  const missing = await run("update", "cli/cli");

  expect(missing.code).not.toBe(0);
});

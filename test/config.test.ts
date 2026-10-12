import { expect, test } from "bun:test";
import { Effect } from "effect";
import { decodeToolingFile, findTool, recordReviewed } from "../src/config.js";

const file = `---
# Tool releases this repository was last reviewed against.
assignee: timmo001
tools:
  - repo: cli/cli
    reviewed: v2.89.0
    update: mise run tooling:refresh
    pins:
      - tooling.yml
      - package.json
    review: Check the snapshot under tooling/gh.
  - repo: herdrdev/herdr
    reviewed: "v0.9.2" # quoted on purpose
`;

test("decodes tools with optional fields and keeps repositories unique", async () => {
  const decoded = await Effect.runPromise(decodeToolingFile(file));

  expect(decoded.assignee).toBe("timmo001");
  expect(decoded.tools.map((tool) => tool.repo)).toEqual([
    "cli/cli",
    "herdrdev/herdr",
  ]);
  expect(decoded.tools[0]?.pins).toEqual(["tooling.yml", "package.json"]);
  expect(decoded.tools[1]?.update).toBeUndefined();
  expect(findTool(decoded, "CLI/CLI")?.reviewed).toBe("v2.89.0");

  const duplicate = await Effect.runPromise(
    decodeToolingFile(
      "tools:\n  - repo: a/b\n    reviewed: v1\n  - repo: A/B\n    reviewed: v2\n",
    ).pipe(Effect.flip),
  );

  expect(duplicate.message).toContain("listed more than once");

  const malformed = await Effect.runPromise(
    decodeToolingFile("tools:\n  - repo: not-a-repo\n    reviewed: v1\n").pipe(
      Effect.flip,
    ),
  );

  expect(malformed.message).toContain("owner/name");
});

test("recordReviewed moves one tool's tag and keeps comments and quoting elsewhere", () => {
  const updated = recordReviewed(file, "herdrdev/herdr", "v0.9.3");

  expect(updated).toContain(
    'reviewed: "v0.9.2" # quoted on purpose'.replace(
      '"v0.9.2" # quoted on purpose',
      "v0.9.3",
    ),
  );
  expect(updated).toContain("reviewed: v2.89.0");
  expect(updated).toContain("# Tool releases this repository");
  expect(recordReviewed(file, "missing/tool", "v9")).toBe(file);
});

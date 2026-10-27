import { expect, test } from "bun:test";
import type { Tool } from "../src/config.js";
import {
  branchName,
  isPinOnly,
  newestTag,
  pullRequestBody,
  pullRequestTitle,
} from "../src/drift.js";

test("the newest tag is the highest stable version matching the pattern", () => {
  const tags = [
    "effect@4.0.9",
    "effect@4.0.10",
    "effect@4.1.0-beta.1",
    "@effect/platform-node@4.2.0",
    "effect@3.19.4",
  ];

  expect(newestTag(tags, "^effect@")).toBe("effect@4.0.10");
  expect(newestTag(["v1.19.0", "v2.0.9", "v2.0.27"], "^v2\\.")).toBe("v2.0.27");
  expect(newestTag(tags, "^nothing@")).toBeUndefined();
});

test("prereleases count when included, and give way to their stable version", () => {
  const tags = ["v4.0.6", "v4.5.0-rc1", "v4.5.0-rc2", "v4.0.5"];

  expect(newestTag(tags, "", true)).toBe("v4.5.0-rc2");
  expect(newestTag(tags, "")).toBe("v4.0.6");
  expect(newestTag([...tags, "v4.5.0"], "", true)).toBe("v4.5.0");
  expect(newestTag(["v1.0.0-rc9", "v1.0.0-rc10"], "", true)).toBe(
    "v1.0.0-rc10",
  );
  expect(
    newestTag(["effect@4.0.10", "effect@4.1.0-beta.1"], "^effect@", true),
  ).toBe("effect@4.1.0-beta.1");
});

test("two-part versions count, such as Home Assistant frontend's", () => {
  const tags = ["20260930.4", "20260930.5", "20261104.0", "20250101.12"];

  expect(newestTag(tags, "", true)).toBe("20261104.0");
  expect(newestTag(tags, "")).toBe("20261104.0");
  expect(newestTag(["v1.2", "v1.2.1", "v1.10"], "")).toBe("v1.10");
  expect(newestTag(["v1.2.0", "v1.2"], "")).toBe("v1.2.0");
});

const contract: Tool = {
  repo: "cli/cli",
  reviewed: "v2.89.0",
  update: "mise run tooling:refresh",
  review: "Check the snapshot under tooling/gh.",
};

const reviewOnly: Tool = { repo: "herdrdev/herdr", reviewed: "v0.9.2" };

test("a contract tool whose update only moved the pins is pin-only", () => {
  expect(isPinOnly(contract, ["tooling.yml"])).toBe(true);
  expect(pullRequestTitle(contract, "v2.102.0", ["tooling.yml"])).toBe(
    "[Pin-only] Update cli/cli to v2.102.0",
  );
  expect(pullRequestBody(contract, "v2.102.0", ["tooling.yml"])).toContain(
    "only the pin moves",
  );

  const pinned: Tool = {
    repo: contract.repo,
    reviewed: contract.reviewed,
    update: "mise run tooling:refresh",
    pins: ["tooling.yml", "package.json"],
  };

  expect(isPinOnly(pinned, ["package.json", "tooling.yml"])).toBe(true);
});

test("a changed derived file needs a review and is listed", () => {
  const changed = ["tooling.yml", "tooling/gh/api.txt"];

  expect(isPinOnly(contract, changed)).toBe(false);
  expect(pullRequestTitle(contract, "v2.102.0", changed)).toBe(
    "Update cli/cli to v2.102.0",
  );

  const body = pullRequestBody(contract, "v2.102.0", changed);

  expect(body).toContain("- `tooling/gh/api.txt`");
  expect(body).not.toContain("- `tooling.yml`");
  expect(body).toContain("Check the snapshot under tooling/gh.");
  expect(body).toContain(
    "https://github.com/cli/cli/compare/v2.89.0...v2.102.0",
  );
});

test("a tool without an update command always asks for a review", () => {
  expect(isPinOnly(reviewOnly, ["tooling.yml"])).toBe(false);
  expect(pullRequestTitle(reviewOnly, "v0.9.3", ["tooling.yml"])).toBe(
    "Update herdrdev/herdr to v0.9.3",
  );
  expect(pullRequestBody(reviewOnly, "v0.9.3", ["tooling.yml"])).toContain(
    "push any change they need to this branch",
  );
  expect(branchName("HerdrDev/Herdr")).toBe("tooling/herdrdev-herdr");
});

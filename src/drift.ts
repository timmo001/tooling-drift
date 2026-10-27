import { TOOLING_FILE, type Tool } from "./config.js";

/** The branch a tool's pull requests live on. */
export const branchName = (repo: string) =>
  `tooling/${repo.toLowerCase().replace("/", "-")}`;

/** `x.y.z`, or `x.y` for tools such as Home Assistant's frontend (`20260930.5`). */
const stableVersion = /(\d+)\.(\d+)(?:\.(\d+))?$/;

/** A version with an optional prerelease after it, such as `-rc.2` or `rc2`. */
const anyVersion =
  /(\d+)\.(\d+)(?:\.(\d+))?(?:-?([0-9A-Za-z][0-9A-Za-z.-]*))?$/;

interface Version {
  readonly tag: string;
  readonly parts: readonly number[];
  /** The prerelease, or undefined for a stable version. */
  readonly prerelease: string | undefined;
}

const compareVersions = (a: Version, b: Version) => {
  // A missing part counts as 0, so `1.2` sorts with `1.2.0`
  const parts = Array.from(
    { length: Math.max(a.parts.length, b.parts.length) },
    (_, index) => (a.parts[index] ?? 0) - (b.parts[index] ?? 0),
  ).reduce((order, part) => order || part, 0);

  if (parts !== 0) return parts;

  // A prerelease comes before its stable version
  if (a.prerelease === undefined || b.prerelease === undefined)
    return (
      Number(a.prerelease === undefined) - Number(b.prerelease === undefined)
    );

  // Natural order, so rc10 follows rc9
  return a.prerelease.localeCompare(b.prerelease, "en", { numeric: true });
};

/**
 * The highest version among the tags matching a pattern, read from the
 * `x.y.z` or `x.y` each tag ends with. Prereleases are skipped unless they're
 * included, when one counts as newer than the stable version before it but
 * older than its own stable version. Other tags are skipped.
 */
export const newestTag = (
  tags: readonly string[],
  pattern: string,
  prereleases = false,
) => {
  const matcher = new RegExp(pattern);

  const versions = tags.flatMap((tag): Version[] => {
    if (!matcher.test(tag)) return [];

    const version = (prereleases ? anyVersion : stableVersion).exec(tag);

    return version
      ? [
          {
            tag,
            parts: version
              .slice(1, 4)
              .filter((part) => part !== undefined)
              .map(Number),
            prerelease: version[4],
          },
        ]
      : [];
  });

  return versions.reduce<Version | undefined>(
    (newest, version) =>
      newest && compareVersions(newest, version) >= 0 ? newest : version,
    undefined,
  )?.tag;
};

/** Files changed by an update that are not the tool's pins. */
export const derivedFiles = (tool: Tool, changed: readonly string[]) => {
  const pins = new Set(tool.pins ?? [TOOLING_FILE]);

  return changed.filter((file) => !pins.has(file));
};

/**
 * Only the pins moved after an update command ran, so nothing the repository
 * derives from the tool changed. A tool without an update command always
 * needs a review.
 */
export const isPinOnly = (tool: Tool, changed: readonly string[]) =>
  tool.update !== undefined && derivedFiles(tool, changed).length === 0;

export const pullRequestTitle = (
  tool: Tool,
  tag: string,
  changed: readonly string[],
) =>
  isPinOnly(tool, changed)
    ? `[Pin-only] Update ${tool.repo} to ${tag}`
    : `Update ${tool.repo} to ${tag}`;

/** Pull request titles the tool's branch may carry for a tag. */
export const pullRequestTitles = (repo: string, tag: string) => [
  `Update ${repo} to ${tag}`,
  `[Pin-only] Update ${repo} to ${tag}`,
];

export const pullRequestBody = (
  tool: Tool,
  tag: string,
  changed: readonly string[],
) => {
  const derived = derivedFiles(tool, changed);
  const note = tool.review ? ` ${tool.review}` : "";

  const lines = [
    `Moves the reviewed ${tool.repo} release from \`${tool.reviewed}\` to \`${tag}\`.`,
    "",
  ];

  if (tool.update === undefined)
    lines.push(
      `Review the release notes against the parts of this repository that depend on ${tool.repo}, push any change they need to this branch, then merge.${note}`,
    );
  else if (derived.length === 0)
    lines.push(
      "Nothing the repository derives from it changed at this release, so only the pin moves.",
    );
  else
    lines.push(
      "It also refreshes what the repository derives from it:",
      "",
      ...derived.map((file) => `- \`${file}\``),
      ...(tool.review ? ["", tool.review] : []),
    );

  lines.push(
    "",
    `Release notes: https://github.com/${tool.repo}/releases/tag/${tag}`,
    `Compare: https://github.com/${tool.repo}/compare/${tool.reviewed}...${tag}`,
  );

  return lines.join("\n");
};

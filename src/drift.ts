import { TOOLING_FILE, type Tool } from "./config.js";

/** The branch a tool's pull requests live on. */
export const branchName = (repo: string) =>
  `tooling/${repo.toLowerCase().replace("/", "-")}`;

const stableVersion = /(\d+)\.(\d+)\.(\d+)$/;

/**
 * The highest stable version among the tags matching a pattern, read from the
 * `x.y.z` each tag ends with. Prereleases and other tags are skipped.
 */
export const newestTag = (tags: readonly string[], pattern: string) => {
  const matcher = new RegExp(pattern);

  const versions = tags.flatMap((tag) => {
    const version = matcher.test(tag) ? stableVersion.exec(tag) : null;

    return version ? [{ tag, parts: version.slice(1).map(Number) }] : [];
  });

  const compare = (a: readonly number[], b: readonly number[]) =>
    a.reduce((order, part, index) => order || part - (b[index] ?? 0), 0);

  return versions.reduce<(typeof versions)[number] | undefined>(
    (newest, version) =>
      newest && compare(newest.parts, version.parts) >= 0 ? newest : version,
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

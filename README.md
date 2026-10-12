# tooling-drift

Keep a repository reviewed against the releases of the tools it wraps,
configures or forks. A `tooling.yml` at the repository root records each
tool's GitHub repository and the release tag last reviewed; `tooling-drift`
compares that with the latest release and opens one pull request per tool
that moved.

It is the same idea as the per-skill tool reviews in
[timmo001/skills](https://github.com/timmo001/skills), for repositories:
[effect-gh](https://github.com/timmo001/effect-gh) tracks `gh`,
[effect-herdr](https://github.com/timmo001/effect-herdr) tracks Herdr, and
[dotfiles](https://github.com/timmo001/dotfiles) tracks Herdr, Omarchy and
`gh`. The tool is the thing itself; a fork's upstream is a different concern.

## Install

Pin it with mise next to the repository's other tools and give it tasks:

```toml
[tools]
"npm:@timmo001/tooling-drift" = "0.1.0"

[tasks."tooling:status"]
description = "Compare each reviewed tool release with the latest"
run = "tooling-drift status"

[tasks."tooling:refresh"]
description = "Regenerate what the repository derives from cli/cli at a release"
depends = ["install"]
run = 'bun scripts/gh-contract.ts --release {{arg(name="tag")}}'

[tasks."tooling:update"]
description = "Refresh what the repository derives from cli/cli at a release and record it"
run = 'tooling-drift update cli/cli {{arg(name="tag")}}'

[tasks."tooling:publish"]
description = "Open or refresh a pull request for every tool behind its latest release"
run = "tooling-drift publish"
```

It needs git, an authenticated `gh`, and Node.js; GitHub calls go through
[effect-gh](https://github.com/timmo001/effect-gh). While the package is
under 30 days old, mise's npm backend refuses it as too new; approve it with
`"npm:@timmo001/tooling-drift" = { version = "0.1.0", allow_low_downloads = true }`
until then.

## tooling.yml

```yaml
---
assignee: timmo001 # optional; assigned to every pull request
dispatch: # optional; workflows run on the branch after a push, default ci.yml
  - ci.yml
tools:
  - repo: cli/cli # GitHub repository whose releases are tracked
    reviewed: v2.89.0 # release tag last reviewed
    update: mise run tooling:refresh # optional; run with the tag to refresh derived files
    pins: # optional; files a pin move touches, default tooling.yml
      - tooling.yml
    review: Check the snapshot under tooling/gh against src/. # optional; for the pull request
  - repo: basecamp/omarchy
    reviewed: v4.0.4
    review: Check the custom bar plugins and the generated shell config.
  - repo: Effect-TS/effect
    reviewed: effect@4.0.1
    tags: ^effect@ # optional; follow the newest matching tag instead of the latest release
```

A tool with `tags` follows the highest stable `x.y.z` tag matching the
pattern, read with `git ls-remote`, instead of the repository's latest GitHub
release. Use it for repositories that release several packages, or that tag
versions without publishing releases.

Two kinds of tool entry:

- With an `update` command, the repository derives something from the tool,
  such as a snapshot of `gh --help` output or a bundled API schema. The command
  runs at the new release with the tag as its argument. When nothing but the
  pins changed, the pull request is `[Pin-only] Update <repo> to <tag>` with
  squash auto-merge. When a derived file changed, it is
  `Update <repo> to <tag>`, opened as a draft until it is reviewed.
- Without one, the repository depends on the tool's behaviour: configuration,
  plugins it replaces or extends, code that drives it. Every release gets
  `Update <repo> to <tag>` as a draft for review, never auto-merged.

A pull request that already exists keeps its draft state when a later run
refreshes it.

## Commands

- `tooling-drift status` prints each tool's reviewed and latest release and
  exits 1 when one is behind or unreadable. `--json` prints the report.
- `tooling-drift update <repo> <tag>` runs the tool's update command with the
  tag, then records the tag as reviewed. Run it after a review done by hand.
- `tooling-drift publish [--repo <repo>]` fetches the default branch, and for
  every tool behind its latest release creates `tooling/<owner>-<repo>` from
  it, runs the update, records the tag, commits with the pull request title
  and opens or refreshes the pull request. A pull request already carrying
  the same title and tree is left alone. It refuses a dirty working tree and
  returns to the starting checkout when done or when an update fails.

Pull requests opened with `GITHUB_TOKEN` cannot trigger `pull_request`
workflows, so `publish` dispatches the workflows under `dispatch` on the
branch. Set `TOOLING_DRIFT_DISPATCH=false` when the token can trigger them.
Auto-merge must be enabled on the repository; otherwise the run warns and
leaves the pin-only pull request for a manual merge. With `GITHUB_TOKEN`, the
repository must also allow GitHub Actions to create and approve pull requests
(Settings, Actions, General); otherwise the branch is pushed but opening the
pull request fails.

## In GitHub Actions

Call the shared workflow from
[timmo001/workflows](https://github.com/timmo001/workflows) on a schedule; it
sets up mise and runs `mise run tooling:publish`. A `tooling:refresh` task
that reads dependencies declares `depends = ["install"]`, so nothing else
installs them. The [skill](skills/tooling-drift/SKILL.md) carries a
template and the review steps.

## Agent skill

[The tooling-drift skill](skills/tooling-drift/SKILL.md) tells an agent how to
check drift, review a release, record it and adopt the tool in a repository.
It follows the [Agent Skills specification](https://agentskills.io/specification).

## Development

Use the tool versions pinned in [mise.toml](mise.toml) and Bun for dependencies.

```sh
mise run check ::: build
```

For a release, set the version in `package.json`, keep `bun.lock` in sync, pass `mise run check` and `mise run build`, then publish a
GitHub release with a tag matching the version exactly. The release workflow
publishes to npm with provenance through the shared publisher.

# tooling-drift

Effect v4 CLI that keeps a repository reviewed against the releases of the tools it depends on,
published as `@timmo001/tooling-drift`. The README documents usage and development.

## Tooling

- Use mise-pinned tools and Bun. Keep `bun.lock` in sync with `package.json`.
- Use `mise run format`, `mise run check` and `mise run build` for validation.
- `src/bin.ts` is the CLI entrypoint and `src/index.ts` the library entrypoint; `dist/` is
  generated and untracked. The version comes from `package.json`.
- Use lowercase filenames, with kebab-case for multiword names.
- Use the shared `@timmo001/oxlint-rules/configs/recommended-effect` preset and its supported
  Oxlint peers.

## Conventions

- GitHub goes through `@timmo001/effect-gh`'s typed operations, never raw `gh` calls; git and
  update commands go through the `Processes` service.
- `tooling.yml` is parsed with Schema; `recordReviewed` rewrites one line so comments survive.
- Pull request titles, bodies and the pin-only rule live in `src/drift.ts` as pure functions
  with tests. Keep the title format: `[Pin-only] Update <repo> to <tag>` or
  `Update <repo> to <tag>`; consumers and the skill rely on it.
- `skills/tooling-drift/` is the tool-owned Agent Skill, imported into timmo001/skills. Edit it
  here.

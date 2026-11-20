# github-core-clone-01

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/deplien/github-core-clone-01/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/deplien/github-core-clone-01/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A GitHub-compatible git forge in a single Node process, built with the standard library only — no git binary, no dependencies, no network. It stores git objects itself (SHA-1 loose-object semantics over an in-memory store, packfile reading and writing) and serves four surfaces over one shared state:

- **git smart HTTP** at `/{owner}/{repo}.git` — `git-upload-pack` with protocol v2 (ls-refs and fetch, including shallow clones, ref-prefix filtering and pack filters) plus the v0 fetch path, and `git-receive-pack` (v0) with fast-forward checks and report-status.
- **REST v3** under `/api/v3` — repositories, branches, commits, contents, labels, issues with comments, and pull requests with files, three-way merge (merge commit and squash) and conflict detection.
- **GraphQL v4** at `/api/graphql` — a small query/mutation engine with Relay-style connections and cursors, global node ids, and schema introspection for the types the API exposes.
- **MCP** at `/mcp` — JSON-RPC 2.0 tools (`create_repo`, `get_repo`, `create_issue`, `list_issues`, `create_pull_request`, `merge_pull_request`, …) speaking the 2026-07-28 revision via `server/discover` and the legacy `initialize` handshake, acting on the very same store as the other surfaces.

Every surface is guarded by one bearer token. The program binds an ephemeral port, registers it with the harness environment, and exits when the harness signals completion.

## Design notes

State lives in one in-memory store (`store.ts`): git objects keyed by their SHA-1, refs, and the REST-level resources (labels, issues, pull requests) side by side, so an object created through any surface is immediately visible in all the others. The git core (`git.ts`) parses and writes packfiles — including ofs-delta and ref-delta resolution — and the fetch selector walks the commit graph with git's own shallow rules: a deepen request may cross a shallow boundary (the client does not hold those ancestors), and a boundary commit whose parents get delivered is reported back as `unshallow`. Pull request merges use a whole-file three-way merge against the merge base; a file both sides changed differently is a conflict, matching the API's 405 answer. GraphQL global ids are opaque, stable encodings of the same keys REST uses, so a node read in one surface is the same object in the other.

## Run it

```sh
node main.ts
```

The harness sets `MAKEFUN_ENV_URL` and `MAKEFUN_SHOP_TOKEN`; the forge announces its port to the environment, serves until it reports done, and exits 0.

---

<sub>Entered on [make.fun](https://make.fun/?ref=&utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards</sub>

// Tree surgery on a repository's object store: flatten a commit's tree
// to a path map, rebuild trees from a changed path map, commit file
// changes to a branch, and three-way-merge two branch tips the way a
// squash merge needs. REST contents writes, pull merges and the pull
// files diff all build on these.

import {
  buildCommit,
  buildTree,
  identityLine,
  parseCommit,
  parseTree,
  type ObjectStore,
  type Repo,
  type TreeEntry,
} from './store.ts';
import { isAncestor, walkCommits } from './git.ts';
import { VIEWER } from './store.ts';

export interface FlatEntry {
  mode: string;
  sha: string;
}

/** Flatten a tree (recursively) into a map of path -> {mode, sha}. */
export function flattenTree(store: ObjectStore, treeSha: string, prefix = '', into = new Map<string, FlatEntry>()): Map<string, FlatEntry> {
  const obj = store.get(treeSha);
  if (obj === undefined || obj.type !== 'tree') return into;
  for (const entry of parseTree(obj.data)) {
    const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.mode === '40000') flattenTree(store, entry.sha, path, into);
    else into.set(path, { mode: entry.mode, sha: entry.sha });
  }
  return into;
}

/** The flattened file map of a commit (empty for an unknown commit). */
export function commitFiles(store: ObjectStore, commitSha: string): Map<string, FlatEntry> {
  const obj = store.get(commitSha);
  if (obj === undefined || obj.type !== 'commit') return new Map();
  return flattenTree(store, parseCommit(obj.data).tree);
}

/** Rebuild nested tree objects from a flat path map; returns the root tree sha. */
export function buildTreeFromFlat(store: ObjectStore, flat: Map<string, FlatEntry>): string {
  interface Node {
    dirs: Map<string, Node>;
    files: TreeEntry[];
  }
  const root: Node = { dirs: new Map(), files: [] };
  for (const [path, entry] of flat) {
    const segments = path.split('/');
    let node = root;
    for (const segment of segments.slice(0, -1)) {
      let child = node.dirs.get(segment);
      if (child === undefined) {
        child = { dirs: new Map(), files: [] };
        node.dirs.set(segment, child);
      }
      node = child;
    }
    node.files.push({ mode: entry.mode, name: segments[segments.length - 1], sha: entry.sha });
  }
  const write = (node: Node): string => {
    const entries: TreeEntry[] = [...node.files];
    for (const [name, child] of node.dirs) entries.push({ mode: '40000', name, sha: write(child) });
    return store.put('tree', buildTree(entries));
  };
  return write(root);
}

/** The viewer's identity line for a commit made at `whenSec`. */
export function viewerIdentity(whenSec: number): string {
  return identityLine(VIEWER.name, VIEWER.email, whenSec);
}

/**
 * Commit file changes onto a branch: `changes` maps a path to its new
 * bytes, or null to delete it. Creates the branch (with a root commit)
 * when it does not exist yet and `create` is set. Returns the new commit
 * sha, or null when the branch is missing and may not be created.
 */
export function commitFileChanges(
  repo: Repo,
  branch: string,
  changes: ReadonlyMap<string, Buffer | null>,
  message: string,
  options: { create?: boolean; whenSec?: number } = {},
): string | null {
  const store = repo.objects;
  const ref = `refs/heads/${branch}`;
  const tip = repo.refs.get(ref);
  if (tip === undefined && options.create !== true) return null;
  const flat = tip === undefined ? new Map<string, FlatEntry>() : commitFiles(store, tip);
  for (const [path, content] of changes) {
    if (content === null) flat.delete(path);
    else flat.set(path, { mode: '100644', sha: store.put('blob', content) });
  }
  const tree = buildTreeFromFlat(store, flat);
  const when = options.whenSec ?? Math.floor(Date.now() / 1000);
  const identity = viewerIdentity(when);
  const commit = store.put('commit', buildCommit({
    tree,
    parents: tip === undefined ? [] : [tip],
    author: identity,
    committer: identity,
    message,
  }));
  repo.refs.set(ref, commit);
  return commit;
}

/** The best common ancestor of two commits, or null when unrelated. */
export function mergeBase(store: ObjectStore, a: string, b: string): string | null {
  const ancestorsOfB = new Set(walkCommits(store, b));
  for (const candidate of walkCommits(store, a)) {
    if (ancestorsOfB.has(candidate)) return candidate;
  }
  return null;
}

export interface MergeOutcome {
  ok: boolean;
  /** The merged tree sha, when ok. */
  tree?: string;
  /** Paths that both sides changed incompatibly, when not ok. */
  conflicts?: string[];
}

/**
 * Three-way merge of two tips against their merge base, at whole-file
 * granularity: a path one side changed takes that side's version; a path
 * both sides changed to the same bytes is fine; a path both sides
 * changed differently (including delete-vs-edit) conflicts.
 */
export function mergeTrees(store: ObjectStore, baseTip: string, headTip: string): MergeOutcome {
  const base = mergeBase(store, baseTip, headTip);
  if (base === null) return { ok: false, conflicts: ['*'] };
  if (isAncestor(store, headTip, baseTip)) {
    // Head is already contained in base: the merged tree is base's tree.
    const tipObj = store.get(baseTip);
    return { ok: true, tree: tipObj !== undefined && tipObj.type === 'commit' ? parseCommit(tipObj.data).tree : undefined };
  }
  const baseFiles = commitFiles(store, base);
  const ourFiles = commitFiles(store, baseTip);
  const theirFiles = commitFiles(store, headTip);
  const merged = new Map<string, FlatEntry>(ourFiles);
  const conflicts: string[] = [];
  const paths = new Set([...baseFiles.keys(), ...theirFiles.keys()]);
  for (const path of paths) {
    const atBase = baseFiles.get(path);
    const atTheirs = theirFiles.get(path);
    const atOurs = ourFiles.get(path);
    const theirsChanged = atBase?.sha !== atTheirs?.sha || (atBase === undefined) !== (atTheirs === undefined);
    if (!theirsChanged) continue;
    const oursChanged = atBase?.sha !== atOurs?.sha || (atBase === undefined) !== (atOurs === undefined);
    if (oursChanged && atOurs?.sha !== atTheirs?.sha) {
      conflicts.push(path);
      continue;
    }
    if (atTheirs === undefined) merged.delete(path);
    else merged.set(path, atTheirs);
  }
  if (conflicts.length > 0) return { ok: false, conflicts };
  return { ok: true, tree: buildTreeFromFlat(store, merged) };
}

/** Line counts of a text diff between two blobs (LCS over lines). */
export function lineDiffCounts(before: Buffer | null, after: Buffer | null): { additions: number; deletions: number } {
  // Byte-identical contents are a no-change file: skip the diff entirely.
  if (before !== null && after !== null && before.equals(after)) return { additions: 0, deletions: 0 };
  const a = before === null ? [] : before.toString('utf8').split('\n');
  const b = after === null ? [] : after.toString('utf8').split('\n');
  // Drop a single trailing empty line each side: a final newline ends the
  // last line rather than starting another one.
  if (a.length > 0 && a[a.length - 1] === '') a.pop();
  if (b.length > 0 && b[b.length - 1] === '') b.pop();
  const m = a.length;
  const n = b.length;
  // LCS lengths via dynamic programming over the shorter axis.
  const dp = new Array<number>(n + 1).fill(0);
  for (let i = 1; i <= m; i += 1) {
    let prev = 0;
    for (let j = 1; j <= n; j += 1) {
      const saved = dp[j];
      dp[j] = a[i - 1] === b[j - 1] ? prev + 1 : Math.max(dp[j], dp[j - 1]);
      prev = saved;
    }
  }
  const common = dp[n];
  return { additions: n - common, deletions: m - common };
}

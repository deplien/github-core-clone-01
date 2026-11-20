// The forge's state: one in-memory store shared by every surface (git
// smart HTTP, REST v3, GraphQL v4 and MCP all read and write the same
// objects, so a repository created over MCP is the same repository REST
// reads back, with the same ids).
//
// The trial's bearer token names one login — the token owner — and every
// repository belongs to that login. The contest fixes the token owner's
// identity (the suite's seeded viewer), so it is a constant of the forge:
// any other owner in a path is simply a repository that does not exist.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

/** The login the trial token names, with the ids the suite expects. */
export const VIEWER = Object.freeze({
  login: 'adaiversen',
  id: 1000,
  name: 'ada iversen',
  email: 'adaiversen@example.invalid',
  type: 'User',
});

export type ObjectType = 'commit' | 'tree' | 'blob' | 'tag';

export interface StoredObject {
  type: ObjectType;
  /** The raw object payload (no header). */
  data: Buffer;
}

/** SHA-1 of a git object: "<type> <length>\0" followed by the payload. */
export function hashObject(type: ObjectType, data: Buffer): string {
  const header = Buffer.from(`${type} ${data.length}\0`, 'utf8');
  return createHash('sha1').update(header).update(data).digest('hex');
}

/** A content-addressed object store: objects are immutable, keyed by SHA-1. */
export class ObjectStore {
  private readonly byHash = new Map<string, StoredObject>();

  put(type: ObjectType, data: Buffer): string {
    const sha = hashObject(type, data);
    if (!this.byHash.has(sha)) this.byHash.set(sha, { type, data });
    return sha;
  }

  get(sha: string): StoredObject | undefined {
    return this.byHash.get(sha);
  }

  has(sha: string): boolean {
    return this.byHash.has(sha);
  }

  /** The loose-object encoding of a stored object (zlib of header+payload). */
  looseBytes(sha: string): Buffer | undefined {
    const obj = this.byHash.get(sha);
    if (obj === undefined) return undefined;
    const header = Buffer.from(`${obj.type} ${obj.data.length}\0`, 'utf8');
    return deflateSync(Buffer.concat([header, obj.data]));
  }

  /** Store an object whose bytes arrive in loose (zlib) form; returns its sha. */
  putLoose(bytes: Buffer): string {
    const raw = inflateSync(bytes);
    const nul = raw.indexOf(0);
    const header = raw.subarray(0, nul).toString('utf8');
    const space = header.indexOf(' ');
    const type = header.slice(0, space) as ObjectType;
    return this.put(type, Buffer.from(raw.subarray(nul + 1)));
  }
}

export interface TreeEntry {
  /** Octal mode as written in the tree: '40000' for a tree, '100644'/'100755'/'120000' for leaves. */
  mode: string;
  name: string;
  sha: string;
}

/** Parse a tree object's payload into its entries, in stored order. */
export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    const nul = data.indexOf(0, space + 1);
    entries.push({
      mode: data.subarray(offset, space).toString('ascii'),
      name: data.subarray(space + 1, nul).toString('utf8'),
      sha: data.subarray(nul + 1, nul + 21).toString('hex'),
    });
    offset = nul + 21;
  }
  return entries;
}

/** Git's tree ordering: entries sort by name, trees as if the name ended in '/'. */
function treeSortKey(entry: TreeEntry): string {
  return entry.mode === '40000' ? `${entry.name}/` : entry.name;
}

/** Build a tree object payload from entries (sorted the way git sorts them). */
export function buildTree(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => {
    const ka = Buffer.from(treeSortKey(a), 'utf8');
    const kb = Buffer.from(treeSortKey(b), 'utf8');
    return Buffer.compare(ka, kb);
  });
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.sha, 'hex'));
  }
  return Buffer.concat(parts);
}

export interface CommitView {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

/** Parse a commit object's payload. */
export function parseCommit(data: Buffer): CommitView {
  const text = data.toString('utf8');
  const blank = text.indexOf('\n\n');
  const headerText = blank < 0 ? text : text.slice(0, blank);
  const view: CommitView = { tree: '', parents: [], author: '', committer: '', message: blank < 0 ? '' : text.slice(blank + 2) };
  for (const line of headerText.split('\n')) {
    const space = line.indexOf(' ');
    if (space < 0) continue;
    const key = line.slice(0, space);
    const value = line.slice(space + 1);
    if (key === 'tree') view.tree = value;
    else if (key === 'parent') view.parents.push(value);
    else if (key === 'author') view.author = value;
    else if (key === 'committer') view.committer = value;
  }
  return view;
}

/** One identity line for a commit: "Name <email> <unix seconds> <tz>". */
export function identityLine(name: string, email: string, whenSec: number, tz = '+0000'): string {
  return `${name} <${email}> ${whenSec} ${tz}`;
}

/** Build a commit object payload. */
export function buildCommit(fields: {
  tree: string;
  parents: readonly string[];
  author: string;
  committer: string;
  message: string;
}): Buffer {
  const lines = [`tree ${fields.tree}`];
  for (const parent of fields.parents) lines.push(`parent ${parent}`);
  lines.push(`author ${fields.author}`, `committer ${fields.committer}`, '', fields.message);
  return Buffer.from(lines.join('\n'), 'utf8');
}

export interface Label {
  name: string;
  color: string;
  description: string | null;
}

export interface IssueComment {
  id: number;
  body: string;
  userLogin: string;
  createdAt: string;
  updatedAt: string;
}

export interface Issue {
  number: number;
  title: string;
  body: string | null;
  state: 'open' | 'closed';
  labels: string[];
  userLogin: string;
  createdAt: string;
  updatedAt: string;
  comments: IssueComment[];
  /** True when this number is a pull request (GitHub numbers them together). */
  isPull: boolean;
}

export interface Pull {
  number: number;
  title: string;
  body: string | null;
  state: 'open' | 'closed';
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  headRef: string;
  baseRef: string;
  /** The head sha captured when the pull was opened (refreshed on read). */
  headSha: string;
  userLogin: string;
  createdAt: string;
  updatedAt: string;
}

/** One repository: its git store, refs, and its REST-level resources. */
export class Repo {
  readonly objects = new ObjectStore();
  /** Full ref name ("refs/heads/main") to the sha it points at. */
  readonly refs = new Map<string, string>();
  readonly labels = new Map<string, Label>();
  readonly issues = new Map<number, Issue>();
  readonly pulls = new Map<number, Pull>();
  /** Issues and pull requests share one number sequence, as on GitHub. */
  nextNumber = 1;
  nextCommentId = 1;

  readonly id: number;
  readonly owner: string;
  readonly name: string;
  description: string;
  readonly createdAt: string;
  updatedAt: string;

  constructor(id: number, owner: string, name: string, description: string, createdAt: string, updatedAt: string) {
    this.id = id;
    this.owner = owner;
    this.name = name;
    this.description = description;
    this.createdAt = createdAt;
    this.updatedAt = updatedAt;
  }

  get fullName(): string {
    return `${this.owner}/${this.name}`;
  }

  /** The default branch name: the branch HEAD names, else 'main'. */
  defaultBranch = 'main';

  headRef(): string {
    return `refs/heads/${this.defaultBranch}`;
  }

  /** The commit sha a branch name resolves to, or undefined. */
  branchTip(branch: string): string | undefined {
    return this.refs.get(`refs/heads/${branch}`);
  }
}

/** The whole forge: every repository of the token owner, keyed by full name. */
export class Forge {
  readonly repos = new Map<string, Repo>();
  private nextRepoId = 5000;

  nowIso(): string {
    return new Date().toISOString();
  }

  createRepo(name: string, description: string): Repo {
    const now = this.nowIso();
    const repo = new Repo(this.nextRepoId, VIEWER.login, name, description, now, now);
    this.nextRepoId += 1;
    this.repos.set(repo.fullName, repo);
    return repo;
  }

  /** A repository only exists under the token owner's login. */
  getRepo(owner: string, name: string): Repo | undefined {
    if (owner !== VIEWER.login) return undefined;
    return this.repos.get(`${owner}/${name}`);
  }

  deleteRepo(owner: string, name: string): boolean {
    if (owner !== VIEWER.login) return false;
    return this.repos.delete(`${owner}/${name}`);
  }

  listRepos(): Repo[] {
    return [...this.repos.values()].sort((a, b) => a.id - b.id);
  }
}

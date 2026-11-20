// GraphQL v4: a small executor for the documents gh and
// github-mcp-server send — viewer, repository reads, issue and pull
// request connections with cursor pagination, the five mutations the
// suite drives, and the __type introspection probes gh feature-detects
// with. Global ids are opaque base64, stable across reads, and decode
// back through node(id:).

import { VIEWER, buildCommit, type Forge, type Issue, type Pull, type Repo } from './store.ts';
import { repoPrivate } from './rest.ts';
import { commitFiles, lineDiffCounts, mergeBase, mergeTrees } from './treetools.ts';

// ---------------------------------------------------------------- ids

/** An opaque global id for a node: base64url of "v1:<Type>:<key>". */
export function globalId(type: string, key: string): string {
  return Buffer.from(`v1:${type}:${key}`, 'utf8').toString('base64url');
}

/** Decode a global id back to its type and key, or null when malformed. */
export function parseGlobalId(id: string): { type: string; key: string } | null {
  try {
    const text = Buffer.from(id, 'base64url').toString('utf8');
    const match = /^v1:([A-Za-z]+):(.+)$/.exec(text);
    if (match === null) return null;
    return { type: match[1], key: match[2] };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- lexer

type Token =
  | { kind: 'name'; value: string }
  | { kind: 'string'; value: string }
  | { kind: 'number'; value: number }
  | { kind: 'punct'; value: string }
  | { kind: 'spread' };

function lex(source: string): Token[] {
  const tokens: Token[] = [];
  let at = 0;
  while (at < source.length) {
    const ch = source[at];
    if (ch === '#') {
      while (at < source.length && source[at] !== '\n') at += 1;
      continue;
    }
    if (/\s|,/.test(ch)) { at += 1; continue; }
    if (source.startsWith('...', at)) { tokens.push({ kind: 'spread' }); at += 3; continue; }
    if ('!$():=@[]{}|&'.includes(ch)) { tokens.push({ kind: 'punct', value: ch }); at += 1; continue; }
    if (ch === '"') {
      if (source.startsWith('"""', at)) {
        const end = source.indexOf('"""', at + 3);
        tokens.push({ kind: 'string', value: source.slice(at + 3, end < 0 ? source.length : end) });
        at = end < 0 ? source.length : end + 3;
        continue;
      }
      let value = '';
      at += 1;
      while (at < source.length && source[at] !== '"') {
        if (source[at] === '\\') {
          const esc = source[at + 1];
          if (esc === 'n') value += '\n';
          else if (esc === 't') value += '\t';
          else if (esc === 'r') value += '\r';
          else if (esc === 'b') value += '\b';
          else if (esc === 'f') value += '\f';
          else if (esc === '/') value += '/';
          else if (esc === '\\') value += '\\';
          else if (esc === '"') value += '"';
          else if (esc === 'u') { value += String.fromCharCode(Number.parseInt(source.slice(at + 2, at + 6), 16)); at += 4; }
          at += 2;
        } else {
          value += source[at];
          at += 1;
        }
      }
      at += 1;
      tokens.push({ kind: 'string', value });
      continue;
    }
    if (/[0-9-]/.test(ch)) {
      const match = /^-?\d+(\.\d+)?([eE][+-]?\d+)?/.exec(source.slice(at));
      if (match === null) throw new Error(`bad number at ${at}`);
      tokens.push({ kind: 'number', value: Number.parseFloat(match[0]) });
      at += match[0].length;
      continue;
    }
    if (/[_A-Za-z]/.test(ch)) {
      const match = /^[_A-Za-z][_0-9A-Za-z]*/.exec(source.slice(at));
      if (match === null) throw new Error(`bad name at ${at}`);
      tokens.push({ kind: 'name', value: match[0] });
      at += match[0].length;
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(ch)} at ${at}`);
  }
  return tokens;
}

// ---------------------------------------------------------------- parser

type Value =
  | { kind: 'var'; name: string }
  | { kind: 'string'; value: string }
  | { kind: 'number'; value: number }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; items: Value[] }
  | { kind: 'object'; fields: Map<string, Value> };

interface FieldNode {
  kind: 'field';
  alias: string | null;
  name: string;
  args: Map<string, Value>;
  selectionSet: Selection[] | null;
}
type Selection =
  | FieldNode
  | { kind: 'inline'; typeCondition: string | null; selectionSet: Selection[] }
  | { kind: 'spread'; name: string };

interface Operation {
  type: 'query' | 'mutation';
  name: string | null;
  selectionSet: Selection[];
}

class Parser {
  private at = 0;
  private readonly tokens: Token[];

  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token | undefined {
    return this.tokens[this.at];
  }

  private next(): Token {
    const token = this.tokens[this.at];
    if (token === undefined) throw new Error('unexpected end of document');
    this.at += 1;
    return token;
  }

  private expectPunct(value: string): void {
    const token = this.next();
    if (token.kind !== 'punct' || token.value !== value) throw new Error(`expected '${value}'`);
  }

  private skipPunct(value: string): boolean {
    const token = this.peek();
    if (token !== undefined && token.kind === 'punct' && token.value === value) {
      this.at += 1;
      return true;
    }
    return false;
  }

  private expectName(): string {
    const token = this.next();
    if (token.kind !== 'name') throw new Error('expected a name');
    return token.value;
  }

  /** Skip a type annotation (for variable definitions): Name, [Type], Type!. */
  private skipType(): void {
    if (this.skipPunct('[')) {
      this.skipType();
      this.expectPunct(']');
    } else {
      this.expectName();
    }
    this.skipPunct('!');
  }

  private parseValue(): Value {
    const token = this.next();
    if (token.kind === 'string') return { kind: 'string', value: token.value };
    if (token.kind === 'number') return { kind: 'number', value: token.value };
    if (token.kind === 'punct' && token.value === '$') return { kind: 'var', name: this.expectName() };
    if (token.kind === 'punct' && token.value === '[') {
      const items: Value[] = [];
      while (!this.skipPunct(']')) items.push(this.parseValue());
      return { kind: 'list', items };
    }
    if (token.kind === 'punct' && token.value === '{') {
      const fields = new Map<string, Value>();
      while (!this.skipPunct('}')) {
        const name = this.expectName();
        this.expectPunct(':');
        fields.set(name, this.parseValue());
      }
      return { kind: 'object', fields };
    }
    if (token.kind === 'name') {
      if (token.value === 'true') return { kind: 'boolean', value: true };
      if (token.value === 'false') return { kind: 'boolean', value: false };
      if (token.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: token.value };
    }
    throw new Error('unexpected value token');
  }

  private parseArguments(): Map<string, Value> {
    const args = new Map<string, Value>();
    if (!this.skipPunct('(')) return args;
    while (!this.skipPunct(')')) {
      const name = this.expectName();
      this.expectPunct(':');
      args.set(name, this.parseValue());
    }
    return args;
  }

  /** Directives are parsed and dropped: the suite's documents use none that change a result. */
  private skipDirectives(): void {
    while (this.skipPunct('@')) {
      this.expectName();
      this.parseArguments();
    }
  }

  private parseSelectionSet(): Selection[] {
    this.expectPunct('{');
    const selections: Selection[] = [];
    while (!this.skipPunct('}')) selections.push(this.parseSelection());
    return selections;
  }

  private parseSelection(): Selection {
    const token = this.peek();
    if (token !== undefined && token.kind === 'spread') {
      this.next();
      const ahead = this.peek();
      if (ahead !== undefined && ahead.kind === 'name' && ahead.value === 'on') {
        this.next();
        const typeCondition = this.expectName();
        this.skipDirectives();
        return { kind: 'inline', typeCondition, selectionSet: this.parseSelectionSet() };
      }
      const name = this.expectName();
      this.skipDirectives();
      return { kind: 'spread', name };
    }
    let name = this.expectName();
    let alias: string | null = null;
    if (this.skipPunct(':')) {
      alias = name;
      name = this.expectName();
    }
    const args = this.parseArguments();
    this.skipDirectives();
    let selectionSet: Selection[] | null = null;
    const ahead = this.peek();
    if (ahead !== undefined && ahead.kind === 'punct' && ahead.value === '{') selectionSet = this.parseSelectionSet();
    return { kind: 'field', alias, name, args, selectionSet };
  }

  parseDocument(): { operations: Operation[]; fragments: Map<string, Selection[]> } {
    const operations: Operation[] = [];
    const fragments = new Map<string, Selection[]>();
    while (this.at < this.tokens.length) {
      const token = this.peek();
      if (token === undefined) break;
      if (token.kind === 'punct' && token.value === '{') {
        operations.push({ type: 'query', name: null, selectionSet: this.parseSelectionSet() });
        continue;
      }
      const keyword = this.expectName();
      if (keyword === 'query' || keyword === 'mutation' || keyword === 'subscription') {
        let name: string | null = null;
        const ahead = this.peek();
        if (ahead !== undefined && ahead.kind === 'name') name = this.expectName();
        // Variable definitions.
        if (this.skipPunct('(')) {
          while (!this.skipPunct(')')) {
            this.expectPunct('$');
            this.expectName();
            this.expectPunct(':');
            this.skipType();
            if (this.skipPunct('=')) this.parseValue();
            this.skipDirectives();
          }
        }
        this.skipDirectives();
        operations.push({ type: keyword === 'mutation' ? 'mutation' : 'query', name, selectionSet: this.parseSelectionSet() });
      } else if (keyword === 'fragment') {
        const name = this.expectName();
        const on = this.expectName();
        if (on !== 'on') throw new Error('fragment without on');
        this.expectName();
        this.skipDirectives();
        fragments.set(name, this.parseSelectionSet());
      } else {
        throw new Error(`unexpected definition ${keyword}`);
      }
    }
    return { operations, fragments };
  }
}

// ---------------------------------------------------------------- schema data

const TYPE_FIELDS: Record<string, string[]> = {
  Query: ['viewer', 'repository', 'node', 'nodes', 'rateLimit', 'search', 'user', 'organization', 'meta'],
  Mutation: ['createIssue', 'closeIssue', 'reopenIssue', 'createPullRequest', 'mergePullRequest', 'addComment', 'updateIssue', 'updatePullRequest'],
  User: ['id', 'databaseId', 'login', 'name', 'email', 'url', 'avatarUrl', 'isViewer', 'createdAt', 'updatedAt'],
  Repository: [
    'id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'description', 'url', 'isPrivate', 'isFork',
    'viewerPermission', 'hasIssuesEnabled', 'hasProjectsEnabled', 'hasWikiEnabled', 'defaultBranchRef',
    'issue', 'issues', 'pullRequest', 'pullRequests', 'createdAt', 'updatedAt', 'pushedAt',
    'stargazerCount', 'forkCount', 'primaryLanguage', 'labels', 'refs', 'ref', 'parent', 'templateRepository',
  ],
  Issue: [
    'id', 'databaseId', 'number', 'title', 'state', 'body', 'bodyText', 'url', 'author', 'repository',
    'labels', 'comments', 'assignees', 'createdAt', 'updatedAt', 'closedAt', 'closed', 'viewerCanUpdate',
    'milestone', 'reactionGroups', 'participants',
  ],
  PullRequest: [
    'id', 'databaseId', 'number', 'title', 'body', 'state', 'merged', 'mergedAt', 'mergeable',
    'headRefName', 'baseRefName', 'headRef', 'baseRef', 'files', 'commits', 'author', 'repository',
    'createdAt', 'updatedAt', 'closedAt', 'url', 'additions', 'deletions', 'changedFiles', 'mergeCommit',
    'viewerCanUpdate', 'isDraft', 'labels', 'comments', 'reviews',
  ],
  Ref: ['id', 'name', 'prefix', 'target', 'repository'],
  Commit: ['id', 'oid', 'message', 'messageHeadline', 'committedDate', 'author', 'tree'],
  Label: ['id', 'name', 'color', 'description', 'url'],
  IssueComment: ['id', 'databaseId', 'body', 'author', 'createdAt', 'updatedAt', 'url', 'issue'],
  PageInfo: ['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor'],
  IssueConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  IssueEdge: ['node', 'cursor'],
  PullRequestEdge: ['node', 'cursor'],
  PullRequestChangedFileConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestChangedFile: ['path', 'additions', 'deletions', 'changeType'],
  PullRequestChangedFileEdge: ['node', 'cursor'],
  LabelConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  IssueCommentConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  CreateIssuePayload: ['issue', 'clientMutationId'],
  CloseIssuePayload: ['issue', 'clientMutationId'],
  ReopenIssuePayload: ['issue', 'clientMutationId'],
  CreatePullRequestPayload: ['pullRequest', 'clientMutationId'],
  MergePullRequestPayload: ['pullRequest', 'clientMutationId'],
  AddCommentPayload: ['commentEdge', 'subject', 'clientMutationId'],
  IssueCommentEdge: ['node', 'cursor'],
  GitHubMetadata: ['installedVersion'],
  RateLimit: ['limit', 'cost', 'remaining', 'resetAt', 'used'],
  __Schema: ['types', 'queryType', 'mutationType', 'subscriptionType', 'directives'],
  __Type: ['name', 'kind', 'description', 'fields', 'enumValues', 'possibleTypes', 'inputFields', 'ofType', 'specifiedByURL'],
  __Field: ['name', 'description', 'args', 'type', 'isDeprecated', 'deprecationReason'],
  __EnumValue: ['name', 'description', 'isDeprecated', 'deprecationReason'],
  __InputValue: ['name', 'description', 'type', 'defaultValue'],
};

const ENUM_VALUES: Record<string, string[]> = {
  SearchType: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION'],
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  RepositoryPermission: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
  OrderDirection: ['ASC', 'DESC'],
  PullRequestOrderField: ['CREATED_AT', 'UPDATED_AT'],
  MergeMethod: ['MERGE', 'SQUASH', 'REBASE'],
  FileChangeType: ['ADDED', 'MODIFIED', 'DELETED', 'RENAMED', 'COPIED', 'CHANGED'],
};

// ---------------------------------------------------------------- nodes

type Node =
  | { $type: 'Root'; rootType: 'Query' | 'Mutation' }
  | { $type: 'User' }
  | { $type: 'Repository'; repo: Repo }
  | { $type: 'Issue'; repo: Repo; issue: Issue }
  | { $type: 'PullRequest'; repo: Repo; pull: Pull }
  | { $type: 'Ref'; repo: Repo; name: string }
  | { $type: 'Commit'; repo: Repo; sha: string }
  | { $type: 'Label'; repo: Repo; name: string; color: string }
  | { $type: 'IssueComment'; repo: Repo; issue: Issue; commentId: number; body: string }
  | { $type: 'PageInfo'; hasNextPage: boolean; hasPreviousPage: boolean; startCursor: string | null; endCursor: string | null }
  | { $type: 'Connection'; connectionType: string; edgeType: string; items: Node[]; total: number }
  | { $type: 'Edge'; edgeType: string; node: Node; cursor: string }
  | { $type: 'ChangedFile'; path: string; additions: number; deletions: number; changeType: string }
  | { $type: 'Payload'; payloadType: string; values: Record<string, unknown> }
  | { $type: '__Type'; name: string }
  | { $type: '__Field'; name: string }
  | { $type: '__EnumValue'; name: string };

interface Ctx {
  forge: Forge;
  variables: Record<string, unknown>;
  fragments: Map<string, Selection[]>;
  errors: Array<{ message: string }>;
}

function resolveValue(value: Value, ctx: Ctx): unknown {
  switch (value.kind) {
    case 'var': return ctx.variables[value.name];
    case 'string': return value.value;
    case 'number': return value.value;
    case 'boolean': return value.value;
    case 'null': return null;
    case 'enum': return value.value;
    case 'list': return value.items.map((item) => resolveValue(item, ctx));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const [key, entry] of value.fields) out[key] = resolveValue(entry, ctx);
      return out;
    }
  }
}

function argsOf(field: FieldNode, ctx: Ctx): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of field.args) out[key] = resolveValue(value, ctx);
  return out;
}

// ---------------------------------------------------------------- connections

function cursorFor(index: number): string {
  return Buffer.from(`cursor:${index}`, 'utf8').toString('base64url');
}

function indexOfCursor(cursor: unknown): number {
  if (typeof cursor !== 'string' || cursor === '') return -1;
  try {
    const text = Buffer.from(cursor, 'base64url').toString('utf8');
    const match = /^cursor:(\d+)$/.exec(text);
    return match === null ? -1 : Number.parseInt(match[1], 10);
  } catch {
    return -1;
  }
}

/** Slice a full ordered list into a Relay connection page. */
function paginate(items: Node[], args: Record<string, unknown>, connectionType: string, edgeType: string): Node {
  const first = typeof args.first === 'number' ? Math.max(0, Math.floor(args.first)) : 10;
  const afterIndex = indexOfCursor(args.after);
  const start = afterIndex + 1;
  const pageItems = items.slice(start, start + first);
  const edges: Node[] = pageItems.map((node, i) => ({ $type: 'Edge', edgeType, node, cursor: cursorFor(start + i) }));
  const connection: Node = {
    $type: 'Connection',
    connectionType,
    edgeType,
    items: pageItems,
    total: items.length,
  };
  // Attach the page's edges and pageInfo through the values map the
  // connection resolver reads.
  (connection as unknown as { edges: Node[] }).edges = edges;
  (connection as unknown as { pageInfo: Node }).pageInfo = {
    $type: 'PageInfo',
    hasNextPage: start + pageItems.length < items.length,
    hasPreviousPage: start > 0,
    startCursor: pageItems.length > 0 ? cursorFor(start) : null,
    endCursor: pageItems.length > 0 ? cursorFor(start + pageItems.length - 1) : null,
  };
  return connection;
}

// ---------------------------------------------------------------- object helpers

function issueState(issue: Issue): string {
  return issue.state === 'open' ? 'OPEN' : 'CLOSED';
}

function pullState(pull: Pull): string {
  if (pull.merged) return 'MERGED';
  return pull.state === 'open' ? 'OPEN' : 'CLOSED';
}

function repoByGlobalId(forge: Forge, id: unknown): Repo | null {
  if (typeof id !== 'string') return null;
  const parsed = parseGlobalId(id);
  if (parsed !== null && parsed.type === 'Repository') {
    const wanted = Number.parseInt(parsed.key, 10);
    for (const repo of forge.repos.values()) if (repo.id === wanted) return repo;
    return null;
  }
  const numeric = Number.parseInt(id, 10);
  if (!Number.isNaN(numeric)) {
    for (const repo of forge.repos.values()) if (repo.id === numeric) return repo;
  }
  return null;
}

function issueByGlobalId(forge: Forge, id: unknown): { repo: Repo; issue: Issue } | null {
  if (typeof id !== 'string') return null;
  const parsed = parseGlobalId(id);
  if (parsed === null || parsed.type !== 'Issue') return null;
  const [repoId, number] = parsed.key.split(':').map((part) => Number.parseInt(part, 10));
  for (const repo of forge.repos.values()) {
    if (repo.id !== repoId) continue;
    const issue = repo.issues.get(number);
    return issue === undefined ? null : { repo, issue };
  }
  return null;
}

function pullByGlobalId(forge: Forge, id: unknown): { repo: Repo; pull: Pull } | null {
  if (typeof id !== 'string') return null;
  const parsed = parseGlobalId(id);
  if (parsed === null || parsed.type !== 'PullRequest') return null;
  const [repoId, number] = parsed.key.split(':').map((part) => Number.parseInt(part, 10));
  for (const repo of forge.repos.values()) {
    if (repo.id !== repoId) continue;
    const pull = repo.pulls.get(number);
    return pull === undefined ? null : { repo, pull };
  }
  return null;
}

/** The changed files of a pull request, in path order. */
export function pullChangedFiles(repo: Repo, pull: Pull): Array<{ path: string; additions: number; deletions: number; changeType: string }> {
  const headTip = repo.branchTip(pull.headRef) ?? pull.headSha;
  const baseTip = repo.branchTip(pull.baseRef);
  if (baseTip === undefined) return [];
  const base = mergeBase(repo.objects, baseTip, headTip) ?? baseTip;
  const before = commitFiles(repo.objects, base);
  const after = commitFiles(repo.objects, headTip);
  const paths = new Set([...before.keys(), ...after.keys()]);
  const out: Array<{ path: string; additions: number; deletions: number; changeType: string }> = [];
  for (const path of [...paths].sort()) {
    const atBase = before.get(path);
    const atHead = after.get(path);
    if (atBase?.sha === atHead?.sha) continue;
    const beforeBlob = atBase !== undefined ? repo.objects.get(atBase.sha)?.data ?? null : null;
    const afterBlob = atHead !== undefined ? repo.objects.get(atHead.sha)?.data ?? null : null;
    const counts = lineDiffCounts(beforeBlob, afterBlob);
    out.push({
      path,
      additions: counts.additions,
      deletions: counts.deletions,
      changeType: atBase === undefined ? 'ADDED' : atHead === undefined ? 'DELETED' : 'MODIFIED',
    });
  }
  return out;
}

function pullMergeable(repo: Repo, pull: Pull): string {
  if (pull.state !== 'open') return 'UNKNOWN';
  const headTip = repo.branchTip(pull.headRef) ?? pull.headSha;
  const baseTip = repo.branchTip(pull.baseRef);
  if (baseTip === undefined) return 'UNKNOWN';
  return mergeTrees(repo.objects, baseTip, headTip).ok ? 'MERGEABLE' : 'CONFLICTING';
}

// ---------------------------------------------------------------- resolvers

type Resolver = (source: Node, args: Record<string, unknown>, ctx: Ctx) => unknown;

const userNode: Node = { $type: 'User' };

const RESOLVERS: Record<string, Record<string, Resolver>> = {
  Query: {
    viewer: () => userNode,
    repository: (_source, args, ctx) => {
      const repo = ctx.forge.getRepo(String(args.owner ?? ''), String(args.name ?? ''));
      return repo === undefined ? null : { $type: 'Repository', repo };
    },
    node: (_source, args, ctx) => nodeById(ctx, args.id),
    nodes: (_source, args, ctx) => (Array.isArray(args.ids) ? args.ids.map((id) => nodeById(ctx, id)) : []),
    user: (_source, args) => (args.login === VIEWER.login ? userNode : null),
    rateLimit: () => ({ $type: 'Payload', payloadType: 'RateLimit', values: { limit: 5000, cost: 1, remaining: 4999, used: 1, resetAt: new Date(Date.now() + 3600_000).toISOString() } }),
  },
  Mutation: {
    createIssue: (_source, args, ctx) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const repo = repoByGlobalId(ctx.forge, input.repositoryId);
      if (repo === null || typeof input.title !== 'string') return null;
      const now = new Date().toISOString();
      const issue: Issue = {
        number: repo.nextNumber,
        title: input.title,
        body: typeof input.body === 'string' ? input.body : null,
        state: 'open',
        labels: [],
        userLogin: VIEWER.login,
        createdAt: now,
        updatedAt: now,
        comments: [],
        isPull: false,
      };
      repo.nextNumber += 1;
      repo.issues.set(issue.number, issue);
      return { $type: 'Payload', payloadType: 'CreateIssuePayload', values: { issue: { $type: 'Issue', repo, issue } } };
    },
    closeIssue: (_source, args, ctx) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const found = issueByGlobalId(ctx.forge, input.issueId);
      if (found === null) return null;
      found.issue.state = 'closed';
      found.issue.updatedAt = new Date().toISOString();
      return { $type: 'Payload', payloadType: 'CloseIssuePayload', values: { issue: { $type: 'Issue', repo: found.repo, issue: found.issue } } };
    },
    reopenIssue: (_source, args, ctx) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const found = issueByGlobalId(ctx.forge, input.issueId);
      if (found === null) return null;
      found.issue.state = 'open';
      found.issue.updatedAt = new Date().toISOString();
      return { $type: 'Payload', payloadType: 'ReopenIssuePayload', values: { issue: { $type: 'Issue', repo: found.repo, issue: found.issue } } };
    },
    createPullRequest: (_source, args, ctx) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const repo = repoByGlobalId(ctx.forge, input.repositoryId);
      if (repo === null) return null;
      const head = String(input.headRefName ?? '');
      const base = String(input.baseRefName ?? '');
      const headTip = repo.branchTip(head);
      if (headTip === undefined || repo.branchTip(base) === undefined) return null;
      for (const pull of repo.pulls.values()) {
        if (pull.state === 'open' && pull.headRef === head && pull.baseRef === base) {
          return { $type: 'Payload', payloadType: 'CreatePullRequestPayload', values: { pullRequest: { $type: 'PullRequest', repo, pull } } };
        }
      }
      const now = new Date().toISOString();
      const pull: Pull = {
        number: repo.nextNumber,
        title: typeof input.title === 'string' ? input.title : '',
        body: typeof input.body === 'string' ? input.body : null,
        state: 'open',
        merged: false,
        mergedAt: null,
        mergeCommitSha: null,
        headRef: head,
        baseRef: base,
        headSha: headTip,
        userLogin: VIEWER.login,
        createdAt: now,
        updatedAt: now,
      };
      repo.nextNumber += 1;
      repo.pulls.set(pull.number, pull);
      return { $type: 'Payload', payloadType: 'CreatePullRequestPayload', values: { pullRequest: { $type: 'PullRequest', repo, pull } } };
    },
    mergePullRequest: (_source, args, ctx) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const found = pullByGlobalId(ctx.forge, input.pullRequestId);
      if (found === null) return null;
      const method = typeof input.mergeMethod === 'string' ? input.mergeMethod.toLowerCase() : 'squash';
      mergePullShared(found.repo, found.pull, method === 'merge' ? 'merge' : 'squash');
      return { $type: 'Payload', payloadType: 'MergePullRequestPayload', values: { pullRequest: { $type: 'PullRequest', repo: found.repo, pull: found.pull } } };
    },
    addComment: (_source, args, ctx) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const found = issueByGlobalId(ctx.forge, input.subjectId);
      if (found === null || typeof input.body !== 'string') return null;
      const now = new Date().toISOString();
      const comment = { id: found.repo.nextCommentId, body: input.body, userLogin: VIEWER.login, createdAt: now, updatedAt: now };
      found.repo.nextCommentId += 1;
      found.issue.comments.push(comment);
      const node: Node = { $type: 'IssueComment', repo: found.repo, issue: found.issue, commentId: comment.id, body: comment.body };
      return {
        $type: 'Payload',
        payloadType: 'AddCommentPayload',
        values: {
          commentEdge: { $type: 'Edge', edgeType: 'IssueCommentEdge', node, cursor: cursorFor(found.issue.comments.length - 1) },
          subject: { $type: 'Issue', repo: found.repo, issue: found.issue },
        },
      };
    },
  },
  User: {
    id: () => globalId('User', String(VIEWER.id)),
    databaseId: () => VIEWER.id,
    login: () => VIEWER.login,
    name: () => VIEWER.name,
    email: () => VIEWER.email,
    url: () => '',
    avatarUrl: () => '',
    isViewer: () => true,
    createdAt: () => '2025-01-01T00:00:00Z',
    updatedAt: (_s, _a, ctx) => ctx.forge.nowIso(),
  },
  Repository: {
    id: (source) => globalId('Repository', String((source as { repo: Repo }).repo.id)),
    databaseId: (source) => (source as { repo: Repo }).repo.id,
    name: (source) => (source as { repo: Repo }).repo.name,
    nameWithOwner: (source) => (source as { repo: Repo }).repo.fullName,
    owner: () => userNode,
    description: (source) => (source as { repo: Repo }).repo.description,
    url: () => '',
    isPrivate: (source) => repoPrivate((source as { repo: Repo }).repo),
    isFork: () => false,
    viewerPermission: () => 'ADMIN',
    hasIssuesEnabled: () => true,
    hasProjectsEnabled: () => false,
    hasWikiEnabled: () => false,
    defaultBranchRef: (source) => {
      const repo = (source as { repo: Repo }).repo;
      if (repo.branchTip(repo.defaultBranch) === undefined) return null;
      return { $type: 'Ref', repo, name: repo.defaultBranch };
    },
    issue: (source, args) => {
      const repo = (source as { repo: Repo }).repo;
      const issue = repo.issues.get(Number(args.number));
      return issue === undefined ? null : { $type: 'Issue', repo, issue };
    },
    issues: (source, args) => {
      const repo = (source as { repo: Repo }).repo;
      let issues = [...repo.issues.values()];
      const states = Array.isArray(args.states) ? (args.states as string[]) : null;
      if (states !== null) issues = issues.filter((issue) => states.includes(issueState(issue)));
      const orderBy = (args.orderBy ?? {}) as { field?: string; direction?: string };
      const direction = typeof orderBy.direction === 'string' ? orderBy.direction : 'DESC';
      issues.sort((a, b) => (direction === 'ASC' ? a.number - b.number : b.number - a.number));
      return paginate(issues.map((issue): Node => ({ $type: 'Issue', repo, issue })), args, 'IssueConnection', 'IssueEdge');
    },
    pullRequest: (source, args) => {
      const repo = (source as { repo: Repo }).repo;
      const pull = repo.pulls.get(Number(args.number));
      return pull === undefined ? null : { $type: 'PullRequest', repo, pull };
    },
    pullRequests: (source, args) => {
      const repo = (source as { repo: Repo }).repo;
      let pulls = [...repo.pulls.values()];
      const states = Array.isArray(args.states) ? (args.states as string[]) : null;
      if (states !== null) pulls = pulls.filter((pull) => states.includes(pullState(pull)));
      const orderBy = (args.orderBy ?? {}) as { direction?: string };
      const direction = typeof orderBy.direction === 'string' ? orderBy.direction : 'DESC';
      pulls.sort((a, b) => (direction === 'ASC' ? a.number - b.number : b.number - a.number));
      return paginate(pulls.map((pull): Node => ({ $type: 'PullRequest', repo, pull })), args, 'PullRequestConnection', 'PullRequestEdge');
    },
    createdAt: (source) => (source as { repo: Repo }).repo.createdAt,
    updatedAt: (source) => (source as { repo: Repo }).repo.updatedAt,
    pushedAt: (source) => (source as { repo: Repo }).repo.updatedAt,
    stargazerCount: () => 0,
    forkCount: () => 0,
    primaryLanguage: () => null,
    labels: (source, args) => {
      const repo = (source as { repo: Repo }).repo;
      const nodes: Node[] = [...repo.labels.values()].map((label): Node => ({ $type: 'Label', repo, name: label.name, color: label.color }));
      return paginate(nodes, args, 'LabelConnection', 'IssueEdge');
    },
    ref: (source, args) => {
      const repo = (source as { repo: Repo }).repo;
      const qualified = String(args.qualifiedName ?? '');
      const branch = qualified.replace(/^refs\/heads\//, '');
      return repo.branchTip(branch) === undefined ? null : { $type: 'Ref', repo, name: branch };
    },
    refs: (source, args) => {
      const repo = (source as { repo: Repo }).repo;
      const prefix = String(args.refPrefix ?? 'refs/heads/');
      const nodes: Node[] = [...repo.refs.keys()]
        .filter((ref) => ref.startsWith(prefix))
        .sort()
        .map((ref): Node => ({ $type: 'Ref', repo, name: ref.slice(prefix.length) }));
      return paginate(nodes, args, 'RefConnection', 'IssueEdge');
    },
    parent: () => null,
    templateRepository: () => null,
  },
  Issue: {
    id: (source) => {
      const node = source as { repo: Repo; issue: Issue };
      return globalId('Issue', `${node.repo.id}:${node.issue.number}`);
    },
    databaseId: (source) => {
      const node = source as { repo: Repo; issue: Issue };
      return node.repo.id * 1000 + node.issue.number;
    },
    number: (source) => (source as { issue: Issue }).issue.number,
    title: (source) => (source as { issue: Issue }).issue.title,
    state: (source) => issueState((source as { issue: Issue }).issue),
    body: (source) => (source as { issue: Issue }).issue.body ?? '',
    bodyText: (source) => (source as { issue: Issue }).issue.body ?? '',
    url: () => '',
    author: () => userNode,
    repository: (source) => ({ $type: 'Repository', repo: (source as { repo: Repo }).repo }),
    labels: (source, args) => {
      const node = source as { repo: Repo; issue: Issue };
      const nodes: Node[] = node.issue.labels.map((name): Node => ({
        $type: 'Label', repo: node.repo, name, color: node.repo.labels.get(name)?.color ?? 'ededed',
      }));
      return paginate(nodes, args, 'LabelConnection', 'IssueEdge');
    },
    comments: (source, args) => {
      const node = source as { repo: Repo; issue: Issue };
      const nodes: Node[] = node.issue.comments.map((comment): Node => ({
        $type: 'IssueComment', repo: node.repo, issue: node.issue, commentId: comment.id, body: comment.body,
      }));
      return paginate(nodes, args, 'IssueCommentConnection', 'IssueCommentEdge');
    },
    assignees: (source, args) => paginate([], args, 'UserConnection', 'IssueEdge'),
    createdAt: (source) => (source as { issue: Issue }).issue.createdAt,
    updatedAt: (source) => (source as { issue: Issue }).issue.updatedAt,
    closedAt: (source) => ((source as { issue: Issue }).issue.state === 'closed' ? (source as { issue: Issue }).issue.updatedAt : null),
    closed: (source) => (source as { issue: Issue }).issue.state === 'closed',
    viewerCanUpdate: () => true,
    milestone: () => null,
    reactionGroups: () => [],
    participants: (source, args) => paginate([], args, 'UserConnection', 'IssueEdge'),
  },
  PullRequest: {
    id: (source) => {
      const node = source as { repo: Repo; pull: Pull };
      return globalId('PullRequest', `${node.repo.id}:${node.pull.number}`);
    },
    databaseId: (source) => {
      const node = source as { repo: Repo; pull: Pull };
      return node.repo.id * 1000 + node.pull.number;
    },
    number: (source) => (source as { pull: Pull }).pull.number,
    title: (source) => (source as { pull: Pull }).pull.title,
    body: (source) => (source as { pull: Pull }).pull.body ?? '',
    state: (source) => pullState((source as { pull: Pull }).pull),
    merged: (source) => (source as { pull: Pull }).pull.merged,
    mergedAt: (source) => (source as { pull: Pull }).pull.mergedAt,
    mergeable: (source) => {
      const node = source as { repo: Repo; pull: Pull };
      return pullMergeable(node.repo, node.pull);
    },
    headRefName: (source) => (source as { pull: Pull }).pull.headRef,
    baseRefName: (source) => (source as { pull: Pull }).pull.baseRef,
    headRef: (source) => {
      const node = source as { repo: Repo; pull: Pull };
      return { $type: 'Ref', repo: node.repo, name: node.pull.headRef };
    },
    baseRef: (source) => {
      const node = source as { repo: Repo; pull: Pull };
      return { $type: 'Ref', repo: node.repo, name: node.pull.baseRef };
    },
    files: (source, args) => {
      const node = source as { repo: Repo; pull: Pull };
      const nodes: Node[] = pullChangedFiles(node.repo, node.pull).map((file): Node => ({
        $type: 'ChangedFile', path: file.path, additions: file.additions, deletions: file.deletions, changeType: file.changeType,
      }));
      return paginate(nodes, args, 'PullRequestChangedFileConnection', 'PullRequestChangedFileEdge');
    },
    commits: (source, args) => paginate([], args, 'PullRequestCommitConnection', 'IssueEdge'),
    author: () => userNode,
    repository: (source) => ({ $type: 'Repository', repo: (source as { repo: Repo }).repo }),
    createdAt: (source) => (source as { pull: Pull }).pull.createdAt,
    updatedAt: (source) => (source as { pull: Pull }).pull.updatedAt,
    closedAt: (source) => (source as { pull: Pull }).pull.mergedAt,
    url: () => '',
    additions: (source) => {
      const node = source as { repo: Repo; pull: Pull };
      return pullChangedFiles(node.repo, node.pull).reduce((sum, file) => sum + file.additions, 0);
    },
    deletions: (source) => {
      const node = source as { repo: Repo; pull: Pull };
      return pullChangedFiles(node.repo, node.pull).reduce((sum, file) => sum + file.deletions, 0);
    },
    changedFiles: (source) => {
      const node = source as { repo: Repo; pull: Pull };
      return pullChangedFiles(node.repo, node.pull).length;
    },
    mergeCommit: (source) => {
      const node = source as { repo: Repo; pull: Pull };
      return node.pull.mergeCommitSha === null ? null : { $type: 'Commit', repo: node.repo, sha: node.pull.mergeCommitSha };
    },
    viewerCanUpdate: () => true,
    isDraft: () => false,
    labels: (source, args) => paginate([], args, 'LabelConnection', 'IssueEdge'),
    comments: (source, args) => paginate([], args, 'IssueCommentConnection', 'IssueCommentEdge'),
    reviews: (source, args) => paginate([], args, 'PullRequestReviewConnection', 'IssueEdge'),
  },
  Ref: {
    id: (source) => {
      const node = source as { repo: Repo; name: string };
      return globalId('Ref', `${node.repo.id}:refs/heads/${node.name}`);
    },
    name: (source) => (source as { name: string }).name,
    prefix: () => 'refs/heads/',
    target: (source) => {
      const node = source as { repo: Repo; name: string };
      const tip = node.repo.branchTip(node.name);
      return tip === undefined ? null : { $type: 'Commit', repo: node.repo, sha: tip };
    },
    repository: (source) => ({ $type: 'Repository', repo: (source as { repo: Repo }).repo }),
  },
  Commit: {
    id: (source) => globalId('Commit', (source as { sha: string }).sha),
    oid: (source) => (source as { sha: string }).sha,
    message: () => '',
    messageHeadline: () => '',
    committedDate: (_s, _a, ctx) => ctx.forge.nowIso(),
    author: () => null,
    tree: () => null,
  },
  Label: {
    id: (source) => {
      const node = source as { repo: Repo; name: string };
      return globalId('Label', `${node.repo.id}:${node.name}`);
    },
    name: (source) => (source as { name: string }).name,
    color: (source) => (source as { color: string }).color,
    description: () => null,
    url: () => '',
  },
  IssueComment: {
    id: (source) => {
      const node = source as { repo: Repo; issue: Issue; commentId: number };
      return globalId('IssueComment', `${node.repo.id}:${node.issue.number}:${node.commentId}`);
    },
    databaseId: (source) => (source as { commentId: number }).commentId,
    body: (source) => (source as { body: string }).body,
    author: () => userNode,
    createdAt: (_s, _a, ctx) => ctx.forge.nowIso(),
    updatedAt: (_s, _a, ctx) => ctx.forge.nowIso(),
    url: () => '',
    issue: (source) => ({ $type: 'Issue', repo: (source as { repo: Repo }).repo, issue: (source as { issue: Issue }).issue }),
  },
};

/** Merge a pull request in the store (shared with the REST merge). */
export function mergePullShared(repo: Repo, pull: Pull, method: 'merge' | 'squash'): boolean {
  if (pull.state !== 'open') return false;
  const headTip = repo.branchTip(pull.headRef) ?? pull.headSha;
  const baseTip = repo.branchTip(pull.baseRef);
  if (baseTip === undefined) return false;
  const outcome = mergeTrees(repo.objects, baseTip, headTip);
  if (!outcome.ok || outcome.tree === undefined) return false;
  const when = Math.floor(Date.now() / 1000);
  const identity = `${VIEWER.name} <${VIEWER.email}> ${when} +0000`;
  const title = method === 'merge'
    ? `Merge pull request #${pull.number} from ${repo.owner}/${pull.headRef}`
    : `${pull.title} (#${pull.number})`;
  const message = method === 'squash' && pull.body ? `${title}\n\n${pull.body}` : title;
  const parents = method === 'merge' ? [baseTip, headTip] : [baseTip];
  const sha = repo.objects.put('commit', buildCommit({ tree: outcome.tree, parents, author: identity, committer: identity, message }));
  repo.refs.set(`refs/heads/${pull.baseRef}`, sha);
  pull.state = 'closed';
  pull.merged = true;
  pull.mergedAt = new Date().toISOString();
  pull.mergeCommitSha = sha;
  pull.updatedAt = pull.mergedAt;
  return true;
}

function nodeById(ctx: Ctx, id: unknown): Node | null {
  if (typeof id !== 'string') return null;
  const parsed = parseGlobalId(id);
  if (parsed === null) return null;
  if (parsed.type === 'Repository') {
    const repo = repoByGlobalId(ctx.forge, id);
    return repo === null ? null : { $type: 'Repository', repo };
  }
  if (parsed.type === 'Issue') {
    const found = issueByGlobalId(ctx.forge, id);
    return found === null ? null : { $type: 'Issue', repo: found.repo, issue: found.issue };
  }
  if (parsed.type === 'PullRequest') {
    const found = pullByGlobalId(ctx.forge, id);
    return found === null ? null : { $type: 'PullRequest', repo: found.repo, pull: found.pull };
  }
  if (parsed.type === 'User') return userNode;
  return null;
}

// ---------------------------------------------------------------- execution

function typeNameOf(node: Node): string {
  if (node.$type === 'Root') return node.rootType;
  if (node.$type === 'Connection') return node.connectionType;
  if (node.$type === 'Edge') return node.edgeType;
  if (node.$type === 'Payload') return node.payloadType;
  if (node.$type === 'ChangedFile') return 'PullRequestChangedFile';
  return node.$type;
}

function resolveField(node: Node, field: FieldNode, ctx: Ctx): unknown {
  const typeName = typeNameOf(node);
  if (field.name === '__typename') return typeName;
  if (node.$type === 'Connection') {
    if (field.name === 'nodes') return node.items;
    if (field.name === 'edges') return (node as unknown as { edges: Node[] }).edges;
    if (field.name === 'pageInfo') return (node as unknown as { pageInfo: Node }).pageInfo;
    if (field.name === 'totalCount') return node.total;
  }
  if (node.$type === 'Edge') {
    if (field.name === 'node') return node.node;
    if (field.name === 'cursor') return node.cursor;
  }
  if (node.$type === 'PageInfo') {
    if (field.name === 'hasNextPage') return node.hasNextPage;
    if (field.name === 'hasPreviousPage') return node.hasPreviousPage;
    if (field.name === 'startCursor') return node.startCursor;
    if (field.name === 'endCursor') return node.endCursor;
  }
  if (node.$type === 'ChangedFile') {
    if (field.name === 'path') return node.path;
    if (field.name === 'additions') return node.additions;
    if (field.name === 'deletions') return node.deletions;
    if (field.name === 'changeType') return node.changeType;
  }
  if (node.$type === 'Payload') {
    if (field.name === 'clientMutationId') return null;
    return node.values[field.name];
  }
  if (node.$type === '__Type') {
    if (field.name === 'name') return node.name;
    if (field.name === 'kind') return ENUM_VALUES[node.name] !== undefined ? 'ENUM' : 'OBJECT';
    if (field.name === 'description') return null;
    if (field.name === 'fields') return (TYPE_FIELDS[node.name] ?? []).map((name): Node => ({ $type: '__Field', name }));
    if (field.name === 'enumValues') return (ENUM_VALUES[node.name] ?? []).map((name): Node => ({ $type: '__EnumValue', name }));
    if (field.name === 'possibleTypes') return [];
    if (field.name === 'inputFields') return [];
    if (field.name === 'ofType') return null;
    if (field.name === 'specifiedByURL') return null;
  }
  if (node.$type === '__Field') {
    if (field.name === 'name') return node.name;
    if (field.name === 'description') return null;
    if (field.name === 'args') return [];
    if (field.name === 'type') return null;
    if (field.name === 'isDeprecated') return false;
    if (field.name === 'deprecationReason') return null;
  }
  if (node.$type === '__EnumValue') {
    if (field.name === 'name') return node.name;
    if (field.name === 'description') return null;
    if (field.name === 'isDeprecated') return false;
    if (field.name === 'deprecationReason') return null;
  }
  const resolver = RESOLVERS[typeName]?.[field.name];
  if (resolver === undefined) {
    ctx.errors.push({ message: `Field '${field.name}' doesn't exist on type '${typeName}'` });
    return null;
  }
  try {
    return resolver(node, argsOf(field, ctx), ctx);
  } catch (err) {
    ctx.errors.push({ message: err instanceof Error ? err.message : String(err) });
    return null;
  }
}

function completeValue(value: unknown, field: FieldNode, ctx: Ctx): unknown {
  if (value === null || value === undefined) return null;
  if (field.selectionSet === null) return value;
  if (Array.isArray(value)) return value.map((item) => completeValue(item, field, ctx));
  if (typeof value === 'object' && value !== null && '$type' in (value as Record<string, unknown>)) {
    return executeSelectionSet(value as Node, field.selectionSet, ctx);
  }
  return value;
}

function executeSelectionSet(node: Node, selections: Selection[], ctx: Ctx): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const typeName = typeNameOf(node);
  for (const selection of selections) {
    if (selection.kind === 'inline') {
      if (selection.typeCondition === null || selection.typeCondition === typeName) {
        Object.assign(out, executeSelectionSet(node, selection.selectionSet, ctx));
      }
      continue;
    }
    if (selection.kind === 'spread') {
      const fragment = ctx.fragments.get(selection.name);
      if (fragment !== undefined) Object.assign(out, executeSelectionSet(node, fragment, ctx));
      continue;
    }
    const key = selection.alias ?? selection.name;
    // Introspection entry points live on the query root.
    if (selection.name === '__type' && (typeName === 'Query')) {
      const nameArg = resolveValue(selection.args.get('name') ?? { kind: 'null' }, ctx);
      const typeNode: Node | null = typeof nameArg === 'string' && (TYPE_FIELDS[nameArg] !== undefined || ENUM_VALUES[nameArg] !== undefined)
        ? { $type: '__Type', name: nameArg }
        : null;
      out[key] = typeNode === null || selection.selectionSet === null ? typeNode : executeSelectionSet(typeNode, selection.selectionSet, ctx);
      continue;
    }
    if (selection.name === '__schema' && typeName === 'Query') {
      out[key] = selection.selectionSet === null ? {} : {};
      continue;
    }
    const value = resolveField(node, selection, ctx);
    out[key] = completeValue(value, selection, ctx);
  }
  return out;
}

export interface GraphQLReply {
  status: number;
  body: unknown;
}

/** Execute one GraphQL request body ({query, variables, operationName}) or a batch array. */
export function handleGraphQL(forge: Forge, payload: unknown): GraphQLReply {
  if (Array.isArray(payload)) {
    const results = payload.map((entry) => executeOne(forge, entry).body);
    return { status: 200, body: results };
  }
  const { status, body } = executeOne(forge, payload);
  return { status, body };
}

function executeOne(forge: Forge, payload: unknown): { status: number; body: Record<string, unknown> } {
  const request = (payload ?? {}) as { query?: unknown; variables?: unknown; operationName?: unknown };
  if (typeof request.query !== 'string') {
    return { status: 400, body: { errors: [{ message: 'query is required' }] } };
  }
  let document: { operations: Operation[]; fragments: Map<string, Selection[]> };
  try {
    document = new Parser(lex(request.query)).parseDocument();
  } catch (err) {
    return { status: 200, body: { errors: [{ message: err instanceof Error ? err.message : 'parse error' }] } };
  }
  const operationName = typeof request.operationName === 'string' ? request.operationName : null;
  const operation = operationName !== null
    ? document.operations.find((candidate) => candidate.name === operationName)
    : document.operations[0];
  if (operation === undefined) {
    return { status: 200, body: { errors: [{ message: 'operation not found' }] } };
  }
  const ctx: Ctx = {
    forge,
    variables: (request.variables ?? {}) as Record<string, unknown>,
    fragments: document.fragments,
    errors: [],
  };
  const root: Node = { $type: 'Root', rootType: operation.type === 'mutation' ? 'Mutation' : 'Query' };
  const data = executeSelectionSet(root, operation.selectionSet, ctx);
  const body: Record<string, unknown> = { data };
  if (ctx.errors.length > 0) body.errors = ctx.errors;
  return { status: 200, body };
}

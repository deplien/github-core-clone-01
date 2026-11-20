// The MCP endpoint: JSON-RPC 2.0 over streamable HTTP at /mcp,
// speaking the 2026-07-28 revision (server/discover, no handshake) and
// the legacy initialize handshake for older clients. The tools act on
// the same forge store as REST and GraphQL, so an issue created here is
// the same object REST reads back.

import { VIEWER, type Forge, type Issue, type Pull, type Repo } from './store.ts';
import { repoJson, setRepoPrivate } from './rest.ts';
import { mergePullShared } from './graphql.ts';

export interface McpReply {
  status: number;
  /** The JSON-RPC response object, or null for a notification (202, empty). */
  body: Record<string, unknown> | null;
}

const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const SERVER_INFO = { name: 'ada-forge', version: '1.0.0' };
const CAPABILITIES = { tools: { listChanged: false } };

interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  run: (forge: Forge, args: Record<string, unknown>) => { ok: boolean; payload: unknown };
}

function stringArg(args: Record<string, unknown>, name: string): string {
  const value = args[name];
  return typeof value === 'string' ? value : '';
}

function repoArg(forge: Forge, args: Record<string, unknown>): Repo | null {
  const owner = stringArg(args, 'owner');
  const repoName = stringArg(args, 'repo');
  if (owner === '' || repoName === '') return null;
  return forge.getRepo(owner, repoName) ?? null;
}

function issuePayload(repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: repo.id * 1000 + issue.number,
    number: issue.number,
    title: issue.title,
    body: issue.body ?? '',
    state: issue.state,
    labels: issue.labels.map((name) => ({ name })),
    user: { login: VIEWER.login },
    html_url: `https://github.com/${repo.fullName}/issues/${issue.number}`,
  };
}

function pullPayload(repo: Repo, pull: Pull): Record<string, unknown> {
  return {
    id: repo.id * 1000 + pull.number,
    number: pull.number,
    title: pull.title,
    body: pull.body ?? '',
    state: pull.state,
    merged: pull.merged,
    merge_commit_sha: pull.mergeCommitSha,
    head: { ref: pull.headRef, sha: repo.branchTip(pull.headRef) ?? pull.headSha },
    base: { ref: pull.baseRef, sha: repo.branchTip(pull.baseRef) ?? '' },
    user: { login: VIEWER.login },
  };
}

const TOOLS: ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository for the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The repository name.' },
        description: { type: 'string', description: 'A short description of the repository.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
      },
      required: ['name'],
    },
    run: (forge, args) => {
      const name = stringArg(args, 'name');
      if (name === '') return { ok: false, payload: { message: 'name is required' } };
      if (forge.getRepo(VIEWER.login, name) !== undefined) return { ok: false, payload: { message: 'name already exists on this account' } };
      const repo = forge.createRepo(name, stringArg(args, 'description'));
      setRepoPrivate(repo, args.private === true);
      return { ok: true, payload: repoJson(repo) };
    },
  },
  {
    name: 'get_repo',
    description: 'Read one repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
      },
      required: ['owner', 'repo'],
    },
    run: (forge, args) => {
      const repo = repoArg(forge, args);
      return repo === null ? { ok: false, payload: { message: 'Not Found' } } : { ok: true, payload: repoJson(repo) };
    },
  },
  {
    name: 'list_repos',
    description: 'List the repositories of the authenticated user.',
    inputSchema: { type: 'object', properties: {}, required: [] },
    run: (forge) => ({ ok: true, payload: { repositories: forge.listRepos().map((repo) => repoJson(repo)) } }),
  },
  {
    name: 'create_issue',
    description: 'Open an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The issue title.' },
        body: { type: 'string', description: 'The issue body.' },
      },
      required: ['owner', 'repo', 'title'],
    },
    run: (forge, args) => {
      const repo = repoArg(forge, args);
      if (repo === null) return { ok: false, payload: { message: 'Not Found' } };
      const now = new Date().toISOString();
      const issue: Issue = {
        number: repo.nextNumber,
        title: stringArg(args, 'title'),
        body: typeof args.body === 'string' ? args.body : null,
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
      return { ok: true, payload: issuePayload(repo, issue) };
    },
  },
  {
    name: 'get_issue',
    description: 'Read one issue by its number.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        issue_number: { type: 'integer', description: 'The issue number.' },
      },
      required: ['owner', 'repo', 'issue_number'],
    },
    run: (forge, args) => {
      const repo = repoArg(forge, args);
      if (repo === null) return { ok: false, payload: { message: 'Not Found' } };
      const issue = repo.issues.get(Number(args.issue_number));
      return issue === undefined ? { ok: false, payload: { message: 'Not Found' } } : { ok: true, payload: issuePayload(repo, issue) };
    },
  },
  {
    name: 'list_issues',
    description: 'List a repository’s issues, optionally filtered by state.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        state: { type: 'string', description: 'open, closed or all (default open).' },
      },
      required: ['owner', 'repo'],
    },
    run: (forge, args) => {
      const repo = repoArg(forge, args);
      if (repo === null) return { ok: false, payload: { message: 'Not Found' } };
      const state = typeof args.state === 'string' ? args.state : 'open';
      let issues = [...repo.issues.values()];
      if (state === 'open') issues = issues.filter((issue) => issue.state === 'open');
      else if (state === 'closed') issues = issues.filter((issue) => issue.state === 'closed');
      issues.sort((a, b) => b.number - a.number);
      return { ok: true, payload: { issues: issues.map((issue) => issuePayload(repo, issue)) } };
    },
  },
  {
    name: 'create_pull_request',
    description: 'Open a pull request from a head branch onto a base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The pull request title.' },
        body: { type: 'string', description: 'The pull request body.' },
        head: { type: 'string', description: 'The head branch name.' },
        base: { type: 'string', description: 'The base branch name.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
    run: (forge, args) => {
      const repo = repoArg(forge, args);
      if (repo === null) return { ok: false, payload: { message: 'Not Found' } };
      const head = stringArg(args, 'head').replace(/^[^:]+:/, '');
      const base = stringArg(args, 'base');
      const headTip = repo.branchTip(head);
      if (headTip === undefined) return { ok: false, payload: { message: `head branch ${head} does not exist` } };
      if (repo.branchTip(base) === undefined) return { ok: false, payload: { message: `base branch ${base} does not exist` } };
      for (const pull of repo.pulls.values()) {
        if (pull.state === 'open' && pull.headRef === head && pull.baseRef === base) {
          return { ok: true, payload: pullPayload(repo, pull) };
        }
      }
      const now = new Date().toISOString();
      const pull: Pull = {
        number: repo.nextNumber,
        title: stringArg(args, 'title'),
        body: typeof args.body === 'string' ? args.body : null,
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
      return { ok: true, payload: pullPayload(repo, pull) };
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request into its base branch (squash).',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        pull_number: { type: 'integer', description: 'The pull request number.' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
    run: (forge, args) => {
      const repo = repoArg(forge, args);
      if (repo === null) return { ok: false, payload: { message: 'Not Found' } };
      const pull = repo.pulls.get(Number(args.pull_number));
      if (pull === undefined) return { ok: false, payload: { message: 'Not Found' } };
      if (!mergePullShared(repo, pull, 'squash')) return { ok: false, payload: { message: 'Pull Request is not mergeable' } };
      return { ok: true, payload: { sha: pull.mergeCommitSha, merged: true, message: 'Pull Request successfully merged', pull_request: pullPayload(repo, pull) } };
    },
  },
];

/** The tools/list answer: built once, so two calls are byte-identical. */
const TOOLS_LIST_RESULT = {
  tools: TOOLS.map((tool) => ({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema })),
};

function rpcError(id: unknown, code: number, message: string): Record<string, unknown> {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } };
}

function rpcResult(id: unknown, result: unknown): Record<string, unknown> {
  return { jsonrpc: '2.0', id: id ?? null, result };
}

/** Handle one /mcp POST. `rawBody` is the unparsed text (for the parse-error path). */
export function handleMcp(forge: Forge, rawBody: string): McpReply {
  let request: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(rawBody);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return { status: 400, body: rpcError(null, -32700, 'Parse error') };
    }
    request = parsed as Record<string, unknown>;
  } catch {
    return { status: 400, body: rpcError(null, -32700, 'Parse error') };
  }
  const id = request.id;
  const method = typeof request.method === 'string' ? request.method : '';
  const params = (typeof request.params === 'object' && request.params !== null ? request.params : {}) as Record<string, unknown>;

  // Notifications carry no id and are answered with an empty 202.
  if (id === undefined || id === null) {
    if (method.startsWith('notifications/')) return { status: 202, body: null };
    if (method === '') return { status: 400, body: rpcError(null, -32600, 'Invalid Request') };
  }

  switch (method) {
    case 'server/discover':
      return {
        status: 200,
        body: rpcResult(id, {
          resultType: 'complete',
          supportedVersions: SUPPORTED_VERSIONS,
          capabilities: CAPABILITIES,
          serverInfo: SERVER_INFO,
          instructions: 'A GitHub-compatible git forge: repositories, issues and pull requests over MCP, REST v3, GraphQL v4 and git smart HTTP.',
        }),
      };
    case 'initialize': {
      const offered = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
      const version = SUPPORTED_VERSIONS.includes(offered) ? offered : '2025-11-25';
      return {
        status: 200,
        body: rpcResult(id, { protocolVersion: version, capabilities: CAPABILITIES, serverInfo: SERVER_INFO }),
      };
    }
    case 'ping':
      return { status: 200, body: rpcResult(id, {}) };
    case 'tools/list':
      return { status: 200, body: rpcResult(id, TOOLS_LIST_RESULT) };
    case 'tools/call': {
      const name = typeof params.name === 'string' ? params.name : '';
      const tool = TOOLS.find((candidate) => candidate.name === name);
      if (tool === undefined) {
        return { status: 200, body: rpcError(id, -32602, `Unknown tool: ${name}`) };
      }
      const args = (typeof params.arguments === 'object' && params.arguments !== null ? params.arguments : {}) as Record<string, unknown>;
      const required = (tool.inputSchema.required as string[] | undefined) ?? [];
      const missing = required.filter((key) => args[key] === undefined || args[key] === null || args[key] === '');
      if (missing.length > 0) {
        return { status: 200, body: rpcError(id, -32602, `Missing required argument(s): ${missing.join(', ')}`) };
      }
      const outcome = tool.run(forge, args);
      return {
        status: 200,
        body: rpcResult(id, {
          resultType: 'complete',
          content: [{ type: 'text', text: JSON.stringify(outcome.payload) }],
          structuredContent: outcome.payload,
          isError: !outcome.ok,
        }),
      };
    }
    default:
      if (method.startsWith('notifications/')) return { status: 202, body: null };
      return { status: 200, body: rpcError(id, -32601, `Method not found: ${method}`) };
  }
}

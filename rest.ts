// REST v3: the /api/v3 surface — repositories, branches, commits,
// contents, labels, issues, comments and pull requests — over the shared
// forge store. Every reply is JSON with a message-carrying error body,
// the way api.github.com answers.

import {
  VIEWER,
  parseCommit,
  type Forge,
  type Issue,
  type Label,
  type Pull,
  type Repo,
} from './store.ts';
import { walkCommits } from './git.ts';
import { commitFileChanges, commitFiles, flattenTree, lineDiffCounts, mergeBase, mergeTrees } from './treetools.ts';
import { buildCommit, parseTree } from './store.ts';

export interface RestRequest {
  method: string;
  /** Path segments after /api/v3, URL-decoded. */
  segments: string[];
  query: URLSearchParams;
  /** The parsed JSON body, or undefined when there was none. */
  body: Record<string, unknown> | undefined;
  /** The request's Host header, for absolute Link URLs. */
  host: string;
}

export interface RestReply {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
}

const notFound = (): RestReply => ({ status: 404, body: { message: 'Not Found' } });
const invalid = (message: string): RestReply => ({ status: 422, body: { message } });

// ---------------------------------------------------------------- shapes

export function userJson(): Record<string, unknown> {
  return {
    login: VIEWER.login,
    id: VIEWER.id,
    avatar_url: '',
    type: VIEWER.type,
    site_admin: false,
    name: VIEWER.name,
    email: VIEWER.email,
  };
}

export function repoJson(repo: Repo): Record<string, unknown> {
  const openIssues = [...repo.issues.values()].filter((issue) => issue.state === 'open').length
    + [...repo.pulls.values()].filter((pull) => pull.state === 'open').length;
  return {
    id: repo.id,
    name: repo.name,
    full_name: repo.fullName,
    owner: userJson(),
    private: repoPrivate(repo),
    description: repo.description,
    fork: false,
    html_url: `https://github.com/${repo.fullName}`,
    url: `/api/v3/repos/${repo.fullName}`,
    created_at: repo.createdAt,
    updated_at: repo.updatedAt,
    pushed_at: repo.updatedAt,
    default_branch: repo.defaultBranch,
    size: 0,
    stargazers_count: 0,
    watchers_count: 0,
    forks_count: 0,
    open_issues_count: openIssues,
    language: null,
    topics: [],
    visibility: repoPrivate(repo) ? 'private' : 'public',
  };
}

// The create call carries `private`; remember it per repository.
const privateFlags = new WeakMap<Repo, boolean>();
export function setRepoPrivate(repo: Repo, value: boolean): void {
  privateFlags.set(repo, value);
}
export function repoPrivate(repo: Repo): boolean {
  return privateFlags.get(repo) ?? false;
}

function labelJson(label: Label): Record<string, unknown> {
  return { name: label.name, color: label.color, description: label.description, default: false };
}

function issueJson(repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: issueIdBase(repo) + issue.number,
    number: issue.number,
    title: issue.title,
    body: issue.body ?? '',
    state: issue.state,
    user: userJson(),
    labels: issue.labels.map((name) => labelJson(repo.labels.get(name) ?? { name, color: 'ededed', description: null })),
    comments: issue.comments.length,
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    html_url: `https://github.com/${repo.fullName}/issues/${issue.number}`,
    url: `/api/v3/repos/${repo.fullName}/issues/${issue.number}`,
  };
}

function issueIdBase(repo: Repo): number {
  return repo.id * 1000;
}

function pullJson(repo: Repo, pull: Pull): Record<string, unknown> {
  const headSha = repo.branchTip(pull.headRef) ?? pull.headSha;
  const baseSha = repo.branchTip(pull.baseRef) ?? '';
  return {
    id: issueIdBase(repo) + pull.number,
    number: pull.number,
    state: pull.state,
    title: pull.title,
    body: pull.body ?? '',
    user: userJson(),
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha ?? headSha,
    head: {
      ref: pull.headRef,
      sha: headSha,
      label: `${repo.owner}:${pull.headRef}`,
      user: userJson(),
      repo: repoJson(repo),
    },
    base: {
      ref: pull.baseRef,
      sha: baseSha,
      label: `${repo.owner}:${pull.baseRef}`,
      user: userJson(),
      repo: repoJson(repo),
    },
    created_at: pull.createdAt,
    updated_at: pull.updatedAt,
    html_url: `https://github.com/${repo.fullName}/pull/${pull.number}`,
    url: `/api/v3/repos/${repo.fullName}/pulls/${pull.number}`,
  };
}

function parseIdentity(line: string): { name: string; email: string; date: string } {
  const match = /^(.*?) <(.*?)> (\d+) [+-]\d{4}$/.exec(line);
  if (match === null) return { name: line, email: '', date: new Date(0).toISOString() };
  return { name: match[1], email: match[2], date: new Date(Number.parseInt(match[3], 10) * 1000).toISOString() };
}

function commitJson(repo: Repo, sha: string): Record<string, unknown> | null {
  const obj = repo.objects.get(sha);
  if (obj === undefined || obj.type !== 'commit') return null;
  const commit = parseCommit(obj.data);
  return {
    sha,
    commit: {
      author: parseIdentity(commit.author),
      committer: parseIdentity(commit.committer),
      message: commit.message,
      tree: { sha: commit.tree },
    },
    author: userJson(),
    committer: userJson(),
    parents: commit.parents.map((parent) => ({ sha: parent })),
    url: `/api/v3/repos/${repo.fullName}/commits/${sha}`,
    html_url: `https://github.com/${repo.fullName}/commit/${sha}`,
  };
}

// ---------------------------------------------------------------- pagination

interface Page {
  perPage: number;
  page: number;
}

function pageOf(query: URLSearchParams): Page {
  const perPage = Math.min(100, Math.max(1, Number.parseInt(query.get('per_page') ?? '30', 10) || 30));
  const page = Math.max(1, Number.parseInt(query.get('page') ?? '1', 10) || 1);
  return { perPage, page };
}

/** Slice a list for the page and build the Link header when more pages follow. */
function paginate<T>(items: T[], page: Page, path: string, query: URLSearchParams, host: string): { items: T[]; headers?: Record<string, string> } {
  const start = (page.page - 1) * page.perPage;
  const slice = items.slice(start, start + page.perPage);
  const lastPage = Math.max(1, Math.ceil(items.length / page.perPage));
  if (page.page >= lastPage) return { items: slice };
  const build = (target: number): string => {
    const params = new URLSearchParams(query);
    params.set('per_page', String(page.perPage));
    params.set('page', String(target));
    return `<http://${host}${path}?${params.toString()}>`;
  };
  const links = [`${build(page.page + 1)}; rel="next"`, `${build(lastPage)}; rel="last"`];
  return { items: slice, headers: { link: links.join(', ') } };
}

// ---------------------------------------------------------------- handlers

function listUserRepos(forge: Forge, req: RestRequest): RestReply {
  const all = forge.listRepos().map((repo) => repoJson(repo));
  const { items, headers } = paginate(all, pageOf(req.query), '/api/v3/user/repos', req.query, req.host);
  return { status: 200, body: items, headers };
}

function createRepo(forge: Forge, req: RestRequest): RestReply {
  const body = req.body ?? {};
  const name = typeof body.name === 'string' ? body.name : '';
  if (name === '' || name.includes('/')) return invalid('Repository creation failed.');
  if (forge.getRepo(VIEWER.login, name) !== undefined) {
    return {
      status: 422,
      body: {
        message: 'Repository creation failed.',
        errors: [{ resource: 'Repository', code: 'custom', field: 'name', message: 'name already exists on this account' }],
      },
    };
  }
  const repo = forge.createRepo(name, typeof body.description === 'string' ? body.description : '');
  setRepoPrivate(repo, body.private === true);
  return { status: 201, body: repoJson(repo) };
}

function repoRoot(forge: Forge, req: RestRequest, owner: string, name: string): RestReply {
  const repo = forge.getRepo(owner, name);
  if (repo === undefined) return notFound();
  if (req.method === 'GET') return { status: 200, body: repoJson(repo) };
  if (req.method === 'PATCH') {
    const body = req.body ?? {};
    if (typeof body.description === 'string') repo.description = body.description;
    if (typeof body.private === 'boolean') setRepoPrivate(repo, body.private);
    if (typeof body.default_branch === 'string' && body.default_branch !== '') repo.defaultBranch = body.default_branch;
    if (typeof body.name === 'string' && body.name !== '' && body.name !== repo.name) {
      // A rename moves the map key, as the account's repository is renamed.
      forge.repos.delete(repo.fullName);
      (repo as { name: string }).name = body.name;
      forge.repos.set(repo.fullName, repo);
    }
    repo.updatedAt = forge.nowIso();
    return { status: 200, body: repoJson(repo) };
  }
  if (req.method === 'DELETE') {
    forge.deleteRepo(owner, name);
    return { status: 204, body: null };
  }
  return notFound();
}

function listBranches(repo: Repo): RestReply {
  const branches = [...repo.refs.keys()]
    .filter((ref) => ref.startsWith('refs/heads/'))
    .map((ref) => ref.slice('refs/heads/'.length))
    .sort()
    .map((name) => ({
      name,
      commit: { sha: repo.refs.get(`refs/heads/${name}`), url: `/api/v3/repos/${repo.fullName}/commits/${repo.refs.get(`refs/heads/${name}`)}` },
      protected: false,
    }));
  return { status: 200, body: branches };
}

function listCommits(repo: Repo, req: RestRequest): RestReply {
  const wanted = req.query.get('sha');
  let tip: string | undefined;
  if (wanted === null || wanted === '') tip = repo.branchTip(repo.defaultBranch);
  else tip = repo.branchTip(wanted) ?? (repo.objects.has(wanted) ? wanted : undefined);
  if (tip === undefined) return { status: 200, body: [] };
  const all = walkCommits(repo.objects, tip)
    .map((sha) => commitJson(repo, sha))
    .filter((entry) => entry !== null);
  const { items, headers } = paginate(all, pageOf(req.query), `/api/v3/repos/${repo.fullName}/commits`, req.query, req.host);
  return { status: 200, body: items, headers };
}

// ---------------------------------------------------------------- contents

/** Resolve a ref query (branch name or sha) to a commit sha. */
function resolveRef(repo: Repo, ref: string | null): string | undefined {
  if (ref === null || ref === '') return repo.branchTip(repo.defaultBranch);
  return repo.branchTip(ref) ?? (repo.objects.has(ref) ? ref : undefined);
}

function contentsGet(repo: Repo, req: RestRequest, path: string): RestReply {
  const tip = resolveRef(repo, req.query.get('ref'));
  if (tip === undefined) return notFound();
  const flat = commitFiles(repo.objects, tip);
  const file = flat.get(path);
  if (file !== undefined) {
    const blob = repo.objects.get(file.sha);
    const data = blob?.data ?? Buffer.alloc(0);
    return {
      status: 200,
      body: {
        type: 'file',
        encoding: 'base64',
        content: data.toString('base64'),
        name: path.split('/').pop(),
        path,
        sha: file.sha,
        size: data.length,
        url: `/api/v3/repos/${repo.fullName}/contents/${path}`,
        html_url: `https://github.com/${repo.fullName}/blob/${repo.defaultBranch}/${path}`,
        download_url: '',
      },
    };
  }
  // A directory: list its immediate children from the tip's tree.
  const commit = repo.objects.get(tip);
  if (commit === undefined || commit.type !== 'commit') return notFound();
  let treeSha = parseCommit(commit.data).tree;
  if (path !== '') {
    for (const segment of path.split('/')) {
      const tree = repo.objects.get(treeSha);
      if (tree === undefined || tree.type !== 'tree') return notFound();
      const entry = parseTree(tree.data).find((candidate) => candidate.name === segment && candidate.mode === '40000');
      if (entry === undefined) return notFound();
      treeSha = entry.sha;
    }
  }
  const tree = repo.objects.get(treeSha);
  if (tree === undefined || tree.type !== 'tree') return notFound();
  const entries = parseTree(tree.data).map((entry) => {
    const childPath = path === '' ? entry.name : `${path}/${entry.name}`;
    const isDir = entry.mode === '40000';
    let size = 0;
    if (!isDir) size = repo.objects.get(entry.sha)?.data.length ?? 0;
    return {
      type: isDir ? 'dir' : 'file',
      name: entry.name,
      path: childPath,
      sha: entry.sha,
      size,
      url: `/api/v3/repos/${repo.fullName}/contents/${childPath}`,
      html_url: '',
      download_url: '',
    };
  });
  entries.sort((a, b) => a.name.localeCompare(b.name));
  return { status: 200, body: entries };
}

function contentsPut(repo: Repo, req: RestRequest, path: string): RestReply {
  const body = req.body ?? {};
  const message = typeof body.message === 'string' ? body.message : '';
  const contentB64 = typeof body.content === 'string' ? body.content : null;
  if (message === '' || contentB64 === null) return invalid('Validation Failed: message and content are required.');
  const branch = typeof body.branch === 'string' && body.branch !== '' ? body.branch : repo.defaultBranch;
  const tip = repo.branchTip(branch);
  const repoEmpty = repo.refs.size === 0;
  if (tip === undefined && !(repoEmpty && branch === repo.defaultBranch)) {
    return invalid(`Validation Failed: branch ${branch} does not exist.`);
  }
  const flat = tip === undefined ? new Map() : commitFiles(repo.objects, tip);
  const existing = flat.get(path);
  const shaGiven = typeof body.sha === 'string' ? body.sha : undefined;
  if (existing !== undefined) {
    if (shaGiven === undefined) return invalid('Validation Failed: sha was not supplied.');
    if (shaGiven !== existing.sha) return { status: 409, body: { message: 'Conflict: the sha does not match the current content.' } };
  } else if (shaGiven !== undefined) {
    return invalid('Validation Failed: the file does not exist.');
  }
  const bytes = Buffer.from(contentB64.replace(/\s+/g, ''), 'base64');
  const commitSha = commitFileChanges(repo, branch, new Map([[path, bytes]]), message, { create: tip === undefined });
  if (commitSha === null) return invalid('Validation Failed: could not commit.');
  const blobSha = repo.objects.put('blob', bytes);
  repo.updatedAt = new Date().toISOString();
  return {
    status: existing !== undefined ? 200 : 201,
    body: {
      content: {
        type: 'file',
        encoding: 'base64',
        name: path.split('/').pop(),
        path,
        sha: blobSha,
        size: bytes.length,
        url: `/api/v3/repos/${repo.fullName}/contents/${path}`,
        html_url: '',
        download_url: '',
      },
      commit: commitJson(repo, commitSha)?.commit !== undefined
        ? { sha: commitSha, ...(commitJson(repo, commitSha) as Record<string, unknown>).commit as object, url: `/api/v3/repos/${repo.fullName}/commits/${commitSha}`, html_url: '' }
        : { sha: commitSha },
    },
  };
}

function contentsDelete(repo: Repo, req: RestRequest, path: string): RestReply {
  const body = req.body ?? {};
  const message = typeof body.message === 'string' ? body.message : '';
  const shaGiven = typeof body.sha === 'string' ? body.sha : undefined;
  if (message === '' || shaGiven === undefined) return invalid('Validation Failed: message and sha are required.');
  const branch = typeof body.branch === 'string' && body.branch !== '' ? body.branch : repo.defaultBranch;
  const tip = repo.branchTip(branch);
  if (tip === undefined) return notFound();
  const flat = commitFiles(repo.objects, tip);
  const existing = flat.get(path);
  if (existing === undefined) return notFound();
  if (existing.sha !== shaGiven) return { status: 409, body: { message: 'Conflict: the sha does not match the current content.' } };
  const commitSha = commitFileChanges(repo, branch, new Map([[path, null]]), message);
  if (commitSha === null) return invalid('Validation Failed: could not commit.');
  return { status: 200, body: { content: null, commit: { sha: commitSha, url: `/api/v3/repos/${repo.fullName}/commits/${commitSha}` } } };
}

// ---------------------------------------------------------------- issues

function createIssue(repo: Repo, req: RestRequest): RestReply {
  const body = req.body ?? {};
  const title = typeof body.title === 'string' ? body.title : '';
  if (title === '') return invalid('Validation Failed: title is required.');
  const labelsIn = Array.isArray(body.labels) ? body.labels : [];
  const labelNames: string[] = [];
  for (const entry of labelsIn) {
    const name = typeof entry === 'string' ? entry : (entry as { name?: unknown })?.name;
    if (typeof name !== 'string') return invalid('Validation Failed: bad label.');
    if (!repo.labels.has(name)) {
      return {
        status: 422,
        body: { message: 'Validation Failed: label does not exist.', errors: [{ resource: 'Issue', code: 'custom', field: 'labels', message: `label ${name} does not exist` }] },
      };
    }
    labelNames.push(name);
  }
  const now = new Date().toISOString();
  const issue: Issue = {
    number: repo.nextNumber,
    title,
    body: typeof body.body === 'string' ? body.body : null,
    state: 'open',
    labels: labelNames,
    userLogin: VIEWER.login,
    createdAt: now,
    updatedAt: now,
    comments: [],
    isPull: false,
  };
  repo.nextNumber += 1;
  repo.issues.set(issue.number, issue);
  return { status: 201, body: issueJson(repo, issue) };
}

function listIssues(repo: Repo, req: RestRequest): RestReply {
  const state = req.query.get('state') ?? 'open';
  const direction = req.query.get('direction') ?? 'desc';
  let issues = [...repo.issues.values()];
  if (state === 'open') issues = issues.filter((issue) => issue.state === 'open');
  else if (state === 'closed') issues = issues.filter((issue) => issue.state === 'closed');
  issues.sort((a, b) => (direction === 'asc' ? a.number - b.number : b.number - a.number));
  const all = issues.map((issue) => issueJson(repo, issue));
  const { items, headers } = paginate(all, pageOf(req.query), `/api/v3/repos/${repo.fullName}/issues`, req.query, req.host);
  return { status: 200, body: items, headers };
}

function issueRoot(repo: Repo, req: RestRequest, number: number): RestReply {
  const issue = repo.issues.get(number);
  if (issue === undefined) return notFound();
  if (req.method === 'GET') return { status: 200, body: issueJson(repo, issue) };
  if (req.method === 'PATCH') {
    const body = req.body ?? {};
    if (typeof body.title === 'string') issue.title = body.title;
    if (typeof body.body === 'string') issue.body = body.body;
    if (body.state === 'open' || body.state === 'closed') issue.state = body.state;
    if (Array.isArray(body.labels)) {
      const names: string[] = [];
      for (const entry of body.labels) {
        const name = typeof entry === 'string' ? entry : (entry as { name?: unknown })?.name;
        if (typeof name === 'string') {
          if (!repo.labels.has(name)) return invalid(`Validation Failed: label ${name} does not exist.`);
          names.push(name);
        }
      }
      issue.labels = names;
    }
    issue.updatedAt = new Date().toISOString();
    return { status: 200, body: issueJson(repo, issue) };
  }
  return notFound();
}

function issueComments(repo: Repo, req: RestRequest, number: number): RestReply {
  const issue = repo.issues.get(number);
  if (issue === undefined) return notFound();
  if (req.method === 'GET') {
    const all = issue.comments.map((comment) => ({
      id: comment.id,
      body: comment.body,
      user: userJson(),
      created_at: comment.createdAt,
      updated_at: comment.updatedAt,
      url: `/api/v3/repos/${repo.fullName}/issues/comments/${comment.id}`,
      html_url: `https://github.com/${repo.fullName}/issues/${number}#issuecomment-${comment.id}`,
    }));
    const { items, headers } = paginate(all, pageOf(req.query), `/api/v3/repos/${repo.fullName}/issues/${number}/comments`, req.query, req.host);
    return { status: 200, body: items, headers };
  }
  if (req.method === 'POST') {
    const body = req.body ?? {};
    if (typeof body.body !== 'string' || body.body === '') return invalid('Validation Failed: body is required.');
    const now = new Date().toISOString();
    const comment = { id: repo.nextCommentId, body: body.body, userLogin: VIEWER.login, createdAt: now, updatedAt: now };
    repo.nextCommentId += 1;
    issue.comments.push(comment);
    return {
      status: 201,
      body: {
        id: comment.id,
        body: comment.body,
        user: userJson(),
        created_at: now,
        updated_at: now,
        url: `/api/v3/repos/${repo.fullName}/issues/comments/${comment.id}`,
        html_url: `https://github.com/${repo.fullName}/issues/${number}#issuecomment-${comment.id}`,
      },
    };
  }
  return notFound();
}

// ---------------------------------------------------------------- pulls

function createPull(repo: Repo, req: RestRequest): RestReply {
  const body = req.body ?? {};
  const title = typeof body.title === 'string' ? body.title : '';
  const head = typeof body.head === 'string' ? body.head.replace(/^[^:]+:/, '') : '';
  const base = typeof body.base === 'string' ? body.base : '';
  if (title === '') return invalid('Validation Failed: title is required.');
  const headTip = repo.branchTip(head);
  if (headTip === undefined) return invalid(`Validation Failed: head branch ${head} does not exist.`);
  if (repo.branchTip(base) === undefined) return invalid(`Validation Failed: base branch ${base} does not exist.`);
  if (head === base) return invalid('Validation Failed: head and base are the same.');
  for (const pull of repo.pulls.values()) {
    if (pull.state === 'open' && pull.headRef === head && pull.baseRef === base) {
      return invalid('Validation Failed: a pull request already exists for this head and base.');
    }
  }
  const now = new Date().toISOString();
  const pull: Pull = {
    number: repo.nextNumber,
    title,
    body: typeof body.body === 'string' ? body.body : null,
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
  return { status: 201, body: pullJson(repo, pull) };
}

function listPulls(repo: Repo, req: RestRequest): RestReply {
  const state = req.query.get('state') ?? 'open';
  const direction = req.query.get('direction') ?? 'desc';
  let pulls = [...repo.pulls.values()];
  if (state === 'open') pulls = pulls.filter((pull) => pull.state === 'open');
  else if (state === 'closed') pulls = pulls.filter((pull) => pull.state === 'closed');
  pulls.sort((a, b) => (direction === 'asc' ? a.number - b.number : b.number - a.number));
  const all = pulls.map((pull) => pullJson(repo, pull));
  const { items, headers } = paginate(all, pageOf(req.query), `/api/v3/repos/${repo.fullName}/pulls`, req.query, req.host);
  return { status: 200, body: items, headers };
}

function pullFiles(repo: Repo, pull: Pull): RestReply {
  const headTip = repo.branchTip(pull.headRef) ?? pull.headSha;
  const baseTip = repo.branchTip(pull.baseRef);
  if (baseTip === undefined) return { status: 200, body: [] };
  const base = mergeBase(repo.objects, baseTip, headTip) ?? baseTip;
  const before = commitFiles(repo.objects, base);
  const after = commitFiles(repo.objects, headTip);
  const paths = new Set([...before.keys(), ...after.keys()]);
  const files: Record<string, unknown>[] = [];
  for (const path of [...paths].sort()) {
    const atBase = before.get(path);
    const atHead = after.get(path);
    if (atBase?.sha === atHead?.sha) continue;
    const beforeBlob = atBase !== undefined ? repo.objects.get(atBase.sha)?.data ?? null : null;
    const afterBlob = atHead !== undefined ? repo.objects.get(atHead.sha)?.data ?? null : null;
    const counts = lineDiffCounts(beforeBlob, afterBlob);
    files.push({
      filename: path,
      status: atBase === undefined ? 'added' : atHead === undefined ? 'removed' : 'modified',
      additions: counts.additions,
      deletions: counts.deletions,
      changes: counts.additions + counts.deletions,
      sha: atHead?.sha ?? atBase?.sha ?? '',
    });
  }
  return { status: 200, body: files };
}

function mergePull(repo: Repo, pull: Pull, req: RestRequest): RestReply {
  if (pull.state !== 'open') return { status: 405, body: { message: 'Pull Request is not mergeable' } };
  const headTip = repo.branchTip(pull.headRef) ?? pull.headSha;
  const baseTip = repo.branchTip(pull.baseRef);
  if (baseTip === undefined) return { status: 405, body: { message: 'Pull Request is not mergeable' } };
  const outcome = mergeTrees(repo.objects, baseTip, headTip);
  if (!outcome.ok || outcome.tree === undefined) {
    return { status: 405, body: { message: 'Pull Request is not mergeable' } };
  }
  const body = req.body ?? {};
  const method = typeof body.merge_method === 'string' ? body.merge_method : 'squash';
  const when = Math.floor(Date.now() / 1000);
  const identity = `${VIEWER.name} <${VIEWER.email}> ${when} +0000`;
  const title = typeof body.commit_title === 'string' && body.commit_title !== ''
    ? body.commit_title
    : method === 'merge'
      ? `Merge pull request #${pull.number} from ${repo.owner}/${pull.headRef}`
      : `${pull.title} (#${pull.number})`;
  const message = typeof body.commit_message === 'string' && body.commit_message !== ''
    ? `${title}\n\n${body.commit_message}`
    : method === 'squash' && pull.body
      ? `${title}\n\n${pull.body}`
      : title;
  const parents = method === 'merge' ? [baseTip, headTip] : [baseTip];
  const sha = repo.objects.put('commit', buildCommit({ tree: outcome.tree, parents, author: identity, committer: identity, message }));
  repo.refs.set(`refs/heads/${pull.baseRef}`, sha);
  pull.state = 'closed';
  pull.merged = true;
  pull.mergedAt = new Date().toISOString();
  pull.mergeCommitSha = sha;
  pull.updatedAt = pull.mergedAt;
  return { status: 200, body: { sha, merged: true, message: 'Pull Request successfully merged' } };
}

// ---------------------------------------------------------------- router

/** Handle one /api/v3 request. Auth and body parsing happen in app.ts. */
export function handleRest(forge: Forge, req: RestRequest): RestReply {
  const seg = req.segments;
  if (seg.length === 0) {
    if (req.method === 'GET') {
      return {
        status: 200,
        headers: { 'x-oauth-scopes': 'repo, read:org' },
        body: {
          current_user_url: '/api/v3/user',
          repository_url: '/api/v3/repos/{owner}/{repo}',
          rate_limit_url: '/api/v3/rate_limit',
          emojis_url: '/api/v3/emojis',
          meta_url: '/api/v3/meta',
        },
      };
    }
    return notFound();
  }
  if (seg[0] === 'meta' && seg.length === 1 && req.method === 'GET') {
    return {
      status: 200,
      body: {
        installed_version: '1.0.0-ada-forge',
        verifiable_password_authentication: false,
        ssh_key_fingerprints: {},
        hooks: [],
        web: [],
        api: [],
        git: [],
        packages: [],
        pages: [],
        importer: [],
        actions: [],
        dependabot: [],
      },
    };
  }
  if (seg[0] === 'user' && seg.length === 1 && req.method === 'GET') {
    return { status: 200, body: { ...userJson(), name: VIEWER.name, email: VIEWER.email, company: null, blog: '', location: null, hireable: null, bio: null, public_repos: forge.listRepos().length, followers: 0, following: 0, created_at: '2025-01-01T00:00:00Z', updated_at: forge.nowIso() } };
  }
  if (seg[0] === 'user' && seg[1] === 'repos' && seg.length === 2) {
    if (req.method === 'GET') return listUserRepos(forge, req);
    if (req.method === 'POST') return createRepo(forge, req);
    return notFound();
  }
  if (seg[0] !== 'repos' || seg.length < 3) return notFound();
  const owner = seg[1];
  const name = seg[2];
  const rest = seg.slice(3);
  if (rest.length === 0) return repoRoot(forge, req, owner, name);
  const repo = forge.getRepo(owner, name);
  if (repo === undefined) return notFound();

  if (rest[0] === 'branches' && rest.length === 1 && req.method === 'GET') return listBranches(repo);
  if (rest[0] === 'branches' && rest.length >= 2 && req.method === 'GET') {
    const branch = rest.slice(1).join('/');
    const tip = repo.branchTip(branch);
    if (tip === undefined) return notFound();
    return { status: 200, body: { name: branch, commit: { sha: tip, url: `/api/v3/repos/${repo.fullName}/commits/${tip}` }, protected: false } };
  }
  if (rest[0] === 'commits' && rest.length === 1 && req.method === 'GET') return listCommits(repo, req);
  if (rest[0] === 'commits' && rest.length === 2 && req.method === 'GET') {
    const found = commitJson(repo, rest[1]);
    return found === null ? notFound() : { status: 200, body: found };
  }
  if (rest[0] === 'contents') {
    const path = rest.slice(1).join('/');
    if (req.method === 'GET') return contentsGet(repo, req, path);
    if (req.method === 'PUT') return contentsPut(repo, req, path);
    if (req.method === 'DELETE') return contentsDelete(repo, req, path);
    return notFound();
  }
  if (rest[0] === 'labels') {
    if (rest.length === 1 && req.method === 'GET') {
      const all = [...repo.labels.values()].sort((a, b) => a.name.localeCompare(b.name)).map(labelJson);
      const { items, headers } = paginate(all, pageOf(req.query), `/api/v3/repos/${repo.fullName}/labels`, req.query, req.host);
      return { status: 200, body: items, headers };
    }
    if (rest.length === 1 && req.method === 'POST') {
      const body = req.body ?? {};
      const labelName = typeof body.name === 'string' ? body.name : '';
      if (labelName === '') return invalid('Validation Failed: name is required.');
      if (repo.labels.has(labelName)) return invalid('Validation Failed: label already exists.');
      const label: Label = {
        name: labelName,
        color: typeof body.color === 'string' ? body.color.replace(/^#/, '') : 'ededed',
        description: typeof body.description === 'string' ? body.description : null,
      };
      repo.labels.set(labelName, label);
      return { status: 201, body: labelJson(label) };
    }
    if (rest.length === 2 && req.method === 'GET') {
      const label = repo.labels.get(decodeURIComponent(rest[1]));
      return label === undefined ? notFound() : { status: 200, body: labelJson(label) };
    }
    return notFound();
  }
  if (rest[0] === 'issues') {
    if (rest.length === 1 && req.method === 'GET') return listIssues(repo, req);
    if (rest.length === 1 && req.method === 'POST') return createIssue(repo, req);
    const number = Number.parseInt(rest[1] ?? '', 10);
    if (Number.isNaN(number)) return notFound();
    if (rest.length === 2) return issueRoot(repo, req, number);
    if (rest.length === 3 && rest[2] === 'comments') return issueComments(repo, req, number);
    return notFound();
  }
  if (rest[0] === 'pulls') {
    if (rest.length === 1 && req.method === 'GET') return listPulls(repo, req);
    if (rest.length === 1 && req.method === 'POST') return createPull(repo, req);
    const number = Number.parseInt(rest[1] ?? '', 10);
    if (Number.isNaN(number)) return notFound();
    const pull = repo.pulls.get(number);
    if (rest.length === 3 && rest[2] === 'merge' && req.method === 'PUT') {
      if (pull === undefined) return notFound();
      return mergePull(repo, pull, req);
    }
    if (pull === undefined) return notFound();
    if (rest.length === 2 && req.method === 'GET') return { status: 200, body: pullJson(repo, pull) };
    if (rest.length === 2 && req.method === 'PATCH') {
      const body = req.body ?? {};
      if (typeof body.title === 'string') pull.title = body.title;
      if (typeof body.body === 'string') pull.body = body.body;
      if (body.state === 'open' || body.state === 'closed') pull.state = body.state;
      pull.updatedAt = new Date().toISOString();
      return { status: 200, body: pullJson(repo, pull) };
    }
    if (rest.length === 3 && rest[2] === 'files' && req.method === 'GET') return pullFiles(repo, pull);
    return notFound();
  }
  if (rest[0] === 'git' && rest[1] === 'refs' && rest.length === 2 && req.method === 'POST') {
    const body = req.body ?? {};
    const ref = typeof body.ref === 'string' ? body.ref : '';
    const sha = typeof body.sha === 'string' ? body.sha : '';
    if (!ref.startsWith('refs/') || repo.objects.get(sha)?.type !== 'commit') {
      return invalid('Validation Failed: ref or sha is invalid.');
    }
    if (repo.refs.has(ref)) return invalid('Validation Failed: reference already exists.');
    repo.refs.set(ref, sha);
    return { status: 201, body: { ref, object: { sha, type: 'commit', url: `/api/v3/repos/${repo.fullName}/git/commits/${sha}` }, url: `/api/v3/repos/${repo.fullName}/git/refs/${ref}` } };
  }
  if (rest[0] === 'git' && rest[1] === 'ref' && rest.length >= 3 && req.method === 'GET') {
    const ref = rest.slice(2).join('/');
    const sha = repo.refs.get(ref);
    if (sha === undefined) return notFound();
    return { status: 200, body: { ref, object: { sha, type: repo.objects.get(sha)?.type ?? 'commit', url: '' }, url: '' } };
  }
  if (rest[0] === 'git' && rest[1] === 'refs' && rest.length >= 3 && req.method === 'GET') {
    // The plural form names the whole ref after /git/refs/: refs/heads/main.
    const ref = `refs/${rest.slice(2).join('/')}`;
    const sha = repo.refs.get(ref);
    if (sha === undefined) return notFound();
    return { status: 200, body: { ref, object: { sha, type: repo.objects.get(sha)?.type ?? 'commit', url: '' }, url: '' } };
  }
  if (rest[0] === 'git' && rest[1] === 'refs' && rest.length === 2 && req.method === 'GET') {
    const all = [...repo.refs.entries()].map(([ref, sha]) => ({
      ref,
      object: { sha, type: repo.objects.get(sha)?.type ?? 'commit', url: '' },
      url: '',
    }));
    return { status: 200, body: all };
  }
  return notFound();
}

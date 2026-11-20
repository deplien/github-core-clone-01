// The forge's HTTP server: one process serving git smart HTTP,
// REST v3, GraphQL v4 and MCP over a single shared store. This file is
// the wiring — routing, the bearer-token check, body reading and the
// headers every reply carries — while the surfaces themselves live in
// git-http.ts, rest.ts, graphql.ts and mcp.ts.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { Forge } from './store.ts';
import { handleRest, type RestReply } from './rest.ts';
import { handleGraphQL } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import { infoRefs, receivePack, uploadPack } from './git-http.ts';

const JSON_TYPE = 'application/json; charset=utf-8';
const MAX_BODY_BYTES = 128 * 1024 * 1024;

function sendBuffer(res: ServerResponse, status: number, contentType: string, body: Buffer, headers: Record<string, string> = {}): void {
  res.writeHead(status, { 'content-type': contentType, 'content-length': body.length, ...headers });
  res.end(body);
}

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const text = body === null || body === undefined ? '' : JSON.stringify(body);
  sendBuffer(res, status, JSON_TYPE, Buffer.from(text, 'utf8'), headers);
}

/** Read a whole request body (bounded; an over-limit body is truncated and the handler fails on it). */
function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total <= MAX_BODY_BYTES) chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/** Build the forge's HTTP server. It binds nothing until the caller listens. */
export function createForgeServer(): Server {
  const forge = new Forge();
  const token = process.env.MAKEFUN_SHOP_TOKEN ?? '';

  const authorized = (req: IncomingMessage): boolean => {
    if (token === '') return true;
    return (req.headers.authorization ?? '') === `Bearer ${token}`;
  };

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const requestId = randomUUID();
    const url = new URL(req.url ?? '/', 'http://forge');
    const path = url.pathname;
    const method = req.method ?? 'GET';
    const body = await readBody(req);

    // The env's boot probe: no token, always available.
    if (method === 'GET' && path === '/healthz') {
      sendJson(res, 200, { ok: true });
      return;
    }

    const apiHeaders = { 'x-github-request-id': requestId };

    // ------------------------------------------------------------ REST v3
    if (path === '/api/v3' || path === '/api/v3/' || path.startsWith('/api/v3/')) {
      if (!authorized(req)) {
        sendJson(res, 401, { message: 'Bad credentials' }, apiHeaders);
        return;
      }
      let parsedBody: Record<string, unknown> | undefined;
      if (body.length > 0) {
        try {
          const parsed: unknown = JSON.parse(body.toString('utf8'));
          if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
            parsedBody = parsed as Record<string, unknown>;
          }
        } catch {
          sendJson(res, 400, { message: 'Problems parsing JSON' }, apiHeaders);
          return;
        }
      }
      const segments = path
        .slice('/api/v3'.length)
        .split('/')
        .filter((segment) => segment !== '')
        .map(decodeSegment);
      const reply: RestReply = handleRest(forge, {
        method,
        segments,
        query: url.searchParams,
        body: parsedBody,
        host: req.headers.host ?? 'localhost',
      });
      sendJson(res, reply.status, reply.body, { ...apiHeaders, ...(reply.headers ?? {}) });
      return;
    }

    // ------------------------------------------------------------ GraphQL v4
    if (path === '/api/graphql') {
      if (!authorized(req)) {
        sendJson(res, 401, { message: 'Bad credentials' }, apiHeaders);
        return;
      }
      if (method !== 'POST') {
        sendJson(res, 404, { message: 'Not Found' }, apiHeaders);
        return;
      }
      let payload: unknown;
      try {
        payload = JSON.parse(body.toString('utf8'));
      } catch {
        sendJson(res, 400, { errors: [{ message: 'invalid JSON in request body' }] }, apiHeaders);
        return;
      }
      const reply = handleGraphQL(forge, payload);
      sendJson(res, reply.status, reply.body, apiHeaders);
      return;
    }

    // ------------------------------------------------------------ MCP
    if (path === '/mcp') {
      if (!authorized(req)) {
        sendJson(res, 401, { message: 'Bad credentials' }, apiHeaders);
        return;
      }
      if (method !== 'POST') {
        sendBuffer(res, 405, JSON_TYPE, Buffer.from(JSON.stringify({ message: 'Method Not Allowed' }), 'utf8'), apiHeaders);
        return;
      }
      const reply = handleMcp(forge, body.toString('utf8'));
      if (reply.body === null) {
        res.writeHead(reply.status, { 'content-length': 0 });
        res.end();
        return;
      }
      sendJson(res, reply.status, reply.body, apiHeaders);
      return;
    }

    // ------------------------------------------------------------ git smart HTTP
    const gitMatch = /^\/([^/]+)\/([^/]+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/.exec(path);
    if (gitMatch !== null) {
      if (!authorized(req)) {
        sendJson(res, 401, { message: 'Bad credentials' }, apiHeaders);
        return;
      }
      const owner = decodeSegment(gitMatch[1]);
      const repoName = decodeSegment(gitMatch[2]);
      const repo = forge.getRepo(owner, repoName);
      const tail = gitMatch[3];
      if (tail === 'info/refs' && method === 'GET') {
        const reply = infoRefs(repo, url.searchParams.get('service') ?? '', req.headers['git-protocol'] ?? null);
        sendBuffer(res, reply.status, reply.contentType, reply.body);
        return;
      }
      if (tail === 'git-upload-pack' && method === 'POST') {
        const reply = uploadPack(repo, body, req.headers['git-protocol'] ?? null);
        sendBuffer(res, reply.status, reply.contentType, reply.body);
        return;
      }
      if (tail === 'git-receive-pack' && method === 'POST') {
        const reply = receivePack(repo, body);
        sendBuffer(res, reply.status, reply.contentType, reply.body);
        return;
      }
      sendJson(res, 404, { message: 'Not Found' }, apiHeaders);
      return;
    }

    // ------------------------------------------------------------ anything else
    sendJson(res, 404, { message: 'Not Found' }, apiHeaders);
  };

  const server = createServer((req, res) => {
    handle(req, res).catch((err: unknown) => {
      process.stderr.write(`[forge] request failed: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
      if (!res.headersSent) sendJson(res, 500, { message: 'Internal error' });
      else res.end();
    });
  });
  // A malformed request line or an aborted client must never take the
  // forge down: drop that one socket and keep serving everyone else.
  server.on('clientError', (_err, socket) => {
    socket.destroy();
  });
  return server;
}

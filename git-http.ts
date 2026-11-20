// Git smart HTTP: the info/refs advertisements and the upload-pack /
// receive-pack POSTs, for protocol v2 and v0 upload-pack and v0
// receive-pack. The suite's client speaks exactly these shapes; the
// replies below mirror what a real git server sends, trimmed to the
// capabilities this forge supports.

import {
  PKT_DELIM,
  PKT_FLUSH,
  ZERO_OID,
  decodePackets,
  isAncestor,
  pktLine,
  selectFetchObjects,
  unpackPack,
  writePack,
  type Packet,
} from './git.ts';
import { parseCommit, type Repo } from './store.ts';

export interface WireReply {
  status: number;
  contentType: string;
  body: Buffer;
}

const AGENT = 'ada-forge/1.0';
const UPLOAD_CAPS_V0 = [
  'multi_ack_detailed',
  'side-band-64k',
  'ofs-delta',
  'shallow',
  'no-progress',
  `agent=${AGENT}`,
];
const RECEIVE_CAPS = ['report-status', 'side-band-64k', 'delete-refs', 'ofs-delta', `agent=${AGENT}`];

function jsonReply(status: number, message: string): WireReply {
  return { status, contentType: 'application/json; charset=utf-8', body: Buffer.from(`${JSON.stringify({ message })}\n`, 'utf8') };
}

/** The refs a server advertises: HEAD first, then every ref in name order, with peeled tags. */
function advertisedRefs(repo: Repo): Array<{ name: string; sha: string; peeled?: string }> {
  const out: Array<{ name: string; sha: string; peeled?: string }> = [];
  const headTarget = repo.headRef();
  const headSha = repo.refs.get(headTarget);
  if (headSha !== undefined) out.push({ name: 'HEAD', sha: headSha });
  const names = [...repo.refs.keys()].sort();
  for (const name of names) {
    const sha = repo.refs.get(name) as string;
    const entry: { name: string; sha: string; peeled?: string } = { name, sha };
    const obj = repo.objects.get(sha);
    if (obj !== undefined && obj.type === 'tag') {
      // Peel an annotated tag to the commit it names (one level is what git advertises).
      const match = /^object ([0-9a-f]{40})$/m.exec(obj.data.toString('utf8'));
      if (match) entry.peeled = match[1];
    }
    out.push(entry);
  }
  return out;
}

/** GET info/refs for either service. */
export function infoRefs(repo: Repo | undefined, service: string, protocolVersion: string | null): WireReply {
  if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
    return jsonReply(400, 'Unknown service');
  }
  if (repo === undefined) return jsonReply(404, 'Not Found');
  const contentType = `application/x-${service}-advertisement`;

  if (service === 'git-upload-pack' && protocolVersion !== null && protocolVersion.includes('version=2')) {
    const lines = [
      'version 2\n',
      `agent=${AGENT}\n`,
      'ls-refs=unborn\n',
      'fetch=shallow wait-for-done filter\n',
      'server-option\n',
      'object-format=sha1\n',
    ];
    const body = Buffer.concat([...lines.map((line) => pktLine(line)), PKT_FLUSH]);
    return { status: 200, contentType, body };
  }

  const preamble = pktLine(`# service=${service}\n`);
  const refs = advertisedRefs(repo);
  const headTarget = repo.headRef();
  const caps = service === 'git-upload-pack'
    ? [...UPLOAD_CAPS_V0, `symref=HEAD:${headTarget}`]
    : RECEIVE_CAPS;
  const refLines: Buffer[] = [];
  if (refs.length === 0) {
    refLines.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps.join(' ')}\n`));
  } else {
    refs.forEach((ref, index) => {
      const suffix = index === 0 ? `\0${caps.join(' ')}` : '';
      refLines.push(pktLine(`${ref.sha} ${ref.name}${suffix}\n`));
      if (ref.peeled !== undefined) refLines.push(pktLine(`${ref.peeled} ${ref.name}^{}\n`));
    });
  }
  const body = Buffer.concat([preamble, PKT_FLUSH, ...refLines, PKT_FLUSH]);
  return { status: 200, contentType, body };
}

// ---------------------------------------------------------------- upload-pack

interface LsRefsArgs {
  peel: boolean;
  symrefs: boolean;
  unborn: boolean;
  prefixes: string[];
}

function lsRefs(repo: Repo, args: LsRefsArgs): Buffer {
  const lines: string[] = [];
  const keep = (name: string): boolean =>
    args.prefixes.length === 0 || args.prefixes.some((prefix) => name.startsWith(prefix));
  const headTarget = repo.headRef();
  const headSha = repo.refs.get(headTarget);
  if (keep('HEAD')) {
    if (headSha !== undefined) {
      lines.push(`${headSha} HEAD${args.symrefs ? ` symref-target:${headTarget}` : ''}\n`);
    } else if (args.unborn) {
      lines.push(`unborn HEAD${args.symrefs ? ` symref-target:${headTarget}` : ''}\n`);
    }
  }
  for (const ref of advertisedRefs(repo)) {
    if (ref.name === 'HEAD' || !keep(ref.name)) continue;
    const peeled = args.peel && ref.peeled !== undefined ? ` peeled:${ref.peeled}` : '';
    lines.push(`${ref.sha} ${ref.name}${peeled}\n`);
  }
  return Buffer.concat([...lines.map((line) => pktLine(line)), PKT_FLUSH]);
}

interface FetchArgs {
  wants: string[];
  haves: string[];
  shallow: string[];
  deepen: number | null;
  deepenSince: number | null;
  deepenNot: string[];
  done: boolean;
  filter: string | null;
}

/** Split pack bytes into sideband band-1 pkt-lines. A pkt-line's length
 *  field covers its own 4 bytes plus the band byte, so a data slice of
 *  65515 keeps the whole line at the 65520 protocol maximum. */
function sidebandChunks(pack: Buffer): Buffer[] {
  const chunks: Buffer[] = [];
  const MAX = 65515;
  for (let at = 0; at < pack.length; at += MAX) {
    const slice = pack.subarray(at, Math.min(at + MAX, pack.length));
    chunks.push(pktLine(Buffer.concat([Buffer.from([1]), slice])));
  }
  if (chunks.length === 0) chunks.push(pktLine(Buffer.concat([Buffer.from([1]), Buffer.alloc(0)])));
  return chunks;
}

/** Apply a partial-clone filter to a chosen object list. */
function applyFilter(repo: Repo, objects: string[], filter: string | null): string[] {
  if (filter === null) return objects;
  if (filter === 'blob:none') {
    return objects.filter((sha) => repo.objects.get(sha)?.type !== 'blob');
  }
  const limit = /^blob:limit=(\d+)([kmg])?$/i.exec(filter);
  if (limit) {
    let max = Number.parseInt(limit[1], 10);
    const unit = (limit[2] ?? '').toLowerCase();
    if (unit === 'k') max *= 1024;
    if (unit === 'm') max *= 1024 * 1024;
    if (unit === 'g') max *= 1024 * 1024 * 1024;
    return objects.filter((sha) => {
      const obj = repo.objects.get(sha);
      return obj === undefined || obj.type !== 'blob' || obj.data.length <= max;
    });
  }
  return objects;
}

function buildFetchPack(repo: Repo, args: FetchArgs): { pack: Buffer; shallow: string[]; unshallow: string[] } {
  let wants = args.wants;
  // deepen-not names refs whose history is excluded: treat their tips as haves.
  const haves = [...args.haves];
  for (const ref of args.deepenNot) {
    const tip = repo.refs.get(ref) ?? repo.refs.get(`refs/heads/${ref}`);
    if (tip !== undefined) haves.push(tip);
  }
  // A want may name a ref's object the store holds under a tag: serve as-is.
  wants = wants.filter((sha) => repo.objects.has(sha));
  let depth = args.deepen;
  if (args.deepenSince !== null) {
    // Approximate deepen-since with a generous fixed depth; the boundary
    // is then cut by commit time below.
    depth = depth ?? 100000;
  }
  const selection = selectFetchObjects(repo.objects, wants, haves, depth, args.shallow);
  let objects = selection.objects;
  if (args.deepenSince !== null) {
    const cutoff = args.deepenSince;
    objects = objects.filter((sha) => {
      const obj = repo.objects.get(sha);
      if (obj === undefined || obj.type !== 'commit') return true;
      const parsed = parseCommit(obj.data);
      const match = / (\d+) [+-]\d{4}$/.exec(parsed.committer);
      return match === null || Number.parseInt(match[1], 10) >= cutoff;
    });
  }
  objects = applyFilter(repo, objects, args.filter);
  return { pack: writePack(repo.objects, objects), shallow: selection.shallow, unshallow: selection.unshallow };
}

function fetchV2(repo: Repo, args: FetchArgs): Buffer {
  const parts: Buffer[] = [];
  if (!args.done) {
    const acks: string[] = ['acknowledgments\n'];
    const common = args.haves.filter((have) => repo.objects.has(have));
    if (common.length === 0) acks.push('NAK\n');
    else for (const have of common) acks.push(`ACK ${have}\n`);
    acks.push('ready\n');
    parts.push(...acks.map((line) => pktLine(line)), PKT_DELIM);
    return Buffer.concat(parts);
  }
  const { pack, shallow, unshallow } = buildFetchPack(repo, args);
  if (args.deepen !== null || args.shallow.length > 0) {
    parts.push(pktLine('shallow-info\n'));
    for (const sha of shallow) parts.push(pktLine(`shallow ${sha}\n`));
    for (const sha of unshallow) parts.push(pktLine(`unshallow ${sha}\n`));
    for (const sha of args.shallow) {
      if (!shallow.includes(sha) && !unshallow.includes(sha) && repo.objects.has(sha)) parts.push(pktLine(`shallow ${sha}\n`));
    }
    parts.push(PKT_DELIM);
  }
  parts.push(pktLine('packfile\n'));
  parts.push(...sidebandChunks(pack));
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

function fetchV0(repo: Repo, wants: string[], haves: string[], shallowIn: string[], deepen: number | null): Buffer {
  const args: FetchArgs = {
    wants, haves, shallow: shallowIn, deepen, deepenSince: null, deepenNot: [], done: true, filter: null,
  };
  const { pack, shallow, unshallow } = buildFetchPack(repo, args);
  const parts: Buffer[] = [];
  for (const sha of shallow) parts.push(pktLine(`shallow ${sha}\n`));
  for (const sha of unshallow) parts.push(pktLine(`unshallow ${sha}\n`));
  const common = haves.filter((have) => repo.objects.has(have));
  if (common.length > 0) parts.push(pktLine(`ACK ${common[0]}\n`));
  else parts.push(pktLine('NAK\n'));
  parts.push(...sidebandChunks(pack));
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

/** POST git-upload-pack (v2 commands or a v0 want/have negotiation). */
export function uploadPack(repo: Repo | undefined, body: Buffer, protocolVersion: string | null): WireReply {
  if (repo === undefined) return jsonReply(404, 'Not Found');
  const contentType = 'application/x-git-upload-pack-result';
  const packets = decodePackets(body);
  const firstData = packets.find((packet) => packet.kind === 'data');
  const firstLine = firstData?.kind === 'data' ? firstData.payload.toString('utf8').replace(/\n$/, '') : '';

  if (firstLine.startsWith('command=')) {
    // Protocol v2: capability lines up to a delim, arguments up to a flush.
    const command = firstLine.slice('command='.length);
    const args: string[] = [];
    let pastDelim = false;
    for (const packet of packets.slice(1)) {
      if (packet.kind === 'delim') { pastDelim = true; continue; }
      if (packet.kind === 'flush') break;
      if (packet.kind === 'data' && pastDelim) args.push(packet.payload.toString('utf8').replace(/\n$/, ''));
    }
    if (command === 'ls-refs') {
      const parsed: LsRefsArgs = { peel: false, symrefs: false, unborn: false, prefixes: [] };
      for (const arg of args) {
        if (arg === 'peel') parsed.peel = true;
        else if (arg === 'symrefs') parsed.symrefs = true;
        else if (arg === 'unborn') parsed.unborn = true;
        else if (arg.startsWith('ref-prefix ')) parsed.prefixes.push(arg.slice('ref-prefix '.length));
      }
      return { status: 200, contentType, body: lsRefs(repo, parsed) };
    }
    if (command === 'fetch') {
      const parsed: FetchArgs = {
        wants: [], haves: [], shallow: [], deepen: null, deepenSince: null, deepenNot: [], done: false, filter: null,
      };
      for (const arg of args) {
        if (arg.startsWith('want ')) parsed.wants.push(arg.slice(5).trim());
        else if (arg.startsWith('have ')) parsed.haves.push(arg.slice(5).trim());
        else if (arg.startsWith('shallow ')) parsed.shallow.push(arg.slice(8).trim());
        else if (arg.startsWith('deepen ')) parsed.deepen = Number.parseInt(arg.slice(7), 10);
        else if (arg.startsWith('deepen-since ')) parsed.deepenSince = Number.parseInt(arg.slice(13), 10);
        else if (arg.startsWith('deepen-not ')) parsed.deepenNot.push(arg.slice(11).trim());
        else if (arg.startsWith('filter ')) parsed.filter = arg.slice(7).trim();
        else if (arg === 'done') parsed.done = true;
      }
      return { status: 200, contentType, body: fetchV2(repo, parsed) };
    }
    return jsonReply(400, `Unknown command ${command}`);
  }

  // Protocol v0: wants (with shallow/deepen) up to a flush, then haves to a second flush.
  const wants: string[] = [];
  const haves: string[] = [];
  const shallowIn: string[] = [];
  let deepen: number | null = null;
  let section = 0;
  for (const packet of packets) {
    if (packet.kind === 'flush') { section += 1; continue; }
    if (packet.kind !== 'data') continue;
    const line = packet.payload.toString('utf8').replace(/\n$/, '');
    if (section === 0) {
      if (line.startsWith('want ')) wants.push(line.slice(5, 45));
      else if (line.startsWith('shallow ')) shallowIn.push(line.slice(8).trim());
      else if (line.startsWith('deepen ')) deepen = Number.parseInt(line.slice(7), 10);
    } else if (line.startsWith('have ')) {
      haves.push(line.slice(5, 45));
    }
  }
  void protocolVersion;
  return { status: 200, contentType, body: fetchV0(repo, wants, haves, shallowIn, deepen) };
}

// ---------------------------------------------------------------- receive-pack

interface PushCommand {
  oldSha: string;
  newSha: string;
  ref: string;
  caps: string[];
}

/** POST git-receive-pack: unpack, validate fast-forwards, apply, report. */
export function receivePack(repo: Repo | undefined, body: Buffer): WireReply {
  if (repo === undefined) return jsonReply(404, 'Not Found');
  const contentType = 'application/x-git-receive-pack-result';
  const packets = decodePackets(body);
  const commands: PushCommand[] = [];
  let sawFlush = false;
  let packStart = body.length;
  {
    let offset = 0;
    for (const packet of packets) {
      if (packet.kind === 'flush') {
        sawFlush = true;
        offset += 4;
        packStart = offset;
        break;
      }
      if (packet.kind === 'data') {
        offset += 4 + packet.payload.length;
        const raw = packet.payload.toString('utf8').replace(/\n$/, '');
        const nul = raw.indexOf('\0');
        const line = nul >= 0 ? raw.slice(0, nul) : raw;
        const caps = nul >= 0 ? raw.slice(nul + 1).split(' ').filter(Boolean) : [];
        const parts = line.split(' ');
        if (parts.length === 3) commands.push({ oldSha: parts[0], newSha: parts[1], ref: parts[2], caps });
      } else {
        offset += 4;
      }
    }
    if (!sawFlush) packStart = body.length;
  }
  const caps = new Set(commands[0]?.caps ?? []);
  const sideband = caps.has('side-band-64k');
  const wantReport = caps.has('report-status') || caps.has('report-status-v2');

  const pack = body.subarray(packStart);
  let unpackError: string | null = null;
  if (pack.length > 0) {
    try {
      unpackPack(repo.objects, Buffer.from(pack));
    } catch (err) {
      unpackError = err instanceof Error ? err.message.replace(/[\r\n]+/g, ' ') : 'unpack failed';
    }
  }

  const results: Array<{ ref: string; ok: boolean; reason?: string }> = [];
  for (const command of commands) {
    const fail = (reason: string) => results.push({ ref: command.ref, ok: false, reason });
    if (unpackError !== null) {
      fail('unpacker error');
      continue;
    }
    const current = repo.refs.get(command.ref) ?? ZERO_OID;
    if (command.oldSha !== current) {
      fail('stale ref');
      continue;
    }
    if (command.newSha === ZERO_OID) {
      // A delete. Refuse to delete the branch HEAD names, as git does.
      if (command.ref === repo.headRef()) {
        fail('deletion of the current branch prohibited');
        continue;
      }
      repo.refs.delete(command.ref);
      results.push({ ref: command.ref, ok: true });
      continue;
    }
    const target = repo.objects.get(command.newSha);
    if (target === undefined) {
      fail('missing object');
      continue;
    }
    if (command.oldSha !== ZERO_OID && command.ref.startsWith('refs/heads/')) {
      if (!isAncestor(repo.objects, command.oldSha, command.newSha)) {
        fail('non-fast-forward');
        continue;
      }
    }
    repo.refs.set(command.ref, command.newSha);
    results.push({ ref: command.ref, ok: true });
  }

  if (!wantReport) {
    return { status: 200, contentType, body: Buffer.alloc(0) };
  }
  const reportLines = [
    unpackError !== null ? `unpack ${unpackError}\n` : 'unpack ok\n',
    ...results.map((result) => (result.ok ? `ok ${result.ref}\n` : `ng ${result.ref} ${result.reason ?? 'failed'}\n`)),
  ];
  const reportStream = Buffer.concat([...reportLines.map((line) => pktLine(line)), PKT_FLUSH]);
  if (!sideband) return { status: 200, contentType, body: reportStream };
  const wrapped: Buffer[] = [];
  const MAX = 65515;
  for (let at = 0; at < reportStream.length; at += MAX) {
    const slice = reportStream.subarray(at, Math.min(at + MAX, reportStream.length));
    wrapped.push(pktLine(Buffer.concat([Buffer.from([1]), slice])));
  }
  wrapped.push(PKT_FLUSH);
  return { status: 200, contentType, body: Buffer.concat(wrapped) };
}

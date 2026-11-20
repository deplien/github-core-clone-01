// The git wire machinery: pkt-line framing, packfiles (read and write)
// and object reachability, all on the standard library. No git binary
// exists in the trial pod, so the forge speaks the smart-HTTP protocol
// itself, the way the suite's in-process client expects it.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';
import { parseCommit, parseTree, type ObjectStore, type ObjectType, type StoredObject } from './store.ts';

export const ZERO_OID = '0'.repeat(40);
const TYPE_CODES: Record<ObjectType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPES: Record<number, ObjectType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

// ---------------------------------------------------------------- pkt-line

/** One pkt-line: a 4-hex length prefix (counting itself) plus the payload. */
export function pktLine(payload: string | Buffer): Buffer {
  const body = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const length = body.length + 4;
  const header = length.toString(16).padStart(4, '0');
  return Buffer.concat([Buffer.from(header, 'ascii'), body]);
}

export const PKT_FLUSH = Buffer.from('0000', 'ascii');
export const PKT_DELIM = Buffer.from('0001', 'ascii');
export const PKT_RESPONSE_END = Buffer.from('0002', 'ascii');

export type Packet =
  | { kind: 'data'; payload: Buffer }
  | { kind: 'flush' }
  | { kind: 'delim' }
  | { kind: 'response-end' };

/** Decode a whole buffer of pkt-lines (request bodies are small and whole). */
export function decodePackets(bytes: Buffer): Packet[] {
  const packets: Packet[] = [];
  let offset = 0;
  while (offset + 4 <= bytes.length) {
    const header = bytes.subarray(offset, offset + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(header)) break;
    const length = Number.parseInt(header, 16);
    if (length === 0) {
      packets.push({ kind: 'flush' });
      offset += 4;
    } else if (length === 1) {
      packets.push({ kind: 'delim' });
      offset += 4;
    } else if (length === 2) {
      packets.push({ kind: 'response-end' });
      offset += 4;
    } else if (length < 4 || offset + length > bytes.length) {
      break;
    } else {
      packets.push({ kind: 'data', payload: bytes.subarray(offset + 4, offset + length) });
      offset += length;
    }
  }
  return packets;
}

/** The offset just past the last pkt-line: where a receive-pack's pack begins. */
export function packetsEnd(bytes: Buffer): number {
  let offset = 0;
  while (offset + 4 <= bytes.length) {
    const header = bytes.subarray(offset, offset + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(header)) break;
    const length = Number.parseInt(header, 16);
    if (length === 0 || length === 1 || length === 2) {
      offset += 4;
      if (length === 0) break;
    } else if (length < 4 || offset + length > bytes.length) {
      break;
    } else {
      offset += length;
    }
  }
  return offset;
}

// ---------------------------------------------------------------- pack read

interface PackEntry {
  type: ObjectType;
  data: Buffer;
  /** Byte offset of this entry's header inside the pack (ofs-delta bases). */
  offset: number;
}

/** Read a variable-length little-endian-ish size from a pack object header. */
function readPackVarint(bytes: Buffer, offset: number): { value: number; next: number } {
  let value = 0;
  let shift = 0;
  let at = offset;
  for (;;) {
    const byte = bytes[at];
    at += 1;
    value += (byte & 0x7f) * 2 ** shift;
    shift += 7;
    if ((byte & 0x80) === 0) break;
  }
  return { value, next: at };
}

/** Inflate one zlib stream starting at `offset`; returns data + bytes consumed. */
function inflateAt(bytes: Buffer, offset: number): { data: Buffer; consumed: number } {
  const result = inflateSync(bytes.subarray(offset), { info: true }) as unknown as {
    buffer: Buffer;
    engine: { bytesWritten?: number; bytesRead?: number };
  };
  return { data: result.buffer, consumed: result.engine.bytesWritten ?? result.engine.bytesRead ?? 0 };
}

/** Apply a git delta (copy/insert program) to its base object's payload. */
export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let at = 0;
  const readVarint = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      const byte = delta[at];
      at += 1;
      value += (byte & 0x7f) * 2 ** shift;
      shift += 7;
      if ((byte & 0x80) === 0) break;
    }
    return value;
  };
  const sourceSize = readVarint();
  if (sourceSize !== base.length) throw new Error(`delta base size ${base.length} != ${sourceSize}`);
  const targetSize = readVarint();
  const out: Buffer[] = [];
  let written = 0;
  while (at < delta.length) {
    const op = delta[at];
    at += 1;
    if (op & 0x80) {
      let offset = 0;
      let size = 0;
      if (op & 0x01) { offset = delta[at]; at += 1; }
      if (op & 0x02) { offset |= delta[at] << 8; at += 1; }
      if (op & 0x04) { offset |= delta[at] << 16; at += 1; }
      if (op & 0x08) { offset |= delta[at] << 24; at += 1; }
      if (op & 0x10) { size = delta[at]; at += 1; }
      if (op & 0x20) { size |= delta[at] << 8; at += 1; }
      if (op & 0x40) { size |= delta[at] << 16; at += 1; }
      if (size === 0) size = 0x10000;
      out.push(base.subarray(offset, offset + size));
      written += size;
    } else if (op > 0) {
      out.push(delta.subarray(at, at + op));
      written += op;
      at += op;
    } else {
      throw new Error('delta opcode 0 is reserved');
    }
  }
  const joined = Buffer.concat(out);
  if (joined.length !== targetSize || written !== targetSize) {
    throw new Error(`delta produced ${joined.length} bytes, expected ${targetSize}`);
  }
  return joined;
}

/**
 * Read every object out of a packfile into `store`. Delta bases may live
 * in the same pack or already in the store (a thin pack from a client
 * that knows we hold the base). Returns the sha of every object stored.
 */
export function unpackPack(store: ObjectStore, pack: Buffer): string[] {
  if (pack.length < 12 + 20 || pack.subarray(0, 4).toString('ascii') !== 'PACK') {
    throw new Error('not a packfile');
  }
  const count = pack.readUInt32BE(8);
  const byOffset = new Map<number, PackEntry & { sha: string }>();
  const pending: Array<{ entry: PackEntry; baseOffset?: number; baseSha?: string }> = [];
  let offset = 12;
  for (let i = 0; i < count; i += 1) {
    const start = offset;
    const firstByte = pack[offset];
    offset += 1;
    const typeCode = (firstByte >> 4) & 0x07;
    let size = firstByte & 0x0f;
    let shift = 4;
    let byte = firstByte;
    while (byte & 0x80) {
      byte = pack[offset];
      offset += 1;
      size += (byte & 0x7f) * 2 ** shift;
      shift += 7;
    }
    let baseOffset: number | undefined;
    let baseSha: string | undefined;
    if (typeCode === 6) {
      // ofs-delta: a back-reference encoded as a biased offset.
      let back = pack[offset];
      offset += 1;
      let value = back & 0x7f;
      while (back & 0x80) {
        back = pack[offset];
        offset += 1;
        value = ((value + 1) << 7) | (back & 0x7f);
      }
      baseOffset = start - value;
    } else if (typeCode === 7) {
      baseSha = pack.subarray(offset, offset + 20).toString('hex');
      offset += 20;
    }
    const { data, consumed } = inflateAt(pack, offset);
    offset += consumed;
    if (data.length !== size) throw new Error(`pack object size mismatch: ${data.length} != ${size}`);
    if (typeCode === 6 || typeCode === 7) {
      pending.push({ entry: { type: 'blob', data, offset: start }, baseOffset, baseSha });
    } else {
      const type = CODE_TYPES[typeCode];
      if (type === undefined) throw new Error(`unknown pack object type ${typeCode}`);
      const sha = store.put(type, data);
      byOffset.set(start, { type, data, offset: start, sha });
    }
  }
  // Resolve deltas once every full object in the pack is stored.
  const shas: string[] = [...byOffset.values()].map((entry) => entry.sha);
  let guard = pending.length + 1;
  while (pending.length > 0 && guard > 0) {
    guard -= 1;
    for (let i = pending.length - 1; i >= 0; i -= 1) {
      const item = pending[i];
      let base: StoredObject | undefined;
      if (item.baseOffset !== undefined) {
        const found = byOffset.get(item.baseOffset);
        if (found) base = { type: found.type, data: found.data };
      } else if (item.baseSha !== undefined) {
        base = store.get(item.baseSha);
      }
      if (base === undefined) continue;
      const data = applyDelta(base.data, item.entry.data);
      const sha = store.put(base.type, data);
      byOffset.set(item.entry.offset, { type: base.type, data, offset: item.entry.offset, sha });
      shas.push(sha);
      pending.splice(i, 1);
    }
  }
  if (pending.length > 0) throw new Error('pack delta base not found');
  return shas;
}

// ---------------------------------------------------------------- pack write

/** The pack object header: type and size in git's variable-length form. */
function packObjectHeader(type: ObjectType, size: number): Buffer {
  const bytes: number[] = [];
  let first = (TYPE_CODES[type] << 4) | (size & 0x0f);
  size = Math.floor(size / 16);
  if (size > 0) first |= 0x80;
  bytes.push(first);
  while (size > 0) {
    let byte = size & 0x7f;
    size = Math.floor(size / 128);
    if (size > 0) byte |= 0x80;
    bytes.push(byte);
  }
  return Buffer.from(bytes);
}

/** Build a self-contained packfile (full objects, no deltas) for `shas`. */
export function writePack(store: ObjectStore, shas: readonly string[]): Buffer {
  const parts: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(shas.length, 8);
  parts.push(header);
  for (const sha of shas) {
    const obj = store.get(sha);
    if (obj === undefined) throw new Error(`cannot pack missing object ${sha}`);
    parts.push(packObjectHeader(obj.type, obj.data.length));
    parts.push(deflateSync(obj.data, { level: 1 }));
  }
  const body = Buffer.concat(parts);
  const trailer = createHash('sha1').update(body).digest();
  return Buffer.concat([body, trailer]);
}

// ---------------------------------------------------------------- reachability

/** Every commit reachable from `tip`, newest first (BFS over parents). */
export function walkCommits(store: ObjectStore, tip: string): string[] {
  const seen = new Set<string>();
  const order: string[] = [];
  const queue = [tip];
  while (queue.length > 0) {
    const sha = queue.shift() as string;
    if (seen.has(sha)) continue;
    const obj = store.get(sha);
    if (obj === undefined || obj.type !== 'commit') continue;
    seen.add(sha);
    order.push(sha);
    for (const parent of parseCommit(obj.data).parents) queue.push(parent);
  }
  return order;
}

/** True when `ancestor` is `descendant` itself or one of its ancestors. */
export function isAncestor(store: ObjectStore, ancestor: string, descendant: string): boolean {
  if (ancestor === descendant) return true;
  const seen = new Set<string>();
  const queue = [descendant];
  while (queue.length > 0) {
    const sha = queue.shift() as string;
    if (seen.has(sha)) continue;
    seen.add(sha);
    if (sha === ancestor) return true;
    const obj = store.get(sha);
    if (obj === undefined || obj.type !== 'commit') continue;
    for (const parent of parseCommit(obj.data).parents) queue.push(parent);
  }
  return false;
}

/** Add a tree and everything under it (subtrees, blobs) to `into`. */
export function collectTree(store: ObjectStore, treeSha: string, into: Set<string>): void {
  if (into.has(treeSha)) return;
  const obj = store.get(treeSha);
  if (obj === undefined || obj.type !== 'tree') return;
  into.add(treeSha);
  for (const entry of parseTree(obj.data)) {
    if (entry.mode === '40000') collectTree(store, entry.sha, into);
    else into.add(entry.sha);
  }
}

export interface FetchSelection {
  /** Object shas to pack, commits first. */
  objects: string[];
  /** Boundary commits for the shallow-info section (deepen runs). */
  shallow: string[];
  /** Earlier boundary commits whose parents this fetch delivers. */
  unshallow: string[];
}

/**
 * Choose the objects a fetch answers with: everything reachable from the
 * wants, minus everything the client provably holds, honouring a depth
 * limit (commits deeper than `depth` from a want are cut, and the ones
 * exactly at the limit are reported shallow).
 *
 * What the client holds is the closure of its haves — except that the
 * closure never crosses a shallow boundary: a shallow client does not
 * hold the boundary commits' ancestors, so a deepen request must be
 * able to deliver them. Traversal from a want likewise walks through a
 * held boundary commit to reach those ancestors.
 */
export function selectFetchObjects(
  store: ObjectStore,
  wants: readonly string[],
  haves: readonly string[],
  depth: number | null,
  shallowBoundaries: readonly string[],
): FetchSelection {
  const boundarySet = new Set(shallowBoundaries);
  const held = new Set<string>();
  {
    const stack = [...haves, ...shallowBoundaries];
    while (stack.length > 0) {
      const sha = stack.pop() as string;
      if (held.has(sha)) continue;
      held.add(sha);
      if (boundarySet.has(sha)) continue; // held, but its ancestry is not
      const obj = store.get(sha);
      if (obj !== undefined && obj.type === 'commit') {
        for (const parent of parseCommit(obj.data).parents) stack.push(parent);
      }
    }
  }

  const included = new Set<string>();
  const shallow: string[] = [];
  // BFS by depth from every want.
  const depthOf = new Map<string, number>();
  let frontier = [...new Set(wants)];
  for (const want of frontier) depthOf.set(want, 0);
  let level = 0;
  while (frontier.length > 0) {
    const next: string[] = [];
    for (const sha of frontier) {
      const obj = store.get(sha);
      if (obj === undefined) continue;
      const isHeld = held.has(sha);
      if (!isHeld && !included.has(sha)) {
        included.add(sha);
        if (obj.type === 'commit' && depth !== null && level + 1 >= depth) shallow.push(sha);
      }
      if (obj.type !== 'commit') continue;
      // A fully held, non-boundary commit's ancestry is held too: stop.
      if (isHeld && !boundarySet.has(sha)) continue;
      // An included commit at the depth limit is the new boundary: stop.
      if (!isHeld && depth !== null && level + 1 >= depth) continue;
      for (const parent of parseCommit(obj.data).parents) {
        if (!depthOf.has(parent)) {
          depthOf.set(parent, level + 1);
          next.push(parent);
        }
      }
    }
    frontier = next;
    level += 1;
  }
  // An old boundary commit stops being shallow when this fetch delivers
  // at least one of its parents.
  const unshallow: string[] = [];
  for (const boundary of shallowBoundaries) {
    const obj = store.get(boundary);
    if (obj !== undefined && obj.type === 'commit' && parseCommit(obj.data).parents.some((parent) => included.has(parent))) {
      unshallow.push(boundary);
    }
  }
  // Trees and blobs of every included commit (and of any non-commit want).
  const withTrees = new Set<string>(included);
  for (const sha of included) {
    const obj = store.get(sha);
    if (obj === undefined) continue;
    if (obj.type === 'commit') collectTree(store, parseCommit(obj.data).tree, withTrees);
    else if (obj.type === 'tree') collectTree(store, sha, withTrees);
    else if (obj.type === 'tag') withTrees.add(sha);
  }
  // Drop trees/blobs the client provably has: anything under a held commit.
  if (held.size > 0) {
    const hadTrees = new Set<string>();
    for (const heldSha of held) {
      const obj = store.get(heldSha);
      if (obj !== undefined && obj.type === 'commit') collectTree(store, parseCommit(obj.data).tree, hadTrees);
    }
    for (const sha of hadTrees) {
      if (!included.has(sha)) withTrees.delete(sha);
    }
  }
  const commits = [...withTrees].filter((sha) => store.get(sha)?.type === 'commit');
  const rest = [...withTrees].filter((sha) => store.get(sha)?.type !== 'commit');
  return { objects: [...commits, ...rest], shallow, unshallow };
}

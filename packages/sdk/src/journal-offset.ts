import { readFileSync } from 'node:fs';

/** Locate a table row's cell in a SQLite snapshot for read-error diagnostics. */
export function journalRecordOffset(path: string, rootPage: number, seq: number): string {
  const main = readFileSync(path);
  const encodedSize = main.readUInt16BE(16);
  const pageSize = encodedSize === 1 ? 65536 : encodedSize;
  const pages = new Map<number, { bytes: Buffer; offset: number; file: string }>();
  let wal: Buffer | undefined;
  try { wal = readFileSync(`${path}-wal`); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  if (wal !== undefined) {
    const frameSize = pageSize + 24;
    let lastCommit = 0;
    for (let frame = 32; frame + frameSize <= wal.length; frame += frameSize) {
      if (wal.readUInt32BE(frame + 4) !== 0) lastCommit = frame;
    }
    for (let frame = 32; frame <= lastCommit; frame += frameSize) {
      pages.set(wal.readUInt32BE(frame), { bytes: wal, offset: frame + 24, file: 'WAL' });
    }
  }
  const visited = new Set<number>();
  let page = rootPage;
  while (!visited.has(page)) {
    visited.add(page);
    const source = pages.get(page) ?? { bytes: main, offset: (page - 1) * pageSize, file: 'journal' };
    const header = source.offset + (page === 1 ? 100 : 0);
    const kind = source.bytes[header];
    if (kind !== 5 && kind !== 13) break;
    const count = source.bytes.readUInt16BE(header + 3);
    let next = kind === 5 ? source.bytes.readUInt32BE(header + 8) : 0;
    for (let index = 0; index < count; index += 1) {
      const cell = source.offset + source.bytes.readUInt16BE(header + (kind === 5 ? 12 : 8) + 2 * index);
      const rowIdOffset = kind === 5 ? cell + 4 : varint(source.bytes, cell).next;
      const rowId = varint(source.bytes, rowIdOffset).value;
      if (kind === 13 && rowId === BigInt(seq)) return `${source.file} byte offset ${cell}`;
      if (kind === 5 && BigInt(seq) <= rowId) {
        next = source.bytes.readUInt32BE(cell);
        break;
      }
    }
    if (next === 0) break;
    page = next;
  }
  throw new Error('Cannot locate journal record cell.');
}

function varint(bytes: Buffer, offset: number): { value: bigint; next: number } {
  let value = 0n;
  for (let index = 0; index < 9; index += 1) {
    const byte = bytes.readUInt8(offset++);
    value = (value << (index === 8 ? 8n : 7n)) | BigInt(index === 8 ? byte : byte & 0x7f);
    if (byte < 0x80 || index === 8) return { value, next: offset };
  }
  throw new Error('Invalid SQLite varint.');
}

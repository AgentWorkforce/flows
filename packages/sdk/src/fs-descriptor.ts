import {
  Dir,
  Dirent,
  Stats,
  close,
  fstat,
  open,
  read,
  type BigIntStats,
  type PathLike,
} from 'node:fs';
import { promisify } from 'node:util';

const CLOSE = promisify(close) as (descriptor: number) => Promise<void>;
const FSTAT = promisify(fstat) as (
  descriptor: number, options: { bigint: true },
) => Promise<BigIntStats>;
const OPEN = promisify(open) as (path: PathLike, flags: number) => Promise<number>;
const READ = promisify(read) as (
  descriptor: number,
  buffer: Buffer,
  offset: number,
  length: number,
  position: number,
) => Promise<{ bytesRead: number; buffer: Buffer }>;
const DIRENT_IS_DIRECTORY = Function.prototype.call.bind(Dirent.prototype.isDirectory) as (
  entry: Dirent,
) => boolean;
const DIRENT_IS_FILE = Function.prototype.call.bind(Dirent.prototype.isFile) as (
  entry: Dirent,
) => boolean;
const DIR_CLOSE = Function.prototype.call.bind(Dir.prototype.close) as (
  directory: Dir,
) => Promise<void>;
const DIR_READ = Function.prototype.call.bind(Dir.prototype.read) as (
  directory: Dir,
) => Promise<Dirent | null>;
const STATS_IS_DIRECTORY = Function.prototype.call.bind(Stats.prototype.isDirectory) as (
  stats: Stats | BigIntStats,
) => boolean;
const STATS_IS_FILE = Function.prototype.call.bind(Stats.prototype.isFile) as (
  stats: Stats | BigIntStats,
) => boolean;

export const closeDescriptor = CLOSE;
export const descriptorIsDirectory = STATS_IS_DIRECTORY;
export const descriptorIsFile = STATS_IS_FILE;
export const directoryEntryIsDirectory = DIRENT_IS_DIRECTORY;
export const directoryEntryIsFile = DIRENT_IS_FILE;
export const openDescriptor = OPEN;
export const readDirectoryEntry = DIR_READ;
export const closeDirectory = DIR_CLOSE;
export const statDescriptor = FSTAT;

export async function readDescriptor(
  descriptor: number,
  buffer: Buffer,
  offset: number,
  length: number,
  position: number,
): Promise<number> {
  return (await READ(descriptor, buffer, offset, length, position)).bytesRead;
}

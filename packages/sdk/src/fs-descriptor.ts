import {
  Dir,
  Dirent,
  Stats,
  close,
  fstat,
  lstat,
  open,
  opendir,
  read,
  readdir,
  type BigIntStats,
  type PathLike,
} from 'node:fs';
import { hostedPromiseValue } from './hosted-promise-safety.js';

const CLOSE = close;
const FSTAT = fstat;
const LSTAT = lstat;
const OPEN = open;
const OPENDIR = opendir;
const READ = read;
const READDIR = readdir;
const PROMISE = Promise;
const DIRENT_IS_DIRECTORY = Function.prototype.call.bind(Dirent.prototype.isDirectory) as (
  entry: Dirent,
) => boolean;
const DIRENT_IS_FILE = Function.prototype.call.bind(Dirent.prototype.isFile) as (
  entry: Dirent,
) => boolean;
const DIR_CLOSE = Function.prototype.call.bind(Dir.prototype.close) as (
  directory: Dir,
  callback: (error?: NodeJS.ErrnoException | null) => void,
) => void;
const DIR_READ = Function.prototype.call.bind(Dir.prototype.read) as (
  directory: Dir,
  callback: (error: NodeJS.ErrnoException | null, entry: Dirent | null) => void,
) => void;
const STATS_IS_DIRECTORY = Function.prototype.call.bind(Stats.prototype.isDirectory) as (
  stats: Stats | BigIntStats,
) => boolean;
const STATS_IS_FILE = Function.prototype.call.bind(Stats.prototype.isFile) as (
  stats: Stats | BigIntStats,
) => boolean;

export const descriptorIsDirectory = STATS_IS_DIRECTORY;
export const descriptorIsFile = STATS_IS_FILE;
export const directoryEntryIsDirectory = DIRENT_IS_DIRECTORY;
export const directoryEntryIsFile = DIRENT_IS_FILE;

export function closeDescriptor(descriptor: number): Promise<void> {
  return new PROMISE<void>((resolvePromise, rejectPromise) => {
    CLOSE(descriptor, error => error === null ? resolvePromise() : rejectPromise(error));
  });
}

export function openDescriptor(path: PathLike, flags: number): Promise<number> {
  return new PROMISE<number>((resolvePromise, rejectPromise) => {
    OPEN(path, flags, (error, descriptor) => error === null ? resolvePromise(descriptor) : rejectPromise(error));
  });
}

export function statDescriptor(descriptor: number, options: { bigint: true }): Promise<BigIntStats> {
  return new PROMISE<BigIntStats>((resolvePromise, rejectPromise) => {
    FSTAT(descriptor, options, (error, stats) => {
      if (error !== null) rejectPromise(error);
      else resolvePromise(hostedPromiseValue(stats));
    });
  });
}

export function lstatPath(path: PathLike): Promise<Stats> {
  return new PROMISE<Stats>((resolvePromise, rejectPromise) => {
    LSTAT(path, (error, stats) => {
      if (error !== null) rejectPromise(error);
      else resolvePromise(hostedPromiseValue(stats));
    });
  });
}

export function openDirectory(path: PathLike): Promise<Dir> {
  return new PROMISE<Dir>((resolvePromise, rejectPromise) => {
    OPENDIR(path, (error, directory) => {
      if (error !== null) rejectPromise(error);
      else resolvePromise(hostedPromiseValue(directory));
    });
  });
}

export function readDirectory(path: PathLike): Promise<Dirent[]> {
  return new PROMISE<Dirent[]>((resolvePromise, rejectPromise) => {
    READDIR(path, { withFileTypes: true }, (error, entries) => {
      if (error !== null) rejectPromise(error);
      else resolvePromise(hostedPromiseValue(entries));
    });
  });
}

export function readDirectoryEntry(directory: Dir): Promise<Dirent | null> {
  return new PROMISE<Dirent | null>((resolvePromise, rejectPromise) => {
    DIR_READ(directory, (error, entry) => {
      if (error !== null) rejectPromise(error);
      else resolvePromise(entry === null ? null : hostedPromiseValue(entry));
    });
  });
}

export function closeDirectory(directory: Dir): Promise<void> {
  return new PROMISE<void>((resolvePromise, rejectPromise) => {
    DIR_CLOSE(directory, error => error == null ? resolvePromise() : rejectPromise(error));
  });
}

export async function readDescriptor(
  descriptor: number,
  buffer: Buffer,
  offset: number,
  length: number,
  position: number,
): Promise<number> {
  return await new PROMISE<number>((resolvePromise, rejectPromise) => {
    READ(descriptor, buffer, offset, length, position, (error, bytesRead) => {
      if (error !== null) rejectPromise(error);
      else resolvePromise(bytesRead);
    });
  });
}

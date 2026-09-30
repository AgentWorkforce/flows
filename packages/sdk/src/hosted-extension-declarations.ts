import {
  constants,
  closeSync,
  existsSync,
  fstatSync,
  openSync,
  readSync,
} from "node:fs";
import { join } from "node:path";
import { safePath } from "./bundle.js";
import { canonicalize } from "./canonical.js";
import { descriptorIsFile } from "./fs-descriptor.js";
import { snapshotJsonValue } from "./json-value.js";
import { PluginError } from "./plugin-manifest.js";
import { appendIntrinsicArray } from "./intrinsic-array.js";
import {
  PLUGIN_LOCK_FILE,
  PLUGIN_LOCK_VERSION,
  type PluginLockEntry,
} from "./plugin-lock.js";
import { canonicalPluginRef, type PluginSourceRef } from "./plugin-source.js";

const CLOSE_SYNC = closeSync;
const EXISTS_SYNC = existsSync;
const FSTAT_SYNC = fstatSync;
const OPEN_SYNC = openSync;
const READ_SYNC = readSync;
const PATH_JOIN = join;
const ERROR = Error;
const PLUGIN_ERROR_IS_INSTANCE = Function.prototype.call.bind(
  Function.prototype[Symbol.hasInstance],
  PluginError,
) as (value: unknown) => boolean;
const MAX_DECLARATION_BYTES = 1024 * 1024;
const BIG_INT = BigInt;
const BUFFER_ALLOC_UNSAFE = Buffer.allocUnsafe;
const BUFFER_TO_STRING = Function.prototype.call.bind(
  Buffer.prototype.toString,
) as (value: Buffer, encoding: BufferEncoding) => string;
const NUMBER = Number;
const DECLARATION_READ_FLAGS =
  constants.O_RDONLY |
  (constants.O_NOFOLLOW ?? 0) |
  (constants.O_NONBLOCK ?? 0);
const JSON_PARSE = JSON.parse;
const ARRAY_IS_ARRAY = Array.isArray;
const DATE_PARSE = Date.parse;
const NUMBER_IS_NAN = Number.isNaN;
const OBJECT_FREEZE = Object.freeze;
const OBJECT_HAS_OWN = Object.hasOwn;
const OBJECT_KEYS = Object.keys;
const REGEXP_TEST = Function.prototype.call.bind(RegExp.prototype.test) as (
  regexp: RegExp,
  value: string,
) => boolean;
const SET = Set;
const SET_ADD = Function.prototype.call.bind(Set.prototype.add) as <T>(
  set: Set<T>,
  value: T,
) => Set<T>;
const SET_HAS = Function.prototype.call.bind(Set.prototype.has) as <T>(
  set: Set<T>,
  value: T,
) => boolean;
const STRING_STARTS_WITH = Function.prototype.call.bind(
  String.prototype.startsWith,
) as (value: string, search: string) => boolean;
const LOCK_HEX64 = /^[0-9a-f]{64}$/;
const LOCK_SHA = /^[0-9a-f]{40}$/;
// `name` reaches pluginStoreDirectory as a path segment, so it stays one
// lowercase kebab-case component: no separators, no `.`/`..`, no traversal.
const LOCK_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const LOCK_OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const LOCK_REPO = /^[A-Za-z0-9_.-]{1,100}$/;
const HTTPS_GITHUB = /^https:\/\/github\.com\//;

export interface HostedDeclaredExtension {
  readonly ref: string;
  readonly entry: PluginLockEntry;
  readonly source: PluginSourceRef;
}

export function declarationSignature(
  declared: readonly HostedDeclaredExtension[],
): string {
  const records: Array<{
    ref: string;
    name: string;
    version: string;
    digest: string;
    manifestSha256: string;
  }> = [];
  for (let index = 0; index < declared.length; index += 1) {
    const { ref, entry } = declared[index]!;
    appendIntrinsicArray(records, {
      ref,
      name: entry.name,
      version: entry.version,
      digest: entry.digest,
      manifestSha256: entry.manifestSha256,
    });
  }
  return canonicalize(records);
}

export function hostedDeclaredExtensions(
  root: string,
): readonly HostedDeclaredExtension[] {
  if (
    EXISTS_SYNC(PATH_JOIN(root, "flows.json.tmp")) ||
    EXISTS_SYNC(PATH_JOIN(root, `${PLUGIN_LOCK_FILE}.tmp`))
  ) {
    throw new PluginError(
      "plugin_lock_invalid",
      "Hosted extension declarations have a pending transaction.",
    );
  }
  let config: unknown;
  try {
    config = JSON_PARSE(
      BUFFER_TO_STRING(
        readBoundedDeclaration(PATH_JOIN(root, "flows.json")),
        "utf8",
      ),
    );
  } catch (error) {
    if (PLUGIN_ERROR_IS_INSTANCE(error)) throw error;
    throw new PluginError(
      "plugin_manifest_invalid",
      "Invalid or oversized flows.json.",
    );
  }
  if (typeof config !== "object" || config === null || ARRAY_IS_ARRAY(config)) {
    throw new PluginError(
      "plugin_manifest_invalid",
      "flows.json plugins must be strings.",
    );
  }
  const plugins = OBJECT_HAS_OWN(config, "plugins")
    ? (config as { plugins?: unknown }).plugins
    : undefined;
  if (plugins !== undefined && !ARRAY_IS_ARRAY(plugins)) {
    throw new PluginError(
      "plugin_manifest_invalid",
      "flows.json plugins must be strings.",
    );
  }
  const declared: string[] = [];
  if (plugins !== undefined) {
    for (let index = 0; index < plugins.length; index += 1) {
      const ref = plugins[index];
      if (typeof ref !== "string") {
        throw new PluginError(
          "plugin_manifest_invalid",
          "flows.json plugins must be strings.",
        );
      }
      if (isHostedGithubPluginRef(ref)) appendIntrinsicArray(declared, ref);
    }
  }
  let lock: {
    readonly version: 2;
    readonly plugins: readonly PluginLockEntry[];
  } = OBJECT_FREEZE({
    version: PLUGIN_LOCK_VERSION,
    plugins: OBJECT_FREEZE([]),
  });
  const lockPath = PATH_JOIN(root, PLUGIN_LOCK_FILE);
  if (EXISTS_SYNC(lockPath)) {
    let value: unknown;
    try {
      value = JSON_PARSE(
        BUFFER_TO_STRING(readBoundedDeclaration(lockPath), "utf8"),
      );
    } catch (error) {
      if (PLUGIN_ERROR_IS_INSTANCE(error)) throw error;
      throw new PluginError(
        "plugin_lock_invalid",
        `${PLUGIN_LOCK_FILE}: not valid or exceeds the hosted size limit.`,
      );
    }
    lock = parseHostedPluginLock(value);
  }
  if (declared.length !== lock.plugins.length) {
    throw new PluginError(
      "plugin_lock_invalid",
      "Hosted flows.json and flows.lock.json declarations differ.",
    );
  }
  const result: HostedDeclaredExtension[] = [];
  for (let index = 0; index < lock.plugins.length; index += 1) {
    const entry = lock.plugins[index]!;
    const source = OBJECT_FREEZE({ ...entry.source, ref: entry.source.sha });
    const ref = canonicalPluginRef(source);
    if (declared[index] !== ref) {
      throw new PluginError(
        "plugin_lock_invalid",
        "Hosted flows.lock.json order differs from flows.json.plugins.",
      );
    }
    appendIntrinsicArray(result, OBJECT_FREEZE({ ref, entry, source }));
  }
  return OBJECT_FREEZE(result);
}

function parseHostedPluginLock(input: unknown): {
  readonly version: 2;
  readonly plugins: readonly PluginLockEntry[];
} {
  let value: unknown;
  try {
    value = snapshotJsonValue(input, "hosted plugin lock");
  } catch {
    return invalidHostedLock(
      `expected { version: ${PLUGIN_LOCK_VERSION}, plugins: [] }.`,
    );
  }
  if (
    !hostedRecord(value) ||
    value.version !== PLUGIN_LOCK_VERSION ||
    !ARRAY_IS_ARRAY(value.plugins) ||
    !hostedHasOnlyKeys(value, ["version", "plugins"])
  ) {
    return invalidHostedLock(
      `expected { version: ${PLUGIN_LOCK_VERSION}, plugins: [] }.`,
    );
  }
  const names = new SET<string>();
  const plugins: PluginLockEntry[] = [];
  for (let index = 0; index < value.plugins.length; index += 1) {
    const entry = value.plugins[index];
    if (
      !hostedRecord(entry) ||
      !hostedHasOnlyKeys(entry, [
        "digest",
        "kind",
        "manifestSha256",
        "name",
        "order",
        "resolvedAt",
        "source",
        "version",
      ]) ||
      entry.kind !== "flow-extension" ||
      typeof entry.name !== "string" ||
      !REGEXP_TEST(LOCK_NAME, entry.name) ||
      typeof entry.version !== "string" ||
      typeof entry.digest !== "string" ||
      !REGEXP_TEST(LOCK_HEX64, entry.digest) ||
      typeof entry.manifestSha256 !== "string" ||
      !REGEXP_TEST(LOCK_HEX64, entry.manifestSha256) ||
      entry.order !== index + 1 ||
      typeof entry.resolvedAt !== "string" ||
      NUMBER_IS_NAN(DATE_PARSE(entry.resolvedAt)) ||
      !hostedRecord(entry.source) ||
      !hostedHasOnlyKeys(entry.source, [
        "host",
        "owner",
        "repo",
        "sha",
        "path",
      ]) ||
      entry.source.host !== "github" ||
      typeof entry.source.owner !== "string" ||
      !REGEXP_TEST(LOCK_OWNER, entry.source.owner) ||
      typeof entry.source.repo !== "string" ||
      !REGEXP_TEST(LOCK_REPO, entry.source.repo) ||
      entry.source.repo === "." ||
      entry.source.repo === ".." ||
      typeof entry.source.sha !== "string" ||
      !REGEXP_TEST(LOCK_SHA, entry.source.sha) ||
      typeof entry.source.path !== "string" ||
      (entry.source.path !== "" && !safePath(entry.source.path))
    ) {
      return invalidHostedLock(`plugins[${index}] is malformed.`);
    }
    if (SET_HAS(names, entry.name))
      return invalidHostedLock(`plugin ${entry.name} is listed twice.`);
    SET_ADD(names, entry.name);
    appendIntrinsicArray(plugins, OBJECT_FREEZE({
      name: entry.name,
      kind: "flow-extension",
      version: entry.version,
      source: OBJECT_FREEZE({
        host: "github",
        owner: entry.source.owner,
        repo: entry.source.repo,
        sha: entry.source.sha,
        path: entry.source.path,
      }),
      digest: entry.digest,
      manifestSha256: entry.manifestSha256,
      order: entry.order,
      resolvedAt: entry.resolvedAt,
    }));
  }
  return OBJECT_FREEZE({
    version: PLUGIN_LOCK_VERSION,
    plugins: OBJECT_FREEZE(plugins),
  });
}

function isHostedGithubPluginRef(value: string): boolean {
  return (
    STRING_STARTS_WITH(value, "github:") || REGEXP_TEST(HTTPS_GITHUB, value)
  );
}

function hostedRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !ARRAY_IS_ARRAY(value);
}

function hostedHasOnlyKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
): boolean {
  const keys = OBJECT_KEYS(value);
  for (let index = 0; index < keys.length; index += 1) {
    let found = false;
    for (
      let allowedIndex = 0;
      allowedIndex < allowed.length;
      allowedIndex += 1
    ) {
      if (keys[index] === allowed[allowedIndex]) {
        found = true;
        break;
      }
    }
    if (!found) return false;
  }
  return true;
}

function invalidHostedLock(message: string): never {
  throw new PluginError(
    "plugin_lock_invalid",
    `${PLUGIN_LOCK_FILE}: ${message}`,
  );
}

function readBoundedDeclaration(path: string): Buffer {
  let descriptor: number | undefined;
  try {
    descriptor = OPEN_SYNC(path, DECLARATION_READ_FLAGS);
    const before = FSTAT_SYNC(descriptor, { bigint: true });
    if (
      !descriptorIsFile(before) ||
      before.size < 0n ||
      before.size > BIG_INT(MAX_DECLARATION_BYTES)
    ) {
      throw new PluginError(
        "plugin_source_invalid",
        "Hosted extension declaration is not a bounded regular file.",
      );
    }
    const expected = NUMBER(before.size);
    const bytes = BUFFER_ALLOC_UNSAFE(expected);
    let offset = 0;
    while (offset < expected) {
      const count = READ_SYNC(
        descriptor,
        bytes,
        offset,
        expected - offset,
        offset,
      );
      if (count === 0) throw new ERROR("short read");
      offset += count;
    }
    if (READ_SYNC(descriptor, BUFFER_ALLOC_UNSAFE(1), 0, 1, expected) !== 0)
      throw new ERROR("grew");
    const after = FSTAT_SYNC(descriptor, { bigint: true });
    if (
      after.size !== before.size ||
      after.mtimeNs !== before.mtimeNs ||
      after.ctimeNs !== before.ctimeNs
    ) {
      throw new ERROR("changed");
    }
    return bytes;
  } catch (error) {
    if (PLUGIN_ERROR_IS_INSTANCE(error)) throw error;
    throw new PluginError(
      "plugin_source_invalid",
      "Hosted extension declaration is unreadable or changed while reading.",
    );
  } finally {
    if (descriptor !== undefined) CLOSE_SYNC(descriptor);
  }
}

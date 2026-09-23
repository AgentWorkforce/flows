import { PluginError, type PluginFailureKind } from './plugin-manifest.js';

const OBJECT_DEFINE_PROPERTY = Object.defineProperty;
const OBJECT_FREEZE = Object.freeze;
const OBJECT_GET_OWN_PROPERTY_DESCRIPTOR = Object.getOwnPropertyDescriptor;
const OBJECT_PROTOTYPE = Object.prototype;
const INERT_THEN = {
  configurable: false,
  enumerable: false,
  value: undefined,
  writable: false,
} as const;
const PROTOTYPE_THEN_GET = () => undefined;
const PROTOTYPE_THEN_SET = function setOwnThen(this: object, value: unknown): void {
  if (this === OBJECT_PROTOTYPE) return;
  // Preserve ordinary `object.then = value` behavior for dependencies while
  // keeping the inherited slot immutable. Assignment reaches this setter only
  // when the receiver does not already have its own `then` property.
  OBJECT_DEFINE_PROPERTY(this, 'then', {
    configurable: true,
    enumerable: true,
    value,
    writable: true,
  });
};
const LOCKED_PROTOTYPE_THEN = {
  configurable: false,
  enumerable: false,
  get: PROTOTYPE_THEN_GET,
  set: PROTOTYPE_THEN_SET,
} as const;

// Promise assimilation consults the prototype after every async operation,
// not just at the public entry point. Lock this one dangerous slot while the
// realm is pristine so authored code cannot install a thenable between awaits.
const initialThen = OBJECT_GET_OWN_PROPERTY_DESCRIPTOR(OBJECT_PROTOTYPE, 'then');
if (initialThen === undefined) OBJECT_DEFINE_PROPERTY(OBJECT_PROTOTYPE, 'then', LOCKED_PROTOTYPE_THEN);
const installedThen = OBJECT_GET_OWN_PROPERTY_DESCRIPTOR(OBJECT_PROTOTYPE, 'then');
const PROMISE_PROTOTYPE_SAFE = installedThen !== undefined
  && installedThen.get === PROTOTYPE_THEN_GET
  && installedThen.set === PROTOTYPE_THEN_SET
  && installedThen.configurable === false
  && installedThen.enumerable === false;

/**
 * Promise resolution reads a returned object's inherited `then` property.
 * Refuse if module initialization did not begin in a pristine realm where the
 * inert prototype slot could be locked for the lifetime of the process.
 */
export function assertHostedPromiseSafety(
  code: PluginFailureKind,
  message = 'Hosted isolation refuses an ambient Object.prototype.then.',
): void {
  if (!PROMISE_PROTOTYPE_SAFE) {
    throw new PluginError(code, message);
  }
}

/** Shadow inherited thenables before an object is used to settle a promise. */
export function hostedPromiseValue<T extends object>(value: T): T {
  OBJECT_DEFINE_PROPERTY(value, 'then', INERT_THEN);
  return value;
}

/** Freeze a behavior-free object after shadowing inherited thenables. */
export function frozenHostedPromiseValue<T extends object>(value: T): Readonly<T> {
  return OBJECT_FREEZE(hostedPromiseValue(value));
}

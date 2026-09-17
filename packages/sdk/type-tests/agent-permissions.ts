import type { AgentOptions, PermissionsSpec as SurfacePermissionsSpec } from '@relayflows/surface';
import type { AgentStepSpec, PermissionsSpec } from '../src/spec.js';

type Assert<T extends true> = T;
type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
type _OptionalFieldParity = Assert<Equal<AgentOptions['permissions'], AgentStepSpec['permissions']>>;
type _ExportParity = Assert<Equal<SurfacePermissionsSpec, PermissionsSpec>>;

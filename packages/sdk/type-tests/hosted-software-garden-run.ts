import type { RunCliOptions } from '../src/cli.js';

type Hosted = NonNullable<RunCliOptions['hostedSoftwareGardenBabysitter']>;

// Production callers can supply only the verified authority/capability pair
// and a timeout. Sandbox executable paths remain internal test seams.
const noBubblewrapOverride: 'bubblewrapPath' extends keyof Hosted ? true : false = false;
const noNodeOverride: 'nodePath' extends keyof Hosted ? true : false = false;
const noPrlimitOverride: 'prlimitPath' extends keyof Hosted ? true : false = false;

void [noBubblewrapOverride, noNodeOverride, noPrlimitOverride];

// Offline fixture entry. The real Babysitter body lives on the babysitter
// branch of AgentWorkforce/flows; this stub exists so the manifest's `entry`
// resolves inside the fixture. Runtime composition is not implemented yet.
import { flow } from '@relayflows/surface';
export default flow('babysitter', async (f) => { f.done('declined'); });

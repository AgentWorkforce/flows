// Offline fixture entry: the handler surface of Babysitter, one `.on()` per
// subscription the manifest declares, over a body that only declines. The real
// review body lives on the babysitter branch of AgentWorkforce/flows; this
// file exists so composition can be proven against the declared contract.
import { flow, github, type Ctx } from '@relayflows/surface';

async function babysit(f: Ctx): Promise<void> { f.done('declined'); }

export default flow('babysitter', { budget: { dollars: 8, wallclock: '45m' } }, babysit)
  .on(github.pull_request('opened'), babysit)
  .on(github.pull_request('synchronize'), babysit)
  .on(github.pull_request('reopened'), babysit)
  .on(github.pull_request('ready_for_review'), babysit)
  .on(github.pull_request('closed'), babysit)
  .on(github.pull_request('labeled'), babysit)
  .on(github.pull_request('unlabeled'), babysit)
  .on(github.pull_request_review({ action: 'submitted' }), babysit)
  .on(github.pull_request_review({ action: 'dismissed' }), babysit)
  .on(github.check_run('completed'), babysit)
  .on(github.issue_comment('created'), babysit);

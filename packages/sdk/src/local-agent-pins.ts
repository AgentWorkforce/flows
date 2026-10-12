/** Surface a timed-out local agent pins so a fresh worker at the clean tree
 *  cannot take the continuation. The local worker always holds it. A step
 *  declares it only when a deadline can continue. */
export const LOCAL_AGENT_WORKSPACE = 'local-workspace';

/** Revision the local worker reports before a deadline stamps the dirty tree. */
export const LOCAL_AGENT_REVISION = 'local';

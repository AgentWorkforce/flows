//! Targeted ingress from the external authorized router, never a run broadcast.
use super::*;

#[derive(Debug)]
pub struct SubscriptionRouterError(pub &'static str);
impl std::fmt::Display for SubscriptionRouterError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.0)
    }
}
impl std::error::Error for SubscriptionRouterError {}

impl<C: Clock> Engine<C> {
    /// The protocol run lock serializes receipt validation with append/close.
    /// Cloud proves provider authority; the kernel fences the immutable receipt.
    pub fn deliver_subscription_frame(
        &self,
        run_id: &str,
        subscription_id: &str,
        router_binding: &Value,
        delivery_id: &str,
        frame: Value,
    ) -> Result<bool> {
        let journal = self.open_run(run_id)?;
        let states = subscriptions(&journal)?;
        let state = states
            .get(subscription_id)
            .ok_or(SubscriptionRouterError("subscription_not_active"))?;
        if &state.opened.router_binding != router_binding {
            return Err(SubscriptionRouterError("subscription_binding_mismatch").into());
        }
        if state.closed.is_some() || state.overflow_fence.is_some() {
            return Err(SubscriptionRouterError("subscription_closed").into());
        }
        drop(journal);
        self.append_subscription_frame(run_id, subscription_id, delivery_id, frame)
    }
}

impl<C: Clock> Engine<C> {
    /// Complete Cloud's durable overflow fence in the same journal sequencer.
    /// A matching closed receipt is an idempotent no-op, including a normal
    /// close that won the race before the external overflow signal.
    pub fn fence_router_subscription_overflow(
        &self,
        run_id: &str,
        subscription_id: &str,
        router_binding: &Value,
    ) -> Result<()> {
        let mut journal = self.open_run(run_id)?;
        let states = subscriptions(&journal)?;
        let state = states
            .get(subscription_id)
            .ok_or(SubscriptionRouterError("subscription_not_active"))?;
        if &state.opened.router_binding != router_binding {
            return Err(SubscriptionRouterError("subscription_binding_mismatch").into());
        }
        if state.closed.is_some() {
            return Ok(());
        }
        let unread = unread_frames(&journal.scan_all()?, state)?;
        self.fence_subscription_overflow_in_journal(
            &mut journal,
            subscription_id,
            unread.len() as u64,
            unread_bytes(&unread) as u64,
            state.acknowledged_offset,
            self.clock.now_ms(),
        )?;
        self.complete_fenced_overflows_in_journal(&mut journal, self.clock.now_ms())?;
        Ok(())
    }

    /// A read-only projection of durable subscription state for external
    /// routers. Absolute idle instants must never be rebuilt from callback time.
    pub fn inspect_subscriptions(&self, run_id: &str) -> Result<Vec<Value>> {
        let journal = self.open_run(run_id)?;
        let entries = journal.scan_all()?;
        let mut result = Vec::new();
        for (_, prepared) in prepared_subscriptions(&journal)? {
            result.push(json!({
                "subscriptionId": prepared.subscription_id, "state": "prepared",
                "unreadFrames": 0, "unreadBytes": 0,
                "settleMs": prepared.settle_ms, "deadlineAtMs": prepared.deadline_at_ms,
            }));
        }
        for (id, state) in subscriptions(&journal)? {
            let unread = unread_frames(&entries, &state)?;
            let mut snapshot = json!({
                "subscriptionId": id,
                "state": if state.closed.is_some() { "closed" } else { "active" },
                "routerBinding": state.opened.router_binding,
                "ingressOffset": state.opened.ingress_offset,
                "unreadFrames": unread.len(), "unreadBytes": unread_bytes(&unread),
                "settleMs": state.opened.settle_ms,
                "idleAtMs": state.active_wait.as_ref().and_then(|wait| wait.idle_at_ms)
                    .unwrap_or_else(|| state.last_wake_at_ms.saturating_add(state.opened.idle_ms)),
                "deadlineAtMs": state.opened.deadline_at_ms,
            });
            if let Some(reason) = state.closed {
                snapshot["completionReason"] = serde_json::to_value(reason)?;
            }
            result.push(snapshot);
        }
        result.sort_by(|a, b| {
            a["subscriptionId"]
                .as_str()
                .cmp(&b["subscriptionId"].as_str())
        });
        Ok(result)
    }
}

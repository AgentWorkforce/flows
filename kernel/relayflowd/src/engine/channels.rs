use super::Engine;
use anyhow::Result;
use relayflowd_core::{
    Clock, JournalEntry,
    channel::{ChannelActor, ChannelCommand},
};

impl<C: Clock> Engine<C> {
    /// Durable channel operations. Protocol callers additionally prove that
    /// their connection holds the named attempt's worker lease.
    pub fn channel_command(
        &self,
        actor: &ChannelActor,
        channel: &str,
        command: ChannelCommand,
    ) -> Result<Option<JournalEntry>> {
        let mut journal = self.open_run(&actor.run_id)?;
        let (entry, newly_appended) =
            journal.channel_command(actor, channel, command, self.clock.now_ms())?;
        if newly_appended && let (Some(observer), Some(entry)) = (&self.observer, &entry) {
            observer.appended(entry);
        }
        Ok(entry)
    }
}

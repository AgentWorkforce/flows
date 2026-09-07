use super::Engine;
use relayflowd_core::{
    Clock, JournalEntry,
    channel::{ChannelActor, ChannelCommand},
};

use relayflowd_journal::JournalStoreError;

/// Preserve channel conflicts through the engine boundary. Opening a run uses
/// the engine's contextual error; journal operations retain their typed error.
#[derive(Debug)]
pub enum ChannelCommandError {
    OpenRun(anyhow::Error),
    Journal(JournalStoreError),
}

impl std::fmt::Display for ChannelCommandError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::OpenRun(error) => error.fmt(formatter),
            Self::Journal(error) => error.fmt(formatter),
        }
    }
}

impl std::error::Error for ChannelCommandError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::OpenRun(error) => Some(error.as_ref()),
            Self::Journal(error) => Some(error),
        }
    }
}

impl<C: Clock> Engine<C> {
    /// Durable channel operations. Protocol callers additionally prove that
    /// their connection holds the named attempt's worker lease.
    pub fn channel_command(
        &self,
        actor: &ChannelActor,
        channel: &str,
        command: ChannelCommand,
    ) -> Result<Option<JournalEntry>, ChannelCommandError> {
        let mut journal = self
            .open_run(&actor.run_id)
            .map_err(ChannelCommandError::OpenRun)?;
        let (entry, newly_appended) = journal
            .channel_command(actor, channel, command, self.clock.now_ms())
            .map_err(ChannelCommandError::Journal)?;
        if newly_appended && let (Some(observer), Some(entry)) = (&self.observer, &entry) {
            observer.appended(entry);
        }
        Ok(entry)
    }
}

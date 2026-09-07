//! Routing replay shares field validation with journal admission.
use super::{RunState, StateError, decode};
use crate::{JournalEntry, RoutingDecision};
use std::collections::BTreeMap;

impl RunState {
    pub(super) fn apply_routing(&mut self, entry: &JournalEntry) -> Result<(), StateError> {
        let id = entry
            .step_id
            .as_ref()
            .ok_or(StateError::MissingStep(entry.seq))?;
        if self.routing.contains_key(id) {
            return Err(StateError::InvalidRouting {
                step: id.clone(),
                detail: "routing decision already recorded".into(),
            });
        }
        let route: RoutingDecision = decode(entry)?;
        self.validate_routing_decision(id, &route)?;
        self.routing.insert(id.clone(), route);
        Ok(())
    }

    pub(super) fn validate_routing(
        &self,
        routing: &BTreeMap<String, RoutingDecision>,
    ) -> Result<(), StateError> {
        for (id, route) in routing {
            self.validate_routing_decision(id, route)?;
        }
        Ok(())
    }

    fn validate_routing_decision(
        &self,
        id: &str,
        route: &RoutingDecision,
    ) -> Result<(), StateError> {
        if !self.steps.contains_key(id) {
            return Err(StateError::UnknownStep(id.into()));
        }
        route
            .validate()
            .map_err(|detail| StateError::InvalidRouting {
                step: id.into(),
                detail,
            })
    }
}

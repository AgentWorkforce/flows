use std::collections::{BTreeMap, BTreeSet};

use super::SpecError;

/// Reject dependency cycles without consuming call-stack depth from the spec.
pub(super) fn validate_dependency_cycles<'a>(
    ids: &'a BTreeSet<String>,
    dependencies: &BTreeMap<&'a str, &'a [String]>,
) -> Result<(), SpecError> {
    struct Frame<'a> {
        id: &'a str,
        next_dependency: usize,
    }

    let mut visiting = BTreeSet::new();
    let mut visited = BTreeSet::new();

    for id in ids {
        let id = id.as_str();
        if visited.contains(id) {
            continue;
        }

        visiting.insert(id);
        let mut frames = vec![Frame {
            id,
            next_dependency: 0,
        }];

        while let Some(frame) = frames.last_mut() {
            let step_dependencies = dependencies.get(frame.id).copied().unwrap_or_default();
            let Some(dependency) = step_dependencies.get(frame.next_dependency) else {
                let completed = frames.pop().expect("the active frame exists");
                visiting.remove(completed.id);
                visited.insert(completed.id);
                continue;
            };
            frame.next_dependency += 1;
            let dependency = dependency.as_str();

            if visited.contains(dependency) {
                continue;
            }
            if !visiting.insert(dependency) {
                return Err(SpecError::DependencyCycle(dependency.to_owned()));
            }
            frames.push(Frame {
                id: dependency,
                next_dependency: 0,
            });
        }
    }
    Ok(())
}

use std::collections::BTreeMap;
use std::sync::Arc;

use crate::{CliAdapter, SharedAdapter};

/// Lookup table of adapters by `cli_id`.
#[derive(Clone, Default)]
pub struct AdapterRegistry {
    adapters: BTreeMap<&'static str, SharedAdapter>,
}

impl AdapterRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    /// Every adapter shipped with COFFE. `include_fake` adds the `fake` adapter used by tests
    /// and demos (runner policy `enable_fake_cli`).
    pub fn builtin(include_fake: bool) -> Self {
        let mut registry = Self::new();
        for adapter in crate::adapters::all() {
            if include_fake || adapter.info().id != crate::adapters::FAKE_ID {
                registry.register(adapter);
            }
        }
        registry
    }

    pub fn register(&mut self, adapter: Arc<dyn CliAdapter>) {
        self.adapters.insert(adapter.info().id, adapter);
    }

    pub fn get(&self, cli_id: &str) -> Option<SharedAdapter> {
        self.adapters.get(cli_id).cloned()
    }

    pub fn all(&self) -> impl Iterator<Item = &SharedAdapter> {
        self.adapters.values()
    }
}

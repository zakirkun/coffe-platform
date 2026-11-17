//! COFFE runner: outbound WebSocket client of the control plane and the only component that
//! touches repositories, agent CLIs and local processes (architecture §7).

pub mod backoff;
pub mod config;
pub mod connection;
pub mod daemon;
pub mod detect;
pub mod envelope;
pub mod error;
pub mod git;
pub mod paths;
pub mod process;
pub mod pty_session;
pub mod repos;
pub mod run_api;
pub mod secrets;
pub mod spool;
pub mod supervisor;

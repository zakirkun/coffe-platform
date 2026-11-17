//! Error type shared by request handlers; every variant maps to a stable wire error code.

use coffe_protocol::ErrorPayload;

/// Failure of a control-plane request, reported as `error {code, message}` with `re` set.
#[derive(Debug, thiserror::Error)]
pub enum RunnerError {
    /// The request points outside the registered repos / runner-managed worktrees.
    #[error("{0}")]
    Scope(String),
    /// The local runner policy forbids the request.
    #[error("{0}")]
    Policy(String),
    #[error("{0}")]
    NotFound(String),
    #[error("{0}")]
    Invalid(String),
    /// No capacity right now; the control plane may retry later.
    #[error("{0}")]
    Busy(String),
    #[error("{0}")]
    Unsupported(String),
    #[error("{0}")]
    Internal(String),
}

impl RunnerError {
    /// Stable machine code used on the wire.
    pub fn code(&self) -> &'static str {
        match self {
            RunnerError::Scope(_) => "scope_violation",
            RunnerError::Policy(_) => "policy_denied",
            RunnerError::NotFound(_) => "not_found",
            RunnerError::Invalid(_) => "invalid_payload",
            RunnerError::Busy(_) => "busy",
            RunnerError::Unsupported(_) => "unsupported",
            RunnerError::Internal(_) => "internal",
        }
    }

    pub fn to_payload(&self) -> ErrorPayload {
        ErrorPayload { code: self.code().to_owned(), message: self.to_string() }
    }
}

impl From<std::io::Error> for RunnerError {
    fn from(err: std::io::Error) -> Self {
        RunnerError::Internal(err.to_string())
    }
}

impl From<crate::git::GitError> for RunnerError {
    fn from(err: crate::git::GitError) -> Self {
        use crate::git::GitError;
        match err {
            GitError::Scope(message) => RunnerError::Scope(message),
            GitError::Invalid(message) => RunnerError::Invalid(message),
            GitError::NotFound(message) => RunnerError::NotFound(message),
            other => RunnerError::Internal(other.to_string()),
        }
    }
}

impl From<tokio::task::JoinError> for RunnerError {
    fn from(err: tokio::task::JoinError) -> Self {
        RunnerError::Internal(format!("background task failed: {err}"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn codes_match_the_protocol_vocabulary() {
        assert_eq!(RunnerError::Scope("x".into()).code(), "scope_violation");
        assert_eq!(RunnerError::Policy("x".into()).code(), "policy_denied");
        assert_eq!(RunnerError::Busy("x".into()).code(), "busy");
        let payload = RunnerError::NotFound("no such run".into()).to_payload();
        assert_eq!(payload.code, "not_found");
        assert_eq!(payload.message, "no such run");
    }
}

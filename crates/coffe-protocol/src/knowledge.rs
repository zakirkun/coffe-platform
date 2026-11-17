//! Phase 4/5 payloads: code index (dependency graph for the Wiki Engine), source snippets for
//! citations, LSP diagnostics, and the agent-facing COFFE MCP server bridge.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

// ---------------------------------------------------------------------------
// Code index (architecture §12.8)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum GraphNodeKind {
    File,
    Module,
    Symbol,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum GraphEdgeKind {
    /// File → file import that resolved to a file in the repository.
    Imports,
    /// File → symbol it defines.
    Defines,
    /// File → symbol it references (name match; unverified).
    References,
    /// Module → file it contains.
    Contains,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct GraphNode {
    /// Stable id: `file:<path>`, `module:<dir>`, `symbol:<path>#<name>@<line>`.
    pub id: String,
    pub kind: GraphNodeKind,
    pub label: String,
    /// Repo-relative path (files, symbols) or directory (modules).
    pub path: String,
    #[serde(default)]
    pub language: Option<String>,
    /// `function` | `class` | `method` | `interface` | `type` | `module` | …
    #[serde(default)]
    pub symbol_kind: Option<String>,
    #[serde(default)]
    pub start_line: Option<u32>,
    #[serde(default)]
    pub end_line: Option<u32>,
    /// Community (cluster) id assigned by label propagation.
    #[serde(default)]
    pub community: Option<u32>,
    #[serde(default)]
    pub size_bytes: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct GraphEdge {
    pub from: String,
    pub to: String,
    pub kind: GraphEdgeKind,
    /// Resolved precisely (import path → existing file); name-based references are unverified.
    pub verified: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct GraphStats {
    pub files: u32,
    pub symbols: u32,
    pub edges: u32,
    pub skipped_files: u32,
    pub languages: Vec<String>,
    pub elapsed_ms: u64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct IndexBuild {
    pub repo_key: String,
    /// Commit-ish to index (defaults to the default branch head).
    #[serde(default)]
    pub rev: Option<String>,
    /// Include symbol nodes (functions, classes) in addition to files and modules.
    pub include_symbols: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct IndexGraph {
    pub repo_key: String,
    pub commit: String,
    pub nodes: Vec<GraphNode>,
    pub edges: Vec<GraphEdge>,
    pub stats: GraphStats,
    /// Nodes/edges were capped (very large repository).
    pub truncated: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct IndexWatch {
    pub repo_key: String,
    /// Branch whose head is watched (the repo's default branch).
    pub branch: String,
    /// Last commit the control plane knows about.
    #[serde(default)]
    pub known_commit: Option<String>,
}

/// The watched branch moved; the control plane refreshes the graph and marks citing pages stale.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct IndexChanged {
    pub repo_key: String,
    pub branch: String,
    #[serde(default)]
    pub old_commit: Option<String>,
    pub new_commit: String,
    /// Repo-relative paths changed between the two commits.
    pub files: Vec<String>,
}

/// Lines of a file at a commit, for rendering wiki citations (relayed, never stored).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct GitSnippet {
    pub repo_key: String,
    pub rev: String,
    pub path: String,
    pub start_line: u32,
    pub end_line: u32,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct GitSnippetResult {
    pub path: String,
    pub rev: String,
    pub start_line: u32,
    pub lines: Vec<String>,
    pub missing: bool,
}

/// Validates citations produced by a wiki run against a commit.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct CitationCheck {
    pub repo_key: String,
    pub rev: String,
    pub citations: Vec<CitationRef>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct CitationRef {
    pub path: String,
    pub start_line: u32,
    pub end_line: u32,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct CitationCheckResult {
    pub commit: String,
    /// Same order as the request; false when the file or line range does not exist.
    pub valid: Vec<bool>,
}

// ---------------------------------------------------------------------------
// LSP diagnostics gate (Phase 5)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum DiagnosticSeverity {
    Error,
    Warning,
    Information,
    Hint,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct Diagnostic {
    pub path: String,
    pub line: u32,
    pub column: u32,
    pub severity: DiagnosticSeverity,
    pub message: String,
    /// Language server that reported it (`typescript-language-server`, `rust-analyzer`, …).
    pub source: String,
    #[serde(default)]
    pub code: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct LspCheck {
    pub repo_key: String,
    pub branch: String,
    /// Repo-relative files to check (changed files of the ticket).
    pub files: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct LspCheckResult {
    pub diagnostics: Vec<Diagnostic>,
    /// Language servers that were found and ran.
    pub servers: Vec<String>,
    /// Files whose language had no server available.
    pub unchecked: Vec<String>,
}

// ---------------------------------------------------------------------------
// COFFE MCP server bridge (Phase 5): agent tool calls answered by the control plane
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct McpToolCall {
    pub call_id: Uuid,
    pub run_id: Uuid,
    /// `ticket_read` | `ticket_comment` | `ask_user` | `wiki_search` | `wiki_page` |
    /// `memory_search` | `memory_propose` | `canvas_read` | `canvas_write`.
    pub tool: String,
    pub arguments: serde_json::Value,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct McpToolResult {
    pub call_id: Uuid,
    pub ok: bool,
    /// Text content returned to the agent.
    pub content: String,
}

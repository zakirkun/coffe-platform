//! `coffe-runner` command line (architecture §7.1).

use std::net::ToSocketAddrs;
use std::path::PathBuf;
use std::process::ExitCode;
use std::time::Duration;

use clap::{Parser, Subcommand};
use coffe_adapters::AdapterRegistry;
use coffe_runner::config::RunnerConfig;
use coffe_runner::connection::{self, PairRequest};
use coffe_runner::daemon::{Daemon, DaemonExit, DaemonOptions};
use coffe_runner::detect::{self, SystemProbe};
use coffe_runner::git;
use coffe_runner::paths::RunnerHome;
use coffe_runner::repos;
use coffe_runner::secrets::SecretStore;

const EXIT_REVOKED: u8 = 2;
const EXIT_UPGRADE: u8 = 3;

#[derive(Parser)]
#[command(name = "coffe-runner", version, about = "COFFE runner: runs agent CLIs for a COFFE workspace")]
struct Cli {
    /// State directory (config, secrets, runs, worktrees). Defaults to the OS user directories.
    #[arg(long, global = true, env = "COFFE_RUNNER_HOME")]
    home: Option<PathBuf>,
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    /// Pair this machine with a workspace using a one-time token from the web app.
    Pair {
        #[arg(long)]
        server: String,
        #[arg(long)]
        token: String,
        /// Display name (defaults to the host name).
        #[arg(long)]
        name: Option<String>,
    },
    /// Run the daemon in the foreground.
    Start {
        /// Directory containing `coffe-fake-cli` (tests and demos).
        #[arg(long)]
        fake_cli_dir: Option<PathBuf>,
    },
    /// Show pairing, policy and registered repositories.
    Status,
    /// Check git, the server connection and installed agent CLIs.
    Doctor,
    /// Manage the local repository registry (never changed by the control plane).
    #[command(subcommand)]
    Repo(RepoCommand),
    /// Agent CLIs found on this machine.
    #[command(subcommand)]
    Cli(CliCommand),
    /// Forget the server binding, token and keys.
    Unpair,
}

#[derive(Subcommand)]
enum RepoCommand {
    /// Register the git repository containing PATH.
    Add {
        path: PathBuf,
        #[arg(long)]
        name: Option<String>,
    },
    List,
    /// Unregister by name or key.
    Remove { name: String },
}

#[derive(Subcommand)]
enum CliCommand {
    List,
}

fn main() -> ExitCode {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info")),
        )
        .with_target(false)
        .init();
    let _ = rustls::crypto::ring::default_provider().install_default();

    let cli = Cli::parse();
    let home = match RunnerHome::resolve(cli.home.as_deref()) {
        Ok(home) => home,
        Err(err) => {
            eprintln!("error: {err}");
            return ExitCode::FAILURE;
        }
    };
    match run(cli.command, home) {
        Ok(code) => code,
        Err(err) => {
            eprintln!("error: {err:#}");
            ExitCode::FAILURE
        }
    }
}

fn run(command: Command, home: RunnerHome) -> anyhow::Result<ExitCode> {
    match command {
        Command::Pair { server, token, name } => pair(&home, &server, &token, name),
        Command::Start { fake_cli_dir } => start(home, fake_cli_dir),
        Command::Status => status(&home),
        Command::Doctor => doctor(&home),
        Command::Repo(RepoCommand::Add { path, name }) => {
            let mut config = RunnerConfig::load(&home.config_file())?;
            let entry = repos::add(&mut config, &path, name.as_deref())?;
            config.save(&home.config_file())?;
            println!("registered {} ({}) as {}", entry.name, entry.path.display(), entry.key);
            println!("restart `coffe-runner start` (or use Re-detect in the web app) to report it");
            Ok(ExitCode::SUCCESS)
        }
        Command::Repo(RepoCommand::List) => {
            let config = RunnerConfig::load(&home.config_file())?;
            if config.repos.is_empty() {
                println!("no repositories registered; use `coffe-runner repo add <path>`");
            }
            for entry in &config.repos {
                let info = repos::describe(entry);
                println!(
                    "{}\t{}\t{}\t{}",
                    entry.name,
                    entry.path.display(),
                    info.default_branch.as_deref().unwrap_or("-"),
                    if info.available { "ok" } else { "missing" }
                );
            }
            Ok(ExitCode::SUCCESS)
        }
        Command::Repo(RepoCommand::Remove { name }) => {
            let mut config = RunnerConfig::load(&home.config_file())?;
            let removed = repos::remove(&mut config, &name)?;
            config.save(&home.config_file())?;
            println!("unregistered {} ({})", removed.name, removed.path.display());
            Ok(ExitCode::SUCCESS)
        }
        Command::Cli(CliCommand::List) => {
            let config = RunnerConfig::load(&home.config_file())?;
            let registry = AdapterRegistry::builtin(config.policy.enable_fake_cli);
            let found = detect::detect_all(&registry, &SystemProbe::new(), |id| config.policy.cli_allowed(id));
            if found.is_empty() {
                println!("no supported agent CLI found on PATH");
            }
            for entry in found {
                println!(
                    "{}\t{}\t{}\t{:?}",
                    entry.info.id,
                    entry.version.as_deref().unwrap_or("?"),
                    entry.path.display(),
                    entry.info.auth
                );
            }
            Ok(ExitCode::SUCCESS)
        }
        Command::Unpair => {
            SecretStore::new(home.secrets_dir()).wipe()?;
            let mut config = RunnerConfig::load(&home.config_file())?;
            config.server_url = None;
            config.runner_id = None;
            config.workspace_id = None;
            config.save(&home.config_file())?;
            println!("unpaired; repositories and policy were kept");
            Ok(ExitCode::SUCCESS)
        }
    }
}

fn runtime() -> anyhow::Result<tokio::runtime::Runtime> {
    Ok(tokio::runtime::Builder::new_multi_thread().enable_all().build()?)
}

fn pair(home: &RunnerHome, server: &str, token: &str, name: Option<String>) -> anyhow::Result<ExitCode> {
    let secrets = SecretStore::new(home.secrets_dir());
    let keys = secrets.load_or_create_keys()?;
    let hostname = gethostname::gethostname().to_string_lossy().into_owned();
    let request = PairRequest { name: name.unwrap_or_else(|| hostname.clone()), hostname };
    let paired = runtime()?.block_on(connection::pair(server, token, request.clone(), &keys))?;
    secrets.save_token(&paired.runner_token)?;
    let mut config = RunnerConfig::load(&home.config_file())?;
    config.server_url = Some(server.trim_end_matches('/').to_owned());
    config.runner_id = Some(paired.runner_id);
    config.workspace_id = Some(paired.workspace_id.clone());
    config.name = Some(request.name);
    config.save(&home.config_file())?;
    println!("paired as runner {} in workspace {}", paired.runner_id, paired.workspace_id);
    println!("fingerprint: {}", paired.fingerprint);
    println!("compare it with the fingerprint shown in the web app, then run `coffe-runner start`");
    Ok(ExitCode::SUCCESS)
}

fn start(home: RunnerHome, fake_cli_dir: Option<PathBuf>) -> anyhow::Result<ExitCode> {
    runtime()?.block_on(async move {
        let daemon = Daemon::new(DaemonOptions { home, extra_bin_dir: fake_cli_dir })?;
        Ok(match daemon.run().await? {
            DaemonExit::Revoked => {
                eprintln!("the runner token was revoked or is unknown; pair again with `coffe-runner pair`");
                ExitCode::from(EXIT_REVOKED)
            }
            DaemonExit::Replaced => {
                eprintln!("another coffe-runner process connected with this token; stopping");
                ExitCode::SUCCESS
            }
            DaemonExit::UpgradeRequired(message) => {
                eprintln!("{message}");
                ExitCode::from(EXIT_UPGRADE)
            }
        })
    })
}

fn status(home: &RunnerHome) -> anyhow::Result<ExitCode> {
    let config = RunnerConfig::load(&home.config_file())?;
    let secrets = SecretStore::new(home.secrets_dir());
    match config.pairing() {
        Some(pairing) => println!("paired: runner {} → {}", pairing.runner_id, pairing.server_url),
        None => println!("not paired"),
    }
    if let Some(keys) = secrets.load_keys()? {
        println!("fingerprint: {}", keys.fingerprint()?);
    }
    println!("token: {}", if secrets.load_token()?.is_some() { "present" } else { "missing" });
    println!("config: {}", home.config_file().display());
    println!("policy: {}", toml::to_string(&config.policy)?.trim().replace('\n', ", "));
    println!("repositories: {}", config.repos.len());
    for entry in &config.repos {
        println!("  {} → {}", entry.name, entry.path.display());
    }
    Ok(ExitCode::SUCCESS)
}

fn doctor(home: &RunnerHome) -> anyhow::Result<ExitCode> {
    let mut healthy = true;
    match git::version() {
        Ok((major, minor, patch)) if (major, minor) >= git::MIN_GIT_VERSION => println!("git {major}.{minor}.{patch}: ok"),
        Ok((major, minor, patch)) => {
            healthy = false;
            println!("git {major}.{minor}.{patch}: too old, need ≥ {}.{}", git::MIN_GIT_VERSION.0, git::MIN_GIT_VERSION.1);
        }
        Err(err) => {
            healthy = false;
            println!("git: {err}");
        }
    }
    let config = RunnerConfig::load(&home.config_file())?;
    let secrets = SecretStore::new(home.secrets_dir());
    match (config.pairing(), secrets.load_token()?) {
        (Some(pairing), Some(_)) => {
            let reachable = reachable(&pairing.server_url);
            healthy &= reachable;
            println!("server {}: {}", pairing.server_url, if reachable { "reachable" } else { "unreachable" });
        }
        _ => {
            healthy = false;
            println!("pairing: missing (run `coffe-runner pair`)");
        }
    }
    let registry = AdapterRegistry::builtin(config.policy.enable_fake_cli);
    let found = detect::detect_all(&registry, &SystemProbe::new(), |id| config.policy.cli_allowed(id));
    println!("agent CLIs: {}", if found.is_empty() { "none found".to_owned() } else { found.iter().map(|e| e.info.id.clone()).collect::<Vec<_>>().join(", ") });
    for entry in &config.repos {
        let info = repos::describe(entry);
        healthy &= info.available;
        println!("repo {}: {}", entry.name, if info.available { "ok" } else { "missing or not a git repository" });
    }
    Ok(if healthy { ExitCode::SUCCESS } else { ExitCode::FAILURE })
}

/// TCP reachability of the server's host:port (no TLS, no token).
fn reachable(server_url: &str) -> bool {
    let Some((scheme, rest)) = server_url.split_once("://") else { return false };
    let authority = rest.split('/').next().unwrap_or(rest);
    let default_port = if scheme.eq_ignore_ascii_case("https") { 443 } else { 80 };
    let address = if authority.rsplit_once(':').is_some_and(|(_, port)| port.parse::<u16>().is_ok()) {
        authority.to_owned()
    } else {
        format!("{authority}:{default_port}")
    };
    address
        .to_socket_addrs()
        .ok()
        .and_then(|mut addrs| addrs.next())
        .is_some_and(|addr| std::net::TcpStream::connect_timeout(&addr, Duration::from_secs(5)).is_ok())
}

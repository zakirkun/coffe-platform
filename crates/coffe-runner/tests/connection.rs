//! Connection, pairing and daemon handshake against an in-process WebSocket server.

use std::net::SocketAddr;

use coffe_protocol::{
    PROTOCOL_HEADER, Paired, ResumeCursor, RunOutput, RunState, RunStatus, RunnerEnvelope, RunnerMessage,
    ServerEnvelope, ServerMessage, Welcome, close_codes,
};
use coffe_runner::config::RunnerConfig;
use coffe_runner::connection::{self, ConnectError, PairRequest};
use coffe_runner::daemon::{Daemon, DaemonExit, DaemonOptions};
use coffe_runner::paths::RunnerHome;
use coffe_runner::secrets::{RunnerKeys, SecretStore};
use coffe_runner::spool::RunSpool;
use futures_util::{SinkExt, StreamExt};
use tokio::net::TcpListener;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::tungstenite::handshake::server::{ErrorResponse, Request, Response};
use tokio_tungstenite::tungstenite::http::StatusCode;
use tokio_tungstenite::tungstenite::protocol::CloseFrame;
use tokio_tungstenite::tungstenite::protocol::frame::coding::CloseCode;
use uuid::Uuid;

fn install_crypto() {
    let _ = rustls::crypto::ring::default_provider().install_default();
}

async fn listener() -> (TcpListener, SocketAddr) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    (listener, addr)
}

fn server_frame(msg: ServerMessage, re: Option<Uuid>) -> Message {
    let env = ServerEnvelope { id: Uuid::now_v7(), re, ts: "2026-11-17T00:00:00Z".into(), msg };
    Message::Text(serde_json::to_string(&env).unwrap().into())
}

fn parse_runner(message: Message) -> RunnerEnvelope {
    match message {
        Message::Text(text) => serde_json::from_str(text.as_str()).unwrap(),
        other => panic!("expected a text frame, got {other:?}"),
    }
}

/// Accepts one upgrade; checks the bearer token and protocol header (401 when the token differs).
async fn accept(listener: &TcpListener, expected_token: &'static str) -> tokio_tungstenite::WebSocketStream<tokio::net::TcpStream> {
    let (stream, _) = listener.accept().await.unwrap();
    tokio_tungstenite::accept_hdr_async(stream, move |request: &Request, response: Response| {
        let auth = request.headers().get("authorization").and_then(|v| v.to_str().ok()).unwrap_or_default();
        let protocol = request.headers().get(PROTOCOL_HEADER).and_then(|v| v.to_str().ok()).unwrap_or_default();
        if auth != format!("Bearer {expected_token}") || protocol != "1.0" {
            let mut rejection = ErrorResponse::new(Some("token rejected".to_owned()));
            *rejection.status_mut() = StatusCode::UNAUTHORIZED;
            return Err(rejection);
        }
        Ok(response)
    })
    .await
    .unwrap()
}

#[tokio::test]
async fn pairing_round_trip_returns_the_runner_token() {
    install_crypto();
    let (listener, addr) = listener().await;
    let runner_id = Uuid::now_v7();
    let server = tokio::spawn(async move {
        let mut ws = accept(&listener, "coffe_pt_one_time").await;
        let frame = parse_runner(ws.next().await.unwrap().unwrap());
        let RunnerMessage::Pair(pair) = frame.msg else { panic!("expected pair, got {:?}", frame.msg) };
        assert_eq!(pair.name, "build-vm");
        assert!(!pair.keys.box_key_signature.is_empty());
        ws.send(server_frame(
            ServerMessage::Paired(Paired {
                runner_id,
                workspace_id: "ws-1".into(),
                runner_token: "coffe_rt_secret".into(),
                fingerprint: "AAAA BBBB".into(),
            }),
            Some(frame.id),
        ))
        .await
        .unwrap();
        let _ = ws.close(None).await;
    });

    let keys = RunnerKeys::generate();
    let paired = connection::pair(
        &format!("http://{addr}"),
        "coffe_pt_one_time",
        PairRequest { name: "build-vm".into(), hostname: "host".into() },
        &keys,
    )
    .await
    .unwrap();
    assert_eq!(paired.runner_id, runner_id);
    assert_eq!(paired.runner_token, "coffe_rt_secret");
    server.await.unwrap();
}

#[tokio::test]
async fn rejected_tokens_are_reported_as_unauthorized() {
    install_crypto();
    let (listener, addr) = listener().await;
    let server = tokio::spawn(async move {
        let (stream, _) = listener.accept().await.unwrap();
        let _ = tokio_tungstenite::accept_hdr_async(stream, |_: &Request, _: Response| {
            let mut rejection = ErrorResponse::new(Some("Runner token is unknown or revoked".to_owned()));
            *rejection.status_mut() = StatusCode::UNAUTHORIZED;
            Err(rejection)
        })
        .await;
    });
    let err = connection::connect(&format!("http://{addr}"), "coffe_rt_revoked").await.unwrap_err();
    assert!(matches!(err, ConnectError::Unauthorized { status: 401, .. }), "{err:?}");
    server.await.unwrap();
}

/// A runner restarted with an unfinished run: the run is reported `interrupted`, `hello` lists
/// it, every spooled frame above the welcome cursor is replayed, and close 4001 stops the daemon.
#[tokio::test]
async fn daemon_reports_interrupted_runs_replays_spool_and_exits_when_revoked() {
    install_crypto();
    let (listener, addr) = listener().await;
    let dir = tempfile::tempdir().unwrap();
    let home = RunnerHome::resolve(Some(dir.path())).unwrap();
    let runner_id = Uuid::now_v7();

    let mut config = RunnerConfig::default();
    config.server_url = Some(format!("http://{addr}"));
    config.runner_id = Some(runner_id);
    config.workspace_id = Some("ws-1".into());
    config.policy.allowed_clis = Some(Vec::new());
    config.save(&home.config_file()).unwrap();
    let secrets = SecretStore::new(home.secrets_dir());
    secrets.save_token("coffe_rt_valid").unwrap();
    secrets.load_or_create_keys().unwrap();

    // A run that was alive when the previous process died: state + one output frame unacked.
    let run_id = Uuid::now_v7();
    {
        let mut spool = RunSpool::open(&home.runs_dir(), run_id).unwrap();
        let seq = spool.next_seq();
        spool
            .append(
                seq,
                &RunnerMessage::RunState(RunState {
                    run_id,
                    seq,
                    status: RunStatus::Running,
                    detail: None,
                    exit_code: None,
                    cli_session_id: Some("sess-9".into()),
                    worktree: None,
                    resumable: None,
                }),
            )
            .unwrap();
        let seq = spool.next_seq();
        spool.append(seq, &RunnerMessage::RunOutput(RunOutput { run_id, seq, data: "aGk=".into() })).unwrap();
    }

    let server = tokio::spawn(async move {
        let mut ws = accept(&listener, "coffe_rt_valid").await;
        let hello = parse_runner(ws.next().await.unwrap().unwrap());
        let RunnerMessage::Hello(hello) = hello.msg else { panic!("expected hello") };
        assert_eq!(hello.runner_id, runner_id);
        let active = hello.active_runs.iter().find(|r| r.run_id == run_id).expect("run listed in hello");
        assert_eq!(active.status, RunStatus::Interrupted);
        assert_eq!(active.last_seq, 3, "state + output + interrupted state");

        ws.send(server_frame(
            ServerMessage::Welcome(Welcome {
                protocol: "1.0".into(),
                server_version: "test".into(),
                server_time: "2026-11-17T00:00:00Z".into(),
                heartbeat_secs: 30,
                resume: vec![ResumeCursor { run_id, ack_seq: 1 }],
                cancel: Vec::new(),
            }),
            None,
        ))
        .await
        .unwrap();

        let mut replayed = Vec::new();
        while replayed.len() < 2 {
            let frame = parse_runner(ws.next().await.unwrap().unwrap());
            match frame.msg {
                RunnerMessage::RunOutput(out) => replayed.push(("output", out.seq)),
                RunnerMessage::RunState(state) => {
                    assert_eq!(state.status, RunStatus::Interrupted);
                    assert_eq!(state.resumable, Some(true));
                    replayed.push(("state", state.seq));
                }
                other => panic!("unexpected frame {other:?}"),
            }
        }
        assert_eq!(replayed, vec![("output", 2), ("state", 3)]);
        ws.close(Some(CloseFrame { code: CloseCode::from(close_codes::UNAUTHORIZED), reason: "revoked".into() }))
            .await
            .unwrap();
        // Drain until the runner closes its side.
        while let Some(Ok(_)) = ws.next().await {}
    });

    let daemon = Daemon::new(DaemonOptions { home, extra_bin_dir: None }).unwrap();
    let exit = tokio::time::timeout(std::time::Duration::from_secs(30), daemon.run()).await.unwrap().unwrap();
    assert_eq!(exit, DaemonExit::Revoked);
    server.await.unwrap();
}

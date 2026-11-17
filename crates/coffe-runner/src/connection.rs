//! Outbound WebSocket to the control plane (architecture §8.1, §8.3): URL mapping, bearer
//! authentication on the upgrade request, and the one-shot pairing exchange.

use std::time::Duration;

use coffe_protocol::{
    PROTOCOL_HEADER, PROTOCOL_VERSION, Pair, Paired, RunnerMessage, ServerEnvelope, ServerMessage,
};
use futures_util::{SinkExt, StreamExt};
use tokio::net::TcpStream;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::http::HeaderValue;
use tokio_tungstenite::tungstenite::{self, Message};
use tokio_tungstenite::{MaybeTlsStream, WebSocketStream};

use crate::envelope;
use crate::secrets::RunnerKeys;

pub type WsStream = WebSocketStream<MaybeTlsStream<TcpStream>>;

/// Path of the runner endpoint on the control plane.
pub const RUNNER_PATH: &str = "/api/runner";
const PAIR_TIMEOUT: Duration = Duration::from_secs(30);

#[derive(Debug, thiserror::Error)]
pub enum ConnectError {
    #[error("the control plane rejected the token (HTTP {status}): {message}")]
    Unauthorized { status: u16, message: String },
    #[error("the control plane answered HTTP {status}: {message}")]
    Http { status: u16, message: String },
    #[error("invalid server URL {0:?}: use http(s)://host[:port]")]
    InvalidUrl(String),
    #[error("connection failed: {0}")]
    Io(String),
}

/// `https://coffe.example.com` → `wss://coffe.example.com/api/runner` (http → ws).
pub fn runner_ws_url(server: &str) -> Result<String, ConnectError> {
    let trimmed = server.trim().trim_end_matches('/');
    let (scheme, rest) = trimmed.split_once("://").ok_or_else(|| ConnectError::InvalidUrl(server.to_owned()))?;
    let ws_scheme = match scheme.to_ascii_lowercase().as_str() {
        "http" | "ws" => "ws",
        "https" | "wss" => "wss",
        _ => return Err(ConnectError::InvalidUrl(server.to_owned())),
    };
    if rest.is_empty() {
        return Err(ConnectError::InvalidUrl(server.to_owned()));
    }
    let base = rest.trim_end_matches(RUNNER_PATH);
    Ok(format!("{ws_scheme}://{base}{RUNNER_PATH}"))
}

/// Opens the runner socket authenticated with a pairing (`coffe_pt_`) or runner (`coffe_rt_`)
/// token. A 401/403 means the token is unknown, used, expired or revoked.
pub async fn connect(server: &str, token: &str) -> Result<WsStream, ConnectError> {
    let url = runner_ws_url(server)?;
    let mut request = url
        .as_str()
        .into_client_request()
        .map_err(|_| ConnectError::InvalidUrl(server.to_owned()))?;
    let bearer = HeaderValue::from_str(&format!("Bearer {token}"))
        .map_err(|_| ConnectError::Io("the token contains invalid characters".to_owned()))?;
    request.headers_mut().insert("Authorization", bearer);
    request.headers_mut().insert(PROTOCOL_HEADER, HeaderValue::from_static(PROTOCOL_VERSION));
    match tokio_tungstenite::connect_async(request).await {
        Ok((ws, _response)) => Ok(ws),
        Err(tungstenite::Error::Http(response)) => {
            let status = response.status().as_u16();
            let message = response
                .body()
                .as_deref()
                .map(|body| String::from_utf8_lossy(body).trim().to_owned())
                .filter(|text| !text.is_empty())
                .unwrap_or_else(|| response.status().canonical_reason().unwrap_or("").to_owned());
            if status == 401 || status == 403 {
                Err(ConnectError::Unauthorized { status, message })
            } else {
                Err(ConnectError::Http { status, message })
            }
        }
        Err(err) => Err(ConnectError::Io(err.to_string())),
    }
}

/// What `pair` needs to describe this machine.
#[derive(Debug, Clone)]
pub struct PairRequest {
    pub name: String,
    pub hostname: String,
}

#[derive(Debug, thiserror::Error)]
pub enum PairError {
    #[error(transparent)]
    Connect(#[from] ConnectError),
    #[error("pairing rejected: {0}")]
    Rejected(String),
    #[error("pairing failed: {0}")]
    Protocol(String),
}

/// `pair` → `paired` on a connection authenticated with the one-time pairing token.
pub async fn pair(server: &str, pairing_token: &str, request: PairRequest, keys: &RunnerKeys) -> Result<Paired, PairError> {
    let public_keys = keys.public_keys().map_err(|err| PairError::Protocol(err.to_string()))?;
    let mut ws = connect(server, pairing_token).await?;
    let frame = envelope::encode(
        RunnerMessage::Pair(Pair {
            name: request.name,
            hostname: request.hostname,
            os: std::env::consts::OS.to_owned(),
            arch: std::env::consts::ARCH.to_owned(),
            runner_version: env!("CARGO_PKG_VERSION").to_owned(),
            keys: public_keys,
        }),
        None,
    );
    ws.send(Message::Text(frame.into())).await.map_err(|err| PairError::Protocol(err.to_string()))?;

    let reply = tokio::time::timeout(PAIR_TIMEOUT, async {
        while let Some(message) = ws.next().await {
            match message {
                Ok(Message::Text(text)) => match envelope::decode(text.as_str()) {
                    Ok(ServerEnvelope { msg: ServerMessage::Paired(paired), .. }) => return Ok(paired),
                    Ok(ServerEnvelope { msg: ServerMessage::Error(err), .. }) => {
                        return Err(PairError::Rejected(format!("{} ({})", err.message, err.code)));
                    }
                    Ok(ServerEnvelope { msg: ServerMessage::UpgradeRequired(up), .. }) => {
                        return Err(PairError::Rejected(up.message));
                    }
                    Ok(_) => continue,
                    Err(unparsed) => return Err(PairError::Protocol(unparsed.error)),
                },
                Ok(Message::Close(frame)) => {
                    let reason = frame.map(|f| format!("{} {}", u16::from(f.code), f.reason)).unwrap_or_default();
                    return Err(PairError::Rejected(format!("connection closed {reason}").trim().to_owned()));
                }
                Ok(_) => continue,
                Err(err) => return Err(PairError::Protocol(err.to_string())),
            }
        }
        Err(PairError::Protocol("connection closed before `paired`".to_owned()))
    })
    .await
    .map_err(|_| PairError::Protocol("no answer within 30 s".to_owned()))??;
    let _ = ws.close(None).await;
    Ok(reply)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_http_urls_to_the_runner_socket() {
        assert_eq!(runner_ws_url("http://localhost:4000").unwrap(), "ws://localhost:4000/api/runner");
        assert_eq!(runner_ws_url("https://coffe.example.com/").unwrap(), "wss://coffe.example.com/api/runner");
        assert_eq!(runner_ws_url("wss://h/api/runner").unwrap(), "wss://h/api/runner");
        assert!(runner_ws_url("coffe.example.com").is_err());
        assert!(runner_ws_url("ftp://x").is_err());
        assert!(runner_ws_url("https://").is_err());
    }
}

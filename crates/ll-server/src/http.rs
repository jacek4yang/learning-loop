use std::net::SocketAddr;
use std::time::Duration;

use axum::body::{Body, Bytes};
use axum::error_handling::HandleErrorLayer;
use axum::extract::{ConnectInfo, DefaultBodyLimit, OriginalUri, State};
use axum::http::header::{CACHE_CONTROL, CONTENT_TYPE, X_CONTENT_TYPE_OPTIONS};
use axum::http::{HeaderValue, StatusCode};
use axum::response::Response;
use axum::routing::{get, post};
use axum::{BoxError, Router};
use ll_protocol::{
    MAX_HANDSHAKE_BYTES, MAX_HTTP_BODY_BYTES, decode_transport_frame, encode_transport_frame,
};
use tower::ServiceBuilder;
use tower::limit::ConcurrencyLimitLayer;
use tower::timeout::TimeoutLayer;

use crate::session::SessionCancellationGuard;
use crate::state::{AppState, HandshakeFailure};

const REQUEST_TIMEOUT: Duration = Duration::from_mins(2);
const MAX_CONCURRENT_REQUESTS: usize = 128;

pub(crate) fn router(state: AppState) -> Router {
    let safeguards = ServiceBuilder::new()
        .layer(HandleErrorLayer::new(handle_service_error))
        .layer(TimeoutLayer::new(REQUEST_TIMEOUT))
        .layer(ConcurrencyLimitLayer::new(MAX_CONCURRENT_REQUESTS));
    Router::new()
        .route("/v1/bootstrap", get(bootstrap))
        .route("/v1/handshake", post(handshake))
        .route("/v1/envelope", post(envelope))
        .fallback(not_found)
        .layer(DefaultBodyLimit::max(MAX_HTTP_BODY_BYTES))
        .layer(safeguards)
        .with_state(state)
}

async fn bootstrap(State(state): State<AppState>, OriginalUri(uri): OriginalUri) -> Response {
    if uri.query().is_some() {
        return empty_response(StatusCode::BAD_REQUEST);
    }
    binary_response(
        StatusCode::OK,
        "application/cbor",
        state.bootstrap().to_vec(),
    )
}

async fn handshake(
    State(state): State<AppState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    OriginalUri(uri): OriginalUri,
    body: Bytes,
) -> Response {
    if uri.query().is_some() || body.is_empty() || body.len() > MAX_HANDSHAKE_BYTES {
        return empty_response(StatusCode::BAD_REQUEST);
    }
    match state.handshake(peer.ip(), &body) {
        Ok(response) => binary_response(StatusCode::OK, "application/octet-stream", response),
        Err(HandshakeFailure::RateLimited) => empty_response(StatusCode::TOO_MANY_REQUESTS),
        Err(HandshakeFailure::Invalid | HandshakeFailure::Capacity) => {
            empty_response(StatusCode::BAD_REQUEST)
        }
    }
}

async fn envelope(
    State(state): State<AppState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    OriginalUri(uri): OriginalUri,
    body: Bytes,
) -> Response {
    if uri.query().is_some() {
        return empty_response(StatusCode::BAD_REQUEST);
    }
    let Ok(frame) = decode_transport_frame(&body) else {
        return empty_response(StatusCode::BAD_REQUEST);
    };
    let Some(session) = state.session(&frame.session_handle) else {
        return empty_response(StatusCode::BAD_REQUEST);
    };
    let sessions = state.sessions();
    let mut cancellation_guard = SessionCancellationGuard::new(sessions, frame.session_handle);
    match state
        .process_envelope(peer.ip(), session, frame.ciphertext)
        .await
    {
        Ok(result) => {
            if result.close_session {
                state.remove_session(&frame.session_handle);
            }
            let Ok(encoded) =
                encode_transport_frame(&frame.session_handle, &result.ciphertext_records)
            else {
                state.remove_session(&frame.session_handle);
                cancellation_guard.disarm();
                return empty_response(StatusCode::INTERNAL_SERVER_ERROR);
            };
            cancellation_guard.disarm();
            binary_response(StatusCode::OK, "application/octet-stream", encoded)
        }
        Err(_) => empty_response(StatusCode::BAD_REQUEST),
    }
}

async fn not_found() -> Response {
    empty_response(StatusCode::NOT_FOUND)
}

async fn handle_service_error(_error: BoxError) -> Response {
    empty_response(StatusCode::REQUEST_TIMEOUT)
}

fn binary_response(status: StatusCode, content_type: &'static str, body: Vec<u8>) -> Response {
    let mut response = Response::new(Body::from(body));
    *response.status_mut() = status;
    let headers = response.headers_mut();
    headers.insert(CONTENT_TYPE, HeaderValue::from_static(content_type));
    headers.insert(CACHE_CONTROL, HeaderValue::from_static("no-store"));
    headers.insert(X_CONTENT_TYPE_OPTIONS, HeaderValue::from_static("nosniff"));
    response
}

fn empty_response(status: StatusCode) -> Response {
    binary_response(status, "application/octet-stream", Vec::new())
}

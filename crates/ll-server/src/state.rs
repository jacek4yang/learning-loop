use std::net::IpAddr;
use std::sync::Arc;

use ll_crypto::{
    ServerIdentity, accept_handshake, authentication_context, decrypt_transport_records,
    encrypt_transport_records, random_array,
};
use ll_protocol::{
    AuthChallenge, Bootstrap, ClientMessage, ErrorCode, MAX_HANDSHAKE_BYTES,
    MAX_TRANSPORT_CIPHERTEXT_BYTES, NOISE_SUITE, PROTOCOL_VERSION, Response, ServerMessage,
    decode_client_message, encode_auth_challenge, encode_bootstrap, encode_server_message,
};
use tokio::sync::Mutex;

use crate::application::Application;
use crate::rate_limit::RateLimiter;
use crate::session::{MAX_SESSION_MESSAGES, Session, SessionPhase, SessionStore};
use crate::storage::InitializedStorage;

#[derive(Clone)]
pub(crate) struct AppState {
    inner: Arc<Inner>,
}

struct Inner {
    identity: ServerIdentity,
    instance_id: [u8; 16],
    authentication_salt: [u8; 16],
    argon2_policy: ll_crypto::Argon2Policy,
    bootstrap: Vec<u8>,
    application: Application,
    sessions: Arc<SessionStore>,
    rate_limiter: Arc<RateLimiter>,
}

pub(crate) struct EnvelopeResult {
    pub ciphertext_records: Vec<u8>,
    pub close_session: bool,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum HandshakeFailure {
    Invalid,
    RateLimited,
    Capacity,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum EnvelopeFailure {
    Invalid,
}

impl AppState {
    pub fn new(identity: ServerIdentity, initialized: InitializedStorage) -> Result<Self, ()> {
        let bootstrap = encode_bootstrap(&Bootstrap {
            protocol_version: PROTOCOL_VERSION,
            instance_id: initialized.instance_id,
            noise_suite: NOISE_SUITE.to_owned(),
            server_static_public_key: *identity.public_key(),
            server_fingerprint: identity.fingerprint().to_owned(),
            maximum_handshake_bytes: u32::try_from(MAX_HANDSHAKE_BYTES).map_err(|_| ())?,
            maximum_transport_bytes: u32::try_from(MAX_TRANSPORT_CIPHERTEXT_BYTES)
                .map_err(|_| ())?,
        })
        .map_err(|_| ())?;
        let authentication_key = Arc::new(initialized.authentication_key);
        let rate_limiter = Arc::new(RateLimiter::default());
        let application = Application::new(
            initialized.storage,
            Arc::clone(&authentication_key),
            Arc::clone(&rate_limiter),
        );
        Ok(Self {
            inner: Arc::new(Inner {
                identity,
                instance_id: initialized.instance_id,
                authentication_salt: initialized.authentication_salt,
                argon2_policy: initialized.argon2_policy,
                bootstrap,
                application,
                sessions: Arc::new(SessionStore::default()),
                rate_limiter,
            }),
        })
    }

    pub fn bootstrap(&self) -> &[u8] {
        &self.inner.bootstrap
    }

    pub fn sessions(&self) -> Arc<SessionStore> {
        Arc::clone(&self.inner.sessions)
    }

    pub fn session(&self, handle: &[u8; 32]) -> Option<Arc<Mutex<Session>>> {
        self.inner.sessions.get(handle)
    }

    pub fn remove_session(&self, handle: &[u8; 32]) {
        self.inner.sessions.remove(handle);
    }

    pub fn handshake(
        &self,
        peer_ip: IpAddr,
        initiator_message: &[u8],
    ) -> Result<Vec<u8>, HandshakeFailure> {
        if initiator_message.is_empty() || initiator_message.len() > MAX_HANDSHAKE_BYTES {
            return Err(HandshakeFailure::Invalid);
        }
        if !self.inner.rate_limiter.allow_handshake(peer_ip) {
            return Err(HandshakeFailure::RateLimited);
        }
        let session_handle = random_array::<32>().map_err(|_| HandshakeFailure::Invalid)?;
        let random_challenge = random_array::<32>().map_err(|_| HandshakeFailure::Invalid)?;
        let session_id = random_array::<16>().map_err(|_| HandshakeFailure::Invalid)?;
        let challenge = AuthChallenge {
            session_handle,
            authentication_salt: self.inner.authentication_salt,
            argon2_memory_kib: self.inner.argon2_policy.memory_kib,
            argon2_iterations: self.inner.argon2_policy.iterations,
            argon2_parallelism: self.inner.argon2_policy.parallelism,
            random_challenge,
            session_id,
        };
        let challenge_bytes =
            encode_auth_challenge(&challenge).map_err(|_| HandshakeFailure::Invalid)?;
        let accepted = accept_handshake(
            &self.inner.identity,
            &self.inner.instance_id,
            initiator_message,
            &challenge_bytes,
        )
        .map_err(|_| HandshakeFailure::Invalid)?;
        let authentication_context =
            authentication_context(&accepted.handshake_hash, &random_challenge, &session_id);
        let inserted = self.inner.sessions.insert(
            session_handle,
            Session {
                peer_ip,
                transport: accepted.transport,
                authentication_context,
                phase: SessionPhase::AwaitingPassword,
                next_client_sequence: 0,
                next_server_sequence: 0,
                message_count: 0,
            },
        );
        if !inserted {
            return Err(HandshakeFailure::Capacity);
        }
        Ok(accepted.response)
    }

    pub async fn process_envelope(
        &self,
        peer_ip: IpAddr,
        session: Arc<Mutex<Session>>,
        ciphertext_records: &[u8],
    ) -> Result<EnvelopeResult, EnvelopeFailure> {
        let mut session = session.lock().await;
        if session.peer_ip != peer_ip {
            return Err(EnvelopeFailure::Invalid);
        }
        let clear = decrypt_transport_records(&mut session.transport, ciphertext_records)
            .map_err(|_| EnvelopeFailure::Invalid)?;
        let ClientMessage { sequence, request } =
            decode_client_message(&clear).map_err(|_| EnvelopeFailure::Invalid)?;

        if sequence != session.next_client_sequence {
            return encrypted_error(&mut session, ErrorCode::SequenceMismatch, true);
        }
        session.next_client_sequence = session
            .next_client_sequence
            .checked_add(1)
            .ok_or(EnvelopeFailure::Invalid)?;
        session.message_count = session
            .message_count
            .checked_add(1)
            .ok_or(EnvelopeFailure::Invalid)?;
        if session.message_count > MAX_SESSION_MESSAGES {
            return encrypted_error(&mut session, ErrorCode::RateLimited, true);
        }

        let result = self.inner.application.dispatch(&mut session, request).await;
        encrypted_response(&mut session, result.response, result.close_session)
    }
}

fn encrypted_error(
    session: &mut Session,
    code: ErrorCode,
    close_session: bool,
) -> Result<EnvelopeResult, EnvelopeFailure> {
    encrypted_response(session, Response::Error(code), close_session)
}

fn encrypted_response(
    session: &mut Session,
    response: Response,
    close_session: bool,
) -> Result<EnvelopeResult, EnvelopeFailure> {
    let sequence = session.next_server_sequence;
    session.next_server_sequence = session
        .next_server_sequence
        .checked_add(1)
        .ok_or(EnvelopeFailure::Invalid)?;
    let clear = encode_server_message(&ServerMessage { sequence, response })
        .map_err(|_| EnvelopeFailure::Invalid)?;
    let ciphertext_records = encrypt_transport_records(&mut session.transport, &clear)
        .map_err(|_| EnvelopeFailure::Invalid)?;
    Ok(EnvelopeResult {
        ciphertext_records,
        close_session,
    })
}

use std::collections::HashMap;
use std::net::IpAddr;
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant};

use snow::TransportState;
use tokio::sync::Mutex as AsyncMutex;

const MAX_SESSIONS: usize = 1024;
const SESSION_LIFETIME: Duration = Duration::from_mins(30);
pub(crate) const MAX_SESSION_MESSAGES: u64 = 10_000;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum SessionPhase {
    AwaitingPassword,
    PasswordAuthenticated,
    DeviceAuthenticated([u8; 16]),
}

pub(crate) struct Session {
    pub peer_ip: IpAddr,
    pub transport: TransportState,
    pub authentication_context: Vec<u8>,
    pub phase: SessionPhase,
    pub next_client_sequence: u64,
    pub next_server_sequence: u64,
    pub message_count: u64,
}

impl Session {
    pub const fn password_authenticated(&self) -> bool {
        matches!(
            self.phase,
            SessionPhase::PasswordAuthenticated | SessionPhase::DeviceAuthenticated(_)
        )
    }
}

struct StoredSession {
    session: Arc<AsyncMutex<Session>>,
    expires_at: Instant,
}

#[derive(Default)]
pub(crate) struct SessionStore {
    sessions: Mutex<HashMap<[u8; 32], StoredSession>>,
}

impl SessionStore {
    pub fn insert(&self, handle: [u8; 32], session: Session) -> bool {
        let now = Instant::now();
        let mut sessions = lock_unpoisoned(&self.sessions);
        sessions.retain(|_, stored| stored.expires_at > now);
        if sessions.len() >= MAX_SESSIONS || sessions.contains_key(&handle) {
            return false;
        }
        sessions.insert(
            handle,
            StoredSession {
                session: Arc::new(AsyncMutex::new(session)),
                expires_at: now + SESSION_LIFETIME,
            },
        );
        true
    }

    pub fn get(&self, handle: &[u8; 32]) -> Option<Arc<AsyncMutex<Session>>> {
        let now = Instant::now();
        let mut sessions = lock_unpoisoned(&self.sessions);
        sessions.retain(|_, stored| stored.expires_at > now);
        sessions
            .get(handle)
            .map(|stored| Arc::clone(&stored.session))
    }

    pub fn remove(&self, handle: &[u8; 32]) {
        lock_unpoisoned(&self.sessions).remove(handle);
    }
}

pub(crate) struct SessionCancellationGuard {
    store: Arc<SessionStore>,
    handle: [u8; 32],
    armed: bool,
}

impl SessionCancellationGuard {
    pub fn new(store: Arc<SessionStore>, handle: [u8; 32]) -> Self {
        Self {
            store,
            handle,
            armed: true,
        }
    }

    pub fn disarm(&mut self) {
        self.armed = false;
    }
}

impl Drop for SessionCancellationGuard {
    fn drop(&mut self) {
        if self.armed {
            self.store.remove(&self.handle);
        }
    }
}

fn lock_unpoisoned<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

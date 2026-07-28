use std::collections::HashMap;
use std::net::IpAddr;
use std::sync::{Mutex, MutexGuard};
use std::time::{Duration, Instant};

const WINDOW: Duration = Duration::from_mins(1);
const MAX_HANDSHAKES_PER_WINDOW: u32 = 30;
const MAX_TRACKED_ADDRESSES: usize = 4096;
const MAX_BACKOFF_SECONDS: u64 = 256;

struct Entry {
    window_started: Instant,
    handshakes: u32,
    failed_authentications: u8,
    blocked_until: Instant,
    last_seen: Instant,
}

#[derive(Default)]
pub(crate) struct RateLimiter {
    entries: Mutex<HashMap<IpAddr, Entry>>,
}

impl RateLimiter {
    pub fn allow_handshake(&self, address: IpAddr) -> bool {
        let now = Instant::now();
        let mut entries = lock_unpoisoned(&self.entries);
        entries.retain(|_, entry| now.duration_since(entry.last_seen) < Duration::from_hours(1));
        if !entries.contains_key(&address) && entries.len() >= MAX_TRACKED_ADDRESSES {
            return false;
        }
        let entry = entries.entry(address).or_insert(Entry {
            window_started: now,
            handshakes: 0,
            failed_authentications: 0,
            blocked_until: now,
            last_seen: now,
        });
        entry.last_seen = now;
        if now < entry.blocked_until {
            return false;
        }
        if now.duration_since(entry.window_started) >= WINDOW {
            entry.window_started = now;
            entry.handshakes = 0;
        }
        if entry.handshakes >= MAX_HANDSHAKES_PER_WINDOW {
            return false;
        }
        entry.handshakes += 1;
        true
    }

    pub fn record_authentication_failure(&self, address: IpAddr) {
        let now = Instant::now();
        let mut entries = lock_unpoisoned(&self.entries);
        let entry = entries.entry(address).or_insert(Entry {
            window_started: now,
            handshakes: 0,
            failed_authentications: 0,
            blocked_until: now,
            last_seen: now,
        });
        entry.failed_authentications = entry.failed_authentications.saturating_add(1).min(8);
        let delay = 1_u64 << u32::from(entry.failed_authentications.saturating_sub(1));
        entry.blocked_until = now + Duration::from_secs(delay.min(MAX_BACKOFF_SECONDS));
        entry.last_seen = now;
    }

    pub fn record_authentication_success(&self, address: IpAddr) {
        let mut entries = lock_unpoisoned(&self.entries);
        if let Some(entry) = entries.get_mut(&address) {
            entry.failed_authentications = 0;
            entry.blocked_until = Instant::now();
            entry.last_seen = Instant::now();
        }
    }
}

fn lock_unpoisoned<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

//! Portable, Node-free client state for pinned Noise transport, vault keys,
//! device identities, and signed encrypted commits.

mod channel;
mod device;
mod error;
mod vault;

pub use channel::ClientChannel;
pub use device::DeviceIdentity;
pub use error::ClientError;
pub use vault::UnlockedVault;

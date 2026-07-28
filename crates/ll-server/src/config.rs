use std::env;
use std::fs;
use std::net::SocketAddr;
use std::path::{Path, PathBuf};

use serde::Deserialize;
use thiserror::Error;
use zeroize::{Zeroize, Zeroizing};

/// Validated three-field server configuration.
pub struct ServerConfig {
    /// Persistent server data directory.
    pub data_dir: PathBuf,
    /// TCP listener address.
    pub listen: SocketAddr,
    /// Server access password, zeroized on drop.
    pub password: Zeroizing<String>,
    permission_warning: bool,
}

impl ServerConfig {
    /// Loads a configuration containing exactly `data_dir`, `listen`, and
    /// `password`.
    ///
    /// A password equal to `${NAME}` is read from the named environment
    /// variable. Unknown TOML fields are rejected.
    ///
    /// # Errors
    ///
    /// Returns a [`ConfigError`] for I/O, TOML, address, environment, or
    /// password-policy failures.
    pub fn load(path: &Path) -> Result<Self, ConfigError> {
        let contents = Zeroizing::new(fs::read_to_string(path)?);
        let mut raw: RawConfig = toml::from_str(&contents)?;
        let data_dir = PathBuf::from(raw.data_dir);
        let listen = raw.listen.parse().map_err(|_| ConfigError::InvalidListen)?;
        let expanded = expand_password(&raw.password)?;
        raw.password.zeroize();
        if expanded.chars().count() < 16 {
            return Err(ConfigError::WeakPassword);
        }
        let permission_warning = insecure_config_permissions(path)?;
        Ok(Self {
            data_dir,
            listen,
            password: expanded,
            permission_warning,
        })
    }

    /// Returns whether Unix group/other permission bits are present.
    #[must_use]
    pub const fn has_permission_warning(&self) -> bool {
        self.permission_warning
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RawConfig {
    data_dir: String,
    listen: String,
    password: String,
}

/// Server configuration loading failure.
#[derive(Debug, Error)]
pub enum ConfigError {
    /// Configuration file I/O failed.
    #[error("configuration file could not be read")]
    Io(#[from] std::io::Error),
    /// TOML is malformed or has an unknown/missing field.
    #[error("configuration must contain only data_dir, listen, and password")]
    Toml(#[from] toml::de::Error),
    /// Listen is not a socket address.
    #[error("listen must be an IP socket address")]
    InvalidListen,
    /// Environment placeholder is malformed.
    #[error("password environment placeholder is invalid")]
    InvalidPasswordPlaceholder,
    /// Referenced environment variable is absent or not Unicode.
    #[error("password environment variable is unavailable")]
    MissingPasswordEnvironment,
    /// Server access passwords shorter than sixteen characters are rejected.
    #[error("server access password is too weak")]
    WeakPassword,
}

fn expand_password(input: &str) -> Result<Zeroizing<String>, ConfigError> {
    if let Some(name) = input
        .strip_prefix("${")
        .and_then(|value| value.strip_suffix('}'))
    {
        if name.is_empty()
            || !name
                .bytes()
                .all(|byte| byte.is_ascii_uppercase() || byte.is_ascii_digit() || byte == b'_')
        {
            return Err(ConfigError::InvalidPasswordPlaceholder);
        }
        return env::var(name)
            .map(Zeroizing::new)
            .map_err(|_| ConfigError::MissingPasswordEnvironment);
    }
    if input.contains("${") || input.contains('}') {
        return Err(ConfigError::InvalidPasswordPlaceholder);
    }
    Ok(Zeroizing::new(input.to_owned()))
}

#[cfg(unix)]
fn insecure_config_permissions(path: &Path) -> Result<bool, ConfigError> {
    use std::os::unix::fs::PermissionsExt;
    Ok(fs::metadata(path)?.permissions().mode() & 0o077 != 0)
}

#[cfg(not(unix))]
fn insecure_config_permissions(path: &Path) -> Result<bool, ConfigError> {
    let _metadata = fs::metadata(path)?;
    Ok(false)
}

#[cfg(test)]
mod tests {
    use std::fs;

    use ll_testkit::random_test_password;

    use super::{ConfigError, ServerConfig};

    #[test]
    fn rejects_unknown_fields_and_weak_passwords() {
        let directory = tempfile::tempdir().unwrap();
        let config_path = directory.path().join("config.toml");
        fs::write(
            &config_path,
            "data_dir='data'\nlisten='127.0.0.1:0'\npassword='short'\n",
        )
        .unwrap();
        assert!(matches!(
            ServerConfig::load(&config_path),
            Err(ConfigError::WeakPassword)
        ));
        let password = random_test_password().unwrap();
        fs::write(
            &config_path,
            format!(
                "data_dir='data'\nlisten='127.0.0.1:0'\npassword='{}'\nextra=true\n",
                password.as_str()
            ),
        )
        .unwrap();
        assert!(matches!(
            ServerConfig::load(&config_path),
            Err(ConfigError::Toml(_))
        ));
    }
}

use std::future::Future;
use std::net::SocketAddr;
use std::path::PathBuf;

use ll_crypto::ServerIdentity;
use thiserror::Error;
use tokio::net::TcpListener;

use crate::config::ServerConfig;
use crate::state::AppState;
use crate::storage::Storage;

/// Initialized Learning Loop service.
pub struct LearningLoopServer {
    state: AppState,
    listen: SocketAddr,
    data_dir: PathBuf,
    fingerprint: String,
    permission_warning: bool,
}

/// Server startup or serving failure.
#[derive(Debug, Error)]
pub enum ServerError {
    /// Cryptographic identity initialization failed.
    #[error("server identity initialization failed")]
    Identity(#[from] ll_crypto::CryptoError),
    /// Durable service initialization failed.
    #[error("server storage initialization failed")]
    Storage(#[from] crate::error::StorageError),
    /// Listener or server I/O failed.
    #[error("server network I/O failed")]
    Io(#[from] std::io::Error),
    /// Public bootstrap encoding failed.
    #[error("server protocol initialization failed")]
    ProtocolInitialization,
    /// Blocking startup worker failed.
    #[error("server startup worker failed")]
    Join(#[from] tokio::task::JoinError),
}

impl LearningLoopServer {
    /// Initializes persistent identity, metadata, and the password verifier.
    ///
    /// # Errors
    ///
    /// Returns a [`ServerError`] if identity, storage, password verification,
    /// or bootstrap generation fails.
    pub async fn initialize(config: ServerConfig) -> Result<Self, ServerError> {
        let permission_warning = config.has_permission_warning();
        let data_dir = config.data_dir;
        let identity_directory = data_dir.clone();
        let identity = tokio::task::spawn_blocking(move || {
            ServerIdentity::load_or_create(&identity_directory)
        })
        .await??;
        let fingerprint = identity.fingerprint().to_owned();
        let initialized = Storage::initialize(data_dir.clone(), config.password).await?;
        let state = AppState::new(identity, initialized)
            .map_err(|()| ServerError::ProtocolInitialization)?;
        let data_dir = std::fs::canonicalize(&data_dir).unwrap_or(data_dir);
        Ok(Self {
            state,
            listen: config.listen,
            data_dir,
            fingerprint,
            permission_warning,
        })
    }

    /// Binds the configured listener, prints the required startup identity,
    /// and serves until Ctrl-C or termination.
    ///
    /// # Errors
    ///
    /// Returns a [`ServerError`] for bind or serving failures.
    pub async fn serve(self) -> Result<(), ServerError> {
        let listener = TcpListener::bind(self.listen).await?;
        self.print_startup(listener.local_addr()?);
        self.serve_on(listener, shutdown_signal()).await
    }

    /// Serves on an already-bound listener until `shutdown` resolves.
    ///
    /// This is public so black-box tests and embedders can use an ephemeral
    /// listener without changing production configuration.
    ///
    /// # Errors
    ///
    /// Returns a [`ServerError`] for serving failures.
    pub async fn serve_on<F>(self, listener: TcpListener, shutdown: F) -> Result<(), ServerError>
    where
        F: Future<Output = ()> + Send + 'static,
    {
        let application = crate::http::router(self.state);
        axum::serve(
            listener,
            application.into_make_service_with_connect_info::<SocketAddr>(),
        )
        .with_graceful_shutdown(shutdown)
        .await?;
        Ok(())
    }

    fn print_startup(&self, actual_address: SocketAddr) {
        println!("Listening: {actual_address}");
        println!("Server fingerprint: {}", self.fingerprint);
        println!("Data directory: {}", self.data_dir.display());
        if self.permission_warning {
            eprintln!(
                "Warning: the configuration file is readable or writable by other Unix users"
            );
        }
    }
}

async fn shutdown_signal() {
    let control_c = async {
        let _result = tokio::signal::ctrl_c().await;
    };

    #[cfg(unix)]
    {
        use tokio::signal::unix::{SignalKind, signal};
        let terminate = async {
            if let Ok(mut stream) = signal(SignalKind::terminate()) {
                stream.recv().await;
            } else {
                std::future::pending::<()>().await;
            }
        };
        tokio::select! {
            () = control_c => {}
            () = terminate => {}
        }
    }

    #[cfg(not(unix))]
    control_c.await;
}

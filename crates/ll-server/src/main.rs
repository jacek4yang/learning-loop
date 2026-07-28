use std::path::PathBuf;

use anyhow::{Context, Result, bail};
use ll_server::LearningLoopServer;
use ll_server::config::ServerConfig;

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("warn")),
        )
        .with_target(false)
        .without_time()
        .init();

    let mut arguments = std::env::args_os().skip(1);
    let config_path = arguments
        .next()
        .map_or_else(|| PathBuf::from("config.toml"), PathBuf::from);
    if arguments.next().is_some() {
        bail!("usage: ll-server [config.toml]");
    }
    let config = ServerConfig::load(&config_path)
        .with_context(|| format!("could not load {}", config_path.display()))?;
    let server = LearningLoopServer::initialize(config).await?;
    server.serve().await?;
    Ok(())
}

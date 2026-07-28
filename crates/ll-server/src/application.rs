use std::sync::Arc;

use ll_crypto::{
    ServerAuthKey, device_auth_signature_context, registration_signature_context,
    verify_device_signature, verify_password_proof,
};
use ll_protocol::{ErrorCode, Request, Response};

use crate::rate_limit::RateLimiter;
use crate::session::{Session, SessionPhase};
use crate::storage::Storage;

pub(crate) struct Application {
    storage: Storage,
    authentication_key: Arc<ServerAuthKey>,
    rate_limiter: Arc<RateLimiter>,
}

pub(crate) struct ApplicationResult {
    pub response: Response,
    pub close_session: bool,
}

impl Application {
    pub fn new(
        storage: Storage,
        authentication_key: Arc<ServerAuthKey>,
        rate_limiter: Arc<RateLimiter>,
    ) -> Self {
        Self {
            storage,
            authentication_key,
            rate_limiter,
        }
    }

    pub async fn dispatch(&self, session: &mut Session, request: Request) -> ApplicationResult {
        match request {
            Request::Authenticate {
                proof,
                device_id,
                device_signature,
            } => {
                self.authenticate(session, &proof, device_id, device_signature)
                    .await
            }
            Request::RegisterDevice {
                device_id,
                public_key,
                encrypted_name,
                signature,
            } => {
                self.register_device(session, device_id, public_key, encrypted_name, &signature)
                    .await
            }
            Request::ListDevices => self.list_devices(session).await,
            Request::RevokeDevice { device_id } => self.revoke_device(session, device_id).await,
            Request::BeginUpload {
                expected_size,
                expected_hash,
            } => {
                self.begin_upload(session, expected_size, expected_hash)
                    .await
            }
            Request::UploadChunk {
                upload_id,
                offset,
                chunk,
            } => self.upload_chunk(session, upload_id, offset, chunk).await,
            Request::CommitUpload { upload_id } => self.commit_upload(session, upload_id).await,
            Request::GetBlob {
                blob_id,
                offset,
                maximum_bytes,
            } => self.get_blob(session, blob_id, offset, maximum_bytes).await,
            Request::Ping => self.ping(session).await,
        }
    }

    async fn list_devices(&self, session: &Session) -> ApplicationResult {
        if let Err(result) = self.require_device(session).await {
            return result;
        }
        from_storage(self.storage.list_devices().await.map(Response::Devices))
    }

    async fn revoke_device(&self, session: &Session, device_id: [u8; 16]) -> ApplicationResult {
        let current = match self.require_device(session).await {
            Ok(current) => current,
            Err(result) => return result,
        };
        match self.storage.revoke_device(device_id).await {
            Ok(()) => ApplicationResult {
                response: Response::DeviceRevoked,
                close_session: current == device_id,
            },
            Err(error) => storage_error(&error),
        }
    }

    async fn begin_upload(
        &self,
        session: &Session,
        expected_size: u64,
        expected_hash: [u8; 32],
    ) -> ApplicationResult {
        let device_id = match self.require_device(session).await {
            Ok(device_id) => device_id,
            Err(result) => return result,
        };
        from_storage(
            self.storage
                .begin_upload(device_id, expected_size, expected_hash)
                .await
                .map(|(upload_id, offset)| Response::UploadReady { upload_id, offset }),
        )
    }

    async fn upload_chunk(
        &self,
        session: &Session,
        upload_id: [u8; 16],
        offset: u64,
        chunk: Vec<u8>,
    ) -> ApplicationResult {
        let device_id = match self.require_device(session).await {
            Ok(device_id) => device_id,
            Err(result) => return result,
        };
        from_storage(
            self.storage
                .append_upload_chunk(device_id, upload_id, offset, chunk)
                .await
                .map(|offset| Response::ChunkAccepted { offset }),
        )
    }

    async fn commit_upload(&self, session: &Session, upload_id: [u8; 16]) -> ApplicationResult {
        let device_id = match self.require_device(session).await {
            Ok(device_id) => device_id,
            Err(result) => return result,
        };
        from_storage(
            self.storage
                .commit_upload(device_id, upload_id)
                .await
                .map(|blob_id| Response::UploadCommitted { blob_id }),
        )
    }

    async fn get_blob(
        &self,
        session: &Session,
        blob_id: [u8; 32],
        offset: u64,
        maximum_bytes: u32,
    ) -> ApplicationResult {
        if let Err(result) = self.require_device(session).await {
            return result;
        }
        from_storage(
            self.storage
                .read_blob_chunk(blob_id, offset, maximum_bytes)
                .await
                .map(|(total_size, complete, chunk)| Response::BlobChunk {
                    offset,
                    total_size,
                    complete,
                    chunk,
                }),
        )
    }

    async fn ping(&self, session: &Session) -> ApplicationResult {
        if let Err(result) = self.require_device(session).await {
            return result;
        }
        success(Response::Pong)
    }

    async fn authenticate(
        &self,
        session: &mut Session,
        proof: &[u8; 32],
        device_id: Option<[u8; 16]>,
        device_signature: Option<[u8; 64]>,
    ) -> ApplicationResult {
        if session.phase != SessionPhase::AwaitingPassword {
            return error(ErrorCode::InvalidState, true);
        }
        if verify_password_proof(
            &self.authentication_key,
            &session.authentication_context,
            proof,
        )
        .is_err()
        {
            self.rate_limiter
                .record_authentication_failure(session.peer_ip);
            return error(ErrorCode::AuthenticationFailed, true);
        }

        match (device_id, device_signature) {
            (None, None) => {
                self.rate_limiter
                    .record_authentication_success(session.peer_ip);
                session.phase = SessionPhase::PasswordAuthenticated;
                success(Response::Authenticated {
                    device_authenticated: false,
                })
            }
            (Some(device_id), Some(signature)) => {
                let Ok(device) = self.storage.require_active_device(device_id).await else {
                    self.rate_limiter
                        .record_authentication_failure(session.peer_ip);
                    return error(ErrorCode::AuthenticationFailed, true);
                };
                let context = device_auth_signature_context(&session.authentication_context);
                if verify_device_signature(&device.public_key, &context, &signature).is_err() {
                    self.rate_limiter
                        .record_authentication_failure(session.peer_ip);
                    return error(ErrorCode::AuthenticationFailed, true);
                }
                self.rate_limiter
                    .record_authentication_success(session.peer_ip);
                session.phase = SessionPhase::DeviceAuthenticated(device_id);
                success(Response::Authenticated {
                    device_authenticated: true,
                })
            }
            _ => error(ErrorCode::AuthenticationFailed, true),
        }
    }

    async fn register_device(
        &self,
        session: &mut Session,
        device_id: [u8; 16],
        public_key: [u8; 32],
        encrypted_name: Vec<u8>,
        signature: &[u8; 64],
    ) -> ApplicationResult {
        if !matches!(
            session.phase,
            SessionPhase::PasswordAuthenticated | SessionPhase::DeviceAuthenticated(_)
        ) {
            return error(ErrorCode::InvalidState, true);
        }
        let context = registration_signature_context(
            &session.authentication_context,
            &device_id,
            &public_key,
        );
        if verify_device_signature(&public_key, &context, signature).is_err() {
            return error(ErrorCode::AuthenticationFailed, true);
        }
        match self
            .storage
            .register_device(device_id, public_key, encrypted_name)
            .await
        {
            Ok(()) => {
                session.phase = SessionPhase::DeviceAuthenticated(device_id);
                success(Response::DeviceRegistered)
            }
            Err(error) => storage_error(&error),
        }
    }

    async fn require_device(&self, session: &Session) -> Result<[u8; 16], ApplicationResult> {
        let SessionPhase::DeviceAuthenticated(device_id) = session.phase else {
            return Err(error(ErrorCode::DeviceRequired, false));
        };
        match self.storage.require_active_device(device_id).await {
            Ok(_) => Ok(device_id),
            Err(storage_error) => Err(ApplicationResult {
                response: Response::Error(storage_error.protocol_code()),
                close_session: true,
            }),
        }
    }
}

fn success(response: Response) -> ApplicationResult {
    ApplicationResult {
        response,
        close_session: false,
    }
}

fn error(code: ErrorCode, close_session: bool) -> ApplicationResult {
    ApplicationResult {
        response: Response::Error(code),
        close_session,
    }
}

fn from_storage(result: Result<Response, crate::error::StorageError>) -> ApplicationResult {
    match result {
        Ok(response) => success(response),
        Err(error) => storage_error(&error),
    }
}

fn storage_error(error: &crate::error::StorageError) -> ApplicationResult {
    let close_session = matches!(
        error,
        crate::error::StorageError::DeviceNotFound
            | crate::error::StorageError::DeviceRevoked
            | crate::error::StorageError::CorruptMetadata
    );
    ApplicationResult {
        response: Response::Error(error.protocol_code()),
        close_session,
    }
}

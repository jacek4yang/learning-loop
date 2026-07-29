use std::net::SocketAddr;

use ed25519_dalek::{Signer, SigningKey};
use ll_crypto::{
    Argon2Policy, ObjectType, ServerAuthKey, VaultMasterKey, VaultSubkeys, authentication_context,
    build_initiator, decrypt_transport_records, derive_server_auth_key,
    device_auth_signature_context, encrypt_object, encrypt_transport_records, password_proof,
    registration_signature_context,
};
use ll_protocol::{
    AuthChallenge, Bootstrap, ClientMessage, ErrorCode, MAX_HANDSHAKE_BYTES, MAX_HTTP_BODY_BYTES,
    Request, Response, ServerMessage, decode_auth_challenge, decode_bootstrap,
    decode_server_message, decode_transport_frame, encode_client_message, encode_transport_frame,
};
use ll_server::LearningLoopServer;
use ll_server::config::ServerConfig;
use ll_testkit::{random_device_signing_key, random_test_password, test_uuid};
use ll_versioning::{
    CommitBody, SignedCommit, UnsignedCommit, decode_signed_commit, encode_commit_body,
    encode_signed_commit,
};
use snow::TransportState;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::oneshot;
use zeroize::Zeroizing;

struct TestService {
    address: SocketAddr,
    shutdown: Option<oneshot::Sender<()>>,
    task: tokio::task::JoinHandle<Result<(), ll_server::ServerError>>,
    _directory: tempfile::TempDir,
}

impl TestService {
    async fn start(password: &Zeroizing<String>) -> Self {
        let directory = tempfile::tempdir().unwrap();
        let data_dir = directory.path().join("data");
        let config_path = directory.path().join("config.toml");
        let config = format!(
            "data_dir = '{}'\nlisten = '127.0.0.1:0'\npassword = '{}'\n",
            data_dir.display(),
            password.as_str()
        );
        std::fs::write(&config_path, config).unwrap();
        let server = LearningLoopServer::initialize(ServerConfig::load(&config_path).unwrap())
            .await
            .unwrap();
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let (shutdown, receiver) = oneshot::channel();
        let task = tokio::spawn(server.serve_on(listener, async move {
            let _result = receiver.await;
        }));
        Self {
            address,
            shutdown: Some(shutdown),
            task,
            _directory: directory,
        }
    }

    async fn stop(mut self) {
        if let Some(sender) = self.shutdown.take() {
            let _result = sender.send(());
        }
        self.task.await.unwrap().unwrap();
    }
}

struct ClientSession {
    address: SocketAddr,
    handle: [u8; 32],
    transport: TransportState,
    authentication_context: Vec<u8>,
    next_client_sequence: u64,
    next_server_sequence: u64,
}

struct TestDevice {
    id: [u8; 16],
    signing_key: SigningKey,
}

impl ClientSession {
    async fn connect(address: SocketAddr, bootstrap: &Bootstrap) -> Self {
        let mut initiator =
            build_initiator(&bootstrap.server_static_public_key, &bootstrap.instance_id).unwrap();
        let mut message = vec![0_u8; MAX_HANDSHAKE_BYTES];
        let length = initiator.write_message(&[], &mut message).unwrap();
        message.truncate(length);
        let (status, response) = http_request(address, "POST", "/v1/handshake", &message).await;
        assert_eq!(status, 200);

        let mut payload = vec![0_u8; MAX_HANDSHAKE_BYTES];
        let payload_length = initiator.read_message(&response, &mut payload).unwrap();
        payload.truncate(payload_length);
        let challenge = decode_auth_challenge(&payload).unwrap();
        let context = authentication_context(
            initiator.get_handshake_hash(),
            &challenge.random_challenge,
            &challenge.session_id,
        );
        Self {
            address,
            handle: challenge.session_handle,
            transport: initiator.into_transport_mode().unwrap(),
            authentication_context: context,
            next_client_sequence: 0,
            next_server_sequence: 0,
        }
    }

    fn prepare(&mut self, request: Request) -> Vec<u8> {
        let clear = encode_client_message(&ClientMessage {
            sequence: self.next_client_sequence,
            request,
        })
        .unwrap();
        self.next_client_sequence += 1;
        let records = encrypt_transport_records(&mut self.transport, &clear).unwrap();
        encode_transport_frame(&self.handle, &records).unwrap()
    }

    async fn send(&mut self, request: Request) -> Response {
        let frame = self.prepare(request);
        self.send_prepared(&frame).await
    }

    async fn send_prepared(&mut self, frame: &[u8]) -> Response {
        let (status, body) = http_request(self.address, "POST", "/v1/envelope", frame).await;
        assert_eq!(status, 200);
        let frame = decode_transport_frame(&body).unwrap();
        assert_eq!(frame.session_handle, self.handle);
        let clear = decrypt_transport_records(&mut self.transport, frame.ciphertext).unwrap();
        let ServerMessage { sequence, response } = decode_server_message(&clear).unwrap();
        assert_eq!(sequence, self.next_server_sequence);
        self.next_server_sequence += 1;
        response
    }

    async fn authenticate_new(&mut self, authentication_key: &ServerAuthKey) -> [u8; 16] {
        let proof = password_proof(authentication_key, &self.authentication_context);
        let response = self
            .send(Request::Authenticate {
                proof,
                device_id: None,
                device_signature: None,
            })
            .await;
        let Response::Authenticated {
            device_authenticated: false,
            vault_id,
        } = response
        else {
            panic!("new-device password authentication must return the vault ID");
        };
        vault_id
    }

    async fn authenticate_existing(
        &mut self,
        authentication_key: &ServerAuthKey,
        device_id: [u8; 16],
        signing_key: &SigningKey,
    ) -> [u8; 16] {
        let proof = password_proof(authentication_key, &self.authentication_context);
        let signature = signing_key
            .sign(&device_auth_signature_context(&self.authentication_context))
            .to_bytes();
        let response = self
            .send(Request::Authenticate {
                proof,
                device_id: Some(device_id),
                device_signature: Some(signature),
            })
            .await;
        let Response::Authenticated {
            device_authenticated: true,
            vault_id,
        } = response
        else {
            panic!("existing-device authentication must return the vault ID");
        };
        vault_id
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn encrypted_service_handles_resumption_replay_and_revocation() {
    let password = random_test_password().unwrap();
    let service = TestService::start(&password).await;
    let (status, bootstrap_bytes) =
        http_request(service.address, "GET", "/v1/bootstrap", &[]).await;
    assert_eq!(status, 200);
    let bootstrap = decode_bootstrap(&bootstrap_bytes).unwrap();
    assert_server_key_replacement_is_rejected(service.address, &bootstrap).await;
    assert_plain_http_surface_is_bounded(service.address).await;

    let mut primary = ClientSession::connect(service.address, &bootstrap).await;
    let challenge_policy = challenge_policy(service.address, &bootstrap).await;
    let authentication_key =
        derive_server_auth_key(password.as_bytes(), &challenge_policy.0, challenge_policy.1)
            .unwrap();
    assert_eq!(
        primary
            .send(Request::BeginUpload {
                expected_size: 1,
                expected_hash: ll_crypto::random_array::<32>().unwrap(),
            })
            .await,
        Response::Error(ErrorCode::DeviceRequired)
    );
    let vault_id = primary.authenticate_new(&authentication_key).await;
    assert_eq!(
        primary.send(Request::GetVaultKeyEnvelope).await,
        Response::Error(ErrorCode::VaultKeyEnvelopeNotFound)
    );
    // First-run clients register their device before publishing the wrapped
    // vault key so a failed registration cannot strand an unusable envelope.
    let device = register_test_device(&mut primary).await;
    let vault_key_envelope = ll_crypto::random_array::<96>().unwrap().to_vec();
    assert_eq!(
        primary
            .send(Request::PutVaultKeyEnvelope {
                envelope: vault_key_envelope.clone(),
            })
            .await,
        Response::VaultKeyEnvelopeStored
    );
    assert_eq!(
        primary
            .send(Request::PutVaultKeyEnvelope {
                envelope: vault_key_envelope.clone(),
            })
            .await,
        Response::VaultKeyEnvelopeStored
    );
    assert_eq!(
        primary
            .send(Request::PutVaultKeyEnvelope {
                envelope: ll_crypto::random_array::<96>().unwrap().to_vec(),
            })
            .await,
        Response::Error(ErrorCode::VaultKeyEnvelopeConflict)
    );

    let mut secondary = ClientSession::connect(service.address, &bootstrap).await;
    let authenticated_vault = secondary
        .authenticate_existing(&authentication_key, device.id, &device.signing_key)
        .await;
    assert_eq!(authenticated_vault, vault_id);
    assert_eq!(
        secondary.send(Request::GetVaultKeyEnvelope).await,
        Response::VaultKeyEnvelope {
            envelope: vault_key_envelope,
        }
    );

    let post_revoke_commit = assert_commit_graph(
        service.address,
        &bootstrap,
        &authentication_key,
        vault_id,
        &mut primary,
        &device,
    )
    .await;
    assert_resumable_blob_round_trip(&mut primary).await;
    assert_replay_is_rejected(&mut secondary).await;
    assert_revocation_is_immediate(
        service.address,
        &bootstrap,
        &authentication_key,
        &device,
        &mut primary,
        post_revoke_commit,
    )
    .await;
    assert_wrong_password_closes_session(service.address, &bootstrap, challenge_policy).await;
    service.stop().await;
}

async fn assert_server_key_replacement_is_rejected(address: SocketAddr, bootstrap: &Bootstrap) {
    let replacement_key = ll_crypto::random_array::<32>().unwrap();
    let mut initiator = build_initiator(&replacement_key, &bootstrap.instance_id).unwrap();
    let mut message = vec![0_u8; MAX_HANDSHAKE_BYTES];
    let length = initiator.write_message(&[], &mut message).unwrap();
    message.truncate(length);
    let (status, response) = http_request(address, "POST", "/v1/handshake", &message).await;
    assert_eq!(status, 400);
    assert!(response.is_empty());
}

async fn assert_plain_http_surface_is_bounded(address: SocketAddr) {
    let (status, _) = http_request(address, "GET", "/v1/bootstrap?secret=forbidden", &[]).await;
    assert_eq!(status, 400);
    let oversized = vec![0_u8; MAX_HTTP_BODY_BYTES + 1];
    let (status, _) = http_request(address, "POST", "/v1/envelope", &oversized).await;
    assert_eq!(status, 413);
}

async fn register_test_device(primary: &mut ClientSession) -> TestDevice {
    let id = test_uuid();
    let signing_key = random_device_signing_key().unwrap();
    let verifying_key = signing_key.verifying_key().to_bytes();
    let context =
        registration_signature_context(&primary.authentication_context, &id, &verifying_key);
    let signature = signing_key.sign(&context).to_bytes();
    assert_eq!(
        primary
            .send(Request::RegisterDevice {
                device_id: id,
                public_key: verifying_key,
                encrypted_name: vec![0xa5; 48],
                signature,
            })
            .await,
        Response::DeviceRegistered
    );
    TestDevice { id, signing_key }
}

async fn assert_resumable_blob_round_trip(primary: &mut ClientSession) {
    let ciphertext = vec![0x6d; 180 * 1024];
    let expected_hash = *blake3::hash(&ciphertext).as_bytes();
    let Response::UploadReady {
        upload_id,
        offset: 0,
    } = primary
        .send(Request::BeginUpload {
            expected_size: u64::try_from(ciphertext.len()).unwrap(),
            expected_hash,
        })
        .await
    else {
        panic!("expected a new upload");
    };
    let split = 90 * 1024;
    assert_eq!(
        primary
            .send(Request::UploadChunk {
                upload_id,
                offset: 0,
                chunk: ciphertext[..split].to_vec(),
            })
            .await,
        Response::ChunkAccepted {
            offset: u64::try_from(split).unwrap()
        }
    );
    assert_eq!(
        primary
            .send(Request::BeginUpload {
                expected_size: u64::try_from(ciphertext.len()).unwrap(),
                expected_hash,
            })
            .await,
        Response::UploadReady {
            upload_id,
            offset: u64::try_from(split).unwrap()
        }
    );
    assert_eq!(
        primary
            .send(Request::UploadChunk {
                upload_id,
                offset: u64::try_from(split).unwrap(),
                chunk: ciphertext[split..].to_vec(),
            })
            .await,
        Response::ChunkAccepted {
            offset: u64::try_from(ciphertext.len()).unwrap()
        }
    );
    assert_eq!(
        primary.send(Request::CommitUpload { upload_id }).await,
        Response::UploadCommitted {
            blob_id: expected_hash
        }
    );
    assert_eq!(
        primary
            .send(Request::GetBlob {
                blob_id: expected_hash,
                offset: 0,
                maximum_bytes: u32::try_from(ciphertext.len()).unwrap(),
            })
            .await,
        Response::BlobChunk {
            offset: 0,
            total_size: u64::try_from(ciphertext.len()).unwrap(),
            complete: true,
            chunk: ciphertext,
        }
    );
}

async fn assert_commit_graph(
    address: SocketAddr,
    bootstrap: &Bootstrap,
    authentication_key: &ServerAuthKey,
    vault_id: [u8; 16],
    primary: &mut ClientSession,
    primary_device: &TestDevice,
) -> Vec<u8> {
    let subkeys = VaultMasterKey::generate()
        .unwrap()
        .derive_subkeys(&vault_id)
        .unwrap();
    let (root_id, primary_branch) =
        establish_root_and_primary_branch(vault_id, primary_device, &subkeys, primary).await;

    let (mut second_session, second_device) =
        register_additional_device(address, bootstrap, authentication_key, vault_id).await;
    let second_branch = make_commit(vault_id, &second_device, 1, vec![root_id], 5, &subkeys);
    assert_commit_stored(&mut second_session, &second_branch).await;
    let (mut third_session, third_device) =
        register_additional_device(address, bootstrap, authentication_key, vault_id).await;
    let third_branch = make_commit(vault_id, &third_device, 1, vec![root_id], 6, &subkeys);
    assert_commit_stored(&mut third_session, &third_branch).await;

    let mut branch_ids = vec![
        decode_signed_commit(&primary_branch).unwrap().commit_id,
        decode_signed_commit(&second_branch).unwrap().commit_id,
        decode_signed_commit(&third_branch).unwrap().commit_id,
    ];
    branch_ids.sort_unstable();
    assert_eq!(
        primary.send(Request::GetHeads).await,
        Response::Heads(branch_ids.clone())
    );
    let merge = make_commit(vault_id, primary_device, 3, branch_ids.clone(), 7, &subkeys);
    assert_commit_stored(primary, &merge).await;
    let merge_id = decode_signed_commit(&merge).unwrap().commit_id;
    assert_eq!(
        primary.send(Request::GetHeads).await,
        Response::Heads(vec![merge_id])
    );
    assert_eq!(
        primary
            .send(Request::GetCommit {
                commit_id: merge_id,
            })
            .await,
        Response::CommitRecord {
            signed_commit: merge.clone(),
        }
    );

    assert_change_pagination(primary, root_id, merge).await;

    let skipped_sequence = make_commit(vault_id, primary_device, 5, vec![merge_id], 8, &subkeys);
    assert_eq!(
        primary
            .send(Request::PutCommit {
                signed_commit: skipped_sequence,
            })
            .await,
        Response::Error(ErrorCode::SequenceMismatch)
    );
    make_commit(vault_id, primary_device, 4, vec![merge_id], 9, &subkeys)
}

async fn establish_root_and_primary_branch(
    vault_id: [u8; 16],
    device: &TestDevice,
    subkeys: &VaultSubkeys,
    primary: &mut ClientSession,
) -> ([u8; 32], Vec<u8>) {
    let root = make_commit(vault_id, device, 1, Vec::new(), 1, subkeys);
    assert_commit_stored(primary, &root).await;
    assert_commit_stored(primary, &root).await;
    let mut forged = decode_signed_commit(&root).unwrap();
    forged.signature[0] ^= 1;
    assert_eq!(
        primary
            .send(Request::PutCommit {
                signed_commit: encode_signed_commit(&forged).unwrap(),
            })
            .await,
        Response::Error(ErrorCode::InvalidSignature)
    );
    assert_eq!(
        primary
            .send(Request::PutCommit {
                signed_commit: make_commit(vault_id, device, 2, vec![[0xf1; 32]], 2, subkeys,),
            })
            .await,
        Response::Error(ErrorCode::MissingParent)
    );
    let root_id = decode_signed_commit(&root).unwrap().commit_id;
    let branch = make_commit(vault_id, device, 2, vec![root_id], 3, subkeys);
    assert_commit_stored(primary, &branch).await;
    assert_eq!(
        primary
            .send(Request::PutCommit {
                signed_commit: make_commit(vault_id, device, 2, vec![root_id], 4, subkeys),
            })
            .await,
        Response::Error(ErrorCode::SequenceMismatch)
    );
    (root_id, branch)
}

async fn assert_change_pagination(primary: &mut ClientSession, root_id: [u8; 32], merge: Vec<u8>) {
    let Response::Changes {
        commits,
        has_more: true,
    } = primary
        .send(Request::GetChanges {
            known_commit_ids: vec![root_id],
            maximum_commits: 3,
        })
        .await
    else {
        panic!("first change page must contain the three concurrent branches");
    };
    let mut known = vec![root_id];
    known.extend(
        commits
            .iter()
            .map(|record| decode_signed_commit(record).unwrap().commit_id),
    );
    assert_eq!(
        primary
            .send(Request::GetChanges {
                known_commit_ids: known,
                maximum_commits: 3,
            })
            .await,
        Response::Changes {
            commits: vec![merge],
            has_more: false,
        }
    );
}

async fn register_additional_device(
    address: SocketAddr,
    bootstrap: &Bootstrap,
    authentication_key: &ServerAuthKey,
    expected_vault_id: [u8; 16],
) -> (ClientSession, TestDevice) {
    let mut session = ClientSession::connect(address, bootstrap).await;
    assert_eq!(
        session.authenticate_new(authentication_key).await,
        expected_vault_id
    );
    let device = register_test_device(&mut session).await;
    (session, device)
}

async fn assert_commit_stored(session: &mut ClientSession, record: &[u8]) {
    let commit_id = decode_signed_commit(record).unwrap().commit_id;
    assert!(matches!(
        session
            .send(Request::PutCommit {
                signed_commit: record.to_vec(),
            })
            .await,
        Response::CommitStored {
            commit_id: accepted,
            ..
        } if accepted == commit_id
    ));
}

fn make_commit(
    vault_id: [u8; 16],
    device: &TestDevice,
    device_sequence: u64,
    mut parents: Vec<[u8; 32]>,
    marker: u8,
    subkeys: &VaultSubkeys,
) -> Vec<u8> {
    parents.sort_unstable();
    let body = encode_commit_body(&CommitBody {
        logical_timestamp: u64::from(marker),
        operations: Vec::new(),
        manifest_root: *blake3::hash(&[marker, 1]).as_bytes(),
        manifest_blob_id: *blake3::hash(&[marker, 2]).as_bytes(),
        merge_base: None,
        conflict_objects: Vec::new(),
    })
    .unwrap();
    let encrypted_body =
        encrypt_object(subkeys, vault_id, test_uuid(), 1, ObjectType::Commit, &body).unwrap();
    encode_signed_commit(
        &SignedCommit::create(
            UnsignedCommit {
                vault_id,
                parents,
                device_id: device.id,
                device_sequence,
                encrypted_body,
            },
            &device.signing_key,
        )
        .unwrap(),
    )
    .unwrap()
}

async fn assert_replay_is_rejected(session: &mut ClientSession) {
    let replayed = session.prepare(Request::Ping);
    assert_eq!(session.send_prepared(&replayed).await, Response::Pong);
    let (status, body) = http_request(session.address, "POST", "/v1/envelope", &replayed).await;
    assert_eq!(status, 400);
    assert!(body.is_empty());
}

async fn assert_revocation_is_immediate(
    address: SocketAddr,
    bootstrap: &Bootstrap,
    authentication_key: &ServerAuthKey,
    device: &TestDevice,
    primary: &mut ClientSession,
    post_revoke_commit: Vec<u8>,
) {
    let mut revoked_session = ClientSession::connect(address, bootstrap).await;
    revoked_session
        .authenticate_existing(authentication_key, device.id, &device.signing_key)
        .await;
    assert_eq!(
        primary
            .send(Request::RevokeDevice {
                device_id: device.id,
            })
            .await,
        Response::DeviceRevoked
    );
    assert_eq!(
        revoked_session
            .send(Request::PutCommit {
                signed_commit: post_revoke_commit,
            })
            .await,
        Response::Error(ErrorCode::DeviceRevoked)
    );
}

async fn assert_wrong_password_closes_session(
    address: SocketAddr,
    bootstrap: &Bootstrap,
    challenge_policy: ([u8; 16], Argon2Policy),
) {
    let mut wrong_password = ClientSession::connect(address, bootstrap).await;
    let other_password = random_test_password().unwrap();
    let wrong_key = derive_server_auth_key(
        other_password.as_bytes(),
        &challenge_policy.0,
        challenge_policy.1,
    )
    .unwrap();
    let proof = password_proof(&wrong_key, &wrong_password.authentication_context);
    assert_eq!(
        wrong_password
            .send(Request::Authenticate {
                proof,
                device_id: None,
                device_signature: None,
            })
            .await,
        Response::Error(ErrorCode::AuthenticationFailed)
    );
    let rejected = wrong_password.prepare(Request::Ping);
    let (status, _) = http_request(address, "POST", "/v1/envelope", &rejected).await;
    assert_eq!(status, 400);
    assert_eq!(handshake_status(address, bootstrap).await, 429);
}

async fn handshake_status(address: SocketAddr, bootstrap: &Bootstrap) -> u16 {
    let mut initiator =
        build_initiator(&bootstrap.server_static_public_key, &bootstrap.instance_id).unwrap();
    let mut message = vec![0_u8; MAX_HANDSHAKE_BYTES];
    let length = initiator.write_message(&[], &mut message).unwrap();
    let (status, _) = http_request(address, "POST", "/v1/handshake", &message[..length]).await;
    status
}

async fn challenge_policy(address: SocketAddr, bootstrap: &Bootstrap) -> ([u8; 16], Argon2Policy) {
    let mut initiator =
        build_initiator(&bootstrap.server_static_public_key, &bootstrap.instance_id).unwrap();
    let mut message = vec![0_u8; MAX_HANDSHAKE_BYTES];
    let length = initiator.write_message(&[], &mut message).unwrap();
    message.truncate(length);
    let (status, response) = http_request(address, "POST", "/v1/handshake", &message).await;
    assert_eq!(status, 200);
    let mut payload = vec![0_u8; MAX_HANDSHAKE_BYTES];
    let length = initiator.read_message(&response, &mut payload).unwrap();
    let challenge: AuthChallenge = decode_auth_challenge(&payload[..length]).unwrap();
    (
        challenge.authentication_salt,
        Argon2Policy {
            memory_kib: challenge.argon2_memory_kib,
            iterations: challenge.argon2_iterations,
            parallelism: challenge.argon2_parallelism,
        },
    )
}

async fn http_request(
    address: SocketAddr,
    method: &str,
    path: &str,
    body: &[u8],
) -> (u16, Vec<u8>) {
    let mut stream = TcpStream::connect(address).await.unwrap();
    let header = format!(
        "{method} {path} HTTP/1.1\r\nHost: {address}\r\nContent-Type: application/octet-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        body.len()
    );
    stream.write_all(header.as_bytes()).await.unwrap();
    stream.write_all(body).await.unwrap();
    let mut response = Vec::new();
    stream.read_to_end(&mut response).await.unwrap();
    let separator = response
        .windows(4)
        .position(|window| window == b"\r\n\r\n")
        .unwrap();
    let headers = std::str::from_utf8(&response[..separator]).unwrap();
    let status = headers
        .lines()
        .next()
        .unwrap()
        .split_ascii_whitespace()
        .nth(1)
        .unwrap()
        .parse()
        .unwrap();
    (status, response[separator + 4..].to_vec())
}

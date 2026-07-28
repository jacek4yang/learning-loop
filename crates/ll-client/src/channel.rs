use ll_crypto::{
    Argon2Policy, authentication_context, build_initiator, decrypt_transport_records,
    derive_server_auth_key, device_auth_signature_context, encrypt_transport_records,
    password_proof, registration_signature_context, server_fingerprint,
};
use ll_protocol::{
    AuthChallenge, Bootstrap, ClientMessage, MAX_HANDSHAKE_BYTES, Request, Response, ServerMessage,
    decode_auth_challenge, decode_bootstrap, decode_server_message, decode_transport_frame,
    encode_client_message, encode_transport_frame,
};
use subtle::ConstantTimeEq;
use zeroize::{Zeroize, Zeroizing};

use crate::{ClientError, DeviceIdentity};

/// Stateful pinned Noise client. A network error must discard this value and
/// start a fresh handshake because transport nonces are never rolled back.
pub struct ClientChannel {
    handshake: Option<snow::HandshakeState>,
    transport: Option<snow::TransportState>,
    challenge: Option<AuthChallenge>,
    authentication_context: Option<Vec<u8>>,
    next_client_sequence: u64,
    next_server_sequence: u64,
}

impl ClientChannel {
    /// Validates bootstrap identity and creates the first NK handshake message.
    ///
    /// # Errors
    ///
    /// Returns a bootstrap, fingerprint, protocol, or Noise failure.
    pub fn begin(
        encoded_bootstrap: &[u8],
        pinned_fingerprint: &str,
    ) -> Result<(Self, Vec<u8>), ClientError> {
        let bootstrap = decode_bootstrap(encoded_bootstrap)?;
        validate_bootstrap(&bootstrap, pinned_fingerprint)?;
        let mut handshake =
            build_initiator(&bootstrap.server_static_public_key, &bootstrap.instance_id)?;
        let mut message = vec![0_u8; MAX_HANDSHAKE_BYTES];
        let written = handshake.write_message(&[], &mut message)?;
        message.truncate(written);
        Ok((
            Self {
                handshake: Some(handshake),
                transport: None,
                challenge: None,
                authentication_context: None,
                next_client_sequence: 0,
                next_server_sequence: 0,
            },
            message,
        ))
    }

    /// Completes NK and authenticates the encrypted server challenge.
    ///
    /// # Errors
    ///
    /// Returns a state, Noise, or deterministic challenge decoding failure.
    pub fn complete_handshake(&mut self, response: &[u8]) -> Result<(), ClientError> {
        let mut handshake = self.handshake.take().ok_or(ClientError::InvalidState)?;
        let mut payload = vec![0_u8; MAX_HANDSHAKE_BYTES];
        let written = handshake.read_message(response, &mut payload)?;
        payload.truncate(written);
        let challenge = decode_auth_challenge(&payload)?;
        let context = authentication_context(
            handshake.get_handshake_hash(),
            &challenge.random_challenge,
            &challenge.session_id,
        );
        self.transport = Some(handshake.into_transport_mode()?);
        self.authentication_context = Some(context);
        self.challenge = Some(challenge);
        Ok(())
    }

    /// Builds the first encrypted server-password and optional device proof.
    ///
    /// # Errors
    ///
    /// Returns a state, KDF, signing, protocol, or transport failure.
    pub fn authenticate(
        &mut self,
        mut server_password: Zeroizing<String>,
        device: Option<&DeviceIdentity>,
    ) -> Result<Vec<u8>, ClientError> {
        let challenge = self.challenge.as_ref().ok_or(ClientError::InvalidState)?;
        let context = self
            .authentication_context
            .as_ref()
            .ok_or(ClientError::InvalidState)?;
        let key = derive_server_auth_key(
            server_password.as_bytes(),
            &challenge.authentication_salt,
            Argon2Policy {
                memory_kib: challenge.argon2_memory_kib,
                iterations: challenge.argon2_iterations,
                parallelism: challenge.argon2_parallelism,
            },
        )?;
        server_password.zeroize();
        let (device_id, device_signature) = device.map_or((None, None), |identity| {
            (
                Some(identity.device_id()),
                Some(identity.sign(&device_auth_signature_context(context))),
            )
        });
        self.request(Request::Authenticate {
            proof: password_proof(&key, context),
            device_id,
            device_signature,
        })
    }

    /// Builds a proof-of-possession device registration request.
    ///
    /// `encrypted_name` must be a VMK-encrypted metadata object.
    ///
    /// # Errors
    ///
    /// Returns a state, protocol, signing, or transport failure.
    pub fn register_device(
        &mut self,
        device: &DeviceIdentity,
        encrypted_name: Vec<u8>,
    ) -> Result<Vec<u8>, ClientError> {
        let context = self
            .authentication_context
            .as_ref()
            .ok_or(ClientError::InvalidState)?;
        let public_key = device.public_key();
        let signature = device.sign(&registration_signature_context(
            context,
            &device.device_id(),
            &public_key,
        ));
        self.request(Request::RegisterDevice {
            device_id: device.device_id(),
            public_key,
            encrypted_name,
            signature,
        })
    }

    /// Encrypts and frames one sequenced application request.
    ///
    /// # Errors
    ///
    /// Returns a state, sequence, protocol, or transport failure.
    pub fn request(&mut self, request: Request) -> Result<Vec<u8>, ClientError> {
        let challenge = self.challenge.as_ref().ok_or(ClientError::InvalidState)?;
        let transport = self.transport.as_mut().ok_or(ClientError::InvalidState)?;
        let message = encode_client_message(&ClientMessage {
            sequence: self.next_client_sequence,
            request,
        })?;
        let records = encrypt_transport_records(transport, &message)?;
        let frame = encode_transport_frame(&challenge.session_handle, &records)?;
        self.next_client_sequence = self
            .next_client_sequence
            .checked_add(1)
            .ok_or(ClientError::InvalidSequence)?;
        Ok(frame)
    }

    /// Authenticates, decodes, and sequence-checks one server frame.
    ///
    /// # Errors
    ///
    /// Returns a frame, session, Noise, protocol, or sequence failure.
    pub fn response(&mut self, encoded: &[u8]) -> Result<Response, ClientError> {
        let challenge = self.challenge.as_ref().ok_or(ClientError::InvalidState)?;
        let frame = decode_transport_frame(encoded)?;
        if !bool::from(frame.session_handle.ct_eq(&challenge.session_handle)) {
            return Err(ClientError::InvalidSequence);
        }
        let transport = self.transport.as_mut().ok_or(ClientError::InvalidState)?;
        let clear = decrypt_transport_records(transport, frame.ciphertext)?;
        let ServerMessage { sequence, response } = decode_server_message(&clear)?;
        if sequence != self.next_server_sequence {
            return Err(ClientError::InvalidSequence);
        }
        self.next_server_sequence = self
            .next_server_sequence
            .checked_add(1)
            .ok_or(ClientError::InvalidSequence)?;
        Ok(response)
    }
}

fn validate_bootstrap(bootstrap: &Bootstrap, pinned: &str) -> Result<(), ClientError> {
    let computed = server_fingerprint(&bootstrap.server_static_public_key);
    if bootstrap.server_fingerprint == computed && pinned == computed {
        Ok(())
    } else {
        Err(ClientError::InvalidBootstrap)
    }
}

#[cfg(test)]
mod tests {
    use ll_crypto::{
        Argon2Policy, ServerIdentity, accept_handshake, authentication_context,
        decrypt_transport_records, derive_server_auth_key, encrypt_transport_records,
        server_fingerprint, verify_password_proof,
    };
    use ll_protocol::{
        AuthChallenge, Bootstrap, ClientMessage, PROTOCOL_VERSION, Request, Response,
        ServerMessage, decode_client_message, decode_transport_frame, encode_auth_challenge,
        encode_bootstrap, encode_server_message, encode_transport_frame,
    };
    use ll_testkit::random_test_password;

    use super::ClientChannel;

    #[test]
    fn pinned_channel_completes_authentication_and_sequences_transport() {
        let directory = tempfile::tempdir().unwrap();
        let identity = ServerIdentity::load_or_create(directory.path()).unwrap();
        let instance_id = [1; 16];
        let fingerprint = server_fingerprint(identity.public_key());
        let bootstrap = encode_bootstrap(&Bootstrap {
            protocol_version: PROTOCOL_VERSION,
            instance_id,
            noise_suite: ll_protocol::NOISE_SUITE.to_owned(),
            server_static_public_key: *identity.public_key(),
            server_fingerprint: fingerprint.clone(),
            maximum_handshake_bytes: 4096,
            maximum_transport_bytes: 1024 * 1024,
        })
        .unwrap();
        assert!(ClientChannel::begin(&bootstrap, "SHA256:WRONG").is_err());
        let (mut client, first) = ClientChannel::begin(&bootstrap, &fingerprint).unwrap();
        let challenge = AuthChallenge {
            session_handle: [2; 32],
            authentication_salt: [3; 16],
            argon2_memory_kib: 19_456,
            argon2_iterations: 1,
            argon2_parallelism: 1,
            random_challenge: [4; 32],
            session_id: [5; 16],
        };
        let accepted = accept_handshake(
            &identity,
            &instance_id,
            &first,
            &encode_auth_challenge(&challenge).unwrap(),
        )
        .unwrap();
        client.complete_handshake(&accepted.response).unwrap();

        let password = random_test_password().unwrap();
        let request = client.authenticate(password.clone(), None).unwrap();
        let frame = decode_transport_frame(&request).unwrap();
        assert_eq!(frame.session_handle, challenge.session_handle);
        let mut server_transport = accepted.transport;
        let clear = decrypt_transport_records(&mut server_transport, frame.ciphertext).unwrap();
        let ClientMessage {
            sequence,
            request: Request::Authenticate { proof, .. },
        } = decode_client_message(&clear).unwrap()
        else {
            panic!("client must send the authentication request first");
        };
        assert_eq!(sequence, 0);
        let auth_key = derive_server_auth_key(
            password.as_bytes(),
            &challenge.authentication_salt,
            Argon2Policy {
                memory_kib: challenge.argon2_memory_kib,
                iterations: challenge.argon2_iterations,
                parallelism: challenge.argon2_parallelism,
            },
        )
        .unwrap();
        let context = authentication_context(
            &accepted.handshake_hash,
            &challenge.random_challenge,
            &challenge.session_id,
        );
        verify_password_proof(&auth_key, &context, &proof).unwrap();

        let response = encode_server_message(&ServerMessage {
            sequence: 0,
            response: Response::Authenticated {
                device_authenticated: false,
                vault_id: [6; 16],
            },
        })
        .unwrap();
        let records = encrypt_transport_records(&mut server_transport, &response).unwrap();
        let frame = encode_transport_frame(&challenge.session_handle, &records).unwrap();
        assert_eq!(
            client.response(&frame).unwrap(),
            Response::Authenticated {
                device_authenticated: false,
                vault_id: [6; 16],
            }
        );
    }
}

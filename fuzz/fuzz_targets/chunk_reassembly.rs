#![no_main]

use libfuzzer_sys::fuzz_target;
use ll_protocol::{MAX_CHUNK_BYTES, Response, ServerMessage, decode_server_message};

fuzz_target!(|data: &[u8]| {
    let mut cursor = 0_usize;
    let mut expected_offset = 0_u64;
    let mut declared_total = None;
    let mut assembled = Vec::new();

    while cursor.saturating_add(2) <= data.len() {
        let length = usize::from(u16::from_be_bytes([data[cursor], data[cursor + 1]]));
        cursor += 2;
        let end = cursor.saturating_add(length).min(data.len());
        let candidate = &data[cursor..end];
        cursor = end;

        let Ok(ServerMessage {
            response:
                Response::BlobChunk {
                    offset,
                    total_size,
                    complete,
                    chunk,
                },
            ..
        }) = decode_server_message(candidate)
        else {
            continue;
        };
        if offset != expected_offset
            || chunk.len() > MAX_CHUNK_BYTES
            || declared_total.is_some_and(|known| known != total_size)
        {
            break;
        }
        declared_total = Some(total_size);
        let Ok(chunk_len) = u64::try_from(chunk.len()) else {
            break;
        };
        let Some(next) = expected_offset.checked_add(chunk_len) else {
            break;
        };
        if next > total_size {
            break;
        }
        assembled.extend_from_slice(&chunk);
        expected_offset = next;
        if complete {
            let _is_exact = expected_offset == total_size;
            break;
        }
        if chunk.is_empty() {
            break;
        }
    }
});

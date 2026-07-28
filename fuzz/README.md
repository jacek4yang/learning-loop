# Fuzz targets

These `cargo-fuzz` targets exercise all untrusted deterministic decoders added
through phase 2:

- `protocol_decoders`: transport framing, application messages, invalid length
  fields, and upload-chunk messages;
- `commit_decoders`: signed commits, commit bodies, and manifests;
- `portable_path`: Unicode normalization, portable validation, and repair
  suggestions;
- `encrypted_manifest`: VMK/object envelope parsing, corrupted ciphertext, and
  decrypted manifest/body handoff.

Run them on Linux with nightly Rust:

```bash
cargo install cargo-fuzz --locked
cargo +nightly fuzz run protocol_decoders
cargo +nightly fuzz run commit_decoders
cargo +nightly fuzz run portable_path
cargo +nightly fuzz run encrypted_manifest
```

`libfuzzer-sys` relies on Rust sanitizer support and cannot execute on the
Windows MSVC development host. CI runs bounded smoke sessions on Linux; longer
campaigns should retain their generated corpora outside the repository.

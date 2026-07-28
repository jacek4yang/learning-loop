use ll_canonical::{PortablePath, canonicalize_text, detect_collisions};

#[test]
fn multilingual_deep_and_punctuation_paths_are_portable() {
    let cases = [
        "中文/问题.md",
        "日本語/設計.md",
        "한국어/노트.md",
        "emoji/🧪-🔐.md",
        "space allowed/many.parts.in.a.name.md",
        "deep/a/b/c/d/e/f/g/h/i/j/note.md",
    ];
    for case in cases {
        let parsed = PortablePath::parse(case).unwrap();
        assert_eq!(PortablePath::parse(parsed.as_str()).unwrap(), parsed);
    }
}

#[test]
fn platform_aliases_traversal_illegal_suffixes_and_limits_are_rejected() {
    let cases = [
        "../escape.md",
        "folder/../../escape.md",
        "CON.txt",
        "com1",
        "LPT9.log",
        "trailing.",
        "trailing ",
        "colon:name.md",
        "star*.md",
        "question?.md",
        "slash\\name.md",
        "control\u{7}.md",
    ];
    for case in cases {
        assert!(PortablePath::parse(case).is_err(), "{case:?} was accepted");
    }
    assert!(PortablePath::parse(&format!("{}.md", "a".repeat(256))).is_err());
    assert!(PortablePath::parse(&vec!["segment"; 200].join("/")).is_err());
}

#[test]
fn case_normalization_and_file_directory_prefixes_are_collisions() {
    let paths = [
        "Note.md",
        "note.md",
        "Unicode/é.md",
        "unicode/e\u{301}.md",
        "folder",
        "folder/child.md",
    ]
    .into_iter()
    .map(|value| PortablePath::parse(value).unwrap());
    let collisions = detect_collisions(paths);
    assert_eq!(
        collisions.len(),
        3,
        "case, NFC/NFD, and file/directory aliases must all be explicit"
    );
}

#[test]
fn text_content_matrix_has_one_canonical_form_without_reformatting() {
    let cases: &[(&[u8], &[u8])] = &[
        (b"", b""),
        (b"no final newline", b"no final newline"),
        (b"\xef\xbb\xbfBOM\r\nline\r", b"BOM\nline\n"),
        (b"LF\nCRLF\r\nCR\r", b"LF\nCRLF\nCR\n"),
        (
            b"---\nproperty: |\n  multiline\n---\n```rust\n# not a heading\n```\n",
            b"---\nproperty: |\n  multiline\n---\n```rust\n# not a heading\n```\n",
        ),
        (
            br#"{"nodes":[{"id":"a","type":"text","text":"value"}],"edges":[]}"#,
            br#"{"nodes":[{"id":"a","type":"text","text":"value"}],"edges":[]}"#,
        ),
        (
            b"filters:\n  and:\n    - file.ext == \"md\"\nproperties:\n  status:\n    displayName: Status",
            b"filters:\n  and:\n    - file.ext == \"md\"\nproperties:\n  status:\n    displayName: Status",
        ),
    ];
    for (input, expected) in cases {
        assert_eq!(canonicalize_text(input).unwrap(), *expected);
    }
}

use crate::nonce::Nonce;

/// The two halves of the frame, spelled once. Long and unlovely on purpose: a
/// mark short enough to occur by accident in a `PATH` entry would close a
/// harvest that was still being written.
const BEGIN: &str = "__PERSEVERANCE_BEGIN_";
const END: &str = "__PERSEVERANCE_END_";

/// `\n__PERSEVERANCE_BEGIN_<nonce>__\n`, as bytes.
///
/// Newline-wrapped and searched as a byte substring rather than compared
/// against a record. A chatty rc writes its banner with no trailing NUL, so the
/// first NUL-delimited segment of the stream is `BANNER\n__PERSEVERANCE_BEGIN…`
/// — which *equals* no mark at all. #26 found every byte a profile wrote to
/// stdout landing before the opening mark in all 25 non-timeout fixtures, so a
/// parser that compares records for equality fails on the whole measured
/// corpus while its chatty-preamble test still passes.
pub fn opening_mark(nonce: &Nonce) -> Vec<u8> {
    format!("\n{BEGIN}{}__\n", nonce.as_str()).into_bytes()
}

/// `__PERSEVERANCE_END_<nonce>__\n`, as bytes.
///
/// No leading newline, unlike the opening mark, and the asymmetry is the
/// grammar rather than an oversight: the byte before it is always the NUL that
/// ended the last record, so the frame body is exactly a run of NUL-terminated
/// records and there is no trailing fragment to reason about.
pub fn closing_mark(nonce: &Nonce) -> Vec<u8> {
    format!("{END}{}__\n", nonce.as_str()).into_bytes()
}

/// The single argument handed to `-c`.
///
/// ```text
/// printf '\n%s\n' '__PERSEVERANCE_BEGIN_<nonce>__'; env -0; printf '%s\n' '__PERSEVERANCE_END_<nonce>__'
/// ```
///
/// `env -0` rather than `env`: NUL records, so a value holding a newline cannot
/// forge a boundary — which is also, for free, the NUL-delimited payload #26
/// recommends in place of the line-oriented shape it disproved. No `cd`
/// anywhere: #24 calls that the load-bearing correction, because the child's
/// working directory is set at spawn and a `cd` inside the command would run
/// before the framing and put its own output where the opening mark belongs.
/// `printf` and `;` are all this needs, so bash, zsh, ksh, dash and fish can
/// each run it.
pub fn unix_payload(nonce: &Nonce) -> String {
    let nonce = nonce.as_str();
    format!("printf '\\n%s\\n' '{BEGIN}{nonce}__'; env -0; printf '%s\\n' '{END}{nonce}__'")
}

/// The text encoded into `-EncodedCommand`.
///
/// ```powershell
/// $o=[Console]::OpenStandardOutput()
/// function W([byte[]]$b){$o.Write($b,0,$b.Length)}
/// function T([string]$s){W([Text.Encoding]::UTF8.GetBytes($s))}
/// T("`n__PERSEVERANCE_BEGIN_<nonce>__`n")
/// foreach($e in [Environment]::GetEnvironmentVariables().GetEnumerator()){
///   T("<nonce>:V:"+$e.Key+"="+$e.Value); W([byte[]]@(0))}
/// T("__PERSEVERANCE_END_<nonce>__`n")
/// $o.Flush()
/// ```
///
/// Bytes are hand-encoded to UTF-8 and written straight to the standard-output
/// handle, so nothing here depends on `[Console]::OutputEncoding` taking, on
/// the host's formatter, or on the pipeline — the formatter is what hard-wraps
/// text at console width, and the shape #26 measured
/// (`Get-ChildItem Env: | ForEach-Object { "{0}={1}" }`) is the line-oriented
/// one it disproved. Each record carries the nonce, which `env -0` cannot do;
/// see [`RecordTag`] for what that buys and what it does not.
///
/// [`RecordTag`]: crate::RecordTag
pub fn powershell_payload(nonce: &Nonce) -> String {
    let nonce = nonce.as_str();
    format!(
        "$o=[Console]::OpenStandardOutput()\n\
         function W([byte[]]$b){{$o.Write($b,0,$b.Length)}}\n\
         function T([string]$s){{W([Text.Encoding]::UTF8.GetBytes($s))}}\n\
         T(\"`n{BEGIN}{nonce}__`n\")\n\
         foreach($e in [Environment]::GetEnvironmentVariables().GetEnumerator())\
         {{T(\"{nonce}:V:\"+$e.Key+\"=\"+$e.Value);W([byte[]]@(0))}}\n\
         T(\"{END}{nonce}__`n\")\n\
         $o.Flush()\n"
    )
}

/// `<nonce>:V:`, the prefix every record carries where [`RecordTag::Required`]
/// applies. Written once so the payload that emits it and the parser that
/// demands it cannot drift apart.
///
/// [`RecordTag::Required`]: crate::RecordTag::Required
pub(crate) fn record_prefix(nonce: &Nonce) -> Vec<u8> {
    format!("{}:V:", nonce.as_str()).into_bytes()
}

/// UTF-16LE, then base64 over the RFC 4648 alphabet. Hand-rolled for the same
/// reason `perseverance-store` hand-rolled an INI reader rather than take a
/// config dependency: it is twenty lines and four known-answer vectors.
pub fn encode_command(payload: &str) -> String {
    let mut utf16 = Vec::with_capacity(payload.len() * 2);
    for unit in payload.encode_utf16() {
        utf16.extend_from_slice(&unit.to_le_bytes());
    }
    base64(&utf16)
}

/// The RFC 4648 alphabet with padding, which is the only spelling
/// `-EncodedCommand` accepts.
fn base64(bytes: &[u8]) -> String {
    const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

    let mut encoded = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let triple = (u32::from(chunk[0]) << 16)
            | (u32::from(chunk.get(1).copied().unwrap_or(0)) << 8)
            | u32::from(chunk.get(2).copied().unwrap_or(0));

        encoded.push(ALPHABET[(triple >> 18) as usize & 0x3f] as char);
        encoded.push(ALPHABET[(triple >> 12) as usize & 0x3f] as char);
        encoded.push(if chunk.len() > 1 {
            ALPHABET[(triple >> 6) as usize & 0x3f] as char
        } else {
            '='
        });
        encoded.push(if chunk.len() > 2 {
            ALPHABET[triple as usize & 0x3f] as char
        } else {
            '='
        });
    }
    encoded
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Undoes [`base64`] and the UTF-16LE, so the payload test asserts what
    /// PowerShell would receive rather than what we believe we sent.
    pub(crate) fn decode_command(encoded: &str) -> String {
        const ALPHABET: &[u8; 64] =
            b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

        let mut bytes: Vec<u8> = Vec::new();
        let mut accumulator: u32 = 0;
        let mut bits = 0;
        for character in encoded.bytes().filter(|byte| *byte != b'=') {
            let value = ALPHABET
                .iter()
                .position(|candidate| *candidate == character)
                .expect("the encoder only emits the RFC 4648 alphabet");
            accumulator = (accumulator << 6) | value as u32;
            bits += 6;
            if bits >= 8 {
                bits -= 8;
                bytes.push((accumulator >> bits) as u8);
            }
        }

        let units: Vec<u16> = bytes
            .chunks_exact(2)
            .map(|pair| u16::from_le_bytes([pair[0], pair[1]]))
            .collect();
        String::from_utf16(&units).expect("the encoder only emits well-formed UTF-16")
    }

    #[test]
    fn the_unix_payload_dumps_the_environment_nul_delimited_and_never_changes_directory() {
        let payload = unix_payload(&Nonce::from_literal("deadbeefdeadbeef"));

        assert!(payload.contains("env -0"), "{payload}");
        // The child's working directory is set at spawn. A `cd` in here would
        // run before the framing and put its own output where the opening mark
        // belongs — #24 calls this the load-bearing correction.
        assert!(!payload.contains("cd "), "{payload}");
        assert!(payload.contains("__PERSEVERANCE_BEGIN_deadbeefdeadbeef__"));
        assert!(payload.contains("__PERSEVERANCE_END_deadbeefdeadbeef__"));
    }

    #[test]
    fn the_unix_payload_needs_nothing_but_printf_and_a_semicolon() {
        let payload = unix_payload(&Nonce::from_literal("deadbeefdeadbeef"));

        // sh, bash, zsh, ksh and fish all take this. Anything more — an array,
        // a `local`, a `$(…)` — would narrow the set of shells an operator may
        // have without saying so.
        for word in ["printf", "env -0"] {
            assert!(payload.contains(word), "{payload}");
        }
        assert!(!payload.contains('$'), "{payload}");
        assert!(!payload.contains('`'), "{payload}");
    }

    #[test]
    fn the_windows_payload_decodes_from_utf16le_and_carries_this_runs_nonce() {
        let nonce = Nonce::from_literal("00112233445566aa");

        let decoded = decode_command(&encode_command(&powershell_payload(&nonce)));

        assert!(
            decoded.contains("__PERSEVERANCE_BEGIN_00112233445566aa__"),
            "{decoded}"
        );
        assert!(
            decoded.contains("__PERSEVERANCE_END_00112233445566aa__"),
            "{decoded}"
        );
        assert!(decoded.contains("00112233445566aa:V:"), "{decoded}");
    }

    #[test]
    fn the_windows_payload_writes_bytes_to_the_handle_rather_than_through_the_formatter() {
        let decoded = decode_command(&encode_command(&powershell_payload(&Nonce::from_literal(
            "00112233445566aa",
        ))));

        // The formatter is what hard-wraps text at console width, and the
        // line-oriented `Get-ChildItem Env: | ForEach-Object` shape is the one
        // #26 disproved. Writing UTF-8 bytes straight to the handle removes
        // both the formatter and `[Console]::OutputEncoding` from the answer.
        assert!(
            decoded.contains("[Console]::OpenStandardOutput()"),
            "{decoded}"
        );
        assert!(
            decoded.contains("[Text.Encoding]::UTF8.GetBytes"),
            "{decoded}"
        );
        assert!(!decoded.contains("Get-ChildItem"), "{decoded}");
        assert!(!decoded.contains("Write-Output"), "{decoded}");
        assert!(!decoded.contains("Write-Host"), "{decoded}");
    }

    #[test]
    fn the_windows_payload_ends_every_record_with_a_nul_so_a_value_cannot_forge_a_boundary() {
        let decoded = decode_command(&encode_command(&powershell_payload(&Nonce::from_literal(
            "00112233445566aa",
        ))));

        assert!(decoded.contains("W([byte[]]@(0))"), "{decoded}");
    }

    #[test]
    fn base64_matches_the_rfc_4648_vectors() {
        assert_eq!(base64(b""), "");
        assert_eq!(base64(b"f"), "Zg==");
        assert_eq!(base64(b"fo"), "Zm8=");
        assert_eq!(base64(b"foo"), "Zm9v");
        assert_eq!(base64(b"foob"), "Zm9vYg==");
        assert_eq!(base64(b"fooba"), "Zm9vYmE=");
        assert_eq!(base64(b"foobar"), "Zm9vYmFy");
    }

    #[test]
    fn an_encoded_command_round_trips_through_utf16le_including_a_character_outside_the_bmp() {
        let payload = "$o = 'ünïcode — 🜁'";

        assert_eq!(decode_command(&encode_command(payload)), payload);
    }

    #[test]
    fn the_marks_wrap_the_frame_the_payload_writes() {
        let nonce = Nonce::from_literal("deadbeefdeadbeef");

        assert_eq!(
            opening_mark(&nonce),
            b"\n__PERSEVERANCE_BEGIN_deadbeefdeadbeef__\n"
        );
        assert_eq!(
            closing_mark(&nonce),
            b"__PERSEVERANCE_END_deadbeefdeadbeef__\n"
        );
    }

    #[test]
    fn a_mark_carrying_another_runs_nonce_is_not_our_mark() {
        let ours = Nonce::from_literal("aaaaaaaaaaaaaaaa");
        let theirs = Nonce::from_literal("bbbbbbbbbbbbbbbb");

        assert_ne!(opening_mark(&ours), opening_mark(&theirs));
        assert_ne!(closing_mark(&ours), closing_mark(&theirs));
    }
}

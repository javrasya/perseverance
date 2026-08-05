use std::collections::BTreeMap;

use crate::harvest::HarvestCondition;
use crate::nonce::Nonce;
use crate::payload::{closing_mark, opening_mark, record_prefix};

/// Whether a record inside the frame must carry `<nonce>:V:`.
///
/// `Required` on Windows, where we write the loop and the tag is free.
/// `Absent` on unix, where `env -0` cannot prefix and the NUL grammar plus the
/// shape check carry the weight.
///
/// The tag stops a *forged* record being accepted. It does not rescue a record
/// an interleaved writer landed inside — that record is corrupt under any
/// grammar and is dropped either way, which is why [`Tally::records_dropped`]
/// crosses the wire.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RecordTag {
    Required,
    Absent,
}

/// What was found either side of the frame and what was thrown away inside it.
///
/// Carried into the readout because a harvest that dropped nine records is a
/// different fact from one that dropped none, and neither is a failure.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Tally {
    pub records_seen: usize,
    /// Failed [`is_well_shaped`], or failed the nonce tag where it is required.
    /// #26's `System.Timers.Timer` vector wrote five junk lines *inside* the
    /// frame; `junkInside` read 0 across the rest of that matrix only because
    /// `ASYNC-JUNK timer` happens not to look like a variable. This makes it
    /// deliberate.
    pub records_dropped: usize,
    pub duplicates_dropped: usize,
    /// Everything before the winning opening mark: the chatty banner, and on
    /// Windows every byte 25 measured profiles wrote to stdout.
    pub bytes_before_frame: usize,
    pub bytes_after_frame: usize,
    /// More than one opening mark carrying *our* nonce. Recorded, never fatal:
    /// taking the last one already handles it.
    pub extra_opening_marks: usize,
}

/// Names are text; values are bytes.
///
/// A name that is not valid UTF-8 is taken lossily, for the reason the registry
/// takes a path lossily: what crosses to the WebView is text. A *value* is kept
/// as bytes and handed to the child unmangled, because a mangled `PATH` entry
/// is a spawn that fails for a reason nobody can see.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Reading {
    pub variables: BTreeMap<String, Vec<u8>>,
    pub tally: Tally,
}

/// Bytes in, environment out. Pure: no clock, no process, no file.
///
/// - Marks are found as **byte substrings**, not compared against records.
/// - The **last** opening mark wins. A profile that prints a mark, one variable
///   and a closing mark makes a first-mark parser return exactly that one
///   variable — a total substitution of the result, measured three ways in #26
///   and reproduced on zsh on this machine.
/// - The **first** closing mark after it wins, and the read stops there.
/// - **Both or nothing.** A killed harvest emits no pair at all, so truncation
///   is structurally detectable and there is nothing to salvage.
/// - Every record between them must pass [`is_well_shaped`] and, under
///   [`RecordTag::Required`], carry the nonce. Framing is mandatory and **not**
///   sufficient: an event handler registered on PowerShell's own pipeline wrote
///   five lines inside the frame.
/// - **First occurrence wins** on a duplicate name. `env -0` produces none, so
///   this only decides what happens under contamination — where anything
///   appended after the genuine record must not be able to replace `PATH`.
///
/// The one condition this cannot fill in honestly is
/// [`HarvestCondition::FrameNeverClosed`]'s duration: an opening mark with no
/// closing mark is exactly that condition, and this function has no clock. It
/// reports zero and [`harvest_with`], which does have one, replaces it.
///
/// [`harvest_with`]: crate::harvest_with
pub fn read_frame(
    bytes: &[u8],
    nonce: &Nonce,
    tag: RecordTag,
) -> Result<Reading, HarvestCondition> {
    let opening = opening_mark(nonce);
    let closing = closing_mark(nonce);

    let openings = occurrences(bytes, &opening);
    let Some(&last_opening) = openings.last() else {
        return Err(HarvestCondition::NoOpeningMark);
    };

    let body_start = last_opening + opening.len();
    let Some(body_end) = find_from(bytes, &closing, body_start) else {
        return Err(HarvestCondition::FrameNeverClosed { after_ms: 0 });
    };

    let mut tally = Tally {
        bytes_before_frame: last_opening,
        bytes_after_frame: bytes.len() - (body_end + closing.len()),
        extra_opening_marks: openings.len() - 1,
        ..Tally::default()
    };

    let prefix = record_prefix(nonce);
    let mut variables: BTreeMap<String, Vec<u8>> = BTreeMap::new();

    for record in records(&bytes[body_start..body_end]) {
        tally.records_seen += 1;

        let record = match tag {
            RecordTag::Required => match record.strip_prefix(prefix.as_slice()) {
                Some(tagged) => tagged,
                None => {
                    tally.records_dropped += 1;
                    continue;
                }
            },
            RecordTag::Absent => record,
        };

        if !is_well_shaped(record) {
            tally.records_dropped += 1;
            continue;
        }

        let cut = record
            .iter()
            .position(|byte| *byte == b'=')
            .expect("a well-shaped record holds an =");
        let name = String::from_utf8_lossy(&record[..cut]).into_owned();
        if variables.contains_key(&name) {
            tally.duplicates_dropped += 1;
            continue;
        }
        variables.insert(name, record[cut + 1..].to_vec());
    }

    if variables.is_empty() {
        return Err(HarvestCondition::NoVariablesSurvived);
    }
    // Matched without regard to case on both platforms, unlike
    // `Environment::get`: this is a structural check on a transcript that may
    // have come from either kind of shell, and a parser that behaved
    // differently on the two runners could not be reviewed from one of them.
    if !variables
        .keys()
        .any(|name| name.eq_ignore_ascii_case("PATH"))
    {
        return Err(HarvestCondition::NoPathInHarvest);
    }

    Ok(Reading { variables, tally })
}

/// `NAME=VALUE`, where the name is non-empty and holds no `=`, no NUL, no
/// newline and no carriage return.
///
/// The newline rule is what turns chatty output that landed inside the frame
/// into a dropped record rather than a variable. A name beginning with `=` —
/// Windows' per-drive current directory — fails, which is correct: it is not a
/// variable anyone can hand to a child.
pub fn is_well_shaped(record: &[u8]) -> bool {
    let Some(cut) = record.iter().position(|byte| *byte == b'=') else {
        return false;
    };
    let name = &record[..cut];

    !name.is_empty()
        && !name
            .iter()
            .any(|byte| matches!(byte, 0 | b'\n' | b'\r' | b'='))
}

/// The frame body, split on the NUL that ends every record.
///
/// A well-formed body ends with one, so the trailing segment is empty and is
/// not a record. A body that ends part-way through one — a writer that landed
/// inside the frame with no NUL of its own — leaves a non-empty fragment, and
/// that fragment is offered up as a record so the shape check can drop it and
/// count it rather than the bytes vanishing unrecorded.
fn records(body: &[u8]) -> Vec<&[u8]> {
    let mut segments: Vec<&[u8]> = body.split(|byte| *byte == 0).collect();
    if segments.last().is_some_and(|last| last.is_empty()) {
        segments.pop();
    }
    segments
}

/// Every non-overlapping start index of `needle` in `haystack`.
fn occurrences(haystack: &[u8], needle: &[u8]) -> Vec<usize> {
    let mut found = Vec::new();
    let mut from = 0;
    while let Some(at) = find_from(haystack, needle, from) {
        found.push(at);
        from = at + needle.len();
    }
    found
}

/// The first start index of `needle` at or after `from`. Byte substring search,
/// which is the whole of why a chatty preamble is preamble.
pub(crate) fn find_from(haystack: &[u8], needle: &[u8], from: usize) -> Option<usize> {
    if needle.is_empty() || haystack.len() < needle.len() {
        return None;
    }
    (from..=haystack.len() - needle.len()).find(|at| &haystack[*at..*at + needle.len()] == needle)
}

/// Assembles a transcript the way a shell would have written one, so no fixture
/// is checked in: `.gitattributes` is `* text=auto eol=lf`, and a transcript
/// holding a CRLF would be silently rewritten on the way in — after which
/// `assert_eq!(bytes, 616)` would be asserting something git decided.
#[cfg(test)]
pub(crate) fn framed(nonce: &Nonce, before: &[u8], records: &[&[u8]], after: &[u8]) -> Vec<u8> {
    let mut bytes = before.to_vec();
    bytes.extend_from_slice(&opening_mark(nonce));
    for record in records {
        bytes.extend_from_slice(record);
        bytes.push(0);
    }
    bytes.extend_from_slice(&closing_mark(nonce));
    bytes.extend_from_slice(after);
    bytes
}

/// The same, stopped after the records: a shell that opened the frame and was
/// then killed, or one still working through an rc when the bound expired.
#[cfg(test)]
pub(crate) fn opened_only(nonce: &Nonce, before: &[u8], records: &[&[u8]]) -> Vec<u8> {
    let mut bytes = before.to_vec();
    bytes.extend_from_slice(&opening_mark(nonce));
    for record in records {
        bytes.extend_from_slice(record);
        bytes.push(0);
    }
    bytes
}

#[cfg(test)]
mod tests {
    use super::*;

    fn nonce() -> Nonce {
        Nonce::from_literal("deadbeefdeadbeef")
    }

    fn value<'a>(reading: &'a Reading, name: &str) -> &'a [u8] {
        reading
            .variables
            .get(name)
            .unwrap_or_else(|| panic!("{name} survived"))
    }

    #[test]
    fn a_banner_before_the_opening_mark_is_not_mistaken_for_a_variable() {
        // The banner carries no trailing NUL, so the first NUL-delimited
        // segment of this stream is `welcome\n\n__PERSEVERANCE_BEGIN…PATH=/bin`
        // — which equals no mark at all. A parser that compared records for
        // equality would find no frame here, which is the whole measured
        // corpus.
        let bytes = framed(
            &nonce(),
            b"welcome",
            &[b"PATH=/bin", b"HOME=/Users/you"],
            b"",
        );

        let reading = read_frame(&bytes, &nonce(), RecordTag::Absent).expect("reads");

        assert_eq!(value(&reading, "PATH"), b"/bin");
        assert_eq!(value(&reading, "HOME"), b"/Users/you");
        assert_eq!(reading.variables.len(), 2);
        assert_eq!(reading.tally.bytes_before_frame, b"welcome".len());
        assert_eq!(reading.tally.records_seen, 2);
        assert_eq!(reading.tally.records_dropped, 0);
    }

    #[test]
    fn a_record_inside_the_frame_that_is_not_a_variable_is_dropped_and_counted() {
        // #26's `System.Timers.Timer` handler wrote five lines inside the
        // frame. Framing is mandatory and not sufficient.
        let bytes = framed(
            &nonce(),
            b"",
            &[
                b"PATH=/bin",
                b"ASYNC-JUNK timer 1",
                b"ASYNC-JUNK timer 2",
                b"ASYNC-JUNK timer 3",
                b"ASYNC-JUNK timer 4",
                b"ASYNC-JUNK timer 5",
                b"HOME=/Users/you",
            ],
            b"",
        );

        let reading = read_frame(&bytes, &nonce(), RecordTag::Absent).expect("reads");

        assert_eq!(reading.tally.records_seen, 7);
        assert_eq!(reading.tally.records_dropped, 5);
        assert_eq!(reading.variables.len(), 2);
        assert_eq!(value(&reading, "PATH"), b"/bin");
    }

    #[test]
    fn a_shell_that_printed_its_own_frame_first_cannot_substitute_the_harvest() {
        let mut bytes = framed(&nonce(), b"", &[b"INJECTED=evil", b"PATH=/nowhere"], b"");
        bytes.extend_from_slice(&framed(
            &nonce(),
            b"",
            &[b"PATH=/bin", b"HOME=/Users/you"],
            b"",
        ));

        let reading = read_frame(&bytes, &nonce(), RecordTag::Absent).expect("reads");

        // A first-mark parser answers with exactly the forged pair. That is the
        // answer this must not give.
        assert!(!reading.variables.contains_key("INJECTED"));
        assert_eq!(value(&reading, "PATH"), b"/bin");
        assert_eq!(reading.variables.len(), 2);
        assert_eq!(reading.tally.extra_opening_marks, 1);
    }

    #[test]
    fn a_second_opening_mark_wins_and_the_first_is_counted() {
        let mut bytes = framed(&nonce(), b"", &[b"PATH=/first"], b"");
        bytes.extend_from_slice(&framed(&nonce(), b"", &[b"PATH=/second"], b""));

        let reading = read_frame(&bytes, &nonce(), RecordTag::Absent).expect("reads");

        assert_eq!(value(&reading, "PATH"), b"/second");
        assert_eq!(reading.tally.extra_opening_marks, 1);
    }

    #[test]
    fn an_opening_mark_with_no_closing_mark_discards_everything() {
        let bytes = opened_only(&nonce(), b"welcome", &[b"PATH=/bin"]);

        let condition = read_frame(&bytes, &nonce(), RecordTag::Absent).expect_err("discards");

        // Not `NoOpeningMark`: there is a mark here, and a sentence saying
        // otherwise would send the reader to the wrong question.
        assert!(
            matches!(condition, HarvestCondition::FrameNeverClosed { .. }),
            "{condition:?}"
        );
    }

    #[test]
    fn a_closing_mark_with_no_opening_mark_discards_everything() {
        let mut bytes = b"PATH=/bin\0".to_vec();
        bytes.extend_from_slice(&closing_mark(&nonce()));

        let condition = read_frame(&bytes, &nonce(), RecordTag::Absent).expect_err("discards");

        assert_eq!(condition, HarvestCondition::NoOpeningMark);
    }

    #[test]
    fn a_frame_carrying_another_runs_nonce_is_not_this_runs_harvest() {
        let bytes = framed(
            &Nonce::from_literal("bbbbbbbbbbbbbbbb"),
            b"",
            &[b"PATH=/bin"],
            b"",
        );

        let condition = read_frame(&bytes, &nonce(), RecordTag::Absent).expect_err("discards");

        assert_eq!(condition, HarvestCondition::NoOpeningMark);
    }

    #[test]
    fn a_value_holding_a_newline_survives_because_records_end_at_a_nul() {
        let bytes = framed(
            &nonce(),
            b"",
            &[b"PATH=/bin", b"GREETING=first\nsecond"],
            b"",
        );

        let reading = read_frame(&bytes, &nonce(), RecordTag::Absent).expect("reads");

        assert_eq!(value(&reading, "GREETING"), b"first\nsecond");
        assert_eq!(reading.tally.records_dropped, 0);
    }

    #[test]
    fn a_value_that_is_not_utf8_reaches_the_child_unmangled() {
        // The name is taken lossily for the reason `folders.rs:181-184` takes a
        // path lossily — what crosses to the WebView is text. The value is not:
        // a mangled PATH entry is a spawn that fails for a reason nobody can
        // see.
        let bytes = framed(&nonce(), b"", &[b"PATH=/bin", b"ODD=\xff\xfe/caf\xe9"], b"");

        let reading = read_frame(&bytes, &nonce(), RecordTag::Absent).expect("reads");

        assert_eq!(value(&reading, "ODD"), b"\xff\xfe/caf\xe9");
    }

    #[test]
    fn the_first_occurrence_of_a_name_is_the_one_that_survives() {
        let bytes = framed(&nonce(), b"", &[b"PATH=/bin", b"PATH=/nowhere"], b"");

        let reading = read_frame(&bytes, &nonce(), RecordTag::Absent).expect("reads");

        assert_eq!(value(&reading, "PATH"), b"/bin");
        assert_eq!(reading.tally.duplicates_dropped, 1);
    }

    #[test]
    fn a_frame_with_no_path_is_not_an_environment() {
        let bytes = framed(
            &nonce(),
            b"",
            &[b"HOME=/Users/you", b"LANG=en_GB.UTF-8"],
            b"",
        );

        let condition = read_frame(&bytes, &nonce(), RecordTag::Absent).expect_err("discards");

        assert_eq!(condition, HarvestCondition::NoPathInHarvest);
    }

    #[test]
    fn a_frame_with_nothing_shaped_like_a_variable_in_it_is_not_an_environment() {
        let bytes = framed(&nonce(), b"", &[b"ASYNC-JUNK timer 1"], b"");

        let condition = read_frame(&bytes, &nonce(), RecordTag::Absent).expect_err("discards");

        assert_eq!(condition, HarvestCondition::NoVariablesSurvived);
    }

    #[test]
    fn noise_after_the_closing_mark_is_counted_and_not_read() {
        let bytes = framed(
            &nonce(),
            b"",
            &[b"PATH=/bin"],
            b"ASYNC-JUNK timer 6\nLATE=late\0",
        );

        let reading = read_frame(&bytes, &nonce(), RecordTag::Absent).expect("reads");

        assert!(!reading.variables.contains_key("LATE"));
        assert_eq!(reading.variables.len(), 1);
        assert_eq!(
            reading.tally.bytes_after_frame,
            "ASYNC-JUNK timer 6\nLATE=late\0".len()
        );
    }

    #[test]
    fn an_untagged_record_is_ordinary_on_unix_and_refused_on_windows() {
        let bytes = framed(
            &nonce(),
            b"",
            &[b"PATH=/bin", b"deadbeefdeadbeef:V:TAGGED=yes"],
            b"",
        );

        let unix = read_frame(&bytes, &nonce(), RecordTag::Absent).expect("reads");
        assert_eq!(unix.variables.len(), 2);
        assert_eq!(value(&unix, "PATH"), b"/bin");
        // Untagged on unix means nothing, so the tag itself becomes part of the
        // name rather than being stripped.
        assert!(unix.variables.contains_key("deadbeefdeadbeef:V:TAGGED"));

        let windows = read_frame(&bytes, &nonce(), RecordTag::Required).expect_err("discards");
        // `PATH=/bin` carries no tag, so under `Required` only the tagged
        // record survives — and it is not a PATH.
        assert_eq!(windows, HarvestCondition::NoPathInHarvest);
    }

    #[test]
    fn a_tagged_frame_reads_back_the_variables_the_windows_payload_wrote() {
        let bytes = framed(
            &nonce(),
            b"",
            &[
                b"deadbeefdeadbeef:V:Path=C:\\Windows",
                b"deadbeefdeadbeef:V:ProgramFiles(x86)=C:\\Program Files (x86)",
                b"ASYNC-JUNK timer 1",
            ],
            b"",
        );

        let reading = read_frame(&bytes, &nonce(), RecordTag::Required).expect("reads");

        assert_eq!(value(&reading, "Path"), b"C:\\Windows");
        assert_eq!(
            value(&reading, "ProgramFiles(x86)"),
            b"C:\\Program Files (x86)"
        );
        assert_eq!(reading.tally.records_dropped, 1);
    }

    #[test]
    fn a_forged_record_carrying_another_runs_tag_is_refused_where_the_tag_is_required() {
        let bytes = framed(
            &nonce(),
            b"",
            &[
                b"deadbeefdeadbeef:V:Path=C:\\Windows",
                b"bbbbbbbbbbbbbbbb:V:INJECTED=evil",
            ],
            b"",
        );

        let reading = read_frame(&bytes, &nonce(), RecordTag::Required).expect("reads");

        assert!(!reading.variables.contains_key("INJECTED"));
        assert_eq!(reading.variables.len(), 1);
        assert_eq!(reading.tally.records_dropped, 1);
    }

    #[test]
    fn a_fragment_left_by_a_writer_with_no_nul_of_its_own_is_dropped_rather_than_vanishing() {
        let mut bytes = opened_only(&nonce(), b"", &[b"PATH=/bin"]);
        bytes.extend_from_slice(b"ASYNC-JUNK timer");
        bytes.extend_from_slice(&closing_mark(&nonce()));

        let reading = read_frame(&bytes, &nonce(), RecordTag::Absent).expect("reads");

        assert_eq!(reading.tally.records_seen, 2);
        assert_eq!(reading.tally.records_dropped, 1);
        assert_eq!(value(&reading, "PATH"), b"/bin");
    }

    #[test]
    fn a_record_is_well_shaped_only_when_it_could_be_handed_to_a_child() {
        // A check nobody has ever seen fail is indistinguishable from a check
        // that cannot fail, so both answers are pinned here.
        assert!(is_well_shaped(b"PATH=/bin"));
        assert!(is_well_shaped(b"FOO="));
        assert!(is_well_shaped(b"FOO=a=b"));
        assert!(is_well_shaped(b"ProgramFiles(x86)=C:\\Program Files (x86)"));

        assert!(!is_well_shaped(b""));
        assert!(!is_well_shaped(b"FOO"));
        assert!(!is_well_shaped(b"=x"));
        // Windows' per-drive current directory. Real, and not a variable
        // anyone can hand to a child.
        assert!(!is_well_shaped(b"=C:\\Users"));
        assert!(!is_well_shaped(b"FOO\nBAR=x"));
        assert!(!is_well_shaped(b"FOO\rBAR=x"));
        assert!(!is_well_shaped(b"FOO\0BAR=x"));
    }
}

/// What ConPTY asks for before the child runs, and what a terminal answers.
///
/// `portable-pty` creates the pseudoconsole with `PSUEDOCONSOLE_INHERIT_CURSOR`
/// unconditionally, which makes ConPTY write a cursor-position request on the
/// output pipe **before the client starts** and wait for the reply on the input
/// pipe. Measured, in `docs/research/pty-spawn-agent-clis.md` §4: answer it and
/// 161 bytes arrive and the child exits 0; do not, and zero bytes arrive and the
/// child never runs at all.
const ASKED: &[u8] = b"\x1b[6n";

/// The answer: the cursor is at row 1, column 1.
///
/// Row 1 column 1 rather than anything cleverer because this is answered before
/// the child exists, so there is no cursor yet to report and the reply's only
/// job is to be a well-formed one.
pub const ANSWER: &[u8] = b"\x1b[1;1R";

/// The cursor-position requests in a stream of PTY reads.
///
/// **It lives in the plumbing rather than in the WebView**, and that is the
/// finding rather than a preference: an xterm.js-class renderer answers this
/// itself, so wiring the master through the frontend and back would satisfy
/// ConPTY — but every Rust-side consumer that does not is a child that produces
/// nothing and never exits. That includes a run nobody is monitoring, which is
/// most of them, and it includes every test. Research §9: *make the
/// query-responder part of the pty plumbing itself, not something the frontend
/// happens to provide.*
///
/// Carries the trailing bytes of each read, because the request can straddle a
/// read boundary and a scanner with no memory would miss it exactly when the
/// pipe is busiest.
#[derive(Debug, Default)]
pub struct Queries {
    carry: Vec<u8>,
}

impl Queries {
    /// How many answers this read calls for.
    ///
    /// A count rather than a boolean: ConPTY asks once at startup, but an agent
    /// that probes the cursor twice in one read gets two replies, and a terminal
    /// that answered the first and swallowed the second would be a terminal that
    /// lies about how many it saw.
    pub fn asked(&mut self, read: &[u8]) -> usize {
        // Only the tail can hold a straddling request, and a request is four
        // bytes, so three is the whole of what has to be remembered.
        let mut scanned = std::mem::take(&mut self.carry);
        scanned.extend_from_slice(read);

        let mut found = 0;
        let mut at = 0;
        while at + ASKED.len() <= scanned.len() {
            if &scanned[at..at + ASKED.len()] == ASKED {
                found += 1;
                at += ASKED.len();
            } else {
                at += 1;
            }
        }

        // Everything before `at` has either been counted or been ruled out as a
        // start, and what is left is shorter than a request by construction. So
        // the tail is the whole of what has to be remembered, and a request
        // already counted can never be counted again from it.
        self.carry = scanned[at..].to_vec();

        found
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_request_conpty_writes_before_the_child_runs_is_recognised() {
        let mut queries = Queries::default();

        // The first four bytes off the wire in the measured capture, at 24 ms,
        // before the client has said anything.
        assert_eq!(queries.asked(b"\x1b[6n\x1b[?9001h\x1b[?1004h"), 1);
    }

    #[test]
    fn a_request_split_across_two_reads_is_still_one_request() {
        for split in 1..ASKED.len() {
            let mut queries = Queries::default();
            let (head, tail) = ASKED.split_at(split);

            assert_eq!(queries.asked(head), 0, "split at {split} answered early");
            assert_eq!(queries.asked(tail), 1, "split at {split} was missed");
        }
    }

    #[test]
    fn a_request_split_three_ways_is_still_one_request() {
        let mut queries = Queries::default();

        assert_eq!(queries.asked(b"\x1b"), 0);
        assert_eq!(queries.asked(b"["), 0);
        assert_eq!(queries.asked(b"6"), 0);
        assert_eq!(queries.asked(b"n"), 1);
    }

    #[test]
    fn two_requests_in_one_read_call_for_two_answers() {
        let mut queries = Queries::default();

        assert_eq!(queries.asked(b"\x1b[6n\x1b[6n"), 2);
    }

    #[test]
    fn a_request_is_never_answered_twice_from_the_carry() {
        let mut queries = Queries::default();

        assert_eq!(queries.asked(b"x\x1b[6n"), 1);
        // The carry may not still be holding the tail of a request that has
        // already been counted.
        assert_eq!(queries.asked(b""), 0);
        assert_eq!(queries.asked(b"more output"), 0);
    }

    #[test]
    fn output_that_merely_looks_like_a_request_is_not_one() {
        let mut queries = Queries::default();

        for innocent in [
            &b"\x1b[6m"[..],
            b"\x1b[16n",
            b"[6n",
            b"\x1b6n",
            b"the sequence ESC[6n, written out",
        ] {
            assert_eq!(
                queries.asked(innocent),
                0,
                "{innocent:?} was read as a request"
            );
            // Reset between cases, so one case's tail is not the next one's
            // head and each assertion is about its own bytes.
            queries = Queries::default();
        }
    }

    #[test]
    fn the_answer_is_a_well_formed_cursor_position_report() {
        assert_eq!(ANSWER, b"\x1b[1;1R");
    }
}

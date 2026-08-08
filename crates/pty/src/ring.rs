use std::collections::VecDeque;

/// How much of one run's output is kept. Chosen to be several screens of a
/// wide terminal rather than a session transcript: the ring exists so a slow
/// WebView can be caught up, and an archive of the whole run is a different
/// feature with a different home.
pub const SCROLLBACK: usize = 512 * 1024;

/// One run's output, bounded, addressed by absolute offset.
///
/// **The invariant is contiguity.** Every byte the PTY produced has one
/// permanent offset in a single stream, and what this holds is always an
/// unbroken window of that stream — never a splice, never a sample. A VT stream
/// is not sampleable: discarding a range mid-flight cuts an escape sequence in
/// half and the terminal renders garbage permanently, so the only reduction
/// this type performs is dropping **whole scrollback from the front**, which is
/// the one reduction that leaves what remains a contiguous suffix.
///
/// Held as the reads that produced it rather than as one buffer, and that is
/// what makes the front drop free. A byte-buffer ring has to choose between an
/// O(n) shift per read and a wrap that no longer yields one contiguous slice;
/// dropping the oldest read entire costs a pointer.
///
/// Nothing here waits for anybody. The drain thread pushes and returns, so a
/// WebView that has stopped taking bytes slows nothing down and the child is
/// never blocked by a slow consumer — the throttling lives on the channel, in
/// [`Tap`], and never on the wire.
///
/// [`Tap`]: crate::Tap
#[derive(Debug)]
pub struct Ring {
    reads: VecDeque<Vec<u8>>,
    held: usize,
    capacity: usize,
    /// Absolute offset of the first byte still held.
    first: u64,
    /// How many bytes have been dropped from the front, ever. The chrome prints
    /// this; it never goes into the byte stream.
    dropped: u64,
}

impl Ring {
    pub fn new(capacity: usize) -> Ring {
        Ring {
            reads: VecDeque::new(),
            held: 0,
            capacity: capacity.max(1),
            first: 0,
            dropped: 0,
        }
    }

    /// One read off the PTY, appended.
    ///
    /// An empty read is not an event: it carries no bytes, so recording it
    /// would let `first` and `end` disagree about a boundary that does not
    /// exist.
    pub fn push(&mut self, read: &[u8]) {
        if read.is_empty() {
            return;
        }

        self.reads.push_back(read.to_vec());
        self.held += read.len();

        // Only ever from the front, and only ever a whole read. A single read
        // larger than the whole ring is kept rather than cut, because cutting
        // it would be the one thing this type exists to refuse — and the drain
        // loop's buffer is smaller than `SCROLLBACK`, so it cannot happen from
        // the one caller that matters.
        while self.held > self.capacity && self.reads.len() > 1 {
            let oldest = self.reads.pop_front().expect("more than one read");
            self.held -= oldest.len();
            self.first += oldest.len() as u64;
            self.dropped += oldest.len() as u64;
        }
    }

    /// Absolute offset of the oldest byte still held.
    pub fn first(&self) -> u64 {
        self.first
    }

    /// Absolute offset one past the newest byte — the length of the whole
    /// stream so far, including everything already dropped.
    pub fn end(&self) -> u64 {
        self.first + self.held as u64
    }

    pub fn held(&self) -> usize {
        self.held
    }

    /// How much of this run's output the operator can no longer be shown.
    /// Printed in the chrome and never anywhere else.
    pub fn dropped(&self) -> u64 {
        self.dropped
    }

    pub fn truncated(&self) -> bool {
        self.dropped > 0
    }

    /// Everything from `offset` to the end, or `None` when `offset` names a
    /// byte that has been dropped.
    ///
    /// `None` is the whole of the catch-up decision: there is no contiguous
    /// continuation from there, so the only honest move is to reset the
    /// terminal and replay. Returning a shortened range instead is what would
    /// put a spliced stream on the wire.
    pub fn from(&self, offset: u64) -> Option<Vec<u8>> {
        if offset < self.first || offset > self.end() {
            return None;
        }

        let mut skip = (offset - self.first) as usize;
        let mut taken = Vec::with_capacity(self.held - skip);
        for read in &self.reads {
            if skip >= read.len() {
                skip -= read.len();
                continue;
            }
            taken.extend_from_slice(&read[skip..]);
            skip = 0;
        }
        Some(taken)
    }

    /// Everything still held, as one buffer. What a replay sends.
    pub fn whole(&self) -> Vec<u8> {
        self.from(self.first).expect("the front is always present")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_offset_addresses_the_same_byte_for_as_long_as_it_is_held() {
        let mut ring = Ring::new(64);
        ring.push(b"abcde");
        ring.push(b"fghij");

        assert_eq!(ring.first(), 0);
        assert_eq!(ring.end(), 10);
        assert_eq!(ring.from(0).expect("held"), b"abcdefghij");
        assert_eq!(ring.from(5).expect("held"), b"fghij");
        // The end is a legal offset holding nothing, which is what a tap that
        // is fully caught up asks for.
        assert_eq!(ring.from(10).expect("held"), b"");
        assert_eq!(ring.from(11), None);
    }

    #[test]
    fn an_empty_read_is_not_a_boundary_because_it_is_not_bytes() {
        let mut ring = Ring::new(64);
        ring.push(b"ab");
        ring.push(b"");
        ring.push(b"cd");

        assert_eq!(ring.end(), 4);
        assert_eq!(ring.whole(), b"abcd");
        assert!(!ring.truncated());
    }

    #[test]
    fn overflowing_drops_whole_reads_from_the_front_and_never_from_the_middle() {
        let mut ring = Ring::new(8);
        ring.push(b"aaaa");
        ring.push(b"bbbb");
        ring.push(b"cccc");

        // The front went, entire. What is left is a contiguous suffix of the
        // stream, and its offsets still say where in that stream it is.
        assert_eq!(ring.first(), 4);
        assert_eq!(ring.end(), 12);
        assert_eq!(ring.whole(), b"bbbbcccc");
        assert_eq!(ring.dropped(), 4);
        assert!(ring.truncated());

        // And the offsets that went are refused rather than approximated.
        assert_eq!(ring.from(0), None);
        assert_eq!(ring.from(3), None);
        assert_eq!(ring.from(4).expect("held"), b"bbbbcccc");
    }

    #[test]
    fn what_is_held_is_always_an_unbroken_window_of_the_whole_stream() {
        // The property, asserted over a stream long enough to have gone round
        // the ring many times: whatever is held equals the same range of the
        // stream that produced it, byte for byte, at every step.
        let mut ring = Ring::new(100);
        let mut stream: Vec<u8> = Vec::new();
        let mut size = 1usize;

        for step in 0..200u8 {
            let read: Vec<u8> = (0..size).map(|_| step).collect();
            stream.extend_from_slice(&read);
            ring.push(&read);

            let first = ring.first() as usize;
            let end = ring.end() as usize;
            assert_eq!(end, stream.len(), "the stream length is the end offset");
            assert_eq!(
                ring.whole(),
                stream[first..end],
                "step {step} holds something other than the stream it was given"
            );

            size = size % 37 + 1;
        }

        assert!(ring.truncated());
    }

    #[test]
    fn a_read_larger_than_the_whole_ring_is_kept_rather_than_cut() {
        let mut ring = Ring::new(4);
        ring.push(b"aaaaaaaaaaaa");

        // Cutting it would be a splice, which is the one thing this type may
        // not do. It is over budget for as long as it is the only read held.
        assert_eq!(ring.whole(), b"aaaaaaaaaaaa");
        assert_eq!(ring.dropped(), 0);

        ring.push(b"b");
        assert_eq!(ring.whole(), b"b");
        assert_eq!(ring.dropped(), 12);
    }
}

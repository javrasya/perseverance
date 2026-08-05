use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

/// One run's mark, so a frame can be told from a frame something else printed.
///
/// Not cryptographic and not required to be. It travels in the argv on unix and
/// inside the encoded command on Windows, so a profile that reads its own
/// command line can forge it — and a profile that wanted to lie could simply set
/// `PATH` before our payload runs, since the profile and the answer share a
/// process. What it defeats is coincidence and a start-up file written in
/// advance, which is what #26 measured. Said here rather than implied by
/// calling it random.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Nonce(String);

/// Distinguishes two harvests taken inside one millisecond, which the clock
/// alone would not: a launch takes one, and #45 will take one per folder open.
static TAKEN: AtomicU64 = AtomicU64::new(0);

impl Nonce {
    /// The process id, the nanosecond clock and a counter — three things `std`
    /// already knows, so this crate needs no random-number dependency and its
    /// manifest stays one line long.
    pub fn fresh() -> Nonce {
        let process = u64::from(std::process::id());
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|since| since.as_nanos() as u64)
            .unwrap_or(0);
        let taken = TAKEN.fetch_add(1, Ordering::Relaxed);

        // splitmix64's finaliser, which is a bijection: two runs that differ in
        // any one of the three inputs differ here too, so the counter alone is
        // enough to separate a burst the clock could not.
        let mut mixed = process.rotate_left(32) ^ now ^ taken.wrapping_mul(0x9e37_79b9_7f4a_7c15);
        mixed ^= mixed >> 30;
        mixed = mixed.wrapping_mul(0xbf58_476d_1ce4_e5b9);
        mixed ^= mixed >> 27;
        mixed = mixed.wrapping_mul(0x94d0_49bb_1331_11eb);
        mixed ^= mixed >> 31;

        Nonce(format!("{mixed:016x}"))
    }

    /// A nonce fixed by text, so every frame fixture is a `&str` in a test
    /// rather than a checked-in blob this repo's `text=auto` would rewrite.
    pub fn from_literal(text: &str) -> Nonce {
        Nonce(text.to_string())
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn two_harvests_in_one_process_are_framed_with_different_nonces() {
        let first = Nonce::fresh();
        let second = Nonce::fresh();

        assert_ne!(first, second);
        assert_ne!(first.as_str(), second.as_str());
    }

    #[test]
    fn a_nonce_is_sixteen_hex_characters_so_it_cannot_disturb_the_shell_quoting() {
        let nonce = Nonce::fresh();

        assert_eq!(nonce.as_str().len(), 16);
        assert!(nonce
            .as_str()
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte)));
    }

    #[test]
    fn a_burst_of_nonces_taken_faster_than_the_clock_ticks_are_still_distinct() {
        let taken: Vec<String> = (0..1000)
            .map(|_| Nonce::fresh().as_str().to_string())
            .collect();

        let mut sorted = taken.clone();
        sorted.sort();
        sorted.dedup();
        assert_eq!(sorted.len(), taken.len());
    }

    #[test]
    fn a_nonce_fixed_by_text_is_the_text_it_was_given() {
        let nonce = Nonce::from_literal("deadbeefdeadbeef");

        assert_eq!(nonce.as_str(), "deadbeefdeadbeef");
    }
}

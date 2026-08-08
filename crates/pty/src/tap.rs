use crate::ring::Ring;

/// How many bytes may be in flight to the WebView before it is declared behind.
///
/// One frame of a fast build is a few kilobytes; this is a couple of orders
/// above that, so it is reached by a WebView that has stopped taking rather
/// than by one having a slow frame.
pub const SLACK: usize = 256 * 1024;

/// One thing the harness hands the WebView for one run, in one frame.
///
/// There are three, and **none of them is a shortened range**. That absence is
/// the whole design: *lag-drop* cannot mean dropping bytes, because a VT stream
/// is not sampleable — a range discarded mid-flight cuts an escape sequence in
/// half and the terminal renders garbage for the rest of the session. So when
/// the WebView falls behind, what stops is the sending, not the stream.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Delivery {
    /// Nothing goes out this frame. Either there is nothing new, or the run is
    /// desynced and waiting for the WebView to catch up.
    Nothing,
    /// Bytes that continue exactly where the previous delivery ended. `through`
    /// is the absolute offset one past the last byte in it.
    Continues { bytes: Vec<u8>, through: u64 },
    /// The terminal is reset and the ring replayed whole.
    ///
    /// The only way a run leaves the desynced state, and the only thing that
    /// follows a front drop the WebView had not yet reached. `truncated` says
    /// the run has lost scrollback — the chrome prints that, and it never goes
    /// into the byte stream.
    Replay {
        bytes: Vec<u8>,
        through: u64,
        truncated: bool,
    },
}

impl Delivery {
    /// The offset the WebView will confirm, if anything went out at all.
    pub fn through(&self) -> Option<u64> {
        match self {
            Delivery::Nothing => None,
            Delivery::Continues { through, .. } | Delivery::Replay { through, .. } => {
                Some(*through)
            }
        }
    }
}

/// One run's channel to the WebView, and the only thing that decides what
/// crosses it.
///
/// It is a **state machine over two offsets** — what has been handed over, and
/// what the WebView has confirmed taking — rather than a rate limiter, because
/// the quantity that matters is not bytes per second but whether the far end is
/// still where the near end thinks it is.
///
/// Two rules, and every case falls out of them:
///
/// 1. A delivery always starts at [`Tap::handed`]. There is no branch that
///    starts one anywhere else, so a non-contiguous range is not something a
///    caller has to remember not to ask for.
/// 2. When the continuation is unavailable — because the far end is behind, or
///    because the front of the ring went — the answer is a whole replay or it is
///    nothing. Never a partial.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Tap {
    handed: u64,
    taken: u64,
    slack: usize,
    desynced: bool,
}

impl Tap {
    /// A tap on a run whose ring already holds `from` bytes' worth of stream.
    ///
    /// Starting at the ring's front rather than at zero is what makes binding
    /// to a run that has been running for an hour a replay of what is held and
    /// not a replay of what is gone.
    pub fn at(from: u64, slack: usize) -> Tap {
        Tap {
            handed: from,
            taken: from,
            slack,
            desynced: false,
        }
    }

    /// Absolute offset the WebView has been handed bytes up to.
    pub fn handed(&self) -> u64 {
        self.handed
    }

    /// Whether this run's terminal is known to be behind what the harness holds.
    /// The chrome says so; the byte stream does not.
    pub fn desynced(&self) -> bool {
        self.desynced
    }

    /// The WebView confirming it has written everything up to `through`.
    ///
    /// Clamped rather than trusted: a confirmation for bytes that were never
    /// handed over would make the in-flight count negative and turn the backlog
    /// test into a permanent pass.
    pub fn took(&mut self, through: u64) {
        self.taken = through.min(self.handed).max(self.taken);
    }

    /// A delivery that was taken but never arrived — the channel refused it, or
    /// the WebView that was to receive it has gone.
    ///
    /// The tap is **not rewound**, because rewinding is what would put a
    /// non-contiguous range on the wire the moment the ring's front moved past
    /// where it was rewound to. It is marked desynced with nothing in flight
    /// instead, so the next frame is a reset and a whole replay — the same exit
    /// every other way of falling behind takes.
    pub fn unsent(&mut self) {
        self.desynced = true;
        self.taken = self.handed;
    }

    /// What crosses to the WebView this frame.
    ///
    /// Called once per frame for the monitored run and for no other, which is
    /// the whole of *bytes cross for the monitored run only, coalesced at one
    /// frame*: coalescing is not a buffer here, it is the fact that the ring
    /// was written many times between two calls and this reads it once.
    pub fn take(&mut self, ring: &Ring) -> Delivery {
        if self.desynced {
            // Nothing more goes out until the far end has taken what it already
            // has. Adding to a backlog that is already the problem is how a
            // WebView that fell behind never catches up.
            if self.taken < self.handed {
                return Delivery::Nothing;
            }
            return self.replay(ring);
        }

        if self.handed.saturating_sub(self.taken) > self.slack as u64 {
            self.desynced = true;
            return Delivery::Nothing;
        }

        // The continuation was dropped from the front of the ring before the
        // WebView reached it. There is nothing contiguous to send from here, so
        // the terminal is reset and given what is left.
        if ring.first() > self.handed {
            return self.replay(ring);
        }

        match ring.from(self.handed) {
            Some(bytes) if !bytes.is_empty() => {
                self.handed += bytes.len() as u64;
                Delivery::Continues {
                    bytes,
                    through: self.handed,
                }
            }
            // Either nothing new, or an offset this ring cannot answer for at
            // all — which the branch above has already ruled out, and which
            // would be a replay rather than a guess if it ever were not.
            Some(_) => Delivery::Nothing,
            None => self.replay(ring),
        }
    }

    /// Reset and replay. The one exit from every state the two rules above
    /// cannot continue from, and the only place `handed` moves without a
    /// contiguous range behind it — which is exactly why the far end resets
    /// first.
    fn replay(&mut self, ring: &Ring) -> Delivery {
        let bytes = ring.whole();
        self.handed = ring.end();
        // Everything before the replay is no longer in flight; the replay's own
        // bytes are. Carrying the old figure over would re-trip the backlog test
        // on the frame after the catch-up.
        self.taken = ring.first();
        self.desynced = false;

        Delivery::Replay {
            bytes,
            through: self.handed,
            truncated: ring.truncated(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// What the far end would hold, if it applied every delivery in order.
    ///
    /// `Continues` appends and `Replay` replaces, which is what the WebView
    /// does — xterm.js `write` and xterm.js `reset` then `write`.
    #[derive(Default)]
    struct Terminal {
        screen: Vec<u8>,
        through: u64,
    }

    impl Terminal {
        fn apply(&mut self, delivery: &Delivery) {
            match delivery {
                Delivery::Nothing => {}
                Delivery::Continues { bytes, through } => {
                    self.screen.extend_from_slice(bytes);
                    self.through = *through;
                }
                Delivery::Replay { bytes, through, .. } => {
                    self.screen = bytes.clone();
                    self.through = *through;
                }
            }
        }

        /// **The invariant.** What is on the far end is a contiguous window of
        /// the stream, ending where the last delivery said it ended. Anything
        /// spliced fails here, and nothing else in this file has to be trusted
        /// for that to be true.
        fn is_a_window_of(&self, stream: &[u8]) {
            let end = self.through as usize;
            let start = end - self.screen.len();
            assert_eq!(
                self.screen,
                stream[start..end],
                "the terminal holds something other than stream[{start}..{end}]"
            );
        }
    }

    /// Deterministic, so a failure is reproducible and reviewable. A seeded
    /// generator is what makes an adversarial schedule reviewable at all — the
    /// interesting orderings are the ones nobody would think to write down.
    struct Rolls(u64);

    impl Rolls {
        fn next(&mut self, under: u64) -> u64 {
            self.0 = self.0.wrapping_mul(6364136223846793005).wrapping_add(1);
            (self.0 >> 33) % under
        }
    }

    #[test]
    fn bytes_that_continue_start_exactly_where_the_last_delivery_ended() {
        let mut ring = Ring::new(1024);
        let mut tap = Tap::at(0, 1024);

        ring.push(b"one");
        let first = tap.take(&ring);
        assert_eq!(
            first,
            Delivery::Continues {
                bytes: b"one".to_vec(),
                through: 3
            }
        );

        // Nothing new is nothing sent, not an empty write.
        assert_eq!(tap.take(&ring), Delivery::Nothing);

        ring.push(b"two");
        tap.took(3);
        assert_eq!(
            tap.take(&ring),
            Delivery::Continues {
                bytes: b"two".to_vec(),
                through: 6
            }
        );
    }

    #[test]
    fn a_webview_that_stops_taking_stops_being_sent_to_rather_than_being_sampled() {
        let mut ring = Ring::new(4096);
        let mut tap = Tap::at(0, 8);

        ring.push(b"aaaaaaaaaaaa");
        assert!(matches!(tap.take(&ring), Delivery::Continues { .. }));
        assert!(!tap.desynced());

        // Twelve bytes handed over, none confirmed, slack of eight: the far end
        // is behind, so the next frame sends nothing at all.
        ring.push(b"bbbb");
        assert_eq!(tap.take(&ring), Delivery::Nothing);
        assert!(tap.desynced());

        // And goes on sending nothing. A desynced run is not a slow run.
        ring.push(b"cccc");
        assert_eq!(tap.take(&ring), Delivery::Nothing);
        assert!(tap.desynced());

        // The catch-up is a reset and the ring whole, never the gap.
        tap.took(12);
        assert_eq!(
            tap.take(&ring),
            Delivery::Replay {
                bytes: b"aaaaaaaaaaaabbbbcccc".to_vec(),
                through: 20,
                truncated: false
            }
        );
        assert!(!tap.desynced());
    }

    #[test]
    fn a_front_drop_that_only_reaches_the_webview_still_continues() {
        let mut ring = Ring::new(8);
        let mut tap = Tap::at(0, 1024);

        ring.push(b"aaaa");
        assert!(matches!(tap.take(&ring), Delivery::Continues { .. }));
        tap.took(4);

        // The front went, but it went exactly as far as the WebView had already
        // reached — so the continuation from offset 4 is still held and this is
        // an ordinary frame. A replay here would reset a terminal for nothing.
        ring.push(b"bbbb");
        ring.push(b"cccc");
        assert_eq!(ring.first(), 4);
        assert_eq!(
            tap.take(&ring),
            Delivery::Continues {
                bytes: b"bbbbcccc".to_vec(),
                through: 12
            }
        );
    }

    #[test]
    fn a_front_drop_past_the_webview_is_a_replay_and_never_a_gap() {
        let mut ring = Ring::new(8);
        let mut tap = Tap::at(0, 1024);

        ring.push(b"aa");
        assert!(matches!(tap.take(&ring), Delivery::Continues { .. }));
        tap.took(2);

        // The run wrote past the ring while the WebView was between frames, and
        // this time it took the bytes that would have continued from offset 2
        // with it.
        ring.push(b"bb");
        ring.push(b"cccc");
        ring.push(b"dddd");
        assert_eq!(ring.first(), 4);
        assert_eq!(
            tap.take(&ring),
            Delivery::Replay {
                bytes: b"ccccdddd".to_vec(),
                through: 12,
                truncated: true
            }
        );

        // Truncation is a fact the chrome prints. It is reported beside the
        // bytes and never spliced into them.
        assert_eq!(ring.dropped(), 4);
    }

    #[test]
    fn binding_to_a_run_already_under_way_replays_what_is_held_and_not_what_is_gone() {
        let mut ring = Ring::new(8);
        ring.push(b"aaaa");
        ring.push(b"bbbb");
        ring.push(b"cccc");

        let mut tap = Tap::at(ring.first(), 1024);

        // The first thing a newly bound terminal is handed continues from the
        // front of the ring, so it is a window of the stream immediately rather
        // than after the first replay.
        assert_eq!(
            tap.take(&ring),
            Delivery::Continues {
                bytes: b"bbbbcccc".to_vec(),
                through: 12
            }
        );
    }

    #[test]
    fn a_confirmation_for_bytes_that_were_never_sent_cannot_disable_the_backlog_test() {
        let mut ring = Ring::new(4096);
        let mut tap = Tap::at(0, 8);

        ring.push(b"aaaaaaaaaaaa");
        tap.take(&ring);
        // A WebView that claims to have written the whole session. It is claiming
        // everything it was actually handed, which nothing on this side can
        // contradict — but it may not be *credited* with more than that, because
        // an in-flight count that went negative would be a backlog test that
        // passes for the rest of the process.
        tap.took(9_999);
        assert_eq!(tap.handed(), 12);

        ring.push(b"bbbbbbbbbbbb");
        assert!(matches!(tap.take(&ring), Delivery::Continues { .. }));
        assert_eq!(tap.handed(), 24);

        // Twelve in flight against a slack of eight, so the check is still
        // working after the false confirmation rather than permanently satisfied
        // by it.
        ring.push(b"c");
        assert_eq!(tap.take(&ring), Delivery::Nothing);
        assert!(tap.desynced());
    }

    #[test]
    fn a_non_contiguous_byte_range_is_never_handed_over_under_any_schedule() {
        // Every pressure at once, and the ring small enough that the front is
        // dropping constantly: a producer far faster than the ring, a far end
        // that confirms late, sporadically, and sometimes not at all, and a
        // slack low enough to be crossed repeatedly.
        //
        // The assertion is the same after every single step — the far end holds
        // a contiguous window of the stream — so a splice fails on the step that
        // produced it rather than at the end.
        let mut rolls = Rolls(0x5eed);
        let mut ring = Ring::new(64);
        let mut tap = Tap::at(0, 48);
        let mut terminal = Terminal::default();
        let mut stream: Vec<u8> = Vec::new();
        let mut replays = 0;
        let mut continues = 0;

        for step in 0..4_000u32 {
            match rolls.next(4) {
                0..=1 => {
                    let read: Vec<u8> = (0..=rolls.next(40)).map(|_| step as u8).collect();
                    stream.extend_from_slice(&read);
                    ring.push(&read);
                }
                2 => {
                    let delivery = tap.take(&ring);
                    match delivery {
                        Delivery::Continues { .. } => continues += 1,
                        Delivery::Replay { .. } => replays += 1,
                        Delivery::Nothing => {}
                    }
                    terminal.apply(&delivery);
                }
                _ => {
                    // A far end that confirms some of what it was handed. Never
                    // all of it, often: that is what being behind looks like.
                    let behind = tap.handed().saturating_sub(terminal.through);
                    tap.took(terminal.through + behind / 2);
                }
            }

            terminal.is_a_window_of(&stream);
        }

        // The schedule has to have exercised both paths, or the invariant above
        // was asserted over a stream that never went round the ring.
        assert!(replays > 10, "{replays} replays is not an exercised path");
        assert!(
            continues > 10,
            "{continues} continuations is not an exercised path"
        );
        assert!(ring.truncated());
    }
}

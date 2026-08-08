/// What a live signal from inside a terminal can say.
///
/// Three variants, no payloads, and a signal means exactly one thing: **poll
/// GitHub sooner**. It is never evidence in its own right, so there is nothing
/// for a payload to carry.
///
/// There is no `Completed`. Completion is a GitHub state transition and
/// nothing else, and the absence of the variant is what enforces that — a rule
/// written in a doc comment is a rule someone adds a variant next to. Claims
/// only ever decay; the absence of a signal is not evidence of anything; and
/// an adapter that produces no signals is not a degraded adapter, because
/// polling never stopped.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Signal {
    Ready,
    Busy,
    Idle,
}

/// Classifies PTY bytes into signals, one object per run.
///
/// `&mut self` is deliberate and costs nothing: a `Watch` is minted per run by
/// [`Agent::watch`], owned by the drain loop, and is not the adapter. The
/// adapter itself stays `Sync` and immutable.
///
/// `Send` rather than `Sync` for the same reason — one drain thread owns one
/// box, and it is moved to that thread rather than shared with it.
///
/// [`Agent::watch`]: crate::Agent::watch
pub trait Watch: Send + 'static {
    /// The last state this chunk of bytes ended in, or `None` when the chunk
    /// contained no state change at all.
    ///
    /// A chunk is a chunk of a stream and not a message, so several states may
    /// pass through one call; the answer is the one it *ended* in, because a
    /// signal is a state and not an event. `None` is "nothing changed", never
    /// "nothing happened" — absence of an event is not evidence.
    fn classify(&mut self, bytes: &[u8]) -> Option<Signal>;
}

/// The watch an adapter that produces no live signals hands back.
///
/// Not an `Option<Box<dyn Watch>>`, and that is criterion 6 stated as a type:
/// there is exactly one shape of answer, so no call site anywhere can branch
/// on whether an adapter watches. A run that classifies nothing polls on the
/// schedule it was already polling on, which is the schedule that never
/// stopped.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct NoWatch;

impl Watch for NoWatch {
    fn classify(&mut self, _bytes: &[u8]) -> Option<Signal> {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_adapter_that_watches_nothing_still_hands_back_a_watch_rather_than_an_absence() {
        // The type is what stops a call site asking "does this adapter watch?".
        let mut watching: Box<dyn Watch> = Box::new(NoWatch);

        assert_eq!(watching.classify(b""), None);
        assert_eq!(watching.classify(b"\x1b[?1049h some agent output "), None);
    }

    #[test]
    fn a_signal_carries_no_payload_and_completion_is_not_one_of_the_three() {
        // Exhaustive by construction: the match below stops compiling the day a
        // fourth variant appears, which is the only place `Completed` could
        // arrive. Completion is a GitHub state transition and this vocabulary
        // deliberately cannot say it.
        for signal in [Signal::Ready, Signal::Busy, Signal::Idle] {
            let named = match signal {
                Signal::Ready => "ready",
                Signal::Busy => "busy",
                Signal::Idle => "idle",
            };
            assert!(!named.is_empty());
        }

        // No payload: `Copy` and equality by variant alone.
        assert_eq!(Signal::Ready, Signal::Ready);
        assert_ne!(Signal::Ready, Signal::Idle);
    }
}

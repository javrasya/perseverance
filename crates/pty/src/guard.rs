/// Why the harness could not take ownership of a spawned tree.
///
/// It is one sentence and it is a refusal of the *launch*, not a report about
/// the agent: a child the harness cannot promise to reap is a child that
/// outlives the app, and starting one anyway is how an operator ends up with
/// eighteen orphaned processes and no window to close.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum GuardRefusal {
    #[error(
        "the spawned child has no handle to take ownership of, so nothing could promise to reap \
         it when this app goes away"
    )]
    NoHandle,

    #[error(
        "a job object to hold the child's process tree in could not be made, so a hard kill of \
         this app would leave the agent and everything it started running: {detail}"
    )]
    NoJob { detail: String },

    #[error(
        "the child was spawned but could not be put in the job object that reaps it, so it would \
         survive this app: {detail}"
    )]
    NotAssigned { detail: String },
}

/// What holds a spawned process tree for as long as this app is alive, and
/// reaps it when it is not — **however** it stops being alive.
///
/// The two platforms get here differently, and the asymmetry is the mechanism
/// rather than an oversight:
///
/// - **Windows** has nothing until we make it. A job object with
///   `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` terminates every associated process
///   when its last handle closes, and the kernel closes handles when a process
///   dies *however it dies* — so this covers the crash, the `SIGKILL`-equivalent
///   and Task Manager's End Task, none of which fire Tauri's
///   `RunEvent::ExitRequested`. A child inherits its parent's job by default, so
///   assigning the agent covers the whole MCP fleet it goes on to start.
/// - **Unix** already has it, or as much of it as the platform offers.
///   `portable-pty`'s `pre_exec` calls `setsid` and `TIOCSCTTY`, so the child is
///   a session leader with the PTY as its controlling terminal, and when the
///   *controlling process* dies the kernel hangs up that terminal's foreground
///   process group. That is the mechanism, and it is worth stating in those
///   terms rather than as *the master closing*: this session's master is only
///   one of three descriptors — the drain thread holds a `dup` for as long as it
///   lives — so dropping this side's copy closes nothing. What reaches the tree
///   is the leader's death, which is why [`crate::Session`]'s `Drop` kills the
///   child first and does it with the escalating owned-child kill.
///
/// The narrow known gap is documented rather than papered over: assignment
/// happens after `CreateProcess` has returned, so a child that forked inside
/// that window would escape. Research §8.4 measured that the CLIs in question do
/// not. Reaping on a *clean* quit is [`crate::Runs::shut_down`], which asks
/// first and puts a deadline on the answer; this is the one that still works
/// when nothing gets to run.
pub struct Guard {
    /// Never read, and that is the whole of what it does: the promise is
    /// `Drop`, and the only thing this field has to do is exist for exactly as
    /// long as the session does.
    #[cfg(windows)]
    #[allow(dead_code)]
    job: win32job::Job,
}

impl Guard {
    /// Take ownership of a spawned child's tree.
    ///
    /// `handle` is the platform's handle to the direct child, which only Windows
    /// has a use for. It is taken by value as an integer rather than as a
    /// pointer type so that this signature is the same on both platforms and
    /// there is one call site in [`crate::Session`] rather than two.
    pub(crate) fn over(handle: Option<isize>) -> Result<Guard, GuardRefusal> {
        #[cfg(windows)]
        {
            let Some(handle) = handle else {
                return Err(GuardRefusal::NoHandle);
            };

            let mut limits = win32job::ExtendedLimitInfo::new();
            // The whole of the promise, in one flag.
            limits.limit_kill_on_job_close();

            let job = win32job::Job::create_with_limit_info(&limits).map_err(|error| {
                GuardRefusal::NoJob {
                    detail: error.to_string(),
                }
            })?;

            job.assign_process(handle)
                .map_err(|error| GuardRefusal::NotAssigned {
                    detail: error.to_string(),
                })?;

            Ok(Guard { job })
        }

        #[cfg(not(windows))]
        {
            // `setsid` has already happened, in the child, before `exec`. There
            // is no window here to lose a race in and nothing to assign.
            let _ = handle;
            Ok(Guard {})
        }
    }
}

impl std::fmt::Debug for Guard {
    /// Hand-written because a job handle has no useful rendering and
    /// `win32job::Job` does not derive one. What a reader wants from a debug
    /// line here is which of the two mechanisms is holding the tree.
    fn fmt(&self, out: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        if cfg!(windows) {
            out.write_str("Guard(job object, kill on close)")
        } else {
            out.write_str("Guard(session leader)")
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_way_taking_ownership_can_fail_says_so_in_a_sentence() {
        for refusal in [
            GuardRefusal::NoHandle,
            GuardRefusal::NoJob {
                detail: "access is denied".to_string(),
            },
            GuardRefusal::NotAssigned {
                detail: "access is denied".to_string(),
            },
        ] {
            let sentence = refusal.to_string();

            assert!(
                sentence.len() > 40,
                "{sentence:?} is a label rather than a sentence"
            );
            assert!(
                !sentence.ends_with('.'),
                "{sentence:?} ends in a full stop; house style does not"
            );
            assert!(
                sentence
                    .chars()
                    .next()
                    .is_some_and(|opening| !opening.is_uppercase()),
                "{sentence:?} opens upper case; house style does not"
            );
            let _: &dyn std::error::Error = &refusal;
        }
    }

    /// A handle is a Windows fact, and the platform that has none says so by
    /// not needing one.
    #[cfg(not(windows))]
    #[test]
    fn on_unix_the_child_is_already_a_session_leader_so_there_is_nothing_to_take() {
        let guard = Guard::over(None).expect("setsid has already happened");

        assert_eq!(format!("{guard:?}"), "Guard(session leader)");
    }

    #[cfg(windows)]
    #[test]
    fn a_child_with_no_handle_is_refused_rather_than_left_unowned() {
        assert_eq!(
            Guard::over(None).expect_err("nothing to take ownership of"),
            GuardRefusal::NoHandle
        );
    }

    #[cfg(windows)]
    #[test]
    fn a_job_object_that_reaps_on_close_can_be_made_on_this_machine() {
        // The current process, which is a handle this test certainly has and
        // which `kill on close` will not act on while the job outlives nobody:
        // the `Job` is dropped at the end of this test, and a process already in
        // another job (which a test runner may well be) is the nested case
        // Windows 8+ supports.
        let mut limits = win32job::ExtendedLimitInfo::new();
        limits.limit_kill_on_job_close();

        let job = win32job::Job::create_with_limit_info(&limits)
            .expect("a job object can be made on a supported Windows");

        // Not asserting the assignment: assigning *this* process to a
        // kill-on-close job would end the test runner when the job dropped.
        drop(job);
    }
}

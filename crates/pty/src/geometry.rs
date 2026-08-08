/// The one pane geometry, in characters.
///
/// There is one of these for the whole app rather than one per run, and that is
/// the trade this slice makes on purpose: a background research PTY is resized
/// by a dial it has nothing to do with. What it buys is that *nothing is ever
/// resized on bind* — a terminal bound into the pane finds the geometry already
/// in force, so there is no arrival-time reflow to accidentally aim at an
/// in-flight grilling.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Geometry {
    pub rows: u16,
    pub cols: u16,
}

impl Geometry {
    /// A pane measured mid-layout can be zero high, and a zero-row PTY is not a
    /// terminal — ConPTY takes a `COORD` and `TIOCSWINSZ` takes a `winsize`, and
    /// both of those mean *no screen at all* rather than *very small*. One is
    /// the floor, so a measurement taken before layout settled degrades to a
    /// tiny terminal instead of an unusable one.
    pub fn new(rows: u16, cols: u16) -> Geometry {
        Geometry {
            rows: rows.max(1),
            cols: cols.max(1),
        }
    }

    /// What a run opens at, before anything on screen has been measured. Wide
    /// enough that an agent's first frame is not authored against a geometry it
    /// will never see again.
    pub fn opening() -> Geometry {
        Geometry::new(40, 120)
    }
}

/// The one geometry, and the only thing that changes it.
///
/// **There is exactly one method that yields a resize**, and it is named for
/// the only occasion that may cause one. That is what makes *never on bind,
/// never on peek, never during a drag, never on arrival* true rather than
/// asserted: those four callers have nothing here to call. A boolean parameter
/// or an occasion enum would have made every one of them a site that could pass
/// the wrong value; a missing method cannot be called wrongly.
///
/// The debounce itself is the WebView's, because a drag is a thing only the
/// WebView can see — `src/panes/geometry.ts` holds that half, and it is where
/// *one resize per completed gesture* is decided. What is here is the other
/// half: even a caller that has decided a gesture settled gets nothing if the
/// geometry it settled on is the one already in force.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Panes {
    geometry: Geometry,
}

impl Panes {
    pub fn opening() -> Panes {
        Panes {
            geometry: Geometry::opening(),
        }
    }

    /// The geometry every live run is at.
    pub fn geometry(&self) -> Geometry {
        self.geometry
    }

    /// A completed gesture settled on `geometry`.
    ///
    /// `Some` is *resize every live run to this*, and it is returned only when
    /// the figure is new. A gesture that ended where it began is a real thing to
    /// do with a mouse, and forwarding it would reflow every terminal in the app
    /// — including one mid-grilling — to the size it is already at.
    pub fn settled(&mut self, geometry: Geometry) -> Option<Geometry> {
        if geometry == self.geometry {
            return None;
        }
        self.geometry = geometry;
        Some(geometry)
    }
}

impl Default for Panes {
    fn default() -> Panes {
        Panes::opening()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_geometry_no_terminal_could_render_becomes_the_smallest_one_that_could() {
        assert_eq!(Geometry::new(0, 0), Geometry { rows: 1, cols: 1 });
        assert_eq!(Geometry::new(24, 0), Geometry { rows: 24, cols: 1 });
        assert_eq!(Geometry::new(0, 80), Geometry { rows: 1, cols: 80 });
        assert_eq!(Geometry::new(24, 80), Geometry { rows: 24, cols: 80 });
    }

    #[test]
    fn a_settled_gesture_on_a_new_size_resizes_every_live_run_once() {
        let mut panes = Panes::opening();
        let wider = Geometry::new(50, 200);

        assert_eq!(panes.settled(wider), Some(wider));
        assert_eq!(panes.geometry(), wider);
    }

    #[test]
    fn a_gesture_that_ended_where_it_began_reflows_nothing() {
        let mut panes = Panes::opening();

        assert_eq!(panes.settled(Geometry::opening()), None);

        let wider = Geometry::new(50, 200);
        assert_eq!(panes.settled(wider), Some(wider));
        // Two gestures onto the same size is one resize, because the second one
        // would be a reflow to the size everything is already at.
        assert_eq!(panes.settled(wider), None);
    }

    #[test]
    fn a_run_that_binds_finds_the_geometry_already_in_force() {
        let mut panes = Panes::opening();
        panes.settled(Geometry::new(50, 200));

        // What a binding run is opened at is read, not set — there is no method
        // on this type a bind could call to change it, which is the whole of
        // *never resize on bind*.
        assert_eq!(panes.geometry(), Geometry::new(50, 200));
    }
}

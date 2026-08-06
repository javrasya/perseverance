import { useMemo } from "react";
import type { Model } from "../../snapshot/model.generated";
import { NO_MAP_OPEN } from "../../snapshot/readout";
import {
  BEYOND_THE_MAP,
  STATE_NAMES,
  UNSETTLED_NOTE,
  routeOf,
  unlocksLabel,
  type RouteLink,
  type RouteNode,
} from "./route";
import styles from "./Route.module.css";

/**
 * The Route, drawn: the first view, and the first time *a view is a pure
 * function from the derived model to pixels* is tested rather than asserted.
 *
 * Hand-rolled SVG, with no graph library and no layout library anywhere behind
 * it. The two things such a library would be brought in to do are the two
 * things it must not be allowed to do here — the ranking is a longest path
 * over an explicit edge set, and the order inside a rank is the order the
 * operator dragged their sub-issues into. Crossing minimisation is not merely
 * unnecessary, it is unwanted.
 *
 * Nothing is derived in this file. One call to `routeOf` answers with every
 * number that reaches the screen: the ranks, the coordinates, the four states,
 * the singular frontier and what each node unlocks. There is no counting here,
 * no filtering, no ranking and no state resolution, which is what makes the
 * claim checkable — and no positions are stored anywhere, because the same
 * model always answers with the same picture.
 *
 * The Route declines to draw fan-out. What a node unlocks is a number on the
 * node (`unlocks N`) and not a spray of edges, because a drawn fan-out reads as
 * capacity the operator has, and on a map whose takeable tickets are all
 * human-in-the-loop that capacity is one. Declared, not hidden:
 * docs/adr/0005-the-route-declines-to-draw-fan-out.md.
 *
 * Selecting a node draws that node's upstream links and nothing else: *what
 * stands between me and starting this*. Downstream stays a number.
 *
 * **Import this file as `Route.jsx`.** It sits beside `route.ts`, and macOS and
 * Windows filesystems are case-insensitive, so an extensionless `./Route`
 * resolves to the arithmetic module — which exports a `Route` *type* — and this
 * component is never found. The `.jsx` specifier maps to `Route.tsx` under
 * bundler resolution and matches nothing else.
 */

/*
 * Where the words sit inside one box. These are typography and not layout —
 * every coordinate that says where a *node* goes comes from `routeOf`, and
 * nothing in this file may add to one. Two lines: the title, then the number,
 * the state word and what it unlocks.
 */
const PAD = 12;
const TITLE_BASELINE = 24;
const FOOT_BASELINE = 42;
const STATE_X = 64;
const CORNER = 6;

/**
 * The links the Route will draw, which is almost none of them.
 *
 * Nothing selected is nothing drawn — the declared deviation, as a function
 * rather than as a sentence, so a test can fail it. With a node selected it is
 * that node's upstream links only: the edges that arrive at it, never the ones
 * that leave.
 */
export function upstreamLinks(
  links: readonly RouteLink[],
  selected: number | null,
): readonly RouteLink[] {
  if (selected === null) return [];
  return links.filter((link) => link.after === selected);
}

interface RouteProps {
  model: Model;
  selected: number | null;
  onSelect: (number: number | null) => void;
}

export function Route({ model, selected, onSelect }: RouteProps) {
  /*
   * A memo and nothing more. `routeOf` is deterministic and cheap, so this
   * saves a pass over the nodes and buys no correctness — if it were ever load
   * bearing, the layout would be state and the positions would be stored.
   */
  const route = useMemo(() => {
    const map = model.map;
    if (map === null) return null;
    return routeOf(map);
  }, [model]);

  if (route === null) {
    /* An absence, and the chrome's own words for it rather than a second set. */
    return (
      <section className={styles.route} aria-label="The Route">
        <p className={styles.absence}>{NO_MAP_OPEN}</p>
      </section>
    );
  }

  const drawn = upstreamLinks(route.links, selected);

  return (
    <section className={styles.route} aria-label="The Route">
      {/*
        What the picture cannot account for, said in words above it. A column
        the map cannot justify is absence disguised as presence, so where the
        ranking is a guess it says so rather than being left to read as a shape.
      */}
      {route.unsettled.length === 0 ? null : (
        <p className={styles.note}>{UNSETTLED_NOTE}</p>
      )}
      {route.beyondTheMap === 0 ? null : <p className={styles.note}>{BEYOND_THE_MAP}</p>}

      <div className={styles.frame}>
        <svg
          className={styles.canvas}
          viewBox={`0 0 ${route.width} ${route.height}`}
          width={route.width}
          height={route.height}
          role="list"
        >
          {drawn.map((link) => (
            <path
              key={`${link.before}-${link.after}`}
              /* Both ends, so a link on screen can be told from the pair it
                 claims to join rather than only counted. */
              data-link={`${link.before}-${link.after}`}
              className={styles.link}
              d={link.path}
              fill="none"
            />
          ))}

          {route.rows.map((row) => (
            /* The rank is a grouping and not a thing on the list, so it is
               marked presentational and its nodes stay the list's own. */
            <g key={row.rank} data-rank={row.rank} role="presentation">
              {row.nodes.map((entry) => (
                <NodeBox
                  key={entry.node.number}
                  entry={entry}
                  selected={selected === entry.node.number}
                  onSelect={onSelect}
                />
              ))}
            </g>
          ))}
        </svg>
      </div>
    </section>
  );
}

/**
 * One node.
 *
 * The state is a `data-*` attribute and a spelled word, both. The palette is
 * neutrals and one indigo, so there is no hue to spend telling four states
 * apart — the word carries what a colour cannot, and the attribute is what the
 * stylesheet and the tests both read.
 */
function NodeBox({
  entry,
  selected,
  onSelect,
}: {
  entry: RouteNode;
  selected: boolean;
  onSelect: (number: number | null) => void;
}) {
  /* Picking the node you already picked puts it back, so a selection is never
     something you have to go somewhere else to undo. */
  const choose = () => onSelect(selected ? null : entry.node.number);

  return (
    <g
      className={styles.node}
      transform={`translate(${entry.x} ${entry.y})`}
      data-node={entry.node.number}
      data-state={entry.node.state}
      data-kind={entry.node.kind.kind}
      data-frontier={entry.frontier ? "" : undefined}
      data-selected={selected ? "" : undefined}
      role="listitem"
      tabIndex={0}
      onClick={choose}
      onKeyDown={(event) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        // Space scrolls the graph otherwise, which moves the thing being picked.
        event.preventDefault();
        choose();
      }}
    >
      <rect
        className={styles.box}
        x={0}
        y={0}
        width={entry.width}
        height={entry.height}
        rx={CORNER}
      />
      <text className={styles.title} x={PAD} y={TITLE_BASELINE}>
        {entry.label}
      </text>
      <text className={styles.number} x={PAD} y={FOOT_BASELINE}>
        #{entry.node.number}
      </text>
      <text className={styles.state} x={STATE_X} y={FOOT_BASELINE}>
        {STATE_NAMES[entry.node.state]}
      </text>
      {/*
        Only a positive number. A node that opens nothing up says nothing —
        `unlocks 0` is ink spent telling the operator there is nothing here.
      */}
      {entry.unlocks > 0 ? (
        <text
          className={styles.unlocks}
          x={entry.width - PAD}
          y={FOOT_BASELINE}
          textAnchor="end"
        >
          {unlocksLabel(entry.unlocks)}
        </text>
      ) : null}
    </g>
  );
}

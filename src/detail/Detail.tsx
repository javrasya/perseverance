import {
  BLOCKED_ONLY_HERE,
  BOUND_ELSEWHERE_TAG,
  CLAIM_ANONYMOUS,
  CLAIM_FREE,
  CLAIM_HELD,
  DESIGNATED_TAG,
  HEADINGS,
  IN_SCOPE,
  LINK_NOT_OPENABLE,
  MAP_CLOSED,
  MAP_EMPTY,
  MAP_EMPTY_NOTE,
  NO_BLOCKERS,
  NO_BODY,
  NO_DATES,
  NO_MAP_HERE,
  NO_MAP_NOTE,
  NOTHING_BLOCKED,
  NOT_TOLD,
  NOTHING_SELECTED,
  NOTHING_SELECTED_NOTE,
  OUT_OF_SCOPE,
  OUT_OF_SCOPE_NOTE,
  PANEL_HEADING,
  SELECTION_GONE_NOTE,
  STATE_NAMES,
  beyondTheMapNote,
  panelOf,
  selectionGone,
  type Card,
  type Edges,
  type MapNote,
} from "./detail";
/* `markdown` and not `Markdown`: the module is lowercase and there is no
   component file beside it to collide with, so the plain specifier is
   unambiguous — unlike `./Detail`, which every importer of this file has to
   spell `./Detail.jsx`. */
import { Markdown } from "./markdown";
import type { ReactNode } from "react";
import type { Model } from "../snapshot/model.generated";
import styles from "./Detail.module.css";

/**
 * The node you are looking at, spelled out.
 *
 * The map answers *what is there*; this answers *what is this one*. It is
 * chrome at a fixed address rather than a view — no view is handed the
 * selection to describe, and a view that described one would be a second
 * account of a node beside the picture of it — and it holds no copy of the
 * model and no state of its own: `panelOf` turns the model and the store's
 * selection into a value, and everything below is that value on screen.
 *
 * **It never renders empty.** Five states, each with words in it and each
 * saying something the others do not: no map open, a map with nothing on it,
 * nothing picked, a selection whose row is gone, and a node. There is no sixth
 * branch and no `null` return, because a panel that can go blank is a panel an
 * operator learns to distrust — the blank looks the same whether the click
 * missed, the poll landed, or the app broke.
 *
 * What it does **not** print is as deliberate:
 *
 * - **No issue body.** The graph query never asks for one, so there is nothing
 *   on this side to print and nothing on screen implying there is.
 * - **No claimant.** How many people are on a ticket crosses as a number and
 *   the names do not, so *who* is a name this side would have to invent.
 * - **No timestamps.** The model reads none; the field says so and says why.
 * - **No rendered markdown from GitHub**, and none pre-painted in Rust. The one
 *   string here that is markdown — a cut reason, lifted verbatim out of a map
 *   document — is rendered by `./markdown`, which builds React elements and
 *   never an HTML string, so raw HTML in it is literal text by construction.
 *
 * #52 and #57 turn this into the relocatable boarding pass. What this slice
 * settles is *what it says*; where it lives is one address in `App.tsx` and one
 * element to move.
 */
export function Detail({ model, selection }: { model: Model; selection: number | null }) {
  const panel = panelOf(model, selection);

  return (
    <section className={styles.panel} aria-label={PANEL_HEADING} data-panel={panel.kind}>
      <h2 className={styles.heading}>{PANEL_HEADING}</h2>
      {panel.kind === "noMap" ? (
        <Absent title={NO_MAP_HERE} note={NO_MAP_NOTE} />
      ) : panel.kind === "mapEmpty" ? (
        <>
          <MapLine map={panel.map} />
          <Absent title={MAP_EMPTY} note={MAP_EMPTY_NOTE} />
        </>
      ) : panel.kind === "unselected" ? (
        <>
          <MapLine map={panel.map} />
          <Absent title={NOTHING_SELECTED} note={NOTHING_SELECTED_NOTE} />
        </>
      ) : panel.kind === "gone" ? (
        <>
          <MapLine map={panel.map} />
          <Absent title={selectionGone(panel.number)} note={SELECTION_GONE_NOTE} />
        </>
      ) : (
        <>
          <MapLine map={panel.map} />
          <Fields card={panel.card} />
        </>
      )}
    </section>
  );
}

/**
 * A state with no node in it. The reason is on screen with the state, because
 * *why there is nothing here* is the only useful thing the panel can say in it.
 */
function Absent({ title, note }: { title: string; note: string }) {
  return (
    <div className={styles.absent}>
      <p className={styles.absentTitle}>{title}</p>
      <p className={styles.note}>{note}</p>
    </div>
  );
}

/**
 * Which map this is about, and whether it is closed.
 *
 * The closed bit is the map's own state and the top rung of the ladder: no
 * ticket can put a map there, so a node that reads *takeable* under a closed
 * map is a row whose map was closed around it. Printed here rather than folded
 * into the node's state, which would be this side inventing a sixth one.
 *
 * The panel says nothing about how old this is. Staleness is the footer stamp's
 * subject and it is on screen in every state; a second account of freshness
 * here would be one more thing to keep in step.
 */
function MapLine({ map }: { map: MapNote }) {
  return (
    <p className={styles.map} data-closed={map.closed}>
      <span className={styles.mark}>#{map.number}</span>
      {map.closed ? <span className={styles.tag}>{MAP_CLOSED}</span> : null}
    </p>
  );
}

function Fields({ card }: { card: Card }) {
  return (
    <dl className={styles.fields} data-node={card.number}>
      <Field name={HEADINGS.question} field="question">
        <p className={styles.question}>
          <span className={styles.mark}>#{card.number}</span> {card.question}
        </p>
        <p className={styles.note}>{NO_BODY}</p>
      </Field>

      <Field name={HEADINGS.type} field="type">
        <p className={styles.value}>{card.type}</p>
      </Field>

      <Field name={HEADINGS.state} field="state">
        <p className={styles.value} data-state={card.state}>
          {STATE_NAMES[card.state]}
        </p>
        {/* The map's own answer to *what next*, read off the one resolver and
            never re-derived from the rows beside it. */}
        {card.designated ? <p className={styles.tag}>{DESIGNATED_TAG}</p> : null}
        {card.boundElsewhere ? <p className={styles.tag}>{BOUND_ELSEWHERE_TAG}</p> : null}
      </Field>

      <Field name={HEADINGS.blockers} field="blockers">
        <EdgeList edges={card.blockers} none={NO_BLOCKERS} />
      </Field>

      <Field name={HEADINGS.blocked} field="blocked">
        <EdgeList edges={card.blocked} none={NOTHING_BLOCKED} />
        <p className={styles.note}>{BLOCKED_ONLY_HERE}</p>
      </Field>

      <Field name={HEADINGS.claim} field="claim">
        <p className={styles.value} data-claimed={card.claimed}>
          {card.claimed ? CLAIM_HELD : CLAIM_FREE}
        </p>
        <p className={styles.note}>{CLAIM_ANONYMOUS}</p>
      </Field>

      {/* An absence with its reason beside it, and in a different form from a
          number: the dash is set in the same face the fog's *nobody surveyed*
          uses, so *never told* and *told, and it is nothing* cannot be confused
          at a glance. */}
      <Field name={HEADINGS.dates} field="dates">
        <p className={styles.absentValue} aria-hidden="true">
          {NOT_TOLD}
        </p>
        <p className={styles.note}>{NO_DATES}</p>
      </Field>

      <Field name={HEADINGS.resolution} field="resolution">
        {card.resolution.kind === "inScope" ? (
          <p className={styles.value} data-cut="inScope">
            {IN_SCOPE}
          </p>
        ) : (
          <>
            <p className={styles.value} data-cut="fromScope">
              {OUT_OF_SCOPE}
            </p>
            <p className={styles.note}>{OUT_OF_SCOPE_NOTE}</p>
            {/* The words somebody cut it in, visible and never behind a hover.
                Markdown, because they were typed into a map document. */}
            <Markdown source={card.resolution.reason} />
          </>
        )}
      </Field>

      <Field name={HEADINGS.link} field="link">
        {/* Text and not an anchor. See [`LINK_NOT_OPENABLE`]: this WebView has
            no opener, and an anchor here would navigate the app away from
            itself with no way back. */}
        <p className={styles.url}>{card.url}</p>
        <p className={styles.note}>{LINK_NOT_OPENABLE}</p>
      </Field>
    </dl>
  );
}

function Field({
  name,
  field,
  children,
}: {
  name: string;
  field: string;
  children: ReactNode;
}) {
  return (
    <div className={styles.field} data-field={field}>
      <dt className={styles.name}>{name}</dt>
      <dd className={styles.body}>{children}</dd>
    </div>
  );
}

/**
 * One direction of the graph, named.
 *
 * Names rather than a count, which is the whole of why this panel exists: ADR
 * 0006 ships the count on the Route row and says the identity is this panel's
 * to find. Nothing here gates on the length — a blocker list is a list of
 * numbers an operator can go and look at, never an input to a verdict about
 * whether this node is startable, which was decided in Rust.
 */
function EdgeList({ edges, none }: { edges: Edges; none: string }) {
  const nothing = edges.named.length === 0 && edges.beyondTheMap === 0;

  return (
    <>
      {nothing ? <p className={styles.value}>{none}</p> : null}
      {edges.named.length === 0 ? null : (
        <ul className={styles.edges}>
          {edges.named.map((edge) => (
            <li key={edge.number} className={styles.edge} data-edge={edge.number}>
              <span className={styles.mark}>#{edge.number}</span>
              <span className={styles.edgeTitle}>{edge.title}</span>
              <span className={styles.edgeState} data-state={edge.state}>
                {STATE_NAMES[edge.state]}
              </span>
            </li>
          ))}
        </ul>
      )}
      {/* A number this map has no row for is said in words rather than counted
          into the list — this map cannot judge it either way, and a name it
          cannot print is not a name it may invent. */}
      {edges.beyondTheMap === 0 ? null : (
        <p className={styles.note} data-beyond={edges.beyondTheMap}>
          {beyondTheMapNote(edges.beyondTheMap)}
        </p>
      )}
    </>
  );
}

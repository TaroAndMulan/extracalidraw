import { describe, expect, it } from "vitest";

import {
  SharedArea,
  SharedViewTracker,
  fitView,
  interpolateView,
  sameView,
  toScene,
  toScreen,
  visibleBounds,
} from "./viewSync";

import type { SceneBounds } from "../../../whiteboard-server/src/protocol";
import type { Size, View } from "./viewSync";

const expectBounds = (actual: SceneBounds, expected: SceneBounds) => {
  actual.forEach((value, i) => expect(value).toBeCloseTo(expected[i], 6));
};

const contains = (outer: SceneBounds, inner: SceneBounds) =>
  outer[0] <= inner[0] + 1e-6 &&
  outer[1] <= inner[1] + 1e-6 &&
  outer[2] >= inner[2] - 1e-6 &&
  outer[3] >= inner[3] - 1e-6;

const LAPTOP: Size = { width: 1600, height: 900 };
const TABLET_PORTRAIT: Size = { width: 820, height: 1180 };

describe("view math", () => {
  it("maps between the page and the screen", () => {
    const view: View = { scrollX: -120, scrollY: 40, zoom: 1.5 };
    const bounds: SceneBounds = [100, -20, 400, 300];
    expectBounds(toScene(toScreen(bounds, view), view), bounds);
    expectBounds(
      toScene([0, 0, LAPTOP.width, LAPTOP.height], view),
      visibleBounds(view, LAPTOP),
    );
  });

  it("fits an area in, centered, whatever the screen", () => {
    const bounds: SceneBounds = [0, 0, 1600, 900];
    for (const size of [LAPTOP, TABLET_PORTRAIT]) {
      const view = fitView(bounds, size);
      const visible = visibleBounds(view, size);
      expect(contains(visible, bounds)).toBe(true);
      expect((visible[0] + visible[2]) / 2).toBeCloseTo(800);
      expect((visible[1] + visible[3]) / 2).toBeCloseTo(450);
    }
    // the portrait tablet fits the width and sees more above and below
    expect(fitView(bounds, TABLET_PORTRAIT).zoom).toBeCloseTo(820 / 1600);
  });

  it("glides from one view to another", () => {
    const from: View = { scrollX: 0, scrollY: 0, zoom: 1 };
    const to: View = { scrollX: -500, scrollY: 200, zoom: 4 };
    expect(sameView(interpolateView(from, to, 0), from)).toBe(true);
    expect(sameView(interpolateView(from, to, 1), to)).toBe(true);
    // zoom changes geometrically: halfway from 1 to 4 is 2
    expect(interpolateView(from, to, 0.5).zoom).toBeCloseTo(2);
  });
});

describe("SharedArea", () => {
  it("doesn't drift when screens of different shapes take turns moving", () => {
    const laptop = new SharedArea();
    const tablet = new SharedArea();
    // the laptop shares what it sees
    let laptopView: View = { scrollX: 0, scrollY: 0, zoom: 1 };
    let shared = laptop.boundsIn(laptopView, LAPTOP);
    const startWidth = shared[2] - shared[0];

    for (let turn = 0; turn < 5; turn++) {
      // the tablet shows it, then pans 100 units of the page to the left
      let tabletView = tablet.show(shared, TABLET_PORTRAIT);
      tabletView = { ...tabletView, scrollX: tabletView.scrollX + 100 };
      shared = tablet.boundsIn(tabletView, TABLET_PORTRAIT);
      // the laptop shows that, then pans back
      laptopView = laptop.show(shared, LAPTOP);
      laptopView = { ...laptopView, scrollX: laptopView.scrollX - 100 };
      shared = laptop.boundsIn(laptopView, LAPTOP);
    }
    // same size, and back where it started (no zooming out turn by turn)
    expect(shared[2] - shared[0]).toBeCloseTo(startWidth, 6);
    expectBounds(shared, [0, 0, 1600, 900]);
  });

  it("zooming in on one screen zooms in on the others", () => {
    const laptop = new SharedArea();
    const tablet = new SharedArea();
    const shared: SceneBounds = [0, 0, 1600, 900];
    const laptopView = laptop.show(shared, LAPTOP);
    const tabletView = tablet.show(shared, TABLET_PORTRAIT);
    // the tablet zooms in 2× around the center of its screen
    const zoom = tabletView.zoom * 2;
    const zoomed: View = {
      zoom,
      scrollX: TABLET_PORTRAIT.width / 2 / zoom - 800,
      scrollY: TABLET_PORTRAIT.height / 2 / zoom - 450,
    };
    const next = tablet.boundsIn(zoomed, TABLET_PORTRAIT);
    expectBounds(next, [400, 225, 1200, 675]);
    expect(laptop.show(next, LAPTOP).zoom).toBeCloseTo(laptopView.zoom * 2);
  });

  it("shows the same area again after a resize (rotating a tablet)", () => {
    const area = new SharedArea();
    const shared: SceneBounds = [0, 0, 800, 600];
    const view = area.show(shared, TABLET_PORTRAIT);
    const landscape = { width: 1180, height: 820 };
    const rotated = area.resize(view, TABLET_PORTRAIT, landscape);
    expect(contains(visibleBounds(rotated, landscape), shared)).toBe(true);
    expectBounds(area.boundsIn(rotated, landscape), shared);
  });

  it("without a shared area, what we see is what we share", () => {
    const area = new SharedArea();
    const view: View = { scrollX: 10, scrollY: 20, zoom: 2 };
    expectBounds(area.boundsIn(view, LAPTOP), visibleBounds(view, LAPTOP));
  });
});

describe("SharedViewTracker", () => {
  const move = (seq: number, socketId = "other") => ({
    pageId: "p",
    bounds: [0, 0, seq, seq] as SceneBounds,
    seq,
    socketId,
  });
  const ours = { pageId: "p", bounds: null, socketId: "me" };

  it("shows others' moves in order and ignores older ones", () => {
    const tracker = new SharedViewTracker();
    tracker.reset(move(1));
    expect(tracker.received(move(2))).toEqual(move(2));
    expect(tracker.received(move(2))).toBe(null);
    expect(tracker.received(move(1))).toBe(null);
    expect(tracker.latest?.seq).toBe(2);
  });

  it("while our move is on its way, earlier moves of others don't undo it", () => {
    const tracker = new SharedViewTracker();
    tracker.reset(move(1));
    tracker.sent(ours);
    // numbered before ours: it would undo our move here only
    expect(tracker.received(move(2))).toBe(null);
    expect(tracker.acked(3)).toBe(null);
    expect(tracker.latest).toEqual({ ...ours, seq: 3 });
    // numbered after ours: shown
    expect(tracker.received(move(4))).toEqual(move(4));
  });

  it("a move that waited is shown when ours was refused", () => {
    const tracker = new SharedViewTracker();
    tracker.sent(ours);
    expect(tracker.received(move(5))).toBe(null);
    expect(tracker.acked(null)).toEqual(move(5));
    expect(tracker.latest?.seq).toBe(5);
  });

  it("with several moves of ours on their way, waits for the last", () => {
    const tracker = new SharedViewTracker();
    tracker.sent(ours);
    tracker.sent(ours);
    expect(tracker.received(move(2))).toBe(null);
    expect(tracker.acked(1)).toBe(null);
    expect(tracker.isSending).toBe(true);
    expect(tracker.acked(3)).toBe(null);
    expect(tracker.isSending).toBe(false);
    expect(tracker.latest?.seq).toBe(3);
  });

  it("two people moving at once end up in the same place", () => {
    // the server numbers A's move 10, then B's 11. A gets its ack before
    // B's move; B gets A's move before its ack.
    const a = new SharedViewTracker();
    const b = new SharedViewTracker();
    const shown = { a: null as number | null, b: null as number | null };
    a.sent({ ...ours, socketId: "a" });
    b.sent({ ...ours, socketId: "b" });
    a.acked(10);
    shown.a = a.received(move(11, "b"))?.seq ?? shown.a;
    shown.b = b.received(move(10, "a"))?.seq ?? shown.b;
    shown.b = b.acked(11)?.seq ?? shown.b;
    // A shows B's move; B stays where it moved
    expect(shown).toEqual({ a: 11, b: null });
    expect(a.latest?.seq).toBe(11);
    expect(b.latest?.seq).toBe(11);
  });
});

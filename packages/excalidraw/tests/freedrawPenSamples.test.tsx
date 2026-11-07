import { createEvent } from "@testing-library/react";

import type { ExcalidrawFreeDrawElement } from "@excalidraw/element/types";

import { Excalidraw } from "../index";

import { UI } from "./helpers/ui";
import { GlobalTestState, act, fireEvent, render } from "./test-utils";

const { h } = window;

/** a pointermove carrying the positions the device reported before it */
const moveWithSamples = (
  pointerType: "pen" | "mouse",
  samples: { x: number; y: number; pressure: number }[],
) => {
  const canvas = GlobalTestState.interactiveCanvas;
  const last = samples[samples.length - 1];
  const event = createEvent.pointerMove(canvas, {
    clientX: last.x,
    clientY: last.y,
    pressure: last.pressure,
    pointerType,
    pointerId: 1,
  });
  Object.defineProperty(event, "getCoalescedEvents", {
    value: () =>
      samples.map(({ x, y, pressure }) => ({
        clientX: x,
        clientY: y,
        pressure,
        pointerType,
      })),
  });
  fireEvent(canvas, event);
};

const stroke = (pointerType: "pen" | "mouse") => {
  const canvas = GlobalTestState.interactiveCanvas;
  UI.clickTool("freedraw");
  fireEvent.pointerDown(canvas, {
    clientX: 100,
    clientY: 100,
    pressure: 0.6,
    pointerType,
    pointerId: 1,
  });
  moveWithSamples(pointerType, [
    { x: 110, y: 102, pressure: 0.4 },
    { x: 120, y: 104, pressure: 0.5 },
    { x: 130, y: 106, pressure: 0.7 },
  ]);
  // the stroke while drawing (lifting adds the last position once more)
  const { points, pressures } = h.elements[0] as ExcalidrawFreeDrawElement;
  fireEvent.pointerUp(canvas, {
    clientX: 130,
    clientY: 106,
    pointerType,
    pointerId: 1,
  });
  return { points: [...points], pressures: [...pressures] };
};

describe("freedraw: every position a pen reports", () => {
  beforeEach(async () => {
    await render(<Excalidraw handleKeyboardGlobally={true} />);
  });

  afterEach(async () => {
    await act(async () => {});
  });

  it("adds all the positions coalesced into one pen move", () => {
    const element = stroke("pen");
    expect(element.points).toEqual([
      [0, 0],
      [10, 2],
      [20, 4],
      [30, 6],
    ]);
    // each position keeps its own pressure
    expect(element.pressures.slice(1)).toEqual([0.4, 0.5, 0.7]);
  });

  it("keeps one point per move for a mouse", () => {
    const element = stroke("mouse");
    expect(element.points).toEqual([
      [0, 0],
      [30, 6],
    ]);
  });
});

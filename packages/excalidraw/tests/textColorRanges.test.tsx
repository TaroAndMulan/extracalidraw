import React from "react";

import { KEYS } from "@excalidraw/common";
import { newElementWith } from "@excalidraw/element";

import type {
  ExcalidrawTextElement,
  NonDeleted,
} from "@excalidraw/element/types";

import { getDefaultAppState } from "../appState";
import { restoreElements } from "../data/restore";
import { Excalidraw } from "../index";
import { exportScene } from "../scene/export";

import { API } from "./helpers/api";
import { Keyboard, Pointer, UI } from "./helpers/ui";
import { getTextEditor, updateTextEditor } from "./queries/dom";
import { act, render } from "./test-utils";

const coloredText = () =>
  newElementWith(
    API.createElement({
      type: "text",
      text: "Solve for x now",
      strokeColor: "#1e1e1e",
    }) as NonDeleted<ExcalidrawTextElement>,
    {
      colorRanges: [
        { start: 10, end: 11, color: "#e03131" },
        { start: 12, end: 15, color: "#1971c2" },
      ],
    },
  );

describe("partially colored text", () => {
  it("exports colored parts as tspans in SVG", async () => {
    const svg = await exportScene({
      type: "svg",
      data: {
        elements: [coloredText()],
        appState: getDefaultAppState(),
        files: {},
      },
    });
    const tspans = [...svg.querySelectorAll("text tspan")].map((tspan) => [
      tspan.textContent,
      tspan.getAttribute("fill"),
    ]);
    expect(tspans).toEqual([
      ["Solve for ", "#1e1e1e"],
      ["x", "#e03131"],
      [" ", "#1e1e1e"],
      ["now", "#1971c2"],
    ]);
  });

  it("exports single-colored text as before", async () => {
    const svg = await exportScene({
      type: "svg",
      data: {
        elements: [API.createElement({ type: "text", text: "plain" })],
        appState: getDefaultAppState(),
        files: {},
      },
    });
    expect(svg.querySelectorAll("tspan")).toHaveLength(0);
    expect(svg.querySelector("text")?.textContent).toBe("plain");
  });

  it("keeps valid ranges when restoring and drops invalid ones", () => {
    const element = {
      ...coloredText(),
      colorRanges: [
        { start: 10, end: 11, color: "#e03131" },
        { start: 3, end: 2, color: "#e03131" },
        { start: 0, end: 4, color: "url(evil)" },
        { start: 12, end: 500, color: "#1971c2" },
      ],
    };
    const [restored] = restoreElements([element], null);
    expect((restored as ExcalidrawTextElement).colorRanges).toEqual([
      { start: 10, end: 11, color: "#e03131" },
      { start: 12, end: 15, color: "#1971c2" },
    ]);
  });

  it("doesn't add the property to texts without colors", () => {
    const [restored] = restoreElements(
      [API.createElement({ type: "text", text: "plain" })],
      null,
    );
    expect("colorRanges" in restored).toBe(false);
  });
});

describe("coloring selected words while editing", () => {
  const { h } = window;
  const mouse = new Pointer("mouse");
  const RED = "#e03131";

  beforeEach(async () => {
    await render(<Excalidraw handleKeyboardGlobally={true} />);
  });

  afterEach(async () => {
    await act(async () => {});
  });

  const editText = async (text: string) => {
    const element = API.createElement({ type: "text", text: "" });
    API.setElements([element]);
    mouse.doubleClickOn(element);
    const editor = await getTextEditor();
    updateTextEditor(editor, text);
    return { element, editor };
  };

  it("colors only the selected part", async () => {
    const { element, editor } = await editText("Solve for x");
    editor.setSelectionRange(10, 11);
    UI.clickOnTestId(`color-top-pick-${RED}`);
    Keyboard.keyPress(KEYS.ESCAPE, await getTextEditor());

    const updated = h.elements.find((el) => el.id === element.id) as
      | ExcalidrawTextElement
      | undefined;
    expect(updated?.colorRanges).toEqual([{ start: 10, end: 11, color: RED }]);
    expect(updated?.strokeColor).toBe(element.strokeColor);
  });

  it("colors the whole text (and drops partial colors) when all is selected", async () => {
    const { element, editor } = await editText("Solve for x");
    editor.setSelectionRange(10, 11);
    UI.clickOnTestId(`color-top-pick-${RED}`);
    const editorAgain = await getTextEditor();
    editorAgain.setSelectionRange(0, editorAgain.value.length);
    UI.clickOnTestId("color-top-pick-#1971c2");
    Keyboard.keyPress(KEYS.ESCAPE, await getTextEditor());

    const updated = h.elements.find((el) => el.id === element.id) as
      | ExcalidrawTextElement
      | undefined;
    expect(updated?.strokeColor).toBe("#1971c2");
    expect(updated?.colorRanges ?? []).toEqual([]);
  });

  it("picking the text's own color removes the coloring", async () => {
    const { element, editor } = await editText("Solve for x");
    editor.setSelectionRange(10, 11);
    UI.clickOnTestId(`color-top-pick-${RED}`);
    (await getTextEditor()).setSelectionRange(10, 11);
    UI.clickOnTestId(`color-top-pick-${element.strokeColor}`);
    Keyboard.keyPress(KEYS.ESCAPE, await getTextEditor());

    const updated = h.elements.find((el) => el.id === element.id) as
      | ExcalidrawTextElement
      | undefined;
    expect(updated?.colorRanges ?? []).toEqual([]);
  });
});

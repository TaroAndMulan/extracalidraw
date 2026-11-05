import React from "react";

import { MIME_TYPES } from "@excalidraw/common";

import type { FileId } from "@excalidraw/element/types";

import { Excalidraw } from "../index";

import { render } from "./test-utils";

import type { BinaryFileData, DataURL } from "../types";

const { h } = window;

const file = (dataURL: string): BinaryFileData => ({
  id: "file-1" as FileId,
  mimeType: MIME_TYPES.png,
  dataURL: dataURL as DataURL,
  created: 1,
});

describe("addFiles", () => {
  beforeEach(async () => {
    await render(<Excalidraw />);
  });

  it("keeps files that are already there", () => {
    h.app.addFiles([file("data:image/png;base64,AAAA")]);
    h.app.addFiles([file("data:image/png;base64,BBBB")]);
    expect(h.app.files["file-1"].dataURL).toBe("data:image/png;base64,AAAA");
  });

  it("replaces their data with `replace`", () => {
    h.app.addFiles([file("data:image/png;base64,AAAA")]);
    h.app.addFiles([file("data:image/png;base64,BBBB")], { replace: true });
    expect(h.app.files["file-1"].dataURL).toBe("data:image/png;base64,BBBB");
  });

  it("adds new files with `replace` too", () => {
    h.app.addFiles([file("data:image/png;base64,CCCC")], { replace: true });
    expect(h.app.files["file-1"].dataURL).toBe("data:image/png;base64,CCCC");
  });
});

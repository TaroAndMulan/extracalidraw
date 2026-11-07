import { applyDarkModeFilter } from "@excalidraw/common";

import type { ExcalidrawFreeDrawElement } from "@excalidraw/element/types";

import { LiveStrokes } from "./liveStrokes";

const stroke = (
  id: string,
  version: number,
  extra: Partial<ExcalidrawFreeDrawElement> = {},
) =>
  ({
    id,
    type: "freedraw",
    version,
    versionNonce: version,
    x: 10,
    y: 20,
    width: 30,
    height: 4,
    angle: 0,
    strokeColor: "#e03131",
    backgroundColor: "transparent",
    fillStyle: "solid",
    strokeWidth: 1,
    strokeStyle: "solid",
    roughness: 1,
    opacity: 100,
    isDeleted: false,
    points: Array.from({ length: version + 1 }, (_, i) => [i * 3, i % 2]),
    pressures: [],
    simulatePressure: true,
    strokeOptions: { variability: "variable", streamline: 0.5 },
    ...extra,
  } as unknown as ExcalidrawFreeDrawElement);

describe("LiveStrokes", () => {
  let frames: FrameRequestCallback[];
  let theme: "light" | "dark";
  let live: LiveStrokes;
  const flushFrame = () => {
    const pending = frames.splice(0);
    pending.forEach((callback) => callback(performance.now()));
  };

  beforeEach(() => {
    frames = [];
    theme = "light";
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb) => {
      frames.push(cb);
      return frames.length;
    });
    live = new LiveStrokes(
      () =>
        ({
          getAppState: () => ({
            width: 800,
            height: 600,
            zoom: { value: 1 },
            scrollX: 0,
            scrollY: 0,
            theme,
            viewBackgroundColor: "#fff",
          }),
        } as any),
    );
    live.mount(document.body);
  });

  afterEach(() => {
    live.unmount();
    vi.restoreAllMocks();
  });

  it("keeps the newest version of each stroke", () => {
    live.set(stroke("a", 3));
    live.set(stroke("a", 2));
    expect(live.get("a")?.version).toBe(3);
    live.set(stroke("a", 4));
    expect(live.get("a")?.version).toBe(4);
  });

  it("lets go of a stroke only after the page was redrawn with it", () => {
    live.set(stroke("a", 3));
    live.release(["a"]);
    flushFrame();
    expect(live.has("a")).toBe(true);
    flushFrame();
    expect(live.has("a")).toBe(false);
  });

  it("keeps a stroke that grew again meanwhile", () => {
    live.set(stroke("a", 3));
    live.release(["a"]);
    live.set(stroke("a", 4));
    flushFrame();
    flushFrame();
    expect(live.get("a")?.version).toBe(4);
  });

  it("finds strokes that stopped growing", () => {
    const now = vi.spyOn(performance, "now").mockReturnValue(1000);
    live.set(stroke("old", 2));
    now.mockReturnValue(2500);
    live.set(stroke("new", 2));
    now.mockReturnValue(3100);
    expect(live.stale(2000).map((s) => s.id)).toEqual(["old"]);
    expect(live.all().map((s) => s.id)).toEqual(["old", "new"]);
  });

  it("draws each stroke once per frame, in the theme's colors", () => {
    const canvas = document.querySelector<HTMLCanvasElement>(
      "canvas.wb-live-strokes",
    )!;
    const context = canvas.getContext("2d")!;
    const fill = vi.spyOn(context, "fill");
    const styles: string[] = [];
    vi.spyOn(context, "fillStyle", "set").mockImplementation((value) => {
      styles.push(String(value));
    });

    live.set(stroke("a", 3));
    live.set(stroke("b", 3, { isDeleted: true }));
    live.set(stroke("c", 3));
    flushFrame();
    expect(fill).toHaveBeenCalledTimes(2);
    expect(styles).toEqual(["#e03131", "#e03131"]);
    expect(canvas.width).toBe(800 * (window.devicePixelRatio || 1));

    theme = "dark";
    live.scheduleRender();
    flushFrame();
    expect(styles.slice(2)).toEqual([
      applyDarkModeFilter("#e03131"),
      applyDarkModeFilter("#e03131"),
    ]);
  });
});

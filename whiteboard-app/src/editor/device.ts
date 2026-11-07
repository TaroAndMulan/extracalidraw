import { useEffect, useSyncExternalStore } from "react";

/**
 * Keeps the screen on while `active` (others are in the paper): a student
 * watching the presenter on a tablet doesn't touch it, and it would dim and
 * lock after a minute or two. The browser drops the lock while the tab is
 * hidden; it's taken again when the tab comes back. Needs HTTPS (or
 * localhost); where it isn't available nothing happens.
 */
export const useScreenWakeLock = (active: boolean) => {
  useEffect(() => {
    const wakeLock = "wakeLock" in navigator ? navigator.wakeLock : null;
    if (!active || !wakeLock) {
      return;
    }
    let sentinel: WakeLockSentinel | null = null;
    let stopped = false;
    const acquire = async () => {
      if (stopped || sentinel || document.visibilityState !== "visible") {
        return;
      }
      try {
        const lock = await wakeLock.request("screen");
        if (stopped) {
          lock.release().catch(() => {});
          return;
        }
        sentinel = lock;
        lock.addEventListener("release", () => {
          if (sentinel === lock) {
            sentinel = null;
          }
        });
      } catch {
        // refused (battery saver, not a secure context…)
      }
    };
    document.addEventListener("visibilitychange", acquire);
    acquire();
    return () => {
      stopped = true;
      document.removeEventListener("visibilitychange", acquire);
      sentinel?.release().catch(() => {});
      sentinel = null;
    };
  }, [active]);
};

// full screen (Safari on iPad still uses the prefixed API)
type WebkitDocument = Document & {
  webkitFullscreenEnabled?: boolean;
  webkitFullscreenElement?: Element | null;
  webkitExitFullscreen?: () => Promise<void> | void;
};
type WebkitElement = HTMLElement & {
  webkitRequestFullscreen?: () => Promise<void> | void;
};

const doc = () => document as WebkitDocument;

export const canFullscreen = () =>
  !!(document.fullscreenEnabled || doc().webkitFullscreenEnabled);

const isFullscreen = () =>
  !!(document.fullscreenElement || doc().webkitFullscreenElement);

export const toggleFullscreen = async () => {
  try {
    if (isFullscreen()) {
      await (document.exitFullscreen
        ? document.exitFullscreen()
        : doc().webkitExitFullscreen?.());
    } else {
      const root = document.documentElement as WebkitElement;
      await (root.requestFullscreen
        ? root.requestFullscreen()
        : root.webkitRequestFullscreen?.());
    }
  } catch {
    // refused by the browser
  }
};

const subscribeFullscreen = (callback: () => void) => {
  document.addEventListener("fullscreenchange", callback);
  document.addEventListener("webkitfullscreenchange", callback);
  return () => {
    document.removeEventListener("fullscreenchange", callback);
    document.removeEventListener("webkitfullscreenchange", callback);
  };
};

export const useIsFullscreen = () =>
  useSyncExternalStore(subscribeFullscreen, isFullscreen);

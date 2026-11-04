import { useSyncExternalStore } from "react";

import type { AnchorHTMLAttributes, MouseEvent } from "react";

const LOCATION_CHANGE = "whiteboard:locationchange";

const subscribe = (callback: () => void) => {
  window.addEventListener("popstate", callback);
  window.addEventListener(LOCATION_CHANGE, callback);
  return () => {
    window.removeEventListener("popstate", callback);
    window.removeEventListener(LOCATION_CHANGE, callback);
  };
};

const getPathname = () => window.location.pathname;

export const navigate = (to: string, opts?: { replace?: boolean }) => {
  if (opts?.replace) {
    window.history.replaceState({}, "", to);
  } else {
    window.history.pushState({}, "", to);
  }
  window.dispatchEvent(new Event(LOCATION_CHANGE));
};

export const usePathname = () => useSyncExternalStore(subscribe, getPathname);

export const Link = ({
  to,
  onClick,
  ...props
}: AnchorHTMLAttributes<HTMLAnchorElement> & { to: string }) => (
  // content comes in through `props.children`
  // eslint-disable-next-line jsx-a11y/anchor-has-content
  <a
    {...props}
    href={to}
    onClick={(event: MouseEvent<HTMLAnchorElement>) => {
      onClick?.(event);
      if (
        event.defaultPrevented ||
        event.button !== 0 ||
        event.metaKey ||
        event.ctrlKey ||
        event.shiftKey ||
        event.altKey
      ) {
        return;
      }
      event.preventDefault();
      navigate(to);
    }}
  />
);

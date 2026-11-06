import { useSyncExternalStore } from 'react';

// Same edge as Tailwind's `md`, so a component and its `max-md:` classes switch together.
const PHONE = '(max-width: 767px)';

export const isMobileNow = () => window.matchMedia(PHONE).matches;

function subscribe(onChange: () => void) {
  const list = window.matchMedia(PHONE);
  list.addEventListener('change', onChange);
  return () => list.removeEventListener('change', onChange);
}

/** For layouts that differ in structure on a phone; plain size changes use `max-md:` classes instead. */
export function useIsMobile() {
  return useSyncExternalStore(subscribe, isMobileNow);
}

import { useSyncExternalStore } from "react";

const subscribe = () => () => {};

/** False during SSR and hydration, true afterwards. For UI that depends on browser-only wallet state. */
export const useMounted = () => useSyncExternalStore(subscribe, () => true, () => false);

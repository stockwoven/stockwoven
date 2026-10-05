import { ReactNode } from "react";

/** A visible gap in the docs. Never fill one with invented figures or promises. */
export function Todo({ children }: { children: ReactNode }) {
  return (
    <p className="doc-todo t-body">
      <span className="t-eyebrow">TODO</span> {children}
    </p>
  );
}

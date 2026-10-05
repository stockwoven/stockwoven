"use client";

import { ReactNode, RefObject, useEffect } from "react";

/**
 * A native modal <dialog>: showModal() makes the rest of the page inert (focus stays inside),
 * Esc closes it, and the browser returns focus to the opener.
 */
export function Sheet({
  dialog,
  open,
  onClose,
  side,
  labelledBy,
  children,
}: {
  dialog: RefObject<HTMLDialogElement | null>;
  open: boolean;
  onClose: () => void;
  side?: boolean;
  labelledBy: string;
  children: ReactNode;
}) {
  useEffect(() => {
    const el = dialog.current;
    if (!el) return;
    if (open && !el.open) el.showModal();
    if (!open && el.open) el.close();
  }, [dialog, open]);

  return (
    <dialog
      ref={dialog}
      className={`sheet ${side ? "sheet--side" : "sheet--center"}`}
      aria-labelledby={labelledBy}
      onClose={onClose}
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className="sheet__inner">{children}</div>
    </dialog>
  );
}

import { TxStatus as Status } from "@/lib/hooks";
import { explorer } from "@/lib/stockwoven";

const LABEL = { pending: "Pending", ok: "Confirmed", err: "Failed" };

/** Transaction state in words; no color carries meaning on its own. */
export function TxStatus({ status }: { status: Status }) {
  return (
    <div role="status" aria-live="polite">
      {status && (
        <div className={`status status--${status.kind}`}>
          <span className="t-eyebrow">{LABEL[status.kind]}</span>
          <span className="t-body">{status.text}</span>
          {status.signature && (
            <a className="t-data" href={explorer(status.signature, "tx")} target="_blank" rel="noreferrer">
              View transaction on Explorer
            </a>
          )}
        </div>
      )}
    </div>
  );
}

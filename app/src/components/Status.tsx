import { TxStatus } from "@/lib/hooks";
import { explorer } from "@/lib/stockwoven";

export function Status({ status }: { status: TxStatus }) {
  if (!status) return null;
  return (
    <div className={`status ${status.kind === "pending" ? "" : status.kind}`} role="status">
      {status.text}
      {status.signature && (
        <>
          {" · "}
          <a href={explorer(status.signature, "tx")} target="_blank" rel="noreferrer">
            view transaction
          </a>
        </>
      )}
    </div>
  );
}

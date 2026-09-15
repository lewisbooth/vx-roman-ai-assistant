import { useId } from "react";
import type { ConversationClient } from "../session/types";
import type { PendingToolApproval } from "../session/tool-approval";

export function ToolApproval({
  approval,
  session,
  dock = false,
}: {
  approval: PendingToolApproval;
  session: ConversationClient;
  dock?: boolean;
}) {
  const titleId = useId();
  return (
    <section
      className={`roman-tool-approval${dock ? " roman-approval-dock" : ""}`}
      aria-labelledby={titleId}
    >
      <h2 id={titleId}>{approval.title}</h2>
      <div className="roman-approval-details" aria-live="polite">
        {approval.details.map((detail, index) => (
          <p key={index}>{detail}</p>
        ))}
        {approval.unavailable && <p role="status">{approval.unavailable}</p>}
      </div>
      <div className="roman-approval-actions">
        <button
          type="button"
          onClick={() =>
            session.resolveToolApproval(approval.invocationId, false)
          }
        >
          Cancel
        </button>
        <button
          type="button"
          disabled={!!approval.unavailable}
          onClick={() =>
            session.resolveToolApproval(approval.invocationId, true)
          }
        >
          Approve
        </button>
      </div>
    </section>
  );
}

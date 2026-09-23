import { useId } from "react";
import type { ConversationClient } from "../session/types";
import type { PendingToolApproval } from "../session/tool-approval";

export function ToolApproval({
  approval,
  session,
  disabled = false,
}: {
  approval: PendingToolApproval;
  session: ConversationClient;
  disabled?: boolean;
}) {
  const titleId = useId();
  return (
    <section
      className="roman-action-panel roman-tool-approval"
      aria-labelledby={titleId}
    >
      <h2 id={titleId}>{approval.title}</h2>
      <div className="roman-approval-details" aria-live="polite">
        {approval.details.map((detail, index) => (
          <p key={index}>{detail}</p>
        ))}
        {approval.unavailable && <p role="status">{approval.unavailable}</p>}
      </div>
      <div className="roman-action-buttons roman-approval-actions">
        <button
          type="button"
          disabled={disabled}
          onClick={() =>
            session.resolveToolApproval(approval.invocationId, false)
          }
        >
          Cancel
        </button>
        <button
          type="button"
          disabled={disabled || !!approval.unavailable}
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

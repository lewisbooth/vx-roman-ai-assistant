import { BrandedDialog } from "./BrandedDialog";

export function EndChatDialog({
  pending,
  error,
  onCancel,
  onConfirm,
}: {
  pending: boolean;
  error: string | null;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <BrandedDialog
      title="End this chat?"
      description="Your chat will be cleared. Items in your Cart and Gallery will remain."
      pending={pending}
      error={error}
      onClose={onCancel}
    >
      <button type="button" disabled={pending} onClick={onCancel}>
        Keep chatting
      </button>
      <button
        type="button"
        className="roman-dialog-primary"
        disabled={pending}
        onClick={onConfirm}
      >
        {pending ? "Ending chat…" : "End chat"}
      </button>
    </BrandedDialog>
  );
}

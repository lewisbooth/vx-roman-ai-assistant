import { createMemoryRouter } from "react-router";

type AssistantProps = {
  label: string;
  initial: string;
};

function AssistantLauncher({ label, initial }: AssistantProps) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={() => console.log("Hello from Roman")}
      className="fixed right-[calc(20px+env(safe-area-inset-right))] bottom-[calc(20px+env(safe-area-inset-bottom))] z-[1000] inline-flex size-[48px] cursor-pointer items-center justify-center rounded-full border border-solid border-white/10 bg-zinc-900 font-serif text-[26px] leading-none font-semibold text-white [box-shadow:0_6px_24px_#00000026] transition-colors hover:bg-zinc-700 focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-offset-4 focus-visible:outline-zinc-900 motion-reduce:transition-none"
    >
      <span aria-hidden="true">{initial}</span>
    </button>
  );
}

export function createAssistantRouter(props: AssistantProps) {
  return createMemoryRouter(
    [{ path: "/", element: <AssistantLauncher {...props} /> }],
    { initialEntries: ["/"] },
  );
}

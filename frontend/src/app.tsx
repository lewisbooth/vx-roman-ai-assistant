import {
  useEffect,
  useId,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { createMemoryRouter } from "react-router";
import type { StorefrontNavigation } from "./navigation/shared";

type AssistantProps = {
  label: string;
  initial: string;
  navigation: StorefrontNavigation;
};

function Assistant({ label, initial, navigation }: AssistantProps) {
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState("");
  const [instanceId] = useState(() => crypto.randomUUID().slice(0, 8));
  const id = useId();
  const launcherRef = useRef<HTMLButtonElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLElement>(null);
  const { url, pending, error } = useSyncExternalStore(
    navigation.subscribe,
    navigation.getSnapshot,
  );
  const pathname = new URL(url, window.location.origin).pathname;

  useEffect(() => {
    navigation.setSidebarOpen(open);
    if (open) closeRef.current?.focus();
    return () => navigation.setSidebarOpen(false);
  }, [navigation, open]);

  useEffect(() => {
    if (!open) return;
    const panel = panelRef.current;
    if (!panel) return;

    const handleEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
      launcherRef.current?.focus();
    };
    panel.addEventListener("keydown", handleEscape);
    return () => panel.removeEventListener("keydown", handleEscape);
  }, [open]);

  const close = () => {
    setOpen(false);
    launcherRef.current?.focus();
  };

  return (
    <>
      <button
        ref={launcherRef}
        type="button"
        aria-label={label}
        title={label}
        aria-expanded={open}
        aria-controls={`${id}-panel`}
        onClick={() => {
          console.log("Hello from Roman");
          setOpen((value) => !value);
        }}
        className="fixed left-[calc(20px+env(safe-area-inset-left))] bottom-[calc(20px+env(safe-area-inset-bottom))] z-[1000] inline-flex size-[48px] cursor-pointer items-center justify-center rounded-full border border-solid border-white/10 bg-zinc-900 font-serif text-[26px] leading-none font-semibold text-white [box-shadow:0_6px_24px_#00000026] transition-colors hover:bg-zinc-700 focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-offset-4 focus-visible:outline-zinc-900 motion-reduce:transition-none"
      >
        <span aria-hidden="true">{initial}</span>
      </button>

      <section
        ref={panelRef}
        id={`${id}-panel`}
        hidden={!open}
        aria-labelledby={`${id}-title`}
        className="fixed top-0 right-0 z-[1001] flex h-dvh w-[400px] max-w-[100vw] flex-col border-l border-solid border-zinc-200 bg-white font-sans text-[14px] leading-[1.5] text-zinc-900 [box-shadow:-8px_0_32px_#0000000d]"
      >
        <header className="flex items-center justify-between gap-4 border-b border-solid border-zinc-200 px-6 pt-[calc(20px+env(safe-area-inset-top))] pb-5">
          <h2 id={`${id}-title`} className="text-[18px] font-semibold">
            {label}
          </h2>
          <button
            ref={closeRef}
            type="button"
            onClick={close}
            aria-label="Close assistant"
            className="inline-flex min-h-[44px] min-w-[44px] cursor-pointer items-center justify-center rounded-full text-[24px] hover:bg-zinc-100 focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-offset-2 focus-visible:outline-zinc-900"
          >
            <span aria-hidden="true">×</span>
          </button>
        </header>

        <div className="flex-1 overflow-y-auto px-6 py-6">
          <p className="text-[20px] font-semibold">Hello from Roman</p>
          <p className="mt-2 text-zinc-600">
            Browse the store while keeping your assistant open.
          </p>

          <nav aria-label="Browse store" aria-busy={pending} className="mt-6">
            <div className="flex flex-col gap-2">
              {navigation.destinations.map((destination) => (
                <button
                  key={destination.path}
                  type="button"
                  aria-current={
                    pathname === destination.path ? "page" : undefined
                  }
                  disabled={pending}
                  onClick={() => void navigation.navigate(destination.path)}
                  className="min-h-[44px] cursor-pointer rounded-lg border border-solid border-zinc-200 px-4 py-3 text-left hover:bg-zinc-50 focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-offset-2 focus-visible:outline-zinc-900 disabled:cursor-wait disabled:opacity-50 aria-[current=page]:border-zinc-900 aria-[current=page]:bg-zinc-100"
                >
                  {destination.label}
                </button>
              ))}
            </div>
          </nav>

          <p role="status" className="mt-3 text-zinc-500">
            {pending ? "Opening page…" : "Ready"}
          </p>
          {error && (
            <p role="alert" className="mt-3 text-red-700">
              {error}
            </p>
          )}

          <label htmlFor={`${id}-note`} className="mt-8 block font-semibold">
            Your note
          </label>
          <p id={`${id}-note-help`} className="mt-1 text-zinc-600">
            Write a note, then change pages. It stays here while you browse.
          </p>
          <textarea
            id={`${id}-note`}
            aria-describedby={`${id}-note-help`}
            value={note}
            onChange={(event) => setNote(event.target.value)}
            rows={4}
            className="mt-3 w-full resize-y rounded-lg border border-solid border-zinc-300 bg-white px-3 py-3 text-[16px] focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-offset-2 focus-visible:outline-zinc-900"
          />
        </div>

        <footer className="border-t border-solid border-zinc-200 px-6 pt-4 pb-[calc(16px+env(safe-area-inset-bottom))] text-[12px] text-zinc-500">
          Assistant instance: <span className="font-mono">{instanceId}</span>
        </footer>
      </section>
    </>
  );
}

export function createAssistantRouter(props: AssistantProps) {
  return createMemoryRouter(
    [{ path: "/", element: <Assistant {...props} /> }],
    { initialEntries: ["/"] },
  );
}

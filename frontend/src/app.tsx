import { useEffect, useSyncExternalStore } from "react";
import { createMemoryRouter, useRouteError } from "react-router";
import type { StorefrontNavigation } from "./navigation/shared";
import type { AssistantTools } from "./tools";
import { ToolDrawer } from "./tools/ToolDrawer";

type AssistantProps = {
  logoUrl: string;
  navigation: StorefrontNavigation;
  tools: AssistantTools;
  showTools: boolean;
  onReady: () => void;
  onError: (error: unknown) => void;
};

function Assistant({
  logoUrl,
  navigation,
  tools,
  showTools,
  onReady,
}: AssistantProps) {
  const { url, pending, error } = useSyncExternalStore(
    navigation.subscribe,
    navigation.getSnapshot,
  );
  const pathname = new URL(url, window.location.origin).pathname;

  useEffect(() => onReady(), [onReady]);

  return (
    <div className="roman-content flex flex-col items-center px-[24px] pt-[107px] pb-[40px] font-serif font-normal text-[#4E0E0E]">
      <img
        src={logoUrl}
        alt="Roman by SelectBlinds"
        width={121}
        height={50}
        className="block h-[50px] w-[121px] shrink-0"
      />

      <h1 className="mt-[57px] mb-0 w-[303px] max-w-full text-center text-[41.809px] leading-[0.88575] font-normal tracking-[-0.02em]">
        A brighter home <em>starts</em> with a conversation.
      </h1>

      <nav
        aria-label="Browse store"
        aria-busy={pending}
        className="mt-[48px] flex w-[303px] max-w-full flex-col items-center text-center text-[18px] leading-[1.3]"
      >
        {navigation.destinations.map((destination) => (
          <a
            key={destination.path}
            href={destination.path}
            aria-current={pathname === destination.path ? "page" : undefined}
            aria-disabled={pending || undefined}
            onClick={(event) => {
              if (
                event.defaultPrevented ||
                event.button !== 0 ||
                event.metaKey ||
                event.ctrlKey ||
                event.shiftKey ||
                event.altKey
              ) {
                return;
              }
              event.preventDefault();
              if (!pending) void navigation.navigate(destination.path);
            }}
            className="inline-flex min-h-[44px] items-center justify-center rounded-sm px-[8px] py-[8px] text-inherit no-underline decoration-[#C59745] decoration-1 underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-offset-2 focus-visible:outline-[#4E0E0E] aria-[current=page]:underline aria-disabled:cursor-wait aria-disabled:opacity-50"
          >
            {destination.label}
          </a>
        ))}
      </nav>

      <p role="status" className="m-0 mt-[12px] text-center text-[15px]">
        {pending ? "Opening page…" : ""}
      </p>
      {error && (
        <p
          role="alert"
          className="m-0 mt-[12px] w-[303px] max-w-full text-center text-[15px] leading-[1.4]"
        >
          {error}
        </p>
      )}
      {showTools && <ToolDrawer tools={tools} />}
    </div>
  );
}

function AssistantError({ onError }: Pick<AssistantProps, "onError">) {
  const error = useRouteError();
  useEffect(() => onError(error), [error, onError]);
  return null;
}

export function createAssistantRouter(props: AssistantProps) {
  return createMemoryRouter(
    [
      {
        path: "/",
        element: <Assistant {...props} />,
        errorElement: <AssistantError onError={props.onError} />,
      },
    ],
    { initialEntries: ["/"] },
  );
}

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { createPortal } from "react-dom";
import { createMemoryRouter, useRouteError } from "react-router";
import { Composer } from "./chat/Composer";
import { Timeline } from "./chat/Timeline";
import { Welcome } from "./chat/Welcome";
import { VoiceControls } from "./chat/VoiceControls";
import type { StorefrontNavigation } from "./navigation/shared";
import type { ConversationClient } from "./session/types";
import type { AssistantTools } from "./tools";
import { ToolDrawer } from "./tools/ToolDrawer";
import { VoiceChoice } from "./tools/VoiceChoice";

type AssistantProps = {
  logoUrl: string;
  navigation: StorefrontNavigation;
  tools: AssistantTools;
  session: ConversationClient;
  showTools: boolean;
  voiceDock?: HTMLElement;
  onReady: () => void;
  onError: (error: unknown) => void;
};

function Assistant({
  logoUrl,
  navigation,
  tools,
  session,
  showTools,
  onReady,
  voiceDock,
}: AssistantProps) {
  const state = useSyncExternalStore(session.subscribe, session.getSnapshot);
  const viewport = useRef<HTMLDivElement>(null);
  const following = useRef(true);
  const messages = state.conversation?.messages;
  const hasMessages = !!messages?.length;
  const [ending, setEnding] = useState(false);
  const endingRef = useRef(false);
  const [endError, setEndError] = useState<string | null>(null);
  const [chatVersion, setChatVersion] = useState(0);
  const voice = state.voice;
  const localVoice =
    voice.status === "starting" ||
    voice.status === "active" ||
    voice.status === "stopping" ||
    (voice.status === "error" && voice.muted);
  const waitingForVoice =
    !localVoice &&
    (state.conversation?.voice?.status === "starting" ||
      state.conversation?.voice?.status === "active");

  async function endChat() {
    if (endingRef.current) return;
    endingRef.current = true;
    setEnding(true);
    setEndError(null);
    try {
      await session.end();
      following.current = true;
      if (viewport.current) viewport.current.scrollTop = 0;
      setChatVersion((value) => value + 1);
    } catch (error) {
      setEndError(
        error instanceof Error
          ? error.message
          : "Your chat could not be ended. Please retry.",
      );
    } finally {
      endingRef.current = false;
      setEnding(false);
    }
  }

  useEffect(() => onReady(), [onReady]);

  const followConversation = useCallback(() => {
    const scroll = viewport.current;
    if (hasMessages && following.current && scroll)
      scroll.scrollTop = scroll.scrollHeight;
  }, [hasMessages]);

  useLayoutEffect(followConversation, [messages, followConversation]);

  return (
    <div className="roman-content roman-chat">
      {(hasMessages || state.restoring || state.conversation) && (
        <header className="roman-chat-header">
          {state.conversation?.status === "active" && (
            <button
              type="button"
              className="roman-end-chat"
              disabled={ending || state.pending || state.restoring}
              onClick={() => void endChat()}
            >
              {ending ? "Ending…" : "End chat"}
            </button>
          )}
          <img
            src={logoUrl}
            alt="Roman by SelectBlinds"
            width={95}
            height={40}
            className="h-[40px] w-[95px] object-contain"
          />
        </header>
      )}
      <div
        ref={viewport}
        className="roman-chat-scroll"
        onScroll={(event) => {
          const scroll = event.currentTarget;
          following.current =
            scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 48;
        }}
      >
        {state.restoring ? (
          <p className="roman-chat-restoring" role="status">
            Restoring your conversation…
          </p>
        ) : hasMessages ? (
          <Timeline
            messages={messages!}
            session={session}
            navigation={navigation}
            onContentChange={followConversation}
          />
        ) : (
          <Welcome logoUrl={logoUrl} />
        )}
        {showTools && (
          <ToolDrawer tools={tools}>
            <VoiceChoice session={session} disabled={ending} />
          </ToolDrawer>
        )}
      </div>
      <VoiceControls
        session={session}
        voice={voice}
        disabled={
          ending ||
          state.pending ||
          state.restoring ||
          !!state.conversation?.busy
        }
        waiting={waitingForVoice}
      />
      {voiceDock &&
        localVoice &&
        createPortal(
          <VoiceControls session={session} voice={voice} dock />,
          voiceDock,
        )}
      <Composer
        key={chatVersion}
        busy={
          ending ||
          localVoice ||
          waitingForVoice ||
          state.pending ||
          state.restoring ||
          !!state.conversation?.busy
        }
        error={state.error || endError}
        onClearError={() => {
          setEndError(null);
          session.clearError();
        }}
        onSend={(text) => {
          following.current = true;
          return session.sendMessage(text);
        }}
      />
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

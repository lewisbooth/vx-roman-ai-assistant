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
import { ReplyActivity } from "./chat/ReplyActivity";
import { ToolApproval } from "./chat/ToolApproval";
import type { StorefrontNavigation } from "./navigation/shared";
import type { ConversationClient } from "./session/types";
import type { AssistantTools } from "./tools";
import { ToolDrawer } from "./tools/ToolDrawer";
import { VoiceChoice } from "./tools/VoiceChoice";
import { latestQuestion, type QuestionPart } from "../../shared/questions";

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
  const conversationView = useRef<HTMLDivElement>(null);
  const following = useRef(true);
  const messages = state.conversation?.messages;
  const hasMessages = !!messages?.length;
  const [ending, setEnding] = useState(false);
  const endingRef = useRef(false);
  const [endError, setEndError] = useState<string | null>(null);
  const [chatVersion, setChatVersion] = useState(0);
  const [toolsOpen, setToolsOpen] = useState(false);
  const [answering, setAnswering] = useState(false);
  const answeringRef = useRef(false);
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
  const voiceMode = localVoice || waitingForVoice;
  const previousVoiceMode = useRef(voiceMode);
  const activeQuestion =
    state.conversation?.status === "active"
      ? latestQuestion(messages ?? [])
      : undefined;

  async function answerQuestion(part: QuestionPart, answer: string) {
    const current = session.getSnapshot();
    if (
      answeringRef.current ||
      endingRef.current ||
      current.pending ||
      current.restoring ||
      current.conversation?.busy
    )
      throw new Error("Wait for Roman's current reply.");
    if (
      current.conversation?.status !== "active" ||
      latestQuestion(current.conversation.messages)?.invocationId !==
        part.invocationId ||
      !part.answers.includes(answer)
    )
      throw new Error(
        "This question is no longer waiting for an answer. Continue with the latest message.",
      );
    answeringRef.current = true;
    setAnswering(true);
    try {
      following.current = true;
      if (current.voice.status === "active") {
        await session.sendVoiceAnswer(part.invocationId, answer);
      } else if (localVoice || waitingForVoice) {
        throw new Error(
          "Wait until voice is connected here before choosing an answer.",
        );
      } else {
        await session.sendMessage(answer);
      }
    } finally {
      answeringRef.current = false;
      setAnswering(false);
    }
  }

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

  useLayoutEffect(() => {
    if (previousVoiceMode.current === voiceMode) return;
    previousVoiceMode.current = voiceMode;
    const view = conversationView.current;
    if (!view || view.hidden || !view.getClientRects().length) return;
    const active = (view.getRootNode() as ShadowRoot).activeElement;
    // Keep an already focused conversation widget focused when modes change.
    if (
      active &&
      view.contains(active) &&
      !active.closest(".roman-composer, .roman-voice-composer")
    )
      return;
    view
      .querySelector<HTMLElement>(
        voiceMode
          ? ".roman-voice-composer button:not(:disabled)"
          : ".roman-composer textarea",
      )
      ?.focus({ preventScroll: true });
  }, [voiceMode]);

  const followConversation = useCallback(() => {
    const scroll = viewport.current;
    if (hasMessages && following.current && scroll)
      scroll.scrollTop = scroll.scrollHeight;
  }, [hasMessages]);

  useLayoutEffect(followConversation, [
    messages,
    toolsOpen,
    followConversation,
  ]);

  return (
    <div className="roman-content roman-chat">
      <div
        ref={conversationView}
        className="roman-conversation"
        hidden={toolsOpen}
      >
        {(hasMessages || state.restoring || state.conversation) && (
          <header className="roman-chat-header">
            {state.conversation?.status === "active" && (
              <button
                type="button"
                className="roman-end-chat"
                disabled={
                  ending || answering || state.pending || state.restoring
                }
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
              activeQuestionId={activeQuestion?.invocationId}
              questionDisabled={
                ending ||
                answering ||
                state.pending ||
                !!state.conversation?.busy ||
                waitingForVoice ||
                (voice.status === "error" && voice.muted) ||
                voice.status === "starting" ||
                voice.status === "stopping"
              }
              voice={localVoice || waitingForVoice}
              onAnswer={answerQuestion}
            />
          ) : (
            <Welcome logoUrl={logoUrl} />
          )}
          <ReplyActivity
            state={state}
            ending={ending}
            onContentChange={followConversation}
          />
        </div>
        {state.approval && (
          <ToolApproval approval={state.approval} session={session} />
        )}
        <VoiceControls
          session={session}
          voice={voice}
          waiting={waitingForVoice}
        />
        {voiceDock &&
          (localVoice || state.approval) &&
          createPortal(
            <>
              {state.approval && (
                <ToolApproval
                  approval={state.approval}
                  session={session}
                  dock
                />
              )}
              {localVoice && (
                <VoiceControls session={session} voice={voice} dock />
              )}
            </>,
            voiceDock,
          )}
        <Composer
          key={chatVersion}
          hidden={voiceMode}
          busy={
            ending ||
            answering ||
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
          onStartVoice={
            !localVoice && !waitingForVoice
              ? () => session.startVoice()
              : undefined
          }
        />
      </div>
      {showTools && (
        <ToolDrawer tools={tools} open={toolsOpen} onOpenChange={setToolsOpen}>
          <VoiceChoice session={session} disabled={ending} />
        </ToolDrawer>
      )}
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

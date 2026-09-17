import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
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
import {
  isQuestionAnswer,
  latestQuestion,
  type QuestionPart,
} from "../../shared/questions";

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
  const storefront = useSyncExternalStore(
    navigation.subscribe,
    navigation.getSnapshot,
  );
  const viewport = useRef<HTMLDivElement>(null);
  const conversationView = useRef<HTMLDivElement>(null);
  const following = useRef(true);
  const messages = useMemo(
    () =>
      state.optimisticMessage
        ? [...(state.conversation?.messages ?? []), state.optimisticMessage]
        : state.conversation?.messages,
    [state.conversation?.messages, state.optimisticMessage],
  );
  const hasMessages = !!messages?.length;
  const [ending, setEnding] = useState(false);
  const endingRef = useRef(false);
  const [endError, setEndError] = useState<string | null>(null);
  const [chatVersion, setChatVersion] = useState(0);
  const [toolsOpen, setToolsOpen] = useState(false);
  const [answering, setAnswering] = useState(false);
  const answeringRef = useRef(false);
  const [sending, setSending] = useState(false);
  const sendingRef = useRef(false);
  const [startError, setStartError] = useState<string | null>(null);
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
  const textBusy =
    ending ||
    answering ||
    sending ||
    voiceMode ||
    state.pending ||
    state.restoring ||
    !!state.conversation?.busy;
  const previousVoiceMode = useRef(voiceMode);
  const activeQuestion =
    state.conversation?.status === "active"
      ? latestQuestion(messages ?? [], storefront.url)
      : undefined;

  async function sendMessage(text: string) {
    if (sendingRef.current || textBusy)
      throw new Error("Wait for Roman's current reply.");
    sendingRef.current = true;
    setSending(true);
    setStartError(null);
    try {
      following.current = true;
      await session.sendMessage(text);
    } finally {
      sendingRef.current = false;
      setSending(false);
    }
  }

  async function startTopic(text: string) {
    if (sendingRef.current || textBusy) return;
    try {
      await sendMessage(text);
    } catch (error) {
      setStartError(
        error instanceof Error
          ? error.message
          : "Your message could not be sent. Please retry.",
      );
    }
  }

  async function answerQuestion(part: QuestionPart, answer: string) {
    const current = session.getSnapshot();
    const page = navigation.getSnapshot();
    const question = latestQuestion(
      current.conversation?.messages ?? [],
      page.url,
    );
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
      question?.invocationId !== part.invocationId ||
      !isQuestionAnswer(question, answer) ||
      (question.measurement && page.pending)
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
      setStartError(null);
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
                (!!activeQuestion?.measurement && storefront.pending) ||
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
            <Welcome
              logoUrl={logoUrl}
              busy={textBusy}
              onStart={(text) => void startTopic(text)}
            />
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
          busy={textBusy}
          disabled={ending || state.restoring}
          error={state.error || startError || endError}
          onClearError={() => {
            setEndError(null);
            setStartError(null);
            session.clearError();
          }}
          onSend={sendMessage}
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

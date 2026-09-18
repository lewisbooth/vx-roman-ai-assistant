import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
/* eslint-disable jsx-a11y/no-noninteractive-tabindex, jsx-a11y/no-noninteractive-element-interactions -- The named history region is focusable for native keyboard scrolling; its handlers only track scroll intent. */
import { createPortal } from "react-dom";
import {
  createMemoryRouter,
  NavLink,
  useLocation,
  useNavigate,
  useRouteError,
} from "react-router";
import { Composer } from "./chat/Composer";
import { Timeline } from "./chat/Timeline";
import { Welcome } from "./chat/Welcome";
import { VoiceControls } from "./chat/VoiceControls";
import { ReplyActivity } from "./chat/ReplyActivity";
import { ToolApproval } from "./chat/ToolApproval";
import { ProductStage } from "./chat/ProductStage";
import { CartStage } from "./chat/CartStage";
import { RomanViewContext } from "./chat/views";
import { activeProduct } from "../../shared/active-product";
import type { CatalogProduct } from "../../shared/catalog";
import {
  parseProductChoice,
  productChoiceText,
} from "../../shared/product-choice";
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
  const location = useLocation();
  const navigateView = useNavigate();
  const view =
    location.pathname === "/cart"
      ? "cart"
      : location.pathname === "/gallery"
        ? "gallery"
        : "chat";
  const showView = useCallback(
    (next: "chat" | "cart" | "gallery") => {
      void navigateView(next === "chat" ? "/" : `/${next}`);
    },
    [navigateView],
  );
  const state = useSyncExternalStore(session.subscribe, session.getSnapshot);
  const storefront = useSyncExternalStore(
    navigation.subscribe,
    navigation.getSnapshot,
  );
  const viewport = useRef<HTMLDivElement>(null);
  const conversationView = useRef<HTMLDivElement>(null);
  const following = useRef(true);
  const manualScroll = useRef(false);
  const [questionDock, setQuestionDock] = useState<HTMLDivElement | null>(null);
  const [readingHistory, setReadingHistory] = useState(false);
  const messages = useMemo(
    () =>
      state.optimisticMessage
        ? [...(state.conversation?.messages ?? []), state.optimisticMessage]
        : state.conversation?.messages,
    [state.conversation?.messages, state.optimisticMessage],
  );
  // Voice lifecycle events and Roman's opening are still the welcome state.
  // An optimistic text/tile reply counts immediately, as does customer speech.
  const hasCustomerReply = !!messages?.some(
    (message) =>
      message.role === "user" &&
      message.parts.some(
        (part) =>
          (part.type === "text" || part.type === "voice") && !!part.text.trim(),
      ),
  );
  const selectedProduct = activeProduct(state.conversation);
  const displayedWidgets = useRef<{
    conversationId?: string;
    ids: Set<string>;
  }>({ ids: new Set() });
  useEffect(() => {
    const conversationId = state.conversation?.id;
    const ids = new Set(
      (state.conversation?.messages ?? []).flatMap((message) =>
        message.parts.flatMap((part) =>
          part.type === "products" ||
          (part.type === "question" && part.measurement)
            ? [part.invocationId]
            : [],
        ),
      ),
    );
    const previous = displayedWidgets.current;
    displayedWidgets.current = { conversationId, ids };
    // A new visual result must be visible even when voice continues from Cart
    // or Gallery. Restoring old widgets or changing tabs never steals focus.
    if (
      conversationId &&
      previous.conversationId === conversationId &&
      [...ids].some((id) => !previous.ids.has(id))
    )
      showView("chat");
  }, [state.conversation, showView]);
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
  const voiceOnly = voiceMode && hasCustomerReply;
  const textBusy =
    ending ||
    answering ||
    sending ||
    voiceOnly ||
    waitingForVoice ||
    voice.status === "stopping" ||
    (voice.status === "error" && voice.muted) ||
    state.pending ||
    state.restoring ||
    !!state.conversation?.busy;
  const previousVoiceMode = useRef(voiceOnly);
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
    showView("chat");
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
      showView("chat");
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

  async function chooseProduct(carouselId: string, product: CatalogProduct) {
    const current = session.getSnapshot();
    if (
      answeringRef.current ||
      sendingRef.current ||
      endingRef.current ||
      current.pending ||
      current.restoring ||
      current.conversation?.busy
    )
      throw new Error("Wait for Roman's current reply.");
    const choice = parseProductChoice({
      carouselId,
      productId: product.id,
      title: product.title,
      productPath: new URL(product.url, window.location.origin).pathname,
    });
    answeringRef.current = true;
    setAnswering(true);
    following.current = true;
    try {
      if (current.voice.status === "active")
        await session.sendVoiceProductChoice(carouselId, product);
      else if (localVoice || waitingForVoice)
        throw new Error(
          "Wait until voice is connected before choosing a blind.",
        );
      else await session.sendMessage(productChoiceText(choice), choice);
    } finally {
      answeringRef.current = false;
      setAnswering(false);
    }
  }

  useEffect(() => onReady(), [onReady]);

  useLayoutEffect(() => {
    if (previousVoiceMode.current === voiceOnly) return;
    previousVoiceMode.current = voiceOnly;
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
        voiceOnly
          ? ".roman-voice-composer button:not(:disabled)"
          : ".roman-composer textarea",
      )
      ?.focus({ preventScroll: true });
  }, [voiceOnly]);

  const followConversation = useCallback(() => {
    const scroll = viewport.current;
    if (hasCustomerReply && following.current && scroll) {
      manualScroll.current = false;
      scroll.scrollTop = scroll.scrollHeight;
    }
  }, [hasCustomerReply]);

  useLayoutEffect(() => {
    if (!viewport.current || !window.ResizeObserver) return;
    const observer = new ResizeObserver(followConversation);
    observer.observe(viewport.current);
    return () => observer.disconnect();
  }, [followConversation]);

  useLayoutEffect(followConversation, [
    messages,
    toolsOpen,
    view,
    followConversation,
  ]);

  return (
    <RomanViewContext.Provider value={showView}>
      <div className="roman-content roman-chat">
        <div
          ref={conversationView}
          className="roman-conversation"
          hidden={toolsOpen}
        >
          <header className="roman-chat-header">
            <div className="roman-header-brand">
              <img
                src={logoUrl}
                alt="Roman by SelectBlinds"
                width={121}
                height={50}
              />
            </div>
            <nav className="roman-view-nav" aria-label="Roman views">
              <NavLink to="/" end>
                Chat
              </NavLink>
              <NavLink to="/cart">Cart</NavLink>
              <NavLink to="/gallery">Gallery</NavLink>
            </nav>
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
          </header>
          <div className="roman-workspace">
            {selectedProduct && (
              <ProductStage
                navigation={navigation}
                selectedPath={selectedProduct.path}
                selectedTitle={selectedProduct.title}
                hidden={view !== "chat"}
              />
            )}
            <div className="roman-dialogue">
              {view !== "chat" && (
                <div className="roman-secondary-view">
                  <CartStage
                    navigation={navigation}
                    session={session}
                    visible={view === "cart"}
                  />
                  {view === "gallery" && (
                    <section
                      className="roman-gallery"
                      aria-label="Your gallery"
                    >
                      <span className="roman-stage-eyebrow">
                        Your home, imagined
                      </span>
                      <h1>Your gallery</h1>
                      <p>
                        Your room photos and Roman’s visualizations will live
                        here.
                      </p>
                      <p className="roman-gallery-note">
                        Photo uploads and visualizations are coming soon.
                      </p>
                    </section>
                  )}
                </div>
              )}
              <div
                ref={viewport}
                className="roman-chat-scroll"
                hidden={view !== "chat"}
                tabIndex={0}
                role="region"
                aria-label="Conversation history"
                onWheel={(event) => {
                  if (event.deltaY) manualScroll.current = true;
                }}
                onTouchMove={() => {
                  manualScroll.current = true;
                }}
                onPointerDown={(event) => {
                  if (event.target === event.currentTarget)
                    manualScroll.current = true;
                }}
                onKeyDown={(event) => {
                  if (
                    event.target === event.currentTarget &&
                    [
                      "ArrowUp",
                      "ArrowDown",
                      "PageUp",
                      "PageDown",
                      "Home",
                      "End",
                      " ",
                    ].includes(event.key)
                  )
                    manualScroll.current = true;
                }}
                onScroll={(event) => {
                  const scroll = event.currentTarget;
                  const atBottom =
                    scroll.scrollHeight -
                      scroll.scrollTop -
                      scroll.clientHeight <
                    48;
                  if (atBottom) following.current = true;
                  else if (manualScroll.current) following.current = false;
                  manualScroll.current = false;
                  setReadingHistory(!following.current);
                }}
              >
                {state.restoring ? (
                  <p className="roman-chat-restoring" role="status">
                    Restoring your conversation…
                  </p>
                ) : hasCustomerReply ? (
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
                    questionDock={questionDock}
                    onChooseProduct={chooseProduct}
                  />
                ) : (
                  <Welcome
                    logoUrl={logoUrl}
                    busy={textBusy}
                    onStart={(text) => void startTopic(text)}
                  />
                )}
                {hasCustomerReply && (
                  <ReplyActivity
                    state={state}
                    ending={ending}
                    onContentChange={followConversation}
                  />
                )}
              </div>
              {view !== "chat" && (
                <ReplyActivity
                  state={state}
                  ending={ending}
                  onContentChange={followConversation}
                />
              )}
              {view === "chat" && readingHistory && hasCustomerReply && (
                <button
                  className="roman-return-current"
                  type="button"
                  onClick={() => {
                    following.current = true;
                    setReadingHistory(false);
                    followConversation();
                  }}
                >
                  Back to the conversation <span aria-hidden="true">↓</span>
                </button>
              )}
              <div
                className="roman-response-dock"
                ref={setQuestionDock}
                aria-live={voiceMode ? "off" : "polite"}
                aria-relevant="additions text"
              />
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
                hidden={voiceOnly}
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
          </div>
        </div>
        {showTools && (
          <ToolDrawer
            tools={tools}
            open={toolsOpen}
            onOpenChange={setToolsOpen}
          >
            <VoiceChoice session={session} disabled={ending} />
          </ToolDrawer>
        )}
      </div>
    </RomanViewContext.Provider>
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
        path: "*",
        element: <Assistant {...props} />,
        errorElement: <AssistantError onError={props.onError} />,
      },
    ],
    { initialEntries: ["/"] },
  );
}

import {
  useCallback,
  useEffect,
  useId,
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
  useLocation,
  useNavigate,
  useRouteError,
} from "react-router";
import { Composer } from "./chat/Composer";
import { AssistantHeader } from "./chat/AssistantHeader";
import { Timeline } from "./chat/Timeline";
import { Welcome } from "./chat/Welcome";
import { VoiceControls } from "./chat/VoiceControls";
import { ReplyActivity } from "./chat/ReplyActivity";
import { ToolApproval } from "./chat/ToolApproval";
import { ProductStage } from "./chat/ProductStage";
import { CartStage } from "./chat/CartStage";
import { EndChatDialog } from "./chat/EndChatDialog";
import { BrandedDialog } from "./chat/BrandedDialog";
import { CartAddedDialog } from "./chat/CartAddedDialog";
import { useCart } from "./chat/useCart";
import { useMessageQueue } from "./chat/useMessageQueue";
import { MessageQueue } from "./chat/MessageQueue";
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
  const cart = useCart(navigation, session);
  const cartCount = !cart.error ? cart.cart?.itemCount : undefined;
  const viewport = useRef<HTMLDivElement>(null);
  const scrollPositions = useRef({ chat: 0, cart: 0, gallery: 0 });
  const following = useRef(true);
  const manualScroll = useRef(false);
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
  const [confirmEnd, setConfirmEnd] = useState(false);
  const [microphoneDenied, setMicrophoneDenied] = useState(false);
  const endingRef = useRef(false);
  const [endError, setEndError] = useState<string | null>(null);
  const [chatVersion, setChatVersion] = useState(0);
  const [toolsOpen, setToolsOpen] = useState(false);
  const toolsId = useId();
  const settingsReturn = useRef<HTMLButtonElement | null>(null);
  const wasToolsOpen = useRef(false);
  useLayoutEffect(() => {
    if (wasToolsOpen.current && !toolsOpen && settingsReturn.current) {
      const trigger = settingsReturn.current.isConnected
        ? settingsReturn.current
        : viewport.current
            ?.closest(".roman-content")
            ?.querySelector<HTMLButtonElement>(
              ".roman-menu-toggle, .roman-settings-trigger",
            );
      trigger?.focus({ preventScroll: true });
      settingsReturn.current = null;
    }
    wasToolsOpen.current = toolsOpen;
  }, [toolsOpen]);
  const [answering, setAnswering] = useState(false);
  const answeringRef = useRef(false);
  const [startError, setStartError] = useState<string | null>(null);
  const startingTopic = useRef(false);
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
  const messageQueue = useMessageQueue(
    session,
    ending || confirmEnd || answering,
  );
  const textBusy = ending || answering || messageQueue.busy;
  const chatError = state.error || startError || endError;
  const activeQuestion =
    state.conversation?.status === "active"
      ? latestQuestion(messages ?? [], storefront.url)
      : undefined;

  async function sendMessage(text: string) {
    if (endingRef.current || state.restoring || confirmEnd)
      throw new Error("Wait until your conversation is ready.");
    setStartError(null);
    showView("chat");
    following.current = true;
    messageQueue.enqueue(text);
  }

  async function startVoice() {
    setStartError(null);
    try {
      await session.startVoice();
    } catch (error) {
      // Autostart calls the session directly. Only a deliberate button press
      // opens this explanation; other voice errors remain visible in the bar.
      const failedVoice = session.getSnapshot().voice;
      if (failedVoice.errorCode === "microphone_denied")
        setMicrophoneDenied(true);
      else if (!failedVoice.error)
        setStartError(
          error instanceof Error
            ? error.message
            : "Voice could not start. Please try again.",
        );
    }
  }

  async function startTopic(text: string) {
    if (
      startingTopic.current ||
      endingRef.current ||
      state.restoring ||
      confirmEnd
    )
      return;
    startingTopic.current = true;
    try {
      await sendMessage(text);
    } catch (error) {
      setStartError(
        error instanceof Error
          ? error.message
          : "Your message could not be sent. Please retry.",
      );
    } finally {
      startingTopic.current = false;
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
      messageQueue.hasMessages() ||
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
      messageQueue.clear();
      setConfirmEnd(false);
      settingsReturn.current = null;
      setToolsOpen(false);
      scrollPositions.current.chat = 0;
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
      endingRef.current ||
      current.restoring ||
      confirmEnd ||
      current.approval ||
      microphoneDenied ||
      toolsOpen ||
      current.conversation?.status !== "active"
    )
      throw new Error("Wait until your conversation is ready.");
    const url = new URL(product.url, window.location.origin);
    if (url.origin !== window.location.origin || url.username || url.password)
      throw new Error("Choose a product from this storefront.");
    const choice = parseProductChoice({
      carouselId,
      productId: product.id,
      title: product.title,
      productPath: url.pathname,
    });
    setStartError(null);
    showView("chat");
    following.current = true;
    messageQueue.enqueue(productChoiceText(choice), choice);
  }

  useEffect(() => onReady(), [onReady]);

  const followConversation = useCallback(() => {
    const scroll = viewport.current;
    if (view === "chat" && hasCustomerReply && following.current && scroll) {
      manualScroll.current = false;
      scroll.scrollTop = scroll.scrollHeight;
    }
  }, [hasCustomerReply, view]);

  useLayoutEffect(() => {
    const scroll = viewport.current;
    if (scroll) scroll.scrollTop = scrollPositions.current[view];
  }, [view]);

  useLayoutEffect(() => {
    if (!viewport.current || !window.ResizeObserver) return;
    const observer = new ResizeObserver(followConversation);
    observer.observe(viewport.current);
    const history = viewport.current.querySelector(".roman-chat-history");
    if (history) observer.observe(history);
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
        <AssistantHeader
          logoUrl={logoUrl}
          cartCount={cartCount}
          hasConversation={state.conversation?.status === "active"}
          endDisabled={ending || answering || state.pending || state.restoring}
          ending={ending}
          onEnd={() => {
            setEndError(null);
            setConfirmEnd(true);
          }}
          showSettings={showTools}
          settingsOpen={toolsOpen}
          settingsId={toolsId}
          onSettings={(trigger) => {
            settingsReturn.current = trigger;
            setToolsOpen((open) => !open);
          }}
          onNavigate={() => {
            settingsReturn.current = null;
            setToolsOpen(false);
          }}
        />
        <div className="roman-conversation" hidden={toolsOpen}>
          <div className="roman-workspace">
            {selectedProduct && (
              <ProductStage
                key={selectedProduct.path}
                session={session}
                navigation={navigation}
                selectedPath={selectedProduct.path}
                selectedTitle={selectedProduct.title}
                hidden={view !== "chat" || toolsOpen}
                onMessage={sendMessage}
                disabled={ending || state.restoring || confirmEnd}
              />
            )}
            <div className="roman-dialogue">
              <div
                ref={viewport}
                className="roman-chat-scroll"
                tabIndex={0}
                role="region"
                aria-label={
                  view === "chat" ? "Conversation history" : `Roman ${view}`
                }
                onWheel={(event) => {
                  if (view === "chat" && event.deltaY)
                    manualScroll.current = true;
                }}
                onTouchMove={() => {
                  if (view === "chat") manualScroll.current = true;
                }}
                onPointerDown={(event) => {
                  if (view === "chat" && event.target === event.currentTarget)
                    manualScroll.current = true;
                }}
                onKeyDown={(event) => {
                  if (
                    view === "chat" &&
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
                  scrollPositions.current[view] = scroll.scrollTop;
                  if (view !== "chat") return;
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
                {view !== "chat" && (
                  <div className="roman-secondary-view">
                    {view === "cart" && <CartStage {...cart} />}
                    {view === "gallery" && (
                      <section
                        className="roman-gallery"
                        aria-label="Your gallery"
                      >
                        <h2>Your gallery</h2>
                        <p>
                          Your room photos and Roman’s visualizations will live
                          here.
                        </p>
                      </section>
                    )}
                  </div>
                )}
                <div className="roman-chat-history" hidden={view !== "chat"}>
                  {state.restoring ? (
                    <p className="roman-chat-restoring" role="status">
                      Restoring your conversation…
                    </p>
                  ) : hasCustomerReply || messageQueue.messages.length > 0 ? (
                    <Timeline
                      messages={messages ?? []}
                      session={session}
                      navigation={navigation}
                      onContentChange={followConversation}
                      activeQuestionId={activeQuestion?.invocationId}
                      productsDisabled={
                        ending ||
                        confirmEnd ||
                        !!state.approval ||
                        microphoneDenied ||
                        toolsOpen ||
                        state.conversation?.status !== "active"
                      }
                      questionDisabled={
                        ending ||
                        answering ||
                        messageQueue.messages.length > 0 ||
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
                      onChooseProduct={chooseProduct}
                    />
                  ) : (
                    <Welcome
                      logoUrl={logoUrl}
                      busy={ending || state.restoring || confirmEnd}
                      onStart={(text) => void startTopic(text)}
                    />
                  )}
                </div>
                {(hasCustomerReply || view !== "chat") && (
                  <ReplyActivity
                    state={state}
                    ending={ending}
                    onContentChange={followConversation}
                  />
                )}
              </div>
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
              {state.approval && (
                <ToolApproval approval={state.approval} session={session} />
              )}
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
                busy={textBusy}
                disabled={ending || state.restoring || confirmEnd}
                queuedMessages={
                  <MessageQueue
                    messages={messageQueue.messages}
                    onRemove={messageQueue.remove}
                    onRetry={messageQueue.retry}
                  />
                }
                voiceControls={
                  voiceMode ? (
                    <VoiceControls
                      session={session}
                      voice={voice}
                      waiting={waitingForVoice}
                    />
                  ) : undefined
                }
                error={
                  chatError ||
                  (voice.errorCode !== "microphone_denied" ? voice.error : null)
                }
                onClearError={
                  chatError
                    ? () => {
                        setEndError(null);
                        setStartError(null);
                        session.clearError();
                      }
                    : undefined
                }
                onSend={sendMessage}
                onStartVoice={
                  !localVoice && !waitingForVoice ? startVoice : undefined
                }
              />
            </div>
          </div>
        </div>
        <CartAddedDialog
          conversation={state.conversation}
          restoring={state.restoring}
          blocked={
            confirmEnd ||
            ending ||
            microphoneDenied ||
            !!state.approval ||
            toolsOpen
          }
          onViewCart={() => showView("cart")}
          onKeepShopping={sendMessage}
        />
        {confirmEnd && (
          <EndChatDialog
            pending={ending}
            error={endError}
            onCancel={() => setConfirmEnd(false)}
            onConfirm={() => void endChat()}
          />
        )}
        {microphoneDenied && (
          <BrandedDialog
            title="Microphone access is off"
            description="Allow microphone access in your browser’s site settings, then choose Start voice again. You can keep chatting by text."
            onClose={() => setMicrophoneDenied(false)}
            returnFocus="[data-roman-start-voice]"
          >
            <button
              type="button"
              className="roman-dialog-primary"
              onClick={() => setMicrophoneDenied(false)}
            >
              Got it
            </button>
          </BrandedDialog>
        )}
        {showTools && (
          <ToolDrawer
            id={toolsId}
            tools={tools}
            open={toolsOpen}
            onClose={() => setToolsOpen(false)}
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

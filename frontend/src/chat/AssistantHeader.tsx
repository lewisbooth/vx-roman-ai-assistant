import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { NavLink } from "react-router";

export function AssistantHeader({
  logoUrl,
  cartCount,
  hasConversation,
  endDisabled,
  ending,
  onEnd,
  showSettings,
  settingsOpen,
  settingsId,
  onSettings,
  onNavigate,
}: {
  logoUrl: string;
  cartCount?: number;
  hasConversation: boolean;
  endDisabled: boolean;
  ending: boolean;
  onEnd: () => void;
  showSettings: boolean;
  settingsOpen: boolean;
  settingsId: string;
  onSettings: (trigger: HTMLButtonElement) => void;
  onNavigate: () => void;
}) {
  const [mobile, setMobile] = useState(
    () => window.matchMedia?.("(max-width: 767px)").matches ?? false,
  );
  const [menuOpen, setMenuOpen] = useState(false);
  const header = useRef<HTMLElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const toggle = useRef<HTMLButtonElement>(null);
  const id = useId();

  useEffect(() => {
    const media = window.matchMedia?.("(max-width: 767px)");
    if (!media) return;
    const update = () => {
      setMobile(media.matches);
      setMenuOpen(false);
    };
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);

  useLayoutEffect(() => {
    if (menuOpen)
      menu.current
        ?.querySelector<HTMLButtonElement>("button:not(:disabled)")
        ?.focus();
  }, [menuOpen]);

  useEffect(() => {
    if (!menuOpen) return;
    const element = header.current!;
    const document = element.ownerDocument;
    const root = element.getRootNode();
    const outside = (event: Event) => {
      const path = event.composedPath();
      if (!path.includes(menu.current!) && !path.includes(toggle.current!))
        setMenuOpen(false);
    };
    const dismiss = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      setMenuOpen(false);
      toggle.current?.focus({ preventScroll: true });
    };
    document.addEventListener("pointerdown", outside, true);
    document.addEventListener("focusin", outside, true);
    if (root !== document) root.addEventListener("focusin", outside, true);
    element.addEventListener("keydown", dismiss);
    return () => {
      document.removeEventListener("pointerdown", outside, true);
      document.removeEventListener("focusin", outside, true);
      if (root !== document) root.removeEventListener("focusin", outside, true);
      element.removeEventListener("keydown", dismiss);
    };
  }, [menuOpen]);

  const logo = (
    <img src={logoUrl} alt="Roman by SelectBlinds" width={121} height={50} />
  );
  const endButton = hasConversation && (
    <button
      type="button"
      className="roman-end-chat"
      disabled={endDisabled}
      onClick={(event) => {
        // The native confirmation dialog must capture a trigger that will
        // still be visible after this dropdown closes.
        (mobile ? toggle.current : event.currentTarget)?.focus({
          preventScroll: true,
        });
        setMenuOpen(false);
        onEnd();
      }}
    >
      {ending ? "Ending…" : "End chat"}
    </button>
  );
  const settingsButton = showSettings && (
    <button
      type="button"
      className="roman-settings-trigger"
      aria-label="Settings"
      aria-expanded={settingsOpen}
      aria-controls={settingsId}
      onClick={(event) => {
        const trigger = mobile ? toggle.current! : event.currentTarget;
        trigger.focus({ preventScroll: true });
        setMenuOpen(false);
        onSettings(trigger);
      }}
    >
      Settings
    </button>
  );
  function navigate() {
    setMenuOpen(false);
    onNavigate();
  }

  return (
    <header ref={header} className="roman-chat-header">
      {mobile ? (
        <>
          <button
            ref={toggle}
            type="button"
            className="roman-menu-toggle"
            aria-label="Roman menu"
            aria-expanded={menuOpen}
            aria-controls={id}
            onClick={() => setMenuOpen((value) => !value)}
            onKeyDown={(event) => {
              if (event.key === "ArrowDown") {
                event.preventDefault();
                setMenuOpen(true);
              }
            }}
          >
            <svg
              width="22"
              height="22"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.7"
              strokeLinecap="round"
              aria-hidden="true"
            >
              <path d="M4 6h16M4 12h16M4 18h16" />
            </svg>
          </button>
          <div
            ref={menu}
            id={id}
            className="roman-header-menu"
            role="group"
            aria-label="Roman actions"
            hidden={!menuOpen}
          >
            {logo}
            {endButton}
            {settingsButton}
          </div>
        </>
      ) : (
        <div className="roman-header-brand">{logo}</div>
      )}
      <nav className="roman-view-nav" aria-label="Roman views">
        <NavLink to="/" end onClick={navigate}>
          Chat
        </NavLink>
        <NavLink to="/cart" onClick={navigate}>
          Cart
          {!!cartCount && (
            <span
              className="roman-cart-count"
              aria-label={`${cartCount} ${cartCount === 1 ? "item" : "items"}`}
            >
              {cartCount}
            </span>
          )}
        </NavLink>
        <NavLink to="/gallery" onClick={navigate}>
          Gallery
        </NavLink>
      </nav>
      {!mobile && (
        <div className="roman-header-actions">
          {endButton}
          {settingsButton}
        </div>
      )}
    </header>
  );
}

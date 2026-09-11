(() => {
  let loading = false;

  function loadAssistant() {
    if (loading || customElements.get("roman-ai-assistant")) return;

    const embed = document.querySelector("roman-ai-assistant");
    if (!embed?.dataset.scriptUrl) return;

    loading = true;
    const script = document.createElement("script");
    script.src = embed.dataset.scriptUrl;
    script.async = true;
    script.onerror = () => {
      loading = false;
      script.remove();
      console.error("Roman AI Assistant could not load.");
    };
    document.head.append(script);
  }

  function scheduleAssistant() {
    if ("requestIdleCallback" in window) {
      window.requestIdleCallback(loadAssistant, { timeout: 1500 });
    } else {
      window.setTimeout(loadAssistant, 0);
    }
  }

  document.addEventListener("shopify:section:load", scheduleAssistant);
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", scheduleAssistant, {
      once: true,
    });
  } else {
    scheduleAssistant();
  }
})();

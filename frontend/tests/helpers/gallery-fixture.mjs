/** Keep unrelated app tests explicit about the independently bootstrapped image feature. */
export function installGalleryFixture(window, { enabled = false } = {}) {
  const previous = window.fetch;
  const baseUrl = window.location.href;
  const ownerId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const gallery = { enabled, liveWindowIds: [], liveVisualizationIds: [], windows: [], visualizations: [], nextWindowsCursor: null, nextVisualizationsCursor: null };
  window.fetch = async (url, options) => {
    const path = new URL(String(url), baseUrl).pathname;
    if (path === "/apps/roman/gallery") return new Response(JSON.stringify({
      credential: { ownerId, token: "a".repeat(43), apiBaseUrl: "https://roman.example/api/gallery" }, gallery,
    }), { status: 200, headers: { "Content-Type": "application/json" } });
    if (path.startsWith(`/api/gallery/${ownerId}/`)) return new Response(JSON.stringify(path.endsWith("/list") ? gallery : {}), { status: 200, headers: { "Content-Type": "application/json" } });
    return previous?.(url, options);
  };
}

export const mediaSessionFixture = {
  ensureMediaConversation: async () => ({ conversationId: "conversation", conversationToken: "test-token" }),
  refreshMediaContext: async () => {},
};

import { authenticate } from "../shopify.server";
import { authorizeCredential } from "./repository.server";
import { ConversationError } from "./errors.server";
import {
  CONVERSATION_STOREFRONTS,
  isConversationStorefront,
  isConversationStorefrontForShop,
} from "../../shared/storefronts";

const developmentShops = new Set(Object.keys(CONVERSATION_STOREFRONTS));
const creationWindows = new Map<string, { startedAt: number; count: number }>();

export const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export function allowedOrigin(request: Request): string | undefined {
  const origin = request.headers.get("Origin");
  return origin && isConversationStorefront(origin) ? origin : undefined;
}

export async function authenticateBootstrap(request: Request) {
  let context;
  try {
    context = await authenticate.public.appProxy(request);
  } catch (error) {
    if (error instanceof Response)
      throw new ConversationError(401, "Storefront authorization failed.");
    throw error;
  }
  const session = context.session;
  const signedShop = new URL(request.url).searchParams.get("shop");
  if (
    !session ||
    session.isOnline ||
    !session.accessToken ||
    session.shop !== signedShop ||
    !developmentShops.has(session.shop) ||
    !session.scope
      ?.split(",")
      .map((scope) => scope.trim())
      .includes("write_app_proxy")
  )
    throw new ConversationError(
      401,
      "Open Roman in Shopify admin to approve its permissions, then refresh the storefront.",
    );
  const suppliedOrigin = request.headers.get("Origin");
  // App proxies can omit Origin. The browser supplies its origin in the query
  // Shopify signs; it must still belong to that authenticated permanent shop.
  const origin =
    new URL(request.url).searchParams.get("storefront_origin") ??
    suppliedOrigin ??
    `https://${session.shop}`;
  if (
    !isConversationStorefrontForShop(session.shop, origin) ||
    (suppliedOrigin !== null && suppliedOrigin !== origin)
  )
    throw new ConversationError(401, "Storefront origin does not match.");
  return { shop: session.shop, origin };
}

export function throttleConversationCreation(shop: string) {
  if (!developmentShops.has(shop))
    throw new ConversationError(
      401,
      "This storefront is not authorized for Roman chat.",
    );
  const now = Date.now();
  let window = creationWindows.get(shop);
  if (!window || now - window.startedAt >= 10 * 60 * 1000) {
    window = { startedAt: now, count: 0 };
    creationWindows.set(shop, window);
  }
  if (window.count >= 20)
    throw new ConversationError(
      429,
      "Too many new conversations. Please try again later.",
    );
  window.count++;
}

export async function authorizeStorefrontCredential(
  id: string,
  token: string,
  origin: string,
  shop?: string,
) {
  if (!UUID_PATTERN.test(id) || !TOKEN_PATTERN.test(token))
    throw new ConversationError(401, "Conversation authorization failed.");
  const credential = await authorizeCredential(id, token);
  if (
    !developmentShops.has(credential.shop) ||
    credential.origin !== origin ||
    !isConversationStorefrontForShop(credential.shop, origin) ||
    (shop !== undefined && credential.shop !== shop)
  )
    throw new ConversationError(401, "Conversation authorization failed.");
  return credential;
}

export async function authenticateConversation(request: Request, id?: string) {
  const origin = allowedOrigin(request);
  const authorization = request.headers.get("Authorization");
  const token = authorization?.match(/^Bearer ([A-Za-z0-9_-]{43})$/i)?.[1];
  if (!origin || !id || !token)
    throw new ConversationError(401, "Conversation authorization failed.");
  return authorizeStorefrontCredential(id, token, origin);
}

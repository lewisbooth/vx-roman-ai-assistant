import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import prisma from "../db.server";
import { allowedOrigin, authorizeStorefrontCredential } from "../conversations/auth.server";
import { ConversationError } from "../conversations/errors.server";
import { isMediaId } from "../../shared/visualizations";
import { isConversationStorefrontForShop } from "../../shared/storefronts";

export const galleryTokenHash = (token: string) => createHash("sha256").update(token).digest("hex");
export type GalleryIdentity = { id: string; shop: string; origin: string };
const creationWindows = new Map<string, { startedAt: number; count: number }>();
export async function createGalleryOwner(shop: string, origin: string) {
  if (!isConversationStorefrontForShop(shop, origin)) throw new ConversationError(401, "Gallery authorization failed.");
  const now = Date.now();
  let window = creationWindows.get(shop);
  if (!window || now - window.startedAt >= 10 * 60 * 1000) {
    window = { startedAt: now, count: 0 };
    creationWindows.set(shop, window);
  }
  if (window.count >= 20) throw new ConversationError(429, "Too many new galleries. Please try again later.");
  window.count++;
  const token = randomBytes(32).toString("base64url");
  const owner = await prisma.galleryOwner.create({ data: { id: randomUUID(), shop, origin, tokenHash: galleryTokenHash(token) } });
  return { ownerId: owner.id, token, apiBaseUrl: `${new URL(process.env.SHOPIFY_APP_URL!).origin}/api/gallery` };
}
export async function authorizeGallery(id: string, token: string, origin: string, shop?: string): Promise<GalleryIdentity> {
  if (!isMediaId(id) || !/^[A-Za-z0-9_-]{43}$/.test(token)) throw new ConversationError(401, "Gallery authorization failed.");
  const owner = await prisma.galleryOwner.findUnique({ where: { id } });
  const valid = timingSafeEqual(Buffer.from(galleryTokenHash(token), "hex"), Buffer.from(owner?.tokenHash ?? "0".repeat(64), "hex"));
  if (!valid || !owner || owner.revokedAt || owner.origin !== origin || (shop && owner.shop !== shop) || !isConversationStorefrontForShop(owner.shop, origin))
    throw new ConversationError(401, "Gallery authorization failed.");
  const installation = await prisma.session.findFirst({ where: { shop: owner.shop, isOnline: false }, select: { accessToken: true, scope: true } });
  if (!installation?.accessToken || !installation.scope?.split(",").includes("write_app_proxy"))
    throw new ConversationError(401, "Gallery authorization failed.");
  if (owner.lastSeenAt.getTime() < Date.now() - 86_400_000) await prisma.galleryOwner.update({ where: { id }, data: { lastSeenAt: new Date() } });
  return { id, shop: owner.shop, origin };
}
export async function authenticateGallery(request: Request, id?: string) {
  const origin = allowedOrigin(request);
  const token = request.headers.get("Authorization")?.match(/^Bearer ([A-Za-z0-9_-]{43})$/i)?.[1];
  if (!id || !origin || !token) throw new ConversationError(401, "Gallery authorization failed.");
  return authorizeGallery(id, token, origin);
}
export async function linkGalleryConversation(owner: GalleryIdentity, id: string, token: string) {
  await authorizeStorefrontCredential(id, token, owner.origin, owner.shop);
  const linked = await prisma.conversation.updateMany({ where: { id, status: "active", OR: [{ galleryOwnerId: null }, { galleryOwnerId: owner.id }] }, data: { galleryOwnerId: owner.id } });
  if (!linked.count) throw new ConversationError(409, "This chat is linked to a different gallery or has ended.");
  return id;
}

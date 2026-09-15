import { randomUUID } from "node:crypto";
import type { Prisma, MeasurementDraft as StoredDraft } from "@prisma/client";
import {
  parseMeasurementCall,
  parseMeasurementDraft,
  parseMeasurementToolResult,
  type MeasurementCall,
  type MeasurementDraft,
  type MeasurementInput,
  type MeasurementToolResult,
} from "../../shared/measurements";
import { parseProductPath } from "../../shared/product-path";
import prisma from "../db.server";
import { ConversationError } from "../conversations/errors.server";

const processStartedAt = new Date();
const maxProductDrafts = 20;
const maxManualWrites = 200;
const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function parseCall(name: string, args: unknown): MeasurementCall {
  try {
    return parseMeasurementCall(name, args);
  } catch (error) {
    throw new ConversationError(
      400,
      error instanceof Error ? error.message : "Invalid measurements.",
    );
  }
}

async function requireActive(
  transaction: Prisma.TransactionClient,
  conversationId: string,
) {
  const conversation = await transaction.conversation.findUnique({
    where: { id: conversationId },
    select: { status: true, pendingRequestId: true },
  });
  if (!conversation)
    throw new ConversationError(404, "This conversation could not be found.");
  if (conversation.status !== "active")
    throw new ConversationError(
      409,
      "This conversation has ended. Start a new chat to save measurements.",
    );
  return conversation;
}

function projectDraft(row: StoredDraft): MeasurementDraft {
  return parseMeasurementDraft({
    productPath: row.productPath,
    width: row.width,
    height: row.height,
    unit: row.unit,
    kind: row.kind,
    mount: row.mount,
    updatedAt: row.updatedAt.toISOString(),
  });
}

async function readDraft(
  transaction: Prisma.TransactionClient,
  conversationId: string,
  productPath: string,
) {
  const row = await transaction.measurementDraft.findUnique({
    where: { conversationId_productPath: { conversationId, productPath } },
  });
  return row ? projectDraft(row) : null;
}

export async function getMeasurementDraft(
  conversationId: string,
  productPath: string,
): Promise<MeasurementDraft | null> {
  parseProductPath(productPath);
  return prisma.$transaction(async (transaction) => {
    await requireActive(transaction, conversationId);
    return readDraft(transaction, conversationId, productPath);
  });
}

/** Shared write owner: values are neither converted nor adjusted for fitting. */
async function writeDraft(
  transaction: Prisma.TransactionClient,
  conversationId: string,
  input: MeasurementInput,
): Promise<MeasurementDraft> {
  const previous = await readDraft(
    transaction,
    conversationId,
    input.productPath,
  );
  if (
    !previous &&
    (await transaction.measurementDraft.count({ where: { conversationId } })) >=
      maxProductDrafts
  )
    throw new ConversationError(
      429,
      "This chat has measurements for 20 products. Start a new chat for another product.",
    );
  // Even same-millisecond edits get a different approval fingerprint.
  const updatedAt = new Date(
    Math.max(Date.now(), previous ? Date.parse(previous.updatedAt) + 1 : 0),
  );
  const row = await transaction.measurementDraft.upsert({
    where: {
      conversationId_productPath: {
        conversationId,
        productPath: input.productPath,
      },
    },
    create: { conversationId, ...input, updatedAt },
    update: { ...input, updatedAt },
  });
  return projectDraft(row);
}

async function executeCall(
  transaction: Prisma.TransactionClient,
  conversationId: string,
  call: MeasurementCall,
): Promise<MeasurementToolResult> {
  if (call.name === "set_measurements")
    return {
      status: "saved",
      draft: await writeDraft(transaction, conversationId, call.arguments),
    };
  const draft = await readDraft(
    transaction,
    conversationId,
    call.arguments.productPath,
  );
  return draft
    ? { status: "found", draft }
    : { status: "not_found", productPath: call.arguments.productPath };
}

/** Authenticated manual tools save without starting an assistant/model turn. */
export async function executeManualMeasurementTool(
  conversationId: string,
  requestId: string,
  name: string,
  args: unknown,
): Promise<MeasurementToolResult> {
  if (!uuidPattern.test(requestId))
    throw new ConversationError(400, "Send a requestId UUID.");
  const call = parseCall(name, args);
  return prisma.$transaction(async (transaction) => {
    await requireActive(transaction, conversationId);
    if (call.name === "get_measurements")
      return executeCall(transaction, conversationId, call);
    const argumentsJson = JSON.stringify(call.arguments);
    const receipt = await transaction.measurementWriteReceipt.findUnique({
      where: { conversationId_requestId: { conversationId, requestId } },
    });
    if (receipt) {
      if (receipt.argumentsJson !== argumentsJson)
        throw new ConversationError(
          400,
          "This measurement request ID already has different dimensions.",
        );
      return parseMeasurementToolResult(JSON.parse(receipt.resultJson));
    }
    if (
      (await transaction.measurementWriteReceipt.count({
        where: { conversationId },
      })) >= maxManualWrites
    )
      throw new ConversationError(
        429,
        "This chat has reached its measurement save limit. Start a new chat to save more.",
      );
    const result = await executeCall(transaction, conversationId, call);
    await transaction.measurementWriteReceipt.create({
      data: {
        conversationId,
        requestId,
        argumentsJson,
        resultJson: JSON.stringify(result),
      },
    });
    await transaction.conversation.update({
      where: { id: conversationId },
      data: { revision: { increment: 1 } },
    });
    return result;
  });
}

/** Completes a server-local model tool and its draft atomically. Never replays a write. */
export async function executeMeasurementTool(
  conversationId: string,
  assistantId: string,
  providerCallId: string,
  name: string,
  args: unknown,
): Promise<MeasurementToolResult> {
  if (!providerCallId || providerCallId.length > 200)
    throw new ConversationError(400, "Invalid measurement call ID.");
  const call = parseCall(name, args);
  const argumentsJson = JSON.stringify(call.arguments);
  return prisma.$transaction(async (transaction) => {
    const conversation = await requireActive(transaction, conversationId);
    const existing = await transaction.toolInvocation.findUnique({
      where: {
        conversationId_providerCallId: { conversationId, providerCallId },
      },
    });
    if (existing) {
      if (
        existing.assistantId !== assistantId ||
        existing.name !== call.name ||
        existing.argumentsJson !== argumentsJson
      )
        throw new ConversationError(
          400,
          "This measurement call ID already has different arguments.",
        );
      if (existing.status !== "complete" || !existing.resultJson)
        throw new ConversationError(
          409,
          "This measurement action cannot be replayed.",
        );
      return parseMeasurementToolResult(JSON.parse(existing.resultJson));
    }
    const assistant = await transaction.conversationMessage.findFirst({
      where: {
        id: assistantId,
        conversationId,
        role: { in: ["assistant", "context"] },
        status: "pending",
        requestId: conversation.pendingRequestId ?? "",
      },
      select: { createdAt: true },
    });
    if (!assistant || assistant.createdAt < processStartedAt)
      throw new ConversationError(
        409,
        "This reply is no longer waiting for measurements.",
      );
    if (
      (await transaction.toolInvocation.count({
        where: { assistantId, conversationId },
      })) >= 8
    )
      throw new ConversationError(
        429,
        "This reply has reached its action limit.",
      );
    const result = await executeCall(transaction, conversationId, call);
    await transaction.toolInvocation.create({
      data: {
        id: randomUUID(),
        conversationId,
        assistantId,
        providerCallId,
        name: call.name,
        argumentsJson,
        status: "complete",
        resultJson: JSON.stringify(result),
        completedAt: new Date(),
      },
    });
    await transaction.conversation.update({
      where: { id: conversationId },
      data: { revision: { increment: 1 } },
    });
    return result;
  });
}

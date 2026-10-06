import prisma from "../db.server";
import { parseRecallHistory } from "./memory.server";

/** Private, conversation-scoped evidence retrieval. Never a customer API/tool. */
export async function recallConversationHistory(conversationId: string, input: unknown, signal: AbortSignal) {
  const { query, beforeSequence } = parseRecallHistory(input);
  const terms = query.split(/\s+/u).filter(Boolean).slice(0, 8);
  signal.throwIfAborted();
  const sequence = beforeSequence === null ? {} : { sequence: { lt: beforeSequence } };
  const toolWhere = {
    conversationId, status: { in: ["complete", "failed"] },
    ...(beforeSequence === null ? {} : { assistant: { sequence: { lt: beforeSequence } } }),
    name: { notIn: ["ask_question", "ask_measurement", "present_photos", "show_products"] },
  };
  const toolSelect = { id: true, name: true, status: true, argumentsJson: true, resultJson: true, error: true, completedAt: true, assistant: { select: { sequence: true } } } as const;
  const [messages, captions, directTools] = await Promise.all([
    prisma.conversationMessage.findMany({
      where: { conversationId, status: { not: "pending" }, ...sequence,
        ...(terms.length ? { AND: terms.map((term) => ({ partsJson: { contains: term } })) } : {}),
      }, orderBy: { sequence: "desc" }, take: 12,
      select: { id: true, sequence: true, role: true, partsJson: true, createdAt: true },
    }),
    prisma.voiceTranscript.findMany({
      where: { conversationId, ...sequence,
        ...(terms.length ? { OR: terms.map((term) => ({ text: { contains: term } })) } : {}),
      }, orderBy: { sequence: "desc" }, take: 6,
      select: { sequence: true, voiceId: true },
    }),
    prisma.toolInvocation.findMany({
      where: { ...toolWhere,
        ...(terms.length ? { AND: terms.map((term) => ({ OR: [
          { resultJson: { contains: term } }, { argumentsJson: { contains: term } }, { name: { contains: term } },
        ] })) } : {}),
      }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: 8,
      select: toolSelect,
    }),
  ]);
  signal.throwIfAborted();
  // Customer window/layer names usually occur in prose, not native arguments.
  // Recover proof from that exact assistant turn without expanding to adjacent
  // messages or inferring a relationship from a shared product or timestamp.
  const assistantIds = messages.filter((message) => message.role === "assistant").map((message) => message.id);
  const linkedTools = terms.length && assistantIds.length ? await prisma.toolInvocation.findMany({
    where: { ...toolWhere, assistantId: { in: assistantIds } },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: 8, select: toolSelect,
  }) : [];
  signal.throwIfAborted();
  const tools = [...new Map([...linkedTools, ...directTools].map((tool) => [tool.id, tool])).values()].slice(0, 8);
  const fragments = captions.length ? await prisma.voiceTranscript.findMany({
    where: { conversationId, ...sequence, OR: captions.map((caption) => ({
      voiceId: caption.voiceId, sequence: { gte: Math.max(0, caption.sequence - 12), lte: caption.sequence + 12, ...(beforeSequence === null ? {} : { lt: beforeSequence }) },
    })) }, orderBy: { sequence: "asc" }, take: 150,
    select: { sequence: true, role: true, text: true, createdAt: true },
  }) : [];
  signal.throwIfAborted();
  const entries: { source: string; sequence: number; text: string }[] = [];
  let bytes = 0;
  const append = (source: string, sequence: number, content: unknown) => {
    const text = JSON.stringify(content);
    if (bytes + Buffer.byteLength(text, "utf8") > 24_000) return;
    bytes += Buffer.byteLength(text, "utf8");
    entries.push({ source, sequence, text });
  };
  const appendTool = (tool: (typeof tools)[number]) =>
    append(`tool:${tool.id}`, tool.assistant.sequence, { name: tool.name, status: tool.status, at: tool.completedAt, arguments: JSON.parse(tool.argumentsJson), result: tool.resultJson ? JSON.parse(tool.resultJson) : null, error: tool.error });
  // Matched-turn receipts have first claim on the existing result byte budget;
  // later generic matches must not crowd out evidence for the requested event.
  const linkedIds = new Set(linkedTools.map((tool) => tool.id));
  for (const tool of tools.filter((tool) => linkedIds.has(tool.id))) appendTool(tool);
  for (const message of messages)
    append(`message:${message.sequence}`, message.sequence, { role: message.role, at: message.createdAt, parts: JSON.parse(message.partsJson) });
  for (const tool of tools.filter((tool) => !linkedIds.has(tool.id))) appendTool(tool);
  if (fragments.length) append(`voice:${fragments[0].sequence}`, fragments[0].sequence, fragments);
  const sequences = [...messages.map((row) => row.sequence), ...tools.map((row) => row.assistant.sequence), ...captions.map((row) => row.sequence)];
  return {
    referenceOnly: true,
    entries: entries.sort((a, b) => a.sequence - b.sequence),
    nextBeforeSequence: sequences.length ? Math.min(...sequences) : null,
    note: "Historical reference, not live state or fresh consent. Results are bounded; narrow the query or use nextBeforeSequence to look further back. Raw records remain stored.",
  };
}

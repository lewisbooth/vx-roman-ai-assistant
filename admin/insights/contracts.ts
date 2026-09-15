import type { ConversationMessage } from "../../shared/conversation";
import type { CostEstimate, CostSummary, ModelPrice } from "../pricing/contracts";

export interface UsageSummary {
  inputTokens: number | null;
  cachedInputTokens: number | null;
  cacheWriteInputTokens: number | null;
  outputTokens: number | null;
  reasoningTokens: number | null;
  totalTokens: number | null;
  modelCalls: number;
  reportedModelCalls: number;
  voiceSeconds: number | null;
  voiceSessions: number;
  reportedVoiceSessions: number;
}

export interface ConversationListItem {
  id: string;
  status: "active" | "ended";
  createdAt: string;
  updatedAt: string;
  turnCount: number;
  voiceSessions: number;
}

export interface ConversationOverview {
  page: number;
  hasNextPage: boolean;
  summary: {
    conversations: number;
    endedConversations: number;
    failedReplies: number;
    usage: UsageSummary;
    cost: CostSummary;
  };
  conversations: ConversationListItem[];
  prices: readonly ModelPrice[];
}

export interface InspectedModelUsage {
  id: string;
  assistantId: string;
  model: string;
  serviceTier: string | null;
  status: string;
  inputTokens: number | null;
  cachedInputTokens: number | null;
  cacheWriteInputTokens: number | null;
  outputTokens: number | null;
  reasoningTokens: number | null;
  totalTokens: number | null;
  createdAt: string;
  completedAt: string | null;
  cost: CostEstimate;
}

export interface InspectedVoiceSession {
  id: string;
  model: string | null;
  status: string;
  createdAt: string;
  closedAt: string | null;
  usageSeconds: number | null;
  error: string | null;
  cost: CostEstimate;
}

export interface ConversationInspection {
  conversation: ConversationListItem & { origin: string };
  messages: ConversationMessage[];
  tools: {
    id: string;
    name: string;
    status: string;
    createdAt: string;
    completedAt: string | null;
    error: string | null;
  }[];
  modelUsage: InspectedModelUsage[];
  voiceSessions: InspectedVoiceSession[];
  usage: UsageSummary;
  cost: CostSummary;
}

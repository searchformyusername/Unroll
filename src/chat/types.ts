import type { Provider } from "./providers";
export type ContextScope = "relevant" | "whole" | "step";
export interface ContextInfo {
  scope: ContextScope;
  includedEvents: number;
  totalEvents: number;
  excerptedEvents: number;
  characters: number;
  eventNumbers: number[];
  selectedEventId?: string;
}
export interface ContextPacket extends ContextInfo {
  text: string;
}
export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  status: "complete" | "streaming" | "stopped" | "error";
  provider?: Provider;
  model?: string;
  error?: string;
  context?: ContextInfo;
}
export interface ChatThread {
  id: string;
  messages: ChatMessage[];
  draft: string;
}

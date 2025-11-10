
export interface Message {
  id: number;
  speaker: 'user' | 'ai';
  text: string;
}

export type AssistantStatus = 'idle' | 'listening' | 'speaking' | 'thinking' | 'error';

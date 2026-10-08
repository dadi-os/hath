/** Reasoning-lane send_message handoff. Conversation drains this before composing. */

export type DispatchIntent = {
  toAgentId: string | null;
  intent: string;
  /** Attachments the message carries; empty for a plain message. */
  attachmentIds: string[];
};

/** Per-agent dispatch intents the reasoning lane queued for the conversation lane to compose and send. */
export class IntentQueue {
  private readonly items = new Map<string, DispatchIntent[]>();

  append(agentId: string, intent: DispatchIntent): void {
    const list = this.items.get(agentId) ?? [];
    list.push(intent);
    this.items.set(agentId, list);
  }

  drain(agentId: string): DispatchIntent[] {
    const list = this.items.get(agentId) ?? [];
    this.items.delete(agentId);
    return list;
  }

  hasItems(agentId: string): boolean {
    return (this.items.get(agentId) ?? []).length > 0;
  }
}

/**
 * The conversation-lane turn that asks the agent to send each queued intent:
 * dispatch_message for a plain one, forward_attachment (with the note composed
 * from the intent) for one that carries attachments.
 */
export function formatIntentTurn(intents: DispatchIntent[]): string {
  const parts = intents.map((item) => {
    const to = item.toAgentId === null ? "null (the user)" : item.toAgentId;
    const files =
      item.attachmentIds.length > 0
        ? `\nattachment_ids (send with forward_attachment, never retype them): ${item.attachmentIds.join(", ")}`
        : "";
    return `to_agent_id: ${to}${files}\nintent:\n${item.intent}`;
  });
  return `Your reasoning lane asked you to send a message. Send it with dispatch_message, or forward_attachment with the composed note when the intent lists attachment_ids, unless you already sent that recipient the same thing this wake or a newer message makes it wrong: then send nothing for it.\n\n${parts.join("\n\n")}`;
}

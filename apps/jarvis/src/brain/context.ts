// Shift memory (spec 5.4): the last 20 messages of the conversation as plain text, a short note of what was asked
// before that, and the object in focus ("tủ đó"). Tool results of earlier turns are not replayed: they are big and
// stale; the model calls the tool again when it needs fresh data.
import type { LlmMessage } from './llm';
import type { Focus } from '../tools/registry';

export const KEEP_MESSAGES = 20;
const EARLIER_NOTES = 6;

export class ShiftContext {
  private turns: LlmMessage[] = [];
  private earlier: string[] = [];
  focus: Focus = {};

  /**
   * Messages for the next model call: (note of older questions) + the last `recent` messages + the new user message.
   * The context keeps 20 messages (spec 5.4); a small local model gets fewer, it copies old answers otherwise.
   */
  messagesFor(userText: string, recent = KEEP_MESSAGES): LlmMessage[] {
    const keep = Math.max(0, Math.min(recent, this.turns.length));
    const sent = keep ? this.turns.slice(-keep) : [];
    const older = [...this.earlier, ...this.turns.slice(0, this.turns.length - keep).filter((m) => m.role === 'user').map((m) => m.content.slice(0, 80))].slice(-EARLIER_NOTES);
    const out: LlmMessage[] = [];
    if (older.length) {
      out.push({ role: 'user', content: `(Trước đó trong ca, người dùng đã hỏi: ${older.join('; ')})` });
      out.push({ role: 'assistant', content: 'Tôi nhớ.' });
    }
    out.push(...sent, { role: 'user', content: userText });
    return out;
  }

  /** Records a finished turn (only the user text and the final answer). */
  addTurn(userText: string, answer: string) {
    this.turns.push({ role: 'user', content: userText }, { role: 'assistant', content: answer || '…' });
    while (this.turns.length > KEEP_MESSAGES) {
      const dropped = this.turns.shift()!;
      if (dropped.role === 'user') this.earlier.push(dropped.content.slice(0, 80));
      if (this.earlier.length > EARLIER_NOTES) this.earlier.shift();
    }
  }

  get size() {
    return this.turns.length;
  }

  reset() {
    this.turns = [];
    this.earlier = [];
    this.focus = {};
  }
}

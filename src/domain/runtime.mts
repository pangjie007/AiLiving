import type { Mood, MoodEvent, Persona, Phase, Ticket, Transition } from './types.mts';

const limits = {
  pleasure: [-1, 1], activation: [0, 1],
  willingness: [0, 1], fatigue: [0, 1]
} as const;
const clamp = (value: number, min: number, max: number) =>
  Math.min(max, Math.max(min, value));

export class HostRuntime {
  readonly sessionId: string;
  readonly persona: Persona;
  #phase: Phase = 'chatting';
  #epoch = 0;
  #at: number;
  #mood: Mood;
  #seen = new Set<string>();
  #permissions = new Map<string, number>();
  #viewerEpochs = new Map<string, number>();
  #refused = new Set<string>();
  #consentEvents = new Map<string, Set<string>>();

  constructor(sessionId: string, persona: Persona, startedAt: number) {
    if (!sessionId.trim() || !Number.isFinite(startedAt) || startedAt < 0) {
      throw new Error('Invalid session or start time');
    }
    this.sessionId = sessionId;
    this.persona = persona;
    this.#at = startedAt;
    this.#mood = persona.baseline;
  }

  get mood(): Mood { return this.#mood; }
  get phase(): Phase { return this.#phase; }

  apply(event: MoodEvent): Transition | null {
    if (this.#phase !== 'chatting') throw new Error('Automatic state updates paused');
    if (!event.id.trim()) throw new Error('Missing event ID');
    if (this.#seen.has(event.id)) return null;
    if (!Number.isFinite(event.at) || event.at < this.#at) throw new Error('Invalid time');
    for (const [key, value] of Object.entries(event.delta)) {
      if (!Object.hasOwn(limits, key) || !Number.isFinite(value)) {
        throw new Error('Invalid mood delta');
      }
    }
    const before = this.#mood;
    const next: Record<keyof Mood, number> = { ...before };
    const decay = Math.exp(-(event.at - this.#at) / 120_000);
    for (const key of Object.keys(limits) as (keyof Mood)[]) {
      const [min, max] = limits[key];
      const baseline = this.persona.baseline[key];
      next[key] = clamp(baseline + (before[key] - baseline) * decay +
        clamp(event.delta[key] ?? 0, -0.15, 0.15), min, max);
    }
    this.#mood = Object.freeze(next);
    this.#at = event.at;
    this.#seen.add(event.id);
    return Object.freeze({ eventId: event.id, at: event.at, before, after: this.#mood });
  }

  expressionLevel(viewerId: string): number {
    return Math.min(this.persona.maxExpression, this.#permissions.get(viewerId) ?? 0);
  }

  permit(viewerId: string, level: number): void {
    if (!viewerId.trim() || !Number.isInteger(level) || level < 0 || level > 3) {
      throw new Error('Invalid explicit permission');
    }
    if (this.#refused.has(viewerId)) {
      throw new Error('A new explicit consent event is required after refusal');
    }
    this.#permissions.set(viewerId, level);
    this.#invalidateViewer(viewerId);
  }

  grantExplicitConsent(viewerId: string, level: number, sourceEventId: string): void {
    if (!viewerId.trim() || !sourceEventId.trim() ||
        !Number.isInteger(level) || level < 0 || level > 3) {
      throw new Error('Invalid explicit consent');
    }
    let seenEvents = this.#consentEvents.get(viewerId);
    if (!seenEvents) {
      seenEvents = new Set<string>();
      this.#consentEvents.set(viewerId, seenEvents);
    }
    if (seenEvents.has(sourceEventId)) return;
    seenEvents.add(sourceEventId);
    this.#refused.delete(viewerId);
    this.#permissions.set(viewerId, level);
    this.#invalidateViewer(viewerId);
  }

  refuse(viewerId: string): void {
    if (!viewerId.trim()) throw new Error('Missing viewer ID');
    this.#refused.add(viewerId);
    this.#permissions.set(viewerId, 0);
    this.#invalidateViewer(viewerId);
  }

  forget(viewerId: string): void {
    this.#permissions.delete(viewerId);
    this.#refused.delete(viewerId);
    this.#consentEvents.delete(viewerId);
    this.#invalidateViewer(viewerId);
  }

  #invalidateViewer(viewerId: string): void {
    this.#viewerEpochs.set(viewerId, (this.#viewerEpochs.get(viewerId) ?? 0) + 1);
  }

  issueTicket(viewerId: string): Ticket {
    if (this.#phase !== 'chatting' || !viewerId.trim()) throw new Error('Cannot issue ticket');
    return Object.freeze({
      sessionId: this.sessionId, epoch: this.#epoch, viewerId,
      viewerEpoch: this.#viewerEpochs.get(viewerId) ?? 0
    });
  }

  isCurrent(ticket: Ticket): boolean {
    return this.#phase === 'chatting' && ticket.sessionId === this.sessionId &&
      ticket.epoch === this.#epoch &&
      ticket.viewerEpoch === (this.#viewerEpochs.get(ticket.viewerId) ?? 0);
  }

  takeover(): void {
    if (this.#phase === 'ended') throw new Error('Session ended');
    this.#phase = 'takeover';
    this.#epoch++;
  }

  resume(): void {
    if (this.#phase !== 'takeover') throw new Error('Session is not in takeover');
    this.#phase = 'chatting';
    this.#epoch++;
  }

  end(): void {
    this.#phase = 'ended';
    this.#epoch++;
  }
}

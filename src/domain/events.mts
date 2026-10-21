export type LiveEventType = 'chat' | 'viewer_joined' | 'program_request' | 'operator';
export type EventVisibility = 'public' | 'private';
export type LiveEventInput = Readonly<{
  eventId: string;
  workspaceId: string;
  hostId: string;
  sessionId: string;
  source: string;
  sourceEventId: string;
  type: LiveEventType;
  occurredAt: number;
  receivedAt: number;
  viewerId: string | null;
  visibility: EventVisibility;
  content: string;
}>;

const idFields = [
  'eventId', 'workspaceId', 'hostId', 'sessionId', 'source', 'sourceEventId'
] as const;

export function validateEvent(event: LiveEventInput, now: number): LiveEventInput {
  if (!Number.isFinite(now) || now < 0) throw new Error('Invalid validation time');
  for (const field of idFields) {
    const value = event[field];
    if (typeof value !== 'string' || !value.trim() || value.trim().length > 200) {
      throw new Error(`Invalid event field: ${field}`);
    }
  }
  if (event.viewerId !== null &&
      (typeof event.viewerId !== 'string' || !event.viewerId.trim() || event.viewerId.trim().length > 200)) {
    throw new Error('Invalid viewer ID');
  }
  if (!['chat', 'viewer_joined', 'program_request', 'operator'].includes(event.type)) {
    throw new Error('Invalid event type');
  }
  if (!['public', 'private'].includes(event.visibility)) {
    throw new Error('Invalid event visibility');
  }
  if (typeof event.content !== 'string' || event.content.length > 4000) {
    throw new Error('Invalid event content');
  }
  if (!Number.isFinite(event.receivedAt) || event.receivedAt < 0 || event.receivedAt > now + 300_000) {
    throw new Error('Invalid event receive time');
  }
  if (!Number.isFinite(event.occurredAt) || event.occurredAt < now - 86_400_000 ||
      event.occurredAt > now + 300_000) {
    throw new Error('Event outside accepted time window');
  }
  return Object.freeze({
    ...event,
    eventId: event.eventId.trim(), workspaceId: event.workspaceId.trim(),
    hostId: event.hostId.trim(), sessionId: event.sessionId.trim(),
    source: event.source.trim(), sourceEventId: event.sourceEventId.trim(),
    viewerId: event.viewerId?.trim() ?? null
  });
}

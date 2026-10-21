export type Phase = 'chatting' | 'takeover' | 'ended';
export type Mood = Readonly<{
  pleasure: number;
  activation: number;
  willingness: number;
  fatigue: number;
}>;
export type PersonaInput = {
  hostId: string;
  version: number;
  name: string;
  facts: string[];
  baseline: Mood;
  maxExpression: number;
};
export type Persona = Readonly<{
  hostId: string;
  version: number;
  name: string;
  facts: readonly string[];
  baseline: Mood;
  maxExpression: number;
}>;
export type MoodEvent = {
  id: string;
  at: number;
  delta: Partial<Mood>;
};
export type Transition = Readonly<{
  eventId: string;
  at: number;
  before: Mood;
  after: Mood;
}>;
export type Ticket = Readonly<{
  sessionId: string;
  epoch: number;
  viewerId: string;
  viewerEpoch: number;
}>;

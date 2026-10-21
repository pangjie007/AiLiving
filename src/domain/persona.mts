import type { Persona, PersonaInput } from './types.mts';

export function publishPersona(input: PersonaInput): Persona {
  if (!input.hostId.trim() || !input.name.trim() ||
      !Number.isInteger(input.version) || input.version < 1) {
    throw new Error('Invalid identity or version');
  }
  if (!Number.isInteger(input.maxExpression) ||
      input.maxExpression < 0 || input.maxExpression > 3) {
    throw new Error('Expression level must be an integer from 0 to 3');
  }
  const ranges = {
    pleasure: [-1, 1], activation: [0, 1],
    willingness: [0, 1], fatigue: [0, 1]
  } as const;
  for (const key of Object.keys(ranges) as (keyof typeof ranges)[]) {
    const value = input.baseline[key];
    const [min, max] = ranges[key];
    if (!Number.isFinite(value) || value < min || value > max) {
      throw new Error(`Invalid baseline: ${key}`);
    }
  }
  if (input.facts.some(fact => !fact.trim())) {
    throw new Error('Empty persona fact');
  }
  return Object.freeze({
    hostId: input.hostId.trim(), version: input.version,
    name: input.name.trim(),
    facts: Object.freeze([...input.facts]),
    baseline: Object.freeze({ ...input.baseline }),
    maxExpression: input.maxExpression
  });
}

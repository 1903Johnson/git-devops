import { randomUUID } from 'node:crypto';
import type { Subject } from '@church/policy';

/** What the guards attach to the request as it moves through the lifecycle. */
export interface RequestContext {
  readonly requestId: string;
  subject?: Subject;
}

const CONTEXT = Symbol('request-context');

interface Carrier {
  [CONTEXT]?: RequestContext;
}

/** Attaches a context on first read, so ordering between guards does not matter. */
export function contextOf(request: object): RequestContext {
  const carrier = request as Carrier;
  carrier[CONTEXT] ??= { requestId: randomUUID() };
  return carrier[CONTEXT];
}

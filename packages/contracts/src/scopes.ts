import { z } from 'zod';

/** Scopes of an API key (architecture plan, section "Autenticação e autorização"). */
export const SCOPES = ['messages:send', 'instances:manage', 'bots:write', 'events:read'] as const;

export const Scope = z.enum(SCOPES);
export type Scope = z.infer<typeof Scope>;

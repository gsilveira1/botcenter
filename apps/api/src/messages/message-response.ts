import type { MessageResponse, MessageStatus, MessageType } from '@botcenter/contracts';
import { maskPhone } from '../logging/mask';

/** The columns of an outbound message that the API returns. */
export const MESSAGE_RESPONSE_SELECT = {
  id: true,
  instanceId: true,
  contact: true,
  type: true,
  status: true,
  failureReason: true,
  createdAt: true,
  updatedAt: true,
} as const;

export interface MessageResponseRow {
  id: string;
  instanceId: string;
  contact: string;
  /** Outbound rows have only the contracts `MessageType` values. */
  type: string;
  /** Outbound rows never have `received`. */
  status: string;
  failureReason: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export function toMessageResponse(row: MessageResponseRow): MessageResponse {
  return {
    id: row.id,
    instance_id: row.instanceId,
    to_masked: maskPhone(row.contact),
    type: row.type as MessageType,
    status: row.status as MessageStatus,
    failure_reason: row.failureReason,
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
  };
}

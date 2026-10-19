import { Injectable } from '@nestjs/common';
import type { Diagnostic } from '@botcenter/engine';
import { getLogger } from '../../logging/logger';
import { AlertService } from '../../services/alert.service';
import { ConversationMetrics } from '../conversation-metrics';

export interface DiagnosticsContext {
  tenantId: string;
  conversationId: string;
  botSlug: string;
  botVersion: number;
}

/**
 * Logs and counts the engine diagnostics of one step (engine README, step 6). `warning` and `error`
 * entries are logged; an `error` entry also goes to `AlertService` (the bot did less than its definition
 * says). The diagnostic messages contain state and variable names, never message content.
 */
@Injectable()
export class EngineDiagnosticsReporter {
  private readonly logger = getLogger('engine');

  constructor(
    private readonly alerts: AlertService,
    private readonly metrics: ConversationMetrics,
  ) {}

  async report(diagnostics: readonly Diagnostic[], context: DiagnosticsContext): Promise<void> {
    for (const diagnostic of diagnostics) {
      this.metrics.diagnostics.inc({ severity: diagnostic.severity, code: diagnostic.code });
      if (diagnostic.severity === 'info') {
        continue;
      }
      const fields = {
        conversation_id: context.conversationId,
        bot_id: context.botSlug,
        bot_version: context.botVersion,
        code: diagnostic.code,
        path: diagnostic.path?.join('.'),
        detail: diagnostic.message,
      };
      if (diagnostic.severity === 'warning') {
        this.logger.warn(fields, 'engine diagnostic');
        continue;
      }
      this.logger.error(fields, 'engine diagnostic');
      // ARCH-20: the step holds the conversation lock; a slow Discord must not hold it.
      void this.alerts.notify({
        severity: 'warning',
        title: 'Bot engine error diagnostic',
        details: {
          tenant_id: context.tenantId,
          bot_id: context.botSlug,
          bot_version: context.botVersion,
          code: diagnostic.code,
        },
        dedupeKey: `engine:${context.tenantId}:${context.botSlug}:${diagnostic.code}`,
      });
    }
  }
}

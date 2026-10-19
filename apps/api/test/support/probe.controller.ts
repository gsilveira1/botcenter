import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { Body, Controller, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import { CursorQuery, UuidParam } from '@botcenter/contracts';
import { z } from 'zod';
import { Auth, assertInstanceAllowed } from '../../src/auth/auth-context';
import type { AuthContext } from '../../src/auth/auth-context';
import { Public, RequireScope } from '../../src/auth/decorators';
import { AppError } from '../../src/common/errors/app-error';
import { createZodDto } from '../../src/common/zod-dto';

class EchoBody extends createZodDto(
  z.object({ value: z.string().min(1), delay_ms: z.number().int().max(5_000).optional() }),
) {}
class InstanceParam extends createZodDto(UuidParam) {}
class PageQuery extends createZodDto(CursorQuery) {}

export const probeCalls = { echo: 0 };

/** Test routes for the core pipeline (auth, idempotency, rate limit, errors). Not part of the application. */
@Controller('v1/probe')
export class ProbeController {
  @Get('scoped')
  @RequireScope('messages:send')
  scoped(@Auth() auth: AuthContext) {
    return { tenant_id: auth.tenantId, scopes: auth.scopes };
  }

  @Get('instances/:id')
  @RequireScope('messages:send')
  instance(@Auth() auth: AuthContext, @Param() params: InstanceParam) {
    assertInstanceAllowed(auth, params.id);
    return { instance_id: params.id };
  }

  @Post('echo')
  @RequireScope('messages:send')
  async echo(@Body() body: EchoBody) {
    probeCalls.echo += 1;
    if (body.delay_ms) {
      await sleep(body.delay_ms);
    }
    return { id: randomUUID(), value: body.value };
  }

  @Post('fail')
  @HttpCode(202)
  @RequireScope('messages:send')
  fail(): never {
    throw new AppError('CONFLICT', 'Probe conflict');
  }

  @Get('page')
  @RequireScope('messages:send')
  page(@Query() query: PageQuery) {
    return query;
  }

  @Get('undecorated')
  undecorated() {
    return { reached: true };
  }

  @Get('boom')
  @Public()
  boom(): never {
    throw new Error('secret internal detail');
  }
}

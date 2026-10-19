import { RequestMethod } from '@nestjs/common';
import type { INestApplicationContext, Type } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { ModulesContainer } from '@nestjs/core';
import { AUTH_POLICY } from '../auth/decorators';
import type { AuthPolicy } from '../auth/decorators';

/** One HTTP route of the application, read from the Nest metadata. */
export interface RouteInfo {
  controller: Type;
  methodName: string;
  handler: (...args: unknown[]) => unknown;
  httpMethod: string;
  /** Fastify path, for example `/v1/messages/:id`. */
  path: string;
  policy: AuthPolicy | undefined;
}

function paths(value: unknown): string[] {
  const list = Array.isArray(value) ? value : [value ?? '/'];
  return list.map((item) => String(item));
}

function join(base: string, sub: string): string {
  const joined = `/${base}/${sub}`.replace(/\/+/g, '/');
  return joined.length > 1 ? joined.replace(/\/$/, '') : joined;
}

/** Every controller route of the application, in a stable order. */
export function listRoutes(app: INestApplicationContext): RouteInfo[] {
  const container = app.get(ModulesContainer);
  const controllers = new Set<Type>();
  for (const module of container.values()) {
    for (const wrapper of module.controllers.values()) {
      if (wrapper.metatype) {
        controllers.add(wrapper.metatype as Type);
      }
    }
  }
  const routes: RouteInfo[] = [];
  for (const controller of controllers) {
    const basePaths = paths(Reflect.getMetadata(PATH_METADATA, controller));
    const prototype = controller.prototype as Record<string, unknown>;
    for (const methodName of Object.getOwnPropertyNames(prototype)) {
      const handler = prototype[methodName];
      if (methodName === 'constructor' || typeof handler !== 'function') {
        continue;
      }
      const method = Reflect.getMetadata(METHOD_METADATA, handler) as RequestMethod | undefined;
      const subPaths = Reflect.getMetadata(PATH_METADATA, handler) as unknown;
      if (method === undefined || subPaths === undefined) {
        continue;
      }
      const policy =
        (Reflect.getMetadata(AUTH_POLICY, handler) as AuthPolicy | undefined) ??
        (Reflect.getMetadata(AUTH_POLICY, controller) as AuthPolicy | undefined);
      for (const base of basePaths) {
        for (const sub of paths(subPaths)) {
          routes.push({
            controller,
            methodName,
            handler: handler as (...args: unknown[]) => unknown,
            httpMethod: RequestMethod[method],
            path: join(base, sub),
            policy,
          });
        }
      }
    }
  }
  return routes.sort(
    (a, b) => a.path.localeCompare(b.path) || a.httpMethod.localeCompare(b.httpMethod),
  );
}

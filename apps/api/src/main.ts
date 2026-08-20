import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { AppModule } from './app.module.js';
import { API_PREFIX } from './api-prefix.js';
import { API_CONFIG } from './common/tokens.js';
import type { ApiConfig } from './config.js';

export async function bootstrap(): Promise<NestFastifyApplication> {
  const app = await NestFactory.create<NestFastifyApplication>(AppModule, new FastifyAdapter());
  // The contract declares this prefix; the server has to answer on it. See api-prefix.ts.
  app.setGlobalPrefix(API_PREFIX);
  // Without this the pool is never drained and in-flight requests are cut off mid-write.
  app.enableShutdownHooks();
  const config = app.get<ApiConfig>(API_CONFIG);
  await app.listen({ port: config.port, host: config.host });
  Logger.log(`listening on ${config.host}:${config.port}`, 'Bootstrap');
  return app;
}

// `import.meta.main` is Node 24+; compare paths so this works on 22 as well.
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  await bootstrap();
}

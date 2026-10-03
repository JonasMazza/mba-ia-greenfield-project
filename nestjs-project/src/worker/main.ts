import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { WorkerModule } from './worker.module';

async function bootstrap(): Promise<void> {
  // No HTTP server: the worker only consumes jobs (TD-04).
  const app = await NestFactory.createApplicationContext(WorkerModule);
  app.enableShutdownHooks();

  // The process stays alive on the queue's own timers; this makes the intent
  // explicit and gives SIGTERM a clean path through Nest's shutdown hooks.
  new Logger('VideoWorker').log('Video worker started');
}

void bootstrap();

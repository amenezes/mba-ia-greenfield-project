import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { WorkerModule } from './worker/worker.module';
import { VIDEO_PROCESSING_QUEUE } from './video-processing/video-processing.constants';

async function bootstrap() {
  const app = await NestFactory.createApplicationContext(WorkerModule);
  app.enableShutdownHooks();
  Logger.log(
    `Video worker started — consuming queue "${VIDEO_PROCESSING_QUEUE}"`,
    'VideoWorker',
  );
}
void bootstrap();

import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import databaseConfig from '../config/database.config';
import { envValidationSchema } from '../config/env.validation';
import queueConfig from '../config/queue.config';
import storageConfig from '../config/storage.config';
import { DatabaseModule } from '../database/database.module';
import { QueueModule } from '../queue/queue.module';
import { UsersModule } from '../users/users.module';
import { VideoProcessingWorkerModule } from '../video-processing/video-processing-worker.module';

/** Root module of the standalone video worker (no HTTP server). */
@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [databaseConfig, storageConfig, queueConfig],
      validationSchema: envValidationSchema,
      validationOptions: { allowUnknown: true, abortEarly: false },
    }),
    DatabaseModule,
    QueueModule,
    // Registers the User entity: autoLoadEntities needs the full
    // Video → Channel → User relation graph.
    UsersModule,
    VideoProcessingWorkerModule,
  ],
})
export class WorkerModule {}

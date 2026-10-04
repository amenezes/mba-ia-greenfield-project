import { Test } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import { getQueueToken } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import queueConfig from '../config/queue.config';
import { QueueModule } from '../queue/queue.module';
import { VideoProcessingQueueModule } from './video-processing-queue.module';
import { VideoProcessingQueue } from './video-processing-queue.service';
import { VIDEO_PROCESSING_QUEUE } from './video-processing.constants';

describe('VideoProcessingQueueModule', () => {
  it('should compile with the shared queue connection', async () => {
    const module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, load: [queueConfig] }),
        QueueModule,
        VideoProcessingQueueModule,
      ],
    }).compile();

    expect(module.get(VideoProcessingQueue)).toBeInstanceOf(
      VideoProcessingQueue,
    );
    const queue = module.get<Queue>(getQueueToken(VIDEO_PROCESSING_QUEUE));
    expect(queue.name).toBe(VIDEO_PROCESSING_QUEUE);
    await module.close();
  }, 15000);
});

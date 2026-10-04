import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { VideoProcessingQueue } from './video-processing-queue.service';
import { VIDEO_PROCESSING_QUEUE } from './video-processing.constants';

@Module({
  imports: [BullModule.registerQueue({ name: VIDEO_PROCESSING_QUEUE })],
  providers: [VideoProcessingQueue],
  exports: [VideoProcessingQueue, BullModule],
})
export class VideoProcessingQueueModule {}

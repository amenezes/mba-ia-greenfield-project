import { Module } from '@nestjs/common';
import { StorageModule } from '../storage/storage.module';
import { VideosModule } from '../videos/videos.module';
import { MediaProbeService } from './media-probe.service';
import { VideoProcessor } from './video.processor';

/** Queue consumer side — loaded only by the video worker process. */
@Module({
  imports: [VideosModule, StorageModule],
  providers: [VideoProcessor, MediaProbeService],
})
export class VideoProcessingWorkerModule {}

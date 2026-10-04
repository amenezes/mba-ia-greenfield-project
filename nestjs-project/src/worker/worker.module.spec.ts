import { Test } from '@nestjs/testing';
import { VideoProcessor } from '../video-processing/video.processor';
import { WorkerModule } from './worker.module';

describe('WorkerModule', () => {
  it('should compile and register the video processor', async () => {
    const module = await Test.createTestingModule({
      imports: [WorkerModule],
    }).compile();

    expect(module.get(VideoProcessor)).toBeInstanceOf(VideoProcessor);
    await module.close();
  }, 15000);
});

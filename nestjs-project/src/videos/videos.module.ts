import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ChannelsModule } from '../channels/channels.module';
import queueConfig from '../config/queue.config';
import storageConfig from '../config/storage.config';
import { Video } from './entities/video.entity';
import { QueueService } from './queue/queue.service';
import { ObjectStorageService } from './storage/object-storage.service';
import { VideosController } from './videos.controller';
import { VideosService } from './videos.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([Video]),
    ConfigModule.forFeature(storageConfig),
    ConfigModule.forFeature(queueConfig),
    ChannelsModule,
  ],
  controllers: [VideosController],
  providers: [ObjectStorageService, QueueService, VideosService],
  exports: [TypeOrmModule, ObjectStorageService, QueueService, VideosService],
})
export class VideosModule {}

import { Module } from '@nestjs/common';
import { ConfigModule, ConfigType } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import databaseConfig from '../config/database.config';
import { envValidationSchema } from '../config/env.validation';
import queueConfig from '../config/queue.config';
import storageConfig from '../config/storage.config';
import { UsersModule } from '../users/users.module';
import { VideosModule } from '../videos/videos.module';
import { VideoProcessorService } from './video-processor.service';

/**
 * The worker reuses the API's entities, DataSource and config through DI, but
 * boots as an application context — no HTTP server, no controllers (TD-04).
 */
@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [databaseConfig, queueConfig, storageConfig],
      validationSchema: envValidationSchema,
      validationOptions: { allowUnknown: true, abortEarly: false },
    }),
    TypeOrmModule.forRootAsync({
      imports: [ConfigModule],
      inject: [databaseConfig.KEY],
      useFactory: (dbConfig: ConfigType<typeof databaseConfig>) => ({
        type: 'postgres' as const,
        host: dbConfig.host,
        port: dbConfig.port,
        username: dbConfig.username,
        password: dbConfig.password,
        database: dbConfig.name,
        autoLoadEntities: true,
        synchronize: false,
      }),
    }),
    // `autoLoadEntities` only sees entities some module registered via
    // `forFeature`. Video → Channel → User is a chain, so UsersModule has to be
    // here even though the worker never touches users directly.
    UsersModule,
    VideosModule,
  ],
  providers: [VideoProcessorService],
})
export class WorkerModule {}

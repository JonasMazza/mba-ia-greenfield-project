import { Inject, Module, OnModuleInit } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import type { ConfigType } from '@nestjs/config';
import { HttpAdapterHost } from '@nestjs/core';
import type { Express } from 'express';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { AuthModule } from './auth/auth.module';
import appConfig from './config/app.config';
import authConfig from './config/auth.config';
import databaseConfig from './config/database.config';
import mailConfig from './config/mail.config';
import queueConfig from './config/queue.config';
import storageConfig from './config/storage.config';
import swaggerConfig from './config/swagger.config';
import { envValidationSchema } from './config/env.validation';
import { VideosModule } from './videos/videos.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [
        appConfig,
        authConfig,
        databaseConfig,
        mailConfig,
        queueConfig,
        storageConfig,
        swaggerConfig,
      ],
      validationSchema: envValidationSchema,
      validationOptions: { allowUnknown: true, abortEarly: false },
    }),
    TypeOrmModule.forRootAsync({
      imports: [ConfigModule],
      inject: [databaseConfig.KEY],
      useFactory: (dbConfig: ConfigType<typeof databaseConfig>) => ({
        type: 'postgres',
        host: dbConfig.host,
        port: dbConfig.port,
        username: dbConfig.username,
        password: dbConfig.password,
        database: dbConfig.name,
        autoLoadEntities: true,
        synchronize: false,
      }),
    }),
    AuthModule,
    VideosModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule implements OnModuleInit {
  constructor(
    private readonly adapterHost: HttpAdapterHost,
    @Inject(appConfig.KEY)
    private readonly app: ConfigType<typeof appConfig>,
  ) {}

  /**
   * Browser traffic arrives through the BFF, which forwards the client address
   * in `X-Forwarded-For`; trusting that hop makes `req.ip` — and so the
   * throttler's tracker — the real client instead of the BFF.
   */
  onModuleInit(): void {
    const instance = this.adapterHost.httpAdapter?.getInstance<Express>();
    instance?.set('trust proxy', this.app.trustProxy);
  }
}

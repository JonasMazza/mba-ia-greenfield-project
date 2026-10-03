import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { Channel } from '../../channels/entities/channel.entity';

export enum VideoStatus {
  DRAFT = 'draft',
  PROCESSING = 'processing',
  READY = 'ready',
  FAILED = 'failed',
}

/**
 * `bigint` columns are returned as strings by the pg driver to avoid precision
 * loss. Sizes here are bounded by the 10 GiB upload limit, well inside
 * `Number.MAX_SAFE_INTEGER`, so the value is projected to `number` at the
 * entity boundary and the rest of the app never deals with numeric strings.
 */
const bigintToNumber = {
  to: (value: number | null): number | null => value,
  from: (value: string | null): number | null =>
    value === null ? null : Number(value),
};

@Entity('videos')
export class Video {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar', length: 12, unique: true })
  public_id: string;

  @Index()
  @Column({ type: 'uuid' })
  channel_id: string;

  @Column({ type: 'varchar', length: 255, nullable: true })
  title: string | null;

  @Index()
  @Column({
    type: 'enum',
    enum: VideoStatus,
    enumName: 'video_status',
    default: VideoStatus.DRAFT,
  })
  status: VideoStatus;

  @Column({ type: 'varchar', length: 512, nullable: true })
  storage_key: string | null;

  @Column({ type: 'varchar', length: 255, nullable: true })
  upload_id: string | null;

  @Column({ type: 'varchar', length: 127, nullable: true })
  content_type: string | null;

  @Column({ type: 'bigint', nullable: true, transformer: bigintToNumber })
  size_bytes: number | null;

  @Column({ type: 'int', nullable: true })
  duration_seconds: number | null;

  @Column({ type: 'int', nullable: true })
  width: number | null;

  @Column({ type: 'int', nullable: true })
  height: number | null;

  @Column({ type: 'varchar', length: 64, nullable: true })
  codec: string | null;

  @Column({ type: 'int', nullable: true })
  bitrate: number | null;

  @Column({ type: 'varchar', length: 512, nullable: true })
  thumbnail_key: string | null;

  @Column({ type: 'int', default: 0 })
  processing_attempts: number;

  @Column({ type: 'varchar', length: 512, nullable: true })
  failure_reason: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updated_at: Date;

  @ManyToOne(() => Channel, (channel) => channel.videos, {
    onDelete: 'CASCADE',
  })
  @JoinColumn({ name: 'channel_id' })
  channel: Channel;
}

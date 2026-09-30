import { Inject, Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import { QUEUE_PORT, type QueuePort } from '../../core/ports/queue.port';
import { AttachmentsService } from './attachments.service';

const EVERY_SIX_HOURS = 6 * 60 * 60 * 1000;

/**
 * Reclaims storage on a schedule.
 *
 * Six hours rather than nightly: abandoned pending uploads are the common case and they are cheap
 * to collect, so there is no reason to let a day's worth accumulate. The work is idempotent, so a
 * missed run costs nothing but disk.
 */
@Injectable()
export class AttachmentPurgeJob implements OnApplicationBootstrap {
  private readonly logger = new Logger(AttachmentPurgeJob.name);

  constructor(
    private readonly attachments: AttachmentsService,
    @Inject(QUEUE_PORT) private readonly queue: QueuePort,
  ) {}

  onApplicationBootstrap(): void {
    this.queue.schedule('attachments.purge', EVERY_SIX_HOURS, () => this.run());
  }

  async run(): Promise<void> {
    const result = await this.attachments.purgeOrphans();
    const total = result.pendingRemoved + result.rowsRemoved + result.blobsRemoved;
    if (total) {
      this.logger.log(
        `purged ${result.pendingRemoved} pending, ${result.rowsRemoved} expired, ` +
          `${result.blobsRemoved} blob(s), ${Math.round(result.bytesReclaimed / 1024)} KB reclaimed`,
      );
    }
  }
}

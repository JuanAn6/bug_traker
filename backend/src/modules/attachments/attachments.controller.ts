import archiver from 'archiver';
import {
  Body, Controller, Delete, Get, Headers, HttpCode, Param, ParseIntPipe, Patch, Post, Req, Res,
} from '@nestjs/common';
import { IsOptional, IsString, MaxLength } from 'class-validator';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { MAX_FILE_SIZE } from '../../shared/config';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { ValidationError } from '../../common/errors/domain-error';
import type { AuthUser } from '../auth/auth.types';
import { canRenderInline } from './attachment-validation';
import { AttachmentsService } from './attachments.service';

class RenameAttachmentDto {
  @IsOptional() @IsString() @MaxLength(255) name?: string;
  @IsOptional() @IsString() @MaxLength(512) description?: string;
}

/** Only the first slice of a text file is read for the preview pane. */
const TEXT_PREVIEW_BYTES = 200_000;

@Controller()
export class AttachmentsController {
  constructor(private readonly attachments: AttachmentsService) {}

  /**
   * Ticket documents and note files in one list, newest first, with older versions nested under
   * the current one.
   */
  @Get('issues/:id/documents')
  list(@CurrentUser() actor: AuthUser, @Param('id', ParseIntPipe) issueId: number) {
    return this.attachments.listForIssue(actor, issueId);
  }

  /** Multipart. `issueId` in the form attaches straight away; omit it for a pending upload. */
  @Post('attachments')
  async upload(@CurrentUser() actor: AuthUser, @Req() request: FastifyRequest) {
    const part = await this.firstFile(request);
    return this.attachments.upload(actor, part.file, part.target);
  }

  @Post('attachments/:id/versions')
  async addVersion(
    @CurrentUser() actor: AuthUser,
    @Param('id', ParseIntPipe) id: number,
    @Req() request: FastifyRequest,
  ) {
    const part = await this.firstFile(request);
    return this.attachments.addVersion(actor, id, part.file);
  }

  @Patch('attachments/:id')
  @HttpCode(204)
  async rename(
    @CurrentUser() actor: AuthUser,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: RenameAttachmentDto,
  ) {
    await this.attachments.rename(actor, id, dto);
  }

  /** Soft-deletes the whole version chain; the bytes go when nothing references them. */
  @Delete('attachments/:id')
  @HttpCode(200)
  remove(@CurrentUser() actor: AuthUser, @Param('id', ParseIntPipe) id: number) {
    return this.attachments.remove(actor, id);
  }

  /**
   * The bytes, as an attachment download.
   *
   * Supports a single byte range — enough for video seeking and for the text preview, and the
   * multi-range case is not worth the multipart/byteranges machinery. Content addressing makes the
   * ETag trivially correct and the cache immutable: the bytes behind a hash never change.
   */
  @Get('attachments/:id/content')
  async content(
    @CurrentUser() actor: AuthUser,
    @Param('id', ParseIntPipe) id: number,
    @Res() reply: FastifyReply,
    @Headers('range') range?: string,
    @Headers('if-none-match') ifNoneMatch?: string,
  ) {
    await this.send(actor, id, reply, { disposition: 'attachment', range, ifNoneMatch });
  }

  /**
   * The bytes, for rendering in the page.
   *
   * Only types on the inline allow-list are actually served inline; everything else is forced to
   * download. SVG is deliberately excluded — it is a document that can carry script, so serving one
   * inline from this origin would be stored XSS. The CSP and `nosniff` are the second layer.
   */
  @Get('attachments/:id/inline')
  async inline(
    @CurrentUser() actor: AuthUser,
    @Param('id', ParseIntPipe) id: number,
    @Res() reply: FastifyReply,
    @Headers('range') range?: string,
    @Headers('if-none-match') ifNoneMatch?: string,
  ) {
    await this.send(actor, id, reply, { disposition: 'inline', range, ifNoneMatch });
  }

  /** The first 200 KB as text, which is all the preview pane shows. */
  @Get('attachments/:id/text')
  async text(
    @CurrentUser() actor: AuthUser,
    @Param('id', ParseIntPipe) id: number,
    @Res() reply: FastifyReply,
  ) {
    const { attachment, size } = await this.attachments.forDownload(actor, id);
    const end = Math.min(size, TEXT_PREVIEW_BYTES) - 1;
    const stream = await this.attachments.openBlob(attachment.blobHash, { start: 0, end });

    const chunks: Buffer[] = [];
    for await (const chunk of stream) chunks.push(chunk as Buffer);
    // JSON, not text/plain: the body is an envelope carrying the slice plus whether it was cut.
    // Declaring text/plain stopped Fastify serializing the object at all.
    void reply
      .header('content-type', 'application/json; charset=utf-8')
      .header('x-content-type-options', 'nosniff')
      .send({
        text: Buffer.concat(chunks).toString('utf8'),
        truncated: size > TEXT_PREVIEW_BYTES,
        size,
      });
  }

  /**
   * Every current document on the issue, as a zip.
   *
   * Streamed rather than assembled in memory, and already-compressed types are stored rather than
   * deflated — recompressing a PNG costs CPU to make the file slightly bigger. Replaces the
   * frontend's sequential-native-downloads workaround.
   */
  @Get('issues/:id/documents.zip')
  async zip(
    @CurrentUser() actor: AuthUser,
    @Param('id', ParseIntPipe) issueId: number,
    @Res() reply: FastifyReply,
  ) {
    const manifest = await this.attachments.zipManifest(actor, issueId);
    const archive = archiver('zip', { zlib: { level: 6 } });

    void reply
      .header('content-type', 'application/zip')
      .header('content-disposition', `attachment; filename="issue-${issueId}-documents.zip"`)
      .header('cache-control', 'no-store')
      .send(archive);

    for (const entry of manifest) {
      const stream = await this.attachments.openBlob(entry.hash);
      archive.append(stream, {
        name: entry.name,
        // Already-compressed formats gain nothing from deflate.
        store: /\.(png|jpe?g|gif|webp|avif|zip|gz|7z|rar|mp4|webm|mp3|ogg|pdf)$/i.test(entry.name),
      });
    }
    await archive.finalize();
  }

  /**
   * Reads the first file part of a multipart request.
   *
   * The stream is handed to the service unread: the point of streaming is that the bytes go from
   * the socket to disk through a hash without ever being buffered whole, so anything that consumed
   * it here would defeat that.
   */
  private async firstFile(request: FastifyRequest) {
    const multipart = request as FastifyRequest & {
      parts: () => AsyncIterableIterator<
        | {
            type: 'file';
            filename: string;
            mimetype: string;
            // busboy sets `truncated` on this stream once it cuts at limits.fileSize.
            file: AsyncIterable<Buffer> & { truncated?: boolean };
          }
        | { type: 'field'; fieldname: string; value: unknown }
      >;
    };

    const target: { issueId?: number; commentId?: number | null; description?: string } = {};
    for await (const part of multipart.parts()) {
      if (part.type === 'field') {
        // Fields are only usable when they arrive BEFORE the file part, which is what every
        // multipart client does in practice and what the frontend's FormData produces.
        if (part.fieldname === 'issueId') {
          const value = Number(part.value);
          if (Number.isInteger(value) && value > 0) target.issueId = value;
        }
        if (part.fieldname === 'commentId') {
          const value = Number(part.value);
          if (Number.isInteger(value) && value > 0) target.commentId = value;
        }
        if (part.fieldname === 'description') target.description = String(part.value);
        continue;
      }
      return {
        file: {
          filename: part.filename,
          mimetype: part.mimetype,
          stream: part.file as unknown as NodeJS.ReadableStream,
          /**
           * Checked AFTER the stream is consumed, which is the only moment it is meaningful.
           *
           * The multipart layer enforces its size limit by truncating rather than throwing, so
           * without this an oversized upload is stored as a complete-looking file of exactly the
           * limit — a silently corrupted file, presented as whole.
           */
          wasTruncated: () => part.file.truncated === true,
        } as never,
        target,
      };
    }
    throw new ValidationError('files.required', 'A file part is required');
  }

  private async send(
    actor: AuthUser,
    id: number,
    reply: FastifyReply,
    // `| undefined` spelled out rather than optional: exactOptionalPropertyTypes distinguishes
    // "absent" from "present and undefined", and a missing header is the latter.
    options: {
      disposition: 'inline' | 'attachment';
      range: string | undefined;
      ifNoneMatch: string | undefined;
    },
  ): Promise<void> {
    const { attachment, size } = await this.attachments.forDownload(actor, id);
    // The hash IS the version, so the validator is exact and the cache can be immutable.
    const etag = `"${attachment.blobHash}"`;

    if (options.ifNoneMatch === etag) {
      void reply.status(304).header('etag', etag).send();
      return;
    }

    const served = attachment.sniffedMimeType ?? attachment.mimeType;
    const inline = options.disposition === 'inline' && canRenderInline(served);
    const filename = encodeURIComponent(attachment.name);

    void reply
      .header('etag', etag)
      // Safe to cache forever: the bytes behind a hash cannot change. `private` because
      // authorization is per user.
      .header('cache-control', 'private, max-age=31536000, immutable')
      .header('accept-ranges', 'bytes')
      .header('x-content-type-options', 'nosniff')
      .header('content-type', inline ? served : 'application/octet-stream')
      .header(
        'content-disposition',
        `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${filename}`,
      );

    if (inline) {
      // Second layer behind the type allow-list: even if something scriptable slipped through, it
      // has no origin to act in.
      void reply.header('content-security-policy', "default-src 'none'; sandbox");
    }

    const parsed = parseRange(options.range, size);
    if (parsed === 'unsatisfiable') {
      void reply.status(416).header('content-range', `bytes */${size}`).send();
      return;
    }

    if (parsed) {
      const stream = await this.attachments.openBlob(attachment.blobHash, parsed);
      void reply
        .status(206)
        .header('content-range', `bytes ${parsed.start}-${parsed.end}/${size}`)
        .header('content-length', String(parsed.end - parsed.start + 1))
        .send(stream);
      return;
    }

    const stream = await this.attachments.openBlob(attachment.blobHash);
    void reply.header('content-length', String(size)).send(stream);
  }
}

/**
 * `bytes=0-1023`, `bytes=1024-`, `bytes=-500`.
 *
 * Only the single-range form. A multi-range request falls back to the whole body, which is a legal
 * response and avoids building multipart/byteranges for a case no player sends.
 */
function parseRange(
  header: string | undefined,
  size: number,
): { start: number; end: number } | 'unsatisfiable' | null {
  if (!header || !header.startsWith('bytes=') || header.includes(',')) return null;
  const [rawStart, rawEnd] = header.slice(6).split('-');
  if (rawStart === undefined || rawEnd === undefined) return null;

  let start: number;
  let end: number;
  if (rawStart === '') {
    // A suffix range: the last N bytes.
    const suffix = Number(rawEnd);
    if (!Number.isFinite(suffix) || suffix <= 0) return null;
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(rawStart);
    end = rawEnd === '' ? size - 1 : Number(rawEnd);
  }

  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  if (start > end || start >= size) return 'unsatisfiable';
  return { start, end: Math.min(end, size - 1) };
}

export { MAX_FILE_SIZE };

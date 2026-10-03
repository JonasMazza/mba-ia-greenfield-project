import { DomainException } from '../common/exceptions/domain.exception';

export class FileTooLargeException extends DomainException {
  constructor(maxBytes: number) {
    super(
      'FILE_TOO_LARGE',
      413,
      `File exceeds the maximum upload size of ${maxBytes} bytes`,
    );
  }
}

/**
 * Also raised when the caller is not the owner: leaking `403` would confirm that
 * a `public_id` exists.
 */
export class VideoNotFoundException extends DomainException {
  constructor() {
    super('VIDEO_NOT_FOUND', 404, 'Video not found');
  }
}

/** Only the owner ever sees this: for anyone else the video is simply not found. */
export class VideoNotReadyException extends DomainException {
  constructor() {
    super('VIDEO_NOT_READY', 409, 'Video is not ready for playback yet');
  }
}

export class InvalidUploadStateException extends DomainException {
  constructor() {
    super(
      'INVALID_UPLOAD_STATE',
      409,
      'The video has no active multipart upload',
    );
  }
}

export class UnsupportedMediaTypeException extends DomainException {
  constructor(contentType: string) {
    super(
      'UNSUPPORTED_MEDIA_TYPE',
      415,
      `Content type "${contentType}" is not a supported video type`,
    );
  }
}

/**
 * The size declared at initiate is only the client's word; completing is refused
 * unless the stored parts add up to it, which keeps the upload ceiling real.
 */
export class UploadSizeMismatchException extends DomainException {
  constructor(declaredBytes: number, uploadedBytes: number) {
    super(
      'UPLOAD_SIZE_MISMATCH',
      409,
      `Uploaded parts total ${uploadedBytes} bytes but the upload declared ${declaredBytes} bytes`,
    );
  }
}

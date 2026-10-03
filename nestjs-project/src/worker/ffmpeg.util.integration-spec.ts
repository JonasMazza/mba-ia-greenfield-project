import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { MediaToolError, probeVideo } from './ffmpeg.util';

describe('ffmpeg.util (integration)', () => {
  let server: Server;
  let hangingUrl: string;

  beforeAll(async () => {
    // Accepts the connection and never answers — a storage that stalls mid-read.
    server = createServer(() => undefined);
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const { port } = server.address() as AddressInfo;
    hangingUrl = `http://127.0.0.1:${port}/videos/stalled/source`;
  });

  afterAll(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });

  it('should give up on a stalled input once the deadline passes', async () => {
    const startedAt = Date.now();

    const probe = probeVideo(hangingUrl, AbortSignal.timeout(500));

    await expect(probe).rejects.toBeInstanceOf(MediaToolError);
    await expect(probe).rejects.toThrow(
      'ffprobe could not read the source video (timed out)',
    );
    expect(Date.now() - startedAt).toBeLessThan(10000);
  }, 20000);
});

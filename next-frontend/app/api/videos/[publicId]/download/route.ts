import { optionalAuthedUpstream } from "@/lib/api/authed";
import { upstream } from "@/lib/api/upstream";
import { redirectToPresigned } from "@/lib/videos/redirect-to-storage";

type RouteContext = { params: Promise<{ publicId: string }> };

/** `<a download>` target: same handshake as stream, the upstream URL carries the attachment disposition. */
export async function GET(_request: Request, { params }: RouteContext) {
  const { publicId } = await params;

  const result = await optionalAuthedUpstream((headers) =>
    upstream.GET("/videos/{publicId}/download", {
      params: { path: { publicId } },
      headers,
    })
  );

  return redirectToPresigned(result);
}

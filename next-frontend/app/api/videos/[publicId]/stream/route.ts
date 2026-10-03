import { optionalAuthedUpstream } from "@/lib/api/authed";
import { upstream } from "@/lib/api/upstream";
import { redirectToPresigned } from "@/lib/videos/redirect-to-storage";

type RouteContext = { params: Promise<{ publicId: string }> };

/** `<video src>` target: authorizes upstream and 307s to a freshly signed, Range-capable storage URL. */
export async function GET(_request: Request, { params }: RouteContext) {
  const { publicId } = await params;

  const result = await optionalAuthedUpstream((headers) =>
    upstream.GET("/videos/{publicId}/stream", {
      params: { path: { publicId } },
      headers,
    })
  );

  return redirectToPresigned(result);
}

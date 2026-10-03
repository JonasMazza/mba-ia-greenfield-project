import { Card } from "@/components/ui/card"

// A missing video and one that is not ready (for anyone but its owner) look
// the same: the upstream answers 404 for both, never 403 — nothing leaks.
export default function VideoNotFound() {
  return (
    <main className="flex flex-1 items-center justify-center bg-background px-6 py-10">
      <Card className="w-full max-w-[448px] items-center gap-4 px-6 py-10">
        <h1 className="text-h1 text-foreground text-center">Video unavailable</h1>
        <p className="text-body-md text-foreground text-center">
          This video does not exist or is not available yet.
        </p>
      </Card>
    </main>
  )
}

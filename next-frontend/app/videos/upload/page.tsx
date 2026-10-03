import { redirect } from "next/navigation"

import { Card } from "@/components/ui/card"
import { UploadPanel } from "@/components/videos/upload-panel"
import { getSession } from "@/lib/auth/session"
import type { ResumeTarget } from "@/lib/videos/uploader"

type SearchParams = Promise<{ [key: string]: string | string[] | undefined }>

/** `?resume=<public_id>&size=<bytes>` — anything malformed is a fresh upload. */
function parseResume(resume: unknown, size: unknown): ResumeTarget | null {
  if (typeof resume !== "string" || !resume || typeof size !== "string") return null
  const sizeBytes = Number(size)
  if (!Number.isSafeInteger(sizeBytes) || sizeBytes <= 0) return null
  return { publicId: resume, sizeBytes }
}

export default async function UploadVideoPage({ searchParams }: { searchParams: SearchParams }) {
  const session = await getSession()
  if (!session.isLoggedIn) redirect("/login")

  const { resume, size } = await searchParams

  return (
    <main className="flex flex-1 items-center justify-center bg-background px-6 py-10">
      <Card className="w-full max-w-[560px] items-center gap-6 px-6 py-10">
        <h1 className="text-h1 text-foreground text-center">Upload a video</h1>
        <UploadPanel resume={parseResume(resume, size)} />
      </Card>
    </main>
  )
}

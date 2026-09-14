import { describe, expect, it } from "vitest"
import { BlobSignalRepository } from "./blob-storage"

const live = process.env.RUN_BLOB_LIVE === "1" ? describe : describe.skip

live("BlobSignalRepository live OIDC probe", () => {
  it("reads the provisioned private store and performs two CAS transactions", async () => {
    const repository = new BlobSignalRepository()
    await expect(repository.read()).resolves.toBeDefined()
    await expect(repository.transaction((current) => current.listRuns().length)).resolves.toBeTypeOf("number")
    await expect(repository.transaction((current) => current.listRuns().length)).resolves.toBeTypeOf("number")
  })
})

import { createEditorController } from "@alwith/module-editor"
import { createFileSystem } from "@alwith/module-fs"
import { createMemoryAdapter } from "@alwith/module-fs/testing"
import { expect, test } from "vitest"

import { createResilientWriteFileSystem } from "../resilient-write-fs"

const PATH = "/repo/notes.md"
const BASE = "# Notes\n\nOriginal\n"
const decoder = new TextDecoder()
const encoder = new TextEncoder()

function setup() {
  const adapter = createMemoryAdapter({ [PATH]: BASE })
  const base = createFileSystem({
    adapter,
    reportError: (error) => {
      throw error
    }
  })
  const fs = createResilientWriteFileSystem(base)
  const controller = createEditorController({
    fs,
    confirmClose: () => Promise.resolve("cancel"),
    reportError: () => {}
  })
  return { base, fs, controller }
}

test("a same-body version rotation does not block a Markdown autosave", async () => {
  const { base, controller } = setup()
  const document = await controller.open(PATH)
  controller.update(document.id, "# Notes\n\nEdited\n")
  // Drive re-uploads the same body and the backend issues a new version marker.
  await base.writeFile(PATH, encoder.encode(BASE), { mode: "replace" })

  await controller.save(document.id)

  expect(decoder.decode(await base.readFile(PATH))).toBe("# Notes\n\nEdited\n")
  expect(controller.getSnapshot().documents[0]).toMatchObject({
    text: "# Notes\n\nEdited\n",
    savedText: "# Notes\n\nEdited\n",
    dirty: false
  })
})

test("the exact draft already on disk is adopted without another write", async () => {
  const { base, controller } = setup()
  const document = await controller.open(PATH)
  controller.update(document.id, "# Notes\n\nSame draft\n")
  await base.writeFile(PATH, encoder.encode("# Notes\n\nSame draft\n"), { mode: "replace" })
  const before = await base.stat(PATH)

  await controller.save(document.id)

  // The conditional attempt is rejected before mutation; the version is not advanced by us.
  expect((await base.stat(PATH))?.version).toBe(before?.version)
  expect(controller.getSnapshot().documents[0]).toMatchObject({ dirty: false, savedText: "# Notes\n\nSame draft\n" })
})

test("a real concurrent body change stays on disk and leaves the local draft dirty", async () => {
  const { base, controller } = setup()
  const document = await controller.open(PATH)
  controller.update(document.id, "# Notes\n\nLocal draft\n")
  await base.writeFile(PATH, encoder.encode("# Notes\n\nCloud edit\n"), { mode: "replace" })

  await expect(controller.save(document.id)).rejects.toThrow(/changed on disk/i)

  expect(decoder.decode(await base.readFile(PATH))).toBe("# Notes\n\nCloud edit\n")
  expect(controller.getSnapshot().documents[0]).toMatchObject({
    text: "# Notes\n\nLocal draft\n",
    dirty: true
  })
})

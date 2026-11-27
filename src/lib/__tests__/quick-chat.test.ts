import { afterEach, expect, test, vi } from "vitest"

import { commands } from "@/bindings"

import { createChatDirectory, deleteChatOwnDirectory, isTemporaryChatDir, primeQuickChatRoot } from "../quick-chat"

const ROOT = "/Users/me/Chats"

afterEach(() => vi.restoreAllMocks())

test("new chats use YY-MM-DD-HH-MM-SS below the configured root", async () => {
  vi.spyOn(commands, "quickChatDirectory").mockResolvedValue(ROOT)
  const create = vi
    .spyOn(commands, "newChatDirectory")
    .mockResolvedValue(`${ROOT}/26-11-28-09-08-07`)
  await primeQuickChatRoot()

  await expect(createChatDirectory(new Date(2026, 10, 28, 9, 8, 7))).resolves.toBe(`${ROOT}/26-11-28-09-08-07`)
  expect(create).toHaveBeenCalledWith({ stamp: "26-11-28-09-08-07" })
  expect(isTemporaryChatDir(`${ROOT}/26-11-28-09-08-07`)).toBe(true)
  expect(isTemporaryChatDir(`${ROOT}/Chat/2026-11-28 09-08-07`)).toBe(true)
  expect(isTemporaryChatDir(ROOT)).toBe(true)
  // Choosing a broad parent such as ~/Documents must not turn every project below it into a chat.
  expect(isTemporaryChatDir(`${ROOT}/work-project`)).toBe(false)
})

test("two chats requested in the same second retry with a unique folder name", async () => {
  vi.spyOn(commands, "quickChatDirectory").mockResolvedValue(ROOT)
  const create = vi
    .spyOn(commands, "newChatDirectory")
    .mockRejectedValueOnce(new Error("聊天文件夹已存在：/Users/me/Chats/26-11-28-09-08-07"))
    .mockResolvedValueOnce(`${ROOT}/26-11-28-09-08-08`)
  await primeQuickChatRoot()

  await expect(createChatDirectory(new Date(2026, 10, 28, 9, 8, 7))).resolves.toBe(`${ROOT}/26-11-28-09-08-08`)
  expect(create.mock.calls.map(([args]) => args.stamp)).toEqual(["26-11-28-09-08-07", "26-11-28-09-08-08"])
})

test("deleting a chat removes its own folder but never a project or the shared root", async () => {
  vi.spyOn(commands, "quickChatDirectory").mockResolvedValue(ROOT)
  const remove = vi.spyOn(commands, "deleteChatDirectory").mockResolvedValue(null)
  await primeQuickChatRoot()

  await expect(deleteChatOwnDirectory("/old/26-11-28-09-08-07")).resolves.toBe(true)
  expect(remove).toHaveBeenCalledWith({ path: "/old/26-11-28-09-08-07" })
  await expect(deleteChatOwnDirectory("/Users/me/project")).resolves.toBe(false)
  await expect(deleteChatOwnDirectory(ROOT)).resolves.toBe(false)
  expect(remove).toHaveBeenCalledTimes(1)
})

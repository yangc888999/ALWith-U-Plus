import { act, cleanup, renderHook } from "@testing-library/react"
import { afterEach, expect, test } from "vitest"

import { usePlatformAuth } from "@/features/auth/store"

import { profileOverrides } from "../profile-store"
import { useDisplayProfile } from "../use-display-profile"

afterEach(cleanup)

function setUser(user: { user_uuid?: string; nickname: string; login_email: string; avatar?: string } | null): void {
  act(() =>
    usePlatformAuth.setState({
      user: user === null ? null : { user_uuid: "u-1", ...user },
      isAuthenticated: user !== null,
      isLoading: false,
      _initialized: true
    })
  )
}

test("falls back to the account nickname and avatar", () => {
  act(() => profileOverrides.setState({ owner: null, nickname: null, avatar: null }))
  setUser({ nickname: "Leo Wang", login_email: "leo@yup.id", avatar: "https://cdn/leo.png" })

  const { result } = renderHook(() => useDisplayProfile())

  expect(result.current).toEqual({
    displayName: "Leo Wang",
    accountName: "Leo Wang",
    email: "leo@yup.id",
    avatarUrl: "https://cdn/leo.png",
    initials: "LW",
    hasCustomAvatar: false
  })
})

test("a local nickname and avatar win over the account ones", () => {
  act(() => profileOverrides.setState({ owner: "u-1", nickname: "小哥哥", avatar: "data:image/jpeg;base64,AAA" }))
  setUser({ nickname: "Leo Wang", login_email: "leo@yup.id", avatar: "https://cdn/leo.png" })

  const { result } = renderHook(() => useDisplayProfile())

  expect(result.current?.displayName).toBe("小哥哥")
  expect(result.current?.avatarUrl).toBe("data:image/jpeg;base64,AAA")
  expect(result.current?.initials).toBe("小哥")
  expect(result.current?.hasCustomAvatar).toBe(true)
})

test("another account never inherits the previous person's overrides", () => {
  act(() => profileOverrides.setState({ owner: "u-1", nickname: "小哥哥", avatar: "data:image/jpeg;base64,AAA" }))
  setUser({ user_uuid: "u-2", nickname: "Sam", login_email: "sam@yup.id" })

  const { result } = renderHook(() => useDisplayProfile())

  expect(result.current?.displayName).toBe("Sam")
  expect(result.current?.avatarUrl).toBeUndefined()
  expect(result.current?.hasCustomAvatar).toBe(false)
})

test("an empty account nickname falls back to the email, and no user means no profile", () => {
  act(() => profileOverrides.setState({ owner: null, nickname: "  ", avatar: null }))
  setUser({ nickname: "", login_email: "leo@yup.id" })

  const { result, rerender } = renderHook(() => useDisplayProfile())
  expect(result.current?.displayName).toBe("leo@yup.id")
  expect(result.current?.initials).toBe("LE")

  setUser(null)
  rerender()
  expect(result.current).toBeNull()
})

import { act, fireEvent, render, waitFor } from "@testing-library/react"
import { toast } from "sonner"
import { afterEach, expect, test, vi } from "vitest"

import { initI18n } from "@/lib/i18n"

import { type UpdaterState, useUpdaterStore } from "../../store"
import { UpdateStatusButton } from "../update-status-button"

await initI18n("en")
const originalState = useUpdaterStore.getState()
const update = { version: "0.2.5", filename: "update.tar.gz", signature: "sig", contentLength: 100 }

afterEach(() => {
  useUpdaterStore.setState(originalState, true)
  vi.restoreAllMocks()
})

test.each<UpdaterState>([
  { type: "uninitialized" },
  { type: "idle" },
  { type: "checkingForUpdates" },
  { type: "disabled", reason: "invalidConfiguration" },
  { type: "availableForDownload", update }
])("hides the card in $type", (state) => {
  useUpdaterStore.setState({ state })
  expect(render(<UpdateStatusButton />).container).toBeEmptyDOMElement()
})

test.each([
  [25, 100, 25],
  [120, 100, 100],
  [0, null, 0]
])("shows download progress for %s of %s bytes", (downloadedBytes, totalBytes, percent) => {
  useUpdaterStore.setState({ state: { type: "downloading", update, downloadedBytes, totalBytes } })
  const view = render(<UpdateStatusButton />)
  expect(view.getByRole("progressbar")).toHaveAttribute("aria-valuenow", String(percent))
  expect(view.getByText(`Downloaded ${percent}%`)).toBeInTheDocument()
  expect(view.queryByRole("button")).toBeNull()
})

test("ready card displays the version and opens the existing confirmation", async () => {
  const confirm = vi.fn<() => Promise<void>>().mockResolvedValue()
  useUpdaterStore.setState({ state: { type: "ready", update }, confirmInstallAndRelaunch: confirm })
  const view = render(<UpdateStatusButton />)
  expect(view.getByText(/v0.2.5/)).toBeInTheDocument()
  await act(() => Promise.try(() => fireEvent.click(view.getByRole("button", { name: /Downloaded — click to update/ }))))
  expect(confirm).toHaveBeenCalledOnce()
})

test("reports installation errors without echoing the native error", async () => {
  const error = vi.spyOn(toast, "error").mockReturnValue("error-toast")
  useUpdaterStore.setState({
    state: { type: "ready", update },
    confirmInstallAndRelaunch: vi.fn<() => Promise<void>>().mockRejectedValue(new Error("minisign: bad signature"))
  })
  const view = render(<UpdateStatusButton />)
  fireEvent.click(view.getAllByRole("button").find((button) => button.textContent?.includes("v0.2.5"))!)
  await waitFor(() =>
    expect(error).toHaveBeenCalledWith("Couldn't install the update")
  )
})

test("keeps installation feedback visible until restart", () => {
  useUpdaterStore.setState({ state: { type: "restarting", update } })
  const view = render(<UpdateStatusButton />)
  expect(view.getByRole("status")).toHaveTextContent("Installing…")
  expect(view.queryByRole("button")).toBeNull()
})

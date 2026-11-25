/**
 * Custom ProseMirror commands for the Markdown WYSIWYG toolbar.
 *
 * The presets' table helpers do not do what the toolbar needs: `deleteSelectedCellsCommand`
 * requires a CellSelection (a caret inside a cell is a TextSelection, so it returns false), and
 * `selectRowCommand`/`selectColCommand` only move the selection. These commands call
 * `deleteRow`/`deleteColumn` from `@milkdown/prose/tables` directly — they derive the selected
 * rectangle from the caret position, so a plain cursor works. All ProseMirror APIs come through
 * the `@milkdown/prose/*` subpaths to keep a single module instance.
 */
import { commandsCtx, editorViewCtx, type Editor } from "@milkdown/core"
import {
  blockquoteSchema,
  bulletListSchema,
  codeBlockSchema,
  listItemSchema,
  orderedListSchema,
  paragraphSchema
} from "@milkdown/preset-commonmark"
import { lift, setBlockType, toggleMark, wrapIn } from "@milkdown/prose/commands"
import type { Node as ProseNode } from "@milkdown/prose/model"
import { liftListItem, sinkListItem } from "@milkdown/prose/schema-list"
import type { EditorState } from "@milkdown/prose/state"
import { deleteColumn, deleteRow, deleteTable, isInTable, rowIsHeader, selectedRect } from "@milkdown/prose/tables"
import { $command, $useKeymap } from "@milkdown/utils"

import { underlineType } from "./markdown-underline"

/**
 * True when the caret sits inside a node of the given type (any ancestor depth).
 *
 * The type MUST come from `xxxSchema.type(ctx)`. The atoms' `.id` field is written inside the
 * plugin's async body, and the vendor presets are built against a nested copy of `@milkdown/utils`,
 * so `.id` is `undefined` on the atom this module imports. Only `.type(ctx)` resolves reliably.
 */
function hasAncestorOfType(state: EditorState, type: ProseNode["type"]): boolean {
  const { $from } = state.selection
  for (let depth = $from.depth; depth > 0; depth -= 1) {
    if ($from.node(depth).type === type) return true
  }
  return false
}

/** True when the caret sits inside a list item of the given list kind. */
function insideList(state: EditorState, listType: ProseNode["type"]): boolean {
  return hasAncestorOfType(state, listType)
}

/**
 * True when the caret sits inside any list item. `listItem` is resolved by the caller through
 * `listItemSchema.type(ctx)`; looking it up by name off `state.schema` used to read the atom's
 * always-undefined `.id` and made every list check silently false.
 */
function inListItem(state: EditorState, listItem: ProseNode["type"]): boolean {
  return hasAncestorOfType(state, listItem)
}

/** Toggle underline on the selection (Mod-u). */
export const toggleUnderlineCommand = $command("ToggleUnderline", (ctx) => () =>
  toggleMark(underlineType(ctx))
)

/** Blockquote is a toggle: lift out when already quoted, wrap otherwise. */
export const toggleBlockquoteCommand = $command("ToggleBlockquote", (ctx) => () => {
  const blockquote = blockquoteSchema.type(ctx)
  return (state, dispatch, view) => {
    if (insideList(state, blockquote)) return lift(state, dispatch, view)
    return wrapIn(blockquote)(state, dispatch, view)
  }
})

/**
 * Bullet list toggle. Lifting only runs when the caret is actually inside a bullet list —
 * `liftListItem` alone would also lift items of an ordered list, which must stay untouched.
 */
export const toggleBulletListCommand = $command("ToggleBulletList", (ctx) => () => {
  const bulletList = bulletListSchema.type(ctx)
  const listItem = listItemSchema.type(ctx)
  return (state, dispatch, view) => {
    if (insideList(state, bulletList)) return liftListItem(listItem)(state, dispatch, view)
    return wrapIn(bulletList)(state, dispatch, view)
  }
})

/** Ordered list toggle, mirroring the bullet-list command. */
export const toggleOrderedListCommand = $command("ToggleOrderedList", (ctx) => () => {
  const orderedList = orderedListSchema.type(ctx)
  const listItem = listItemSchema.type(ctx)
  return (state, dispatch, view) => {
    if (insideList(state, orderedList)) return liftListItem(listItem)(state, dispatch, view)
    return wrapIn(orderedList)(state, dispatch, view)
  }
})

/**
 * Indent: inside a list, sink the item one level; outside a list, wrap into a bullet list first
 * so the button always produces a visible nesting change. Two dispatches are deliberate — the
 * sink needs the state *after* the wrap, and both land on the history stack.
 */
export const indentCommand = $command("WysiwygIndent", (ctx) => () => {
  const listItem = listItemSchema.type(ctx)
  const bulletList = bulletListSchema.type(ctx)
  const sink = sinkListItem(listItem)
  const wrap = wrapIn(bulletList)
  return (state, dispatch, view) => {
    if (inListItem(state, listItem)) return sink(state, dispatch, view)
    if (!dispatch) return wrap(state)
    let wrapped: EditorState | null = null
    const ok = wrap(state, (tr) => {
      wrapped = state.apply(tr)
      dispatch(tr)
    }, view)
    if (!ok || wrapped === null) return false
    sink(wrapped, dispatch, view)
    return true
  }
})

/** Outdent: lift a list item one level; outside a list, lift the block (e.g. escape a quote). */
export const outdentCommand = $command("WysiwygOutdent", (ctx) => () => {
  const listItem = listItemSchema.type(ctx)
  return (state, dispatch, view) => {
    if (inListItem(state, listItem)) return liftListItem(listItem)(state, dispatch, view)
    return lift(state, dispatch, view)
  }
})

/** Code block toggle: inside one, turn back into a paragraph; otherwise create an empty block. */
export const toggleCodeBlockCommand = $command("ToggleCodeBlock", (ctx) => () => {
  const codeBlock = codeBlockSchema.type(ctx)
  const paragraph = paragraphSchema.type(ctx)
  return (state, dispatch, view) => {
    if (state.selection.$from.parent.type === codeBlock) {
      return setBlockType(paragraph)(state, dispatch, view)
    }
    return setBlockType(codeBlock, { language: "" })(state, dispatch, view)
  }
})

/**
 * Delete the row under the caret. `deleteRow` refuses when the selection spans every row (it
 * would leave an empty shell), so the last-row case removes the whole table instead — the
 * toolbar's 删除行 must never be a silent no-op.
 */
export const deleteTableRowCommand = $command("DeleteTableRow", () => () => (state, dispatch) => {
  if (!isInTable(state)) return false
  const rect = selectedRect(state)
  if (rect.top === 0 && rect.bottom === rect.map.height) return deleteTable(state, dispatch)
  // A Markdown table always keeps its header row, so deleting the last *body* row while the
  // caret is in the header would silently no-op. Treat "only the header remains" as the
  // last-row case and remove the whole table instead.
  if (rect.map.height <= 2 && rect.top === 0 && rowIsHeader(rect.map, rect.table, 0)) {
    return deleteTable(state, dispatch)
  }
  return deleteRow(state, dispatch)
})

/** Delete the column under the caret; deleting the last column removes the table. */
export const deleteTableColumnCommand = $command("DeleteTableColumn", () => () => (state, dispatch) => {
  if (!isInTable(state)) return false
  const rect = selectedRect(state)
  if (rect.left === 0 && rect.right === rect.map.width) return deleteTable(state, dispatch)
  return deleteColumn(state, dispatch)
})

/** Mod-u for underline; Mod-]/Mod-[ for indent/outdent (Tab is deliberately not hijacked). */
export const wysiwygKeymap = $useKeymap("alwithWysiwyg", {
  Underline: {
    shortcuts: "Mod-u",
    command: (ctx) => {
      const commands = ctx.get(commandsCtx)
      return () => commands.call(toggleUnderlineCommand.key)
    }
  },
  Indent: {
    shortcuts: "Mod-]",
    command: (ctx) => {
      const commands = ctx.get(commandsCtx)
      return () => commands.call(indentCommand.key)
    }
  },
  Outdent: {
    shortcuts: "Mod-[",
    command: (ctx) => {
      const commands = ctx.get(commandsCtx)
      return () => commands.call(outdentCommand.key)
    }
  }
})

/** All custom command plugins the wrapper installs, in load order. */
export const wysiwygMarkdownCommands = [
  toggleUnderlineCommand,
  toggleBlockquoteCommand,
  toggleBulletListCommand,
  toggleOrderedListCommand,
  indentCommand,
  outdentCommand,
  toggleCodeBlockCommand,
  deleteTableRowCommand,
  deleteTableColumnCommand
]

/** Focus the editor view after a toolbar action so typing continues where the caret was. */
export function focusEditor(editor: Editor): void {
  editor.action((ctx) => {
    ctx.get(editorViewCtx).focus()
  })
}

/** Re-exported for the format-state computation. */

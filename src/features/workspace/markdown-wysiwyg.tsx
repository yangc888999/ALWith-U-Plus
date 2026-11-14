/**
 * Markdown WYSIWYG integration: a formatting toolbar + underline mark + table row/column delete
 * commands, layered on top of whatever Markdown integration the host already provides (the Drive
 * collaboration/frontmatter integration when the drive is visible).
 *
 * The toolbar renders through `integration.render()`, which the preview places above the scroll
 * container. It must NOT use `context.setToolbarActions`: that slot belongs to EditorWorkbench and
 * the outline popover re-claims it ~800ms after mount (MutationObserver-driven revision), which
 * would make the toolbar flash and disappear.
 */
import type { Editor } from "@milkdown/core"
import { commandsCtx, editorViewCtx, remarkStringifyOptionsCtx, schemaCtx } from "@milkdown/core"
import type { Ctx } from "@milkdown/ctx"
import type {
  MarkdownIntegration,
  PreviewContext
} from "@alwith/module-editor/previews"
import {
  blockquoteSchema,
  bulletListSchema,
  codeBlockSchema,
  emphasisSchema,
  inlineCodeSchema,
  isMarkSelectedCommand,
  isNodeSelectedCommand,
  orderedListSchema,
  strongSchema,
  toggleEmphasisCommand,
  toggleInlineCodeCommand,
  toggleStrongCommand
} from "@milkdown/preset-commonmark"
import { insertTableCommand, strikethroughSchema, toggleStrikethroughCommand } from "@milkdown/preset-gfm"
import type { MarkType, NodeType } from "@milkdown/prose/model"
import type { EditorState } from "@milkdown/prose/state"
import { Plugin } from "@milkdown/prose/state"
import { isInTable } from "@milkdown/prose/tables"
import { $prose } from "@milkdown/utils"
import {
  Bold,
  Check,
  Code,
  Columns3,
  IndentDecrease,
  IndentIncrease,
  Italic,
  List,
  ListOrdered,
  Pencil,
  Quote,
  Rows3,
  SquareCode,
  Strikethrough,
  Table,
  Underline
} from "lucide-react"
import type { ReactNode } from "react"
import { useEffect, useState, useSyncExternalStore } from "react"

import {
  deleteTableColumnCommand,
  deleteTableRowCommand,
  focusEditor,
  indentCommand,
  outdentCommand,
  toggleBlockquoteCommand,
  toggleBulletListCommand,
  toggleCodeBlockCommand,
  toggleOrderedListCommand,
  toggleUnderlineCommand,
  wysiwygKeymap,
  wysiwygMarkdownCommands
} from "./markdown-commands"
import { underlineRemark, underlineSchema, withUnderlineHandler } from "./markdown-underline"
import { Toolbar, type ToolbarItem } from "./components/Toolbar"
import {
  createSnapshotStore,
  EMPTY_FORMAT_STATE,
  formatStateEqual,
  type FormatState,
  type SnapshotStore,
  type WysiwygCommand,
  type WysiwygLabels
} from "./wysiwyg-types"

/**
 * The schema types the toolbar compares against, resolved once per editor.
 *
 * Every entry comes from `xxxSchema.type(ctx)`. NEVER read `xxxSchema.id`: `@milkdown/utils`
 * assigns `plugin.id` inside the plugin's async body, and the vendor presets resolve against a
 * nested copy of that package, so the atoms imported here keep `id === undefined` forever.
 * `.type(ctx)` reads `schemaCtx` and is the only reliable lookup — it also sidesteps the
 * registered names' inconsistent casing (`strike_through`, `code_block`, `bullet_list`,
 * `list_item` use underscores while `inlineCode` does not).
 *
 * Resolution deliberately throws rather than falling back to "inactive": a missing type means a
 * preset failed to load, and silently reporting every format as off is exactly the defect this
 * module was fixed for. The Markdown preview always loads commonmark + gfm, and `underlineSchema`
 * is installed by `configure`, so all nine lookups are guaranteed to resolve.
 */
export interface ToolbarSchema {
  strong: MarkType
  emphasis: MarkType
  underline: MarkType
  strikethrough: MarkType
  inlineCode: MarkType
  blockquote: NodeType
  bulletList: NodeType
  orderedList: NodeType
  codeBlock: NodeType
}

export function resolveToolbarSchema(ctx: Ctx): ToolbarSchema {
  return {
    strong: strongSchema.type(ctx),
    emphasis: emphasisSchema.type(ctx),
    underline: underlineSchema.type(ctx),
    strikethrough: strikethroughSchema.type(ctx),
    inlineCode: inlineCodeSchema.type(ctx),
    blockquote: blockquoteSchema.type(ctx),
    bulletList: bulletListSchema.type(ctx),
    orderedList: orderedListSchema.type(ctx),
    codeBlock: codeBlockSchema.type(ctx)
  }
}

/**
 * Compute the toolbar's pressed/disabled state. Pure for testability: the resolved schema and the
 * ProseMirror state are both passed in, so nothing is read from module or editor globals.
 */
export function computeFormatState(schema: ToolbarSchema, state: EditorState, canEdit: boolean): FormatState {
  const markActive = (type: MarkType): boolean => {
    const { from, to, empty, $from } = state.selection
    if (empty) {
      return (
        $from.marks().some((mark) => mark.type === type) ||
        Boolean(state.storedMarks?.some((mark) => mark.type === type))
      )
    }
    return state.doc.rangeHasMark(from, to, type)
  }
  let quoted = false
  let bulleted = false
  let numbered = false
  const { $from } = state.selection
  for (let depth = $from.depth; depth > 0; depth -= 1) {
    const type = $from.node(depth).type
    if (type === schema.blockquote) quoted = true
    if (type === schema.bulletList) bulleted = true
    if (type === schema.orderedList) numbered = true
  }
  return {
    bold: markActive(schema.strong),
    italic: markActive(schema.emphasis),
    underline: markActive(schema.underline),
    strike: markActive(schema.strikethrough),
    blockquote: quoted,
    ul: bulleted,
    ol: numbered,
    code: markActive(schema.inlineCode),
    codeBlock: $from.parent.type === schema.codeBlock,
    inTable: isInTable(state),
    hasImage: false,
    canEdit
  }
}

interface ToolbarButtonSpec {
  command: WysiwygCommand
  label: string
  icon: ReactNode
  /** Which FormatState flag lights the button up. */
  pressed?: keyof FormatState
  /** Disabled unless this flag is true (table deletes need a table). */
  requires?: keyof FormatState
  /** A separator is drawn before this button. */
  separator?: boolean
}

function buttonSpecs(labels: WysiwygLabels): ToolbarButtonSpec[] {
  return [
    { command: "bold", label: labels.bold, icon: <Bold />, pressed: "bold" },
    { command: "italic", label: labels.italic, icon: <Italic />, pressed: "italic" },
    { command: "underline", label: labels.underline, icon: <Underline />, pressed: "underline" },
    { command: "strike", label: labels.strikethrough, icon: <Strikethrough />, pressed: "strike" },
    { command: "inlineCode", label: labels.inlineCode, icon: <Code />, pressed: "code", separator: true },
    { command: "codeBlock", label: labels.codeBlock, icon: <SquareCode />, pressed: "codeBlock" },
    { command: "blockquote", label: labels.blockquote, icon: <Quote />, pressed: "blockquote", separator: true },
    { command: "bulletList", label: labels.bulletList, icon: <List />, pressed: "ul" },
    { command: "orderedList", label: labels.orderedList, icon: <ListOrdered />, pressed: "ol" },
    { command: "outdent", label: labels.outdent, icon: <IndentDecrease /> },
    { command: "indent", label: labels.indent, icon: <IndentIncrease /> },
    { command: "insertTable", label: labels.insertTable, icon: <Table />, separator: true },
    { command: "deleteRow", label: labels.deleteRow, icon: <Rows3 />, requires: "inTable" },
    { command: "deleteColumn", label: labels.deleteColumn, icon: <Columns3 />, requires: "inTable" }
  ]
}

/** Run a toolbar command against the live editor, then return focus to the document. */
function runCommand(editor: Editor, command: WysiwygCommand): void {
  editor.action((ctx) => {
    const commands = ctx.get(commandsCtx)
    switch (command) {
      case "bold":
        commands.call(toggleStrongCommand.key)
        break
      case "italic":
        commands.call(toggleEmphasisCommand.key)
        break
      case "underline":
        commands.call(toggleUnderlineCommand.key)
        break
      case "strike":
        commands.call(toggleStrikethroughCommand.key)
        break
      case "blockquote":
        commands.call(toggleBlockquoteCommand.key)
        break
      case "bulletList":
        commands.call(toggleBulletListCommand.key)
        break
      case "orderedList":
        commands.call(toggleOrderedListCommand.key)
        break
      case "outdent":
        commands.call(outdentCommand.key)
        break
      case "indent":
        commands.call(indentCommand.key)
        break
      case "inlineCode":
        commands.call(toggleInlineCodeCommand.key)
        break
      case "codeBlock":
        commands.call(toggleCodeBlockCommand.key)
        break
      case "insertTable":
        commands.call(insertTableCommand.key, { row: 3, col: 3 })
        break
      case "deleteRow":
        commands.call(deleteTableRowCommand.key)
        break
      case "deleteColumn":
        commands.call(deleteTableColumnCommand.key)
        break
      case "deleteImage":
        // Markdown images are deleted through the caret + Backspace; no toolbar entry.
        break
    }
  })
  focusEditor(editor)
}

function MarkdownToolbar({
  store,
  editor,
  labels,
  readOnly
}: {
  store: SnapshotStore<FormatState>
  editor: () => Editor | null
  labels: WysiwygLabels
  readOnly: boolean
}): ReactNode {
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot)
  const [editing, setEditing] = useState(!readOnly)

  // The toolbar's edit toggle is the single source of truth for Milkdown's editability; mirror it
  // onto the live view (and onto external read-only changes) so a "read-only preview" really is.
  useEffect(() => {
    setEditing(!readOnly)
  }, [readOnly])
  useEffect(() => {
    const instance = editor()
    if (instance === null) return
    instance.action((ctx) => {
      const view = ctx.get(editorViewCtx)
      view.setProps({ editable: () => editing && !readOnly })
    })
  }, [editing, readOnly, editor])

  const canEdit = state.canEdit
  const formatDisabled = !editing || !canEdit
  // The edit button is disabled only when the surface can never be edited (e.g. a read-only doc);
  // once editing is allowed it stays clickable so the user can leave edit mode again.
  const editDisabled = !canEdit && !editing

  const editIcon = editing ? <Check /> : <Pencil />
  const editLabel = editing ? labels.finishEditHtml : labels.editHtml

  const items: ToolbarItem[] = [
    {
      key: "edit-markdown",
      variant: "primary",
      icon: editIcon,
      label: editLabel,
      title: readOnly ? labels.htmlEditBlocked : editLabel,
      ariaLabel: editLabel,
      pressed: editing,
      disabled: editDisabled,
      keepSelection: false,
      onClick: () => setEditing((value) => !value)
    },
    ...buttonSpecs(labels).map((spec) => ({
      key: spec.command,
      icon: spec.icon,
      title: spec.label,
      ariaLabel: spec.label,
      pressed: spec.pressed !== undefined ? state[spec.pressed] : undefined,
      disabled: formatDisabled || (spec.requires !== undefined && !state[spec.requires]),
      separator: spec.separator,
      onClick: () => {
        const instance = editor()
        if (instance !== null) runCommand(instance, spec.command)
      }
    }))
  ]

  return <Toolbar ariaLabel="Markdown formatting" items={items} />
}

/**
 * Wrap a base Markdown integration with the WYSIWYG toolbar. Every base hook is forwarded exactly
 * once so Drive collaboration, frontmatter and comments keep working; `render()` composes both
 * surfaces with a Fragment.
 */
export function createWysiwygMarkdownIntegration(
  base: MarkdownIntegration | undefined,
  context: PreviewContext,
  labels: WysiwygLabels
): MarkdownIntegration {
  const store = createSnapshotStore<FormatState>(EMPTY_FORMAT_STATE, formatStateEqual)
  let editorRef: Editor | null = null
  let disposed = false

  const formatPlugin = $prose((ctx) => {
    // Resolved once when the plugin is built (after SchemaReady), not on every view update: the
    // types are stable for the editor's lifetime and this runs on each keystroke.
    const schema = resolveToolbarSchema(ctx)
    return new Plugin({
      view: () => ({
        update: (view) => {
          if (disposed) return
          store.publish(computeFormatState(schema, view.state, !context.readOnly && (base?.editable() ?? true)))
        }
      })
    })
  })

  return {
    configure(editor) {
      base?.configure(editor)
      // $remark returns [optionsCtx, plugin]; both must load or the plugin's ctx.get(options) fails.
      editor.use(underlineRemark)
      editor.use([underlineSchema.ctx, underlineSchema.mark])
      editor.use(wysiwygMarkdownCommands)
      editor.use(wysiwygKeymap)
      editor.use(formatPlugin)
      // The stringify handler must exist before the processor is built (config → ConfigReady →
      // init reads remarkStringifyOptionsCtx), so injecting it here is guaranteed to take effect.
      editor.config((ctx) => {
        ctx.update(remarkStringifyOptionsCtx, (options) => withUnderlineHandler(options))
      })
    },
    async ready(editor) {
      await base?.ready(editor)
      if (disposed) return
      editorRef = editor
      editor.action((ctx) => {
        const { state } = ctx.get(editorViewCtx)
        store.publish(
          computeFormatState(resolveToolbarSchema(ctx), state, !context.readOnly && (base?.editable() ?? true))
        )
      })
    },
    dispose() {
      disposed = true
      editorRef = null
      base?.dispose()
    },
    editable: () => base?.editable() ?? true,
    serialize: (markdown) => base?.serialize(markdown) ?? markdown,
    applyExternal: (editor, next) => base?.applyExternal(editor, next) ?? false,
    render: () => (
      <>
        {base?.render()}
        <MarkdownToolbar
          store={store}
          editor={() => editorRef}
          labels={labels}
          readOnly={context.readOnly}
        />
      </>
    )
  }
}

/** The schema is needed by tests that build a standalone editor; re-export for convenience. */
export { schemaCtx, isMarkSelectedCommand, isNodeSelectedCommand }
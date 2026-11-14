/**
 * The resident edit bridge injected into the previewed HTML iframe.
 *
 * It is a *capability*, not an editing session: once injected it stays alive, and the host turns
 * `body.contentEditable` on/off through postMessage. Switching modes never rebuilds the iframe
 * (a rebuild would lose the caret and the native undo stack). The bridge guards itself against
 * double-injection, validates every host message by source + nonce, and reports selection state
 * and dirty HTML back to the host.
 *
 * `HTML_EDIT_BRIDGE_SOURCE` is a plain JS string so it can be embedded in a <script> tag; it is
 * wrapped by `htmlEditBridgeScript()` which escapes any closing-script sequence.
 */

/** Marker id on the injected <script> so serialization can strip exactly this node. */
export const HTML_EDIT_BRIDGE_ID = "__alwith-edit-bridge"

export const HTML_EDIT_BRIDGE_SOURCE = String.raw`
(function () {
  "use strict";
  if (window.__alwithHtmlEdit === true) return;
  window.__alwithHtmlEdit = true;

  var FRAME_SOURCE = "alwith-html-edit";
  var HOST_SOURCE = "alwith-html-edit-host";
  var NONCE = null;
  var editing = false;
  var selectedImage = null;
  var dirtyTimer = null;
  var pendingUndo = null;

  function post(type, payload) {
    try {
      var message = { source: FRAME_SOURCE, type: type, nonce: NONCE };
      if (payload) for (var key in payload) message[key] = payload[key];
      window.parent.postMessage(message, "*");
    } catch (error) {}
  }

  function body() { return document.body; }

  function selectionElement() {
    var selection = window.getSelection();
    if (!selection || selection.rangeCount === 0) return null;
    var node = selection.getRangeAt(0).commonAncestorContainer;
    return node.nodeType === 1 ? node : node.parentElement;
  }

  function tableContext() {
    var element = selectionElement();
    var cell = element ? element.closest("td, th") : null;
    if (!cell) return null;
    var row = cell.closest("tr");
    var table = cell.closest("table");
    if (!row || !table) return null;
    return { cell: cell, row: row, table: table };
  }

  function tableHasColspan(table) {
    for (var r = 0; r < table.rows.length; r++) {
      var cells = table.rows[r].cells;
      for (var c = 0; c < cells.length; c++) if (cells[c].colSpan > 1) return true;
    }
    return false;
  }

  function query(command) {
    try { return document.queryCommandState(command); } catch (error) { return false; }
  }

  function reportState() {
    var element = selectionElement();
    var context = tableContext();
    var inPre = element ? element.closest("pre") : null;
    var state = {
      bold: query("bold"),
      italic: query("italic"),
      underline: query("underline"),
      strike: query("strikeThrough"),
      blockquote: !!(element && element.closest("blockquote")),
      ul: !!(element && element.closest("ul")),
      ol: !!(element && element.closest("ol")),
      code: !!(element && element.closest("code")) && !inPre,
      codeBlock: !!inPre,
      inTable: !!context && !tableHasColspan(context.table),
      hasImage: selectedImage !== null,
      canEdit: editing
    };
    post("state", { state: state });
  }

  function exec(command, value) {
    try { return document.execCommand(command, false, value); } catch (error) { return false; }
  }

  function surroundSelection(tagName) {
    var selection = window.getSelection();
    if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return false;
    var range = selection.getRangeAt(0);
    var wrapper = document.createElement(tagName);
    try { range.surroundContents(wrapper); }
    catch (error) {
      var fragment = range.extractContents();
      wrapper.appendChild(fragment);
      range.insertNode(wrapper);
    }
    return true;
  }

  function removable(node) {
    var parent = node.parentNode;
    var next = node.nextSibling;
    return function () { if (parent) { parent.insertBefore(node, next); return true; } return false; };
  }

  function deleteRow() {
    var context = tableContext();
    if (!context) return null;
    if (context.table.rows.length <= 1) {
      var undoTable = removable(context.table);
      context.table.remove();
      return { kind: "table", undo: undoTable };
    }
    var undo = removable(context.row);
    context.row.remove();
    return { kind: "row", undo: undo };
  }

  function deleteColumn() {
    var context = tableContext();
    if (!context) return null;
    if (tableHasColspan(context.table)) return null;
    var index = context.cell.cellIndex;
    var rows = Array.prototype.slice.call(context.table.rows);
    var width = rows[0] ? rows[0].cells.length : 0;
    if (width <= 1) {
      var undoTable = removable(context.table);
      context.table.remove();
      return { kind: "table", undo: undoTable };
    }
    var removed = [];
    for (var r = 0; r < rows.length; r++) {
      var target = rows[r].cells[index];
      if (!target) continue;
      removed.push({ node: target, parent: rows[r], next: target.nextSibling });
      target.remove();
    }
    if (removed.length === 0) return null;
    return { kind: "column", undo: function () {
      for (var i = 0; i < removed.length; i++) removed[i].parent.insertBefore(removed[i].node, removed[i].next);
      return true;
    } };
  }

  function toggleBlockquoteDom() {
    var element = selectionElement();
    var existing = element ? element.closest("blockquote") : null;
    if (existing) {
      var parent = existing.parentNode;
      if (!parent) return false;
      while (existing.firstChild) parent.insertBefore(existing.firstChild, existing);
      existing.remove();
      return true;
    }
    var selection = window.getSelection();
    if (!selection || selection.rangeCount === 0) return false;
    var range = selection.getRangeAt(0);
    var quote = document.createElement("blockquote");
    try { range.surroundContents(quote); }
    catch (error) { quote.appendChild(range.extractContents()); range.insertNode(quote); }
    return true;
  }

  function indentDom(outward) {
    var element = selectionElement();
    var block = element ? element.closest("p, div, h1, h2, h3, h4, h5, h6, pre") : null;
    if (!block) return false;
    var wrapper = block.parentElement;
    var isWrapped = wrapper && wrapper.tagName === "DIV" && wrapper.style.marginLeft !== "";
    if (outward) {
      if (!isWrapped) return false;
      var parent = wrapper.parentNode;
      if (!parent) return false;
      parent.insertBefore(block, wrapper);
      if (wrapper.childElementCount === 0) wrapper.remove();
      return true;
    }
    if (isWrapped) {
      var current = parseInt(wrapper.style.marginLeft, 10) || 0;
      wrapper.style.marginLeft = (current + 24) + "px";
      return true;
    }
    var parent2 = block.parentNode;
    if (!parent2) return false;
    var div = document.createElement("div");
    div.style.marginLeft = "24px";
    parent2.insertBefore(div, block);
    div.appendChild(block);
    return true;
  }

  function serialize() {
    var clone = document.cloneNode(true);
    var remove = function (selector) {
      var nodes = clone.querySelectorAll(selector);
      for (var i = 0; i < nodes.length; i++) nodes[i].remove();
    };
    remove('script[data-alwith-bridge="edit"], #__alwith-edit-bridge, #__alwith-edit-style');
    remove('script[src$="__alwith-menu.js"]');
    var scripts = clone.querySelectorAll("script");
    for (var s = 0; s < scripts.length; s++) {
      if ((scripts[s].textContent || "").indexOf("__alwithPreviewMenu") >= 0) scripts[s].remove();
    }
    // Drive comment bridge artifacts: the injected style, the number markers and the highlight
    // spans (unwrap, keeping the quoted text). The bridge script itself carries the drive marker.
    remove("#yup-comment-style, script[data-alwith-bridge]");
    var markers = clone.querySelectorAll(".yup-comment-marker");
    for (var k = 0; k < markers.length; k++) markers[k].remove();
    var highlights = clone.querySelectorAll(".yup-comment-highlight");
    for (var h = 0; h < highlights.length; h++) {
      var span = highlights[h];
      var spanParent = span.parentNode;
      if (!spanParent) continue;
      while (span.firstChild) spanParent.insertBefore(span.firstChild, span);
      span.remove();
    }
    var editable = clone.querySelectorAll("[contenteditable]");
    for (var e = 0; e < editable.length; e++) editable[e].removeAttribute("contenteditable");
    var selected = clone.querySelectorAll(".alwith-img-selected");
    for (var m = 0; m < selected.length; m++) {
      selected[m].classList.remove("alwith-img-selected");
      if (selected[m].classList.length === 0) selected[m].removeAttribute("class");
    }
    var classed = clone.querySelectorAll("[class]");
    for (var c = 0; c < classed.length; c++) if (classed[c].getAttribute("class") === "") classed[c].removeAttribute("class");
    var cloneBody = clone.querySelector("body");
    if (cloneBody) {
      cloneBody.classList.remove("alwith-html-editing");
      if (cloneBody.classList.length === 0) cloneBody.removeAttribute("class");
    }
    var doctype = clone.doctype;
    var doctypeText = "";
    if (doctype) {
      doctypeText = "<!DOCTYPE " + doctype.name;
      if (doctype.publicId) doctypeText += ' PUBLIC "' + doctype.publicId + '"';
      if (doctype.systemId) doctypeText += ' "' + doctype.systemId + '"';
      doctypeText += ">";
    }
    return doctypeText + clone.documentElement.outerHTML;
  }

  function flush() {
    if (dirtyTimer) { clearTimeout(dirtyTimer); dirtyTimer = null; }
    post("dirty", { html: serialize() });
  }

  function scheduleFlush() {
    if (dirtyTimer) clearTimeout(dirtyTimer);
    dirtyTimer = setTimeout(function () { dirtyTimer = null; flush(); }, 600);
  }

  function selectImage(image) {
    if (selectedImage) selectedImage.classList.remove("alwith-img-selected");
    selectedImage = image;
    if (selectedImage) selectedImage.classList.add("alwith-img-selected");
    reportState();
  }

  function ensureStyle() {
    if (document.getElementById("__alwith-edit-style")) return;
    var style = document.createElement("style");
    style.id = "__alwith-edit-style";
    style.textContent =
      "body.alwith-html-editing{outline:none;}" +
      "body.alwith-html-editing img{cursor:pointer;}" +
      ".alwith-img-selected{outline:2px solid #3b82f6;outline-offset:2px;}" +
      // Drive comment bubbles (markers + highlights) are rendered by the Drive comment bridge inside
      // this same iframe. While editing they overlap the WYSIWYG surface and aren't editable, so hide
      // them. They are still stripped from the serialized save (see the #yup-comment-style handling
      // in serialize() above).
      "body.alwith-html-editing .yup-comment-marker,body.alwith-html-editing .yup-comment-highlight{display:none !important;}";
    (document.head || document.documentElement).appendChild(style);
  }

  function setEditing(on) {
    var b = body();
    if (!b) return;
    editing = on;
    b.contentEditable = on ? "true" : "false";
    if (on) { b.classList.add("alwith-html-editing"); ensureStyle(); }
    else { b.classList.remove("alwith-html-editing"); selectImage(null); }
    post("mode", { editing: on });
    reportState();
  }

  function runCommand(command) {
    var deletion = null;
    var changed = false;
    switch (command) {
      case "bold": changed = exec("bold"); break;
      case "italic": changed = exec("italic"); break;
      case "underline": changed = exec("underline") || surroundSelection("u"); break;
      case "strike": changed = exec("strikeThrough"); break;
      case "blockquote": changed = exec("formatBlock", "blockquote") || toggleBlockquoteDom(); break;
      case "bulletList": changed = exec("insertUnorderedList"); break;
      case "orderedList": changed = exec("insertOrderedList"); break;
      case "indent": changed = exec("indent") || indentDom(false); break;
      case "outdent": changed = exec("outdent") || indentDom(true); break;
      case "inlineCode": changed = surroundSelection("code"); break;
      case "codeBlock": changed = exec("formatBlock", "pre"); break;
      case "insertTable": changed = exec("insertHTML", "<table><tbody><tr><td><br></td><td><br></td><td><br></td></tr><tr><td><br></td><td><br></td><td><br></td></tr><tr><td><br></td><td><br></td><td><br></td></tr></tbody></table>"); break;
      case "deleteRow": deletion = deleteRow(); changed = !!deletion; break;
      case "deleteColumn": deletion = deleteColumn(); changed = !!deletion; break;
      case "deleteImage":
        if (selectedImage) { deletion = { kind: "image", undo: removable(selectedImage) }; selectedImage.remove(); selectImage(null); changed = true; }
        break;
    }
    if (deletion) pendingUndo = deletion.undo;
    if (changed) scheduleFlush();
    reportState();
    return deletion;
  }

  function undoPending() {
    if (pendingUndo && pendingUndo()) { pendingUndo = null; scheduleFlush(); reportState(); return true; }
    return false;
  }

  document.addEventListener("click", function (event) {
    if (!editing) return;
    var target = event.target;
    var image = target && target.closest ? target.closest("img") : null;
    if (image) { event.preventDefault(); selectImage(image); }
    else if (selectedImage) selectImage(null);
  }, true);

  document.addEventListener("keydown", function (event) {
    if (!editing) return;
    if ((event.key === "Delete" || event.key === "Backspace") && selectedImage) {
      event.preventDefault();
      runCommand("deleteImage");
      return;
    }
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
      event.preventDefault();
      flush();
    }
  }, true);

  document.addEventListener("selectionchange", function () { if (editing) reportState(); });
  document.addEventListener("input", function () { if (editing) scheduleFlush(); });

  window.addEventListener("message", function (event) {
    if (event.source !== window.parent) return;
    var data = event.data;
    if (!data || data.source !== HOST_SOURCE) return;
    // The host sends init with a placeholder nonce before it has seen our announce; adopting it
    // would break the handshake (our ready carries null, the host then expects the placeholder).
    // Keep the nonce we already minted and just re-announce readiness with it.
    if (data.type === "init") { if (NONCE === null) NONCE = data.nonce; post("ready", { editable: !!body() }); return; }
    if (NONCE === null || data.nonce !== NONCE) return;
    if (data.type === "set-mode") setEditing(!!data.editing);
    else if (data.type === "command") runCommand(data.command);
    else if (data.type === "flush") flush();
    else if (data.type === "undo") undoPending();
  });

  // Remove the Rust menu bridge's DOM nodes so they never reach a save. Their listeners stay
  // registered (the live preview keeps its translated right-click menu).
  function stripMenuBridgeNodes() {
    var external = document.querySelectorAll('script[src$="__alwith-menu.js"]');
    for (var i = 0; i < external.length; i++) external[i].remove();
    var scripts = document.querySelectorAll("script");
    for (var s = 0; s < scripts.length; s++) {
      if ((scripts[s].textContent || "").indexOf("__alwithPreviewMenu") >= 0) scripts[s].remove();
    }
  }

  function announce() {
    stripMenuBridgeNodes();
    post("ready", { editable: !!body() });
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", announce);
  else announce();
})();
`

/** Wrap the bridge in a <script> tag, escaping any closing-script sequence in the source. */
export function htmlEditBridgeScript(): string {
  const escaped = HTML_EDIT_BRIDGE_SOURCE.replace(/<\/script/gi, String.raw`<\/script`)
  return `<script id="${HTML_EDIT_BRIDGE_ID}" data-alwith-bridge="edit">${escaped}</script>`
}
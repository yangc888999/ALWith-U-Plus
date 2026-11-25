(function () {
  if (window.__alwithPreviewMenu === true) return;
  window.__alwithPreviewMenu = true;
  function ensureCommentStyle() {
    if (document.getElementById('alwith-preview-comment-style')) return;
    var style = document.createElement('style');
    style.id = 'alwith-preview-comment-style';
    // The injected report annotator draws its own floating "批注" bubble above a selection.
    // The host's selection bar already carries 评论, so the native bubble is always hidden; the
    // same (hidden) bubble is clicked programmatically below to open the original editor.
    // The preview column has a bottom status strip, so the report's default 24px bottom offset
    // leaves the FAB half clipped. Pull the FAB and its panel inward; the report opened in a
    // normal browser keeps its own layout because this style exists only in the host preview.
    style.textContent =
      '.anno-bubble{display:none!important;}' +
      '.anno-fab{bottom:72px!important;right:36px!important;}' +
      '.anno-panel{bottom:138px!important;right:36px!important;}' +
      '@media (max-width:640px){.anno-fab{bottom:64px!important;right:20px!important;}' +
      '.anno-panel{bottom:124px!important;right:20px!important;}}';
    (document.head || document.documentElement).appendChild(style);
  }
  ensureCommentStyle();
  // The hosting page never sees events inside this frame, so right-click and text selection are
  // both forwarded: contextmenu opens the translated menu, selection drives the copy/quote pill.
  document.addEventListener('contextmenu', function (event) {
    // When the frame is in WYSIWYG edit mode its body is contenteditable, so let the native
    // browser context menu (cut/copy/paste) appear instead of the translated overlay menu.
    if (document.body && document.body.isContentEditable) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    dismissed = true;
    hideSelection();
    var text = '';
    try {
      var selection = window.getSelection && window.getSelection();
      if (selection) { text = String(selection).trim(); }
    } catch (error) {}
    try {
      window.parent.postMessage({
        source: 'alwith-preview',
        type: 'context-menu',
        frameToken: window.location.href,
        text: text,
        x: event.clientX,
        y: event.clientY
      }, '*');
    } catch (error) {}
  }, true);
  var lastText = '';
  var lastRect = null;
  var selectionTimer;
  var scrollTimer;
  var dismissed = false;
  var savedRange = null;
  var suppressSelectionReport = false;
  function publish(text, rect, repositionOnly) {
    lastText = text;
    lastRect = rect;
    try {
      window.parent.postMessage({
        source: 'alwith-preview',
        type: 'selection',
        frameToken: window.location.href,
        text: text,
        repositionOnly: repositionOnly,
        canComment: document.getElementById('annoFab') !== null,
        rect: rect
      }, '*');
    } catch (error) {}
  }
  function hideSelection() {
    clearTimeout(selectionTimer);
    if (lastText) publish('', null, false);
  }
  function reportSelection(repositionOnly) {
    if (dismissed || suppressSelectionReport || (repositionOnly && !lastText)) return;
    var selection = window.getSelection();
    var text = selection && selection.rangeCount ? String(selection).trim().slice(0, 20000) : '';
    if (!text || !document.body || document.body.isContentEditable) return hideSelection();
    if (repositionOnly && text !== lastText) return;
    var range = selection.getRangeAt(0);
    var box = range.getBoundingClientRect();
    if (box.bottom <= 0 || box.top >= window.innerHeight || box.right <= 0 || box.left >= window.innerWidth)
      return hideSelection();
    var sameRange = lastText === text && savedRange && savedRange.startContainer === range.startContainer &&
      savedRange.endContainer === range.endContainer && savedRange.startOffset === range.startOffset &&
      savedRange.endOffset === range.endOffset;
    if (sameRange && lastRect && box.left === lastRect.left && box.top === lastRect.top &&
        box.width === lastRect.width && box.bottom === lastRect.bottom) return;
    if (!sameRange) savedRange = range.cloneRange();
    publish(text, { left: box.left, top: box.top, bottom: box.bottom, width: box.width }, repositionOnly || !!sameRange);
  }
  function scheduleSelection(delay) {
    clearTimeout(selectionTimer);
    selectionTimer = setTimeout(function () { reportSelection(false); }, delay);
  }
  document.addEventListener('mouseup', function (event) {
    if (event.button !== 0 || suppressSelectionReport) return;
    scheduleSelection(0);
  }, true);
  document.addEventListener('mousedown', function (event) {
    if (event.button !== 0) return;
    dismissed = false;
    savedRange = null;
    hideSelection();
  }, true);
  // The host pill is positioned in the preview pane, not inside this frame. Once the selected
  // text scrolls away, keeping the pill would leave it detached from its quote.
  document.addEventListener('scroll', function () {
    if (!lastText || scrollTimer !== undefined) return;
    scrollTimer = setTimeout(function () {
      scrollTimer = undefined;
      reportSelection(true);
    }, 16);
  }, true);
  document.addEventListener('keydown', function (event) {
    dismissed = event.key === 'Escape';
    if (dismissed) hideSelection();
  }, true);
  document.addEventListener('selectionchange', function (event) {
    if (event.target !== document || dismissed || suppressSelectionReport) return;
    var selection = window.getSelection();
    if (!selection || selection.isCollapsed) hideSelection();
    else scheduleSelection(120);
  }, true);
  // The host selection bar owns 点评. Restore the last selected range, then replay the gesture
  // the report annotator listens for: a mouseup creates its (hidden) bubble, and clicking that
  // bubble opens its original editor on the same text. This keeps one comment implementation.
  window.addEventListener('message', function (event) {
    if (event.source !== window.parent) return;
    var data = event.data;
    if (!data || data.source !== 'alwith-preview-host' || data.type !== 'comment') return;
    try {
      // The report annotator already created its (CSS-hidden) bubble when the reader selected
      // the text. Clicking that bubble keeps its original range and avoids replaying a synthetic
      // mouseup, which used to race the host selection bar and make the editor flash away.
      var existing = document.querySelector('.anno-bubble');
      if (existing) {
        existing.click();
        return;
      }
      // No bubble (a focus loss or an earlier clear removed it). Replay the gesture, but do not
      // report the selection while opening: that would re-show the host bar and steal focus.
      suppressSelectionReport = true;
      var selection = window.getSelection && window.getSelection();
      if (selection && savedRange) {
        selection.removeAllRanges();
        selection.addRange(savedRange);
      }
      if (document.body) {
        document.body.dispatchEvent(new MouseEvent('mouseup', {
          bubbles: true,
          cancelable: true,
          view: window,
          button: 0
        }));
      }
      var attempts = 0;
      (function openBubble() {
        var bubble = document.querySelector('.anno-bubble');
        if (bubble) {
          bubble.click();
          setTimeout(function () { suppressSelectionReport = false; }, 300);
          return;
        }
        if (++attempts < 12) setTimeout(openBubble, 30);
        else setTimeout(function () { suppressSelectionReport = false; }, 300);
      })();
    } catch (error) {}
  });
})();

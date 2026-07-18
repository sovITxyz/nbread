// Editor toolbar + Write/Preview tabs + counter + localStorage autosave +
// Blossom image uploads (toolbar button / drag-drop / paste).
// Pure DOM wiring: all text math lives in editor-md.js (NbreadEditorMd)
// and EVERY textarea mutation goes through replaceRange() below, whose
// execCommand seam keeps each action a single native undo step — including
// the async placeholder->URL swap that an image upload lands.
//
// Preview seam: activating the Preview tab dispatches a
// "nbread:preview-requested" CustomEvent on document; editor.js listens
// and runs the server-rendered preview fetch (it owns /dashboard/preview,
// its value cache, and rate-limit messaging).
//
// Draft seam: window.NbreadDraft.clear() is called by editor.js after a
// successful publish or delete — it drops the stored draft AND disables
// further writes so the beforeunload flush cannot resurrect it.
(function () {
  "use strict";

  var md = globalThis.NbreadEditorMd;
  var contentEl = document.getElementById("post-content");
  if (!md || !contentEl) return;

  var cfgEl = document.getElementById("editor-config");
  var cfg = {};
  if (cfgEl) {
    try {
      cfg = JSON.parse(cfgEl.textContent || "{}") || {};
    } catch (e) {
      cfg = {};
    }
  }

  var titleEl = document.getElementById("post-title");
  var slugEl = document.getElementById("post-slug");
  var summaryEl = document.getElementById("post-summary");
  var metaEl = document.getElementById("editor-meta");

  var URL_RE = /^https?:\/\/\S+$/;

  // --- The one mutation primitive -----------------------------------------------
  // execCommand("insertText") edits through the browser's editing pipeline,
  // so the whole replacement lands on the native undo stack as one step.
  // When it is unavailable/refused, fall back to setRangeText plus a
  // synthetic input event (undo degrades, behavior does not).
  function replaceRange(instr, preserveFocus) {
    if (!instr) return;
    // Async swaps (the upload placeholder->URL replacement) can land seconds
    // later, while the user has moved on to the Title/Slug/Summary field.
    // execCommand requires focusing the textarea, which would yank focus and
    // the caret away from where they're typing. When preserveFocus is set and
    // the textarea isn't the active element, edit through setRangeText (no
    // focus grab, no selection change) — undo granularity degrades for this
    // one case, but the user's typing elsewhere is not hijacked.
    if (preserveFocus && document.activeElement !== contentEl) {
      contentEl.setRangeText(instr.text, instr.start, instr.end, "preserve");
      contentEl.dispatchEvent(new Event("input", { bubbles: true }));
      return;
    }
    contentEl.focus();
    contentEl.setSelectionRange(instr.start, instr.end);
    var ok = false;
    try {
      if (instr.text === "") {
        ok = instr.start === instr.end || document.execCommand("delete");
      } else {
        ok = document.execCommand("insertText", false, instr.text);
      }
    } catch (e) {
      ok = false;
    }
    if (!ok) {
      contentEl.setRangeText(instr.text, instr.start, instr.end, "end");
      contentEl.dispatchEvent(new Event("input", { bubbles: true }));
    }
    contentEl.setSelectionRange(instr.selStart, instr.selEnd);
  }

  // --- Actions ---------------------------------------------------------------------

  function applyFootnote() {
    var instr = md.insertFootnote(
      contentEl.value,
      contentEl.selectionStart,
      contentEl.selectionEnd,
    );
    replaceRange(instr);
    if (instr && instr.append) {
      // Second replacement at end-of-document (see editor-md.js header):
      // the definition stub, with the caret parked after it for typing.
      var len = contentEl.value.length;
      replaceRange({
        start: len,
        end: len,
        text: instr.append,
        selStart: len + instr.append.length,
        selEnd: len + instr.append.length,
      });
    }
  }

  var actions = {
    bold: function (v, s, e) { return md.wrapInline(v, s, e, "**"); },
    italic: function (v, s, e) { return md.wrapInline(v, s, e, "_"); },
    strike: function (v, s, e) { return md.wrapInline(v, s, e, "~~"); },
    mark: function (v, s, e) { return md.wrapInline(v, s, e, "=="); },
    code: function (v, s, e) { return md.wrapInline(v, s, e, "`"); },
    heading: md.cycleHeading,
    quote: function (v, s, e) { return md.toggleLinePrefix(v, s, e, "> "); },
    ul: function (v, s, e) { return md.toggleLinePrefix(v, s, e, "- "); },
    ol: md.orderedList,
    task: function (v, s, e) { return md.toggleLinePrefix(v, s, e, "- [ ] "); },
    fence: md.codeFence,
    table: md.insertTable,
    hr: md.insertRule,
    link: md.makeLink,
    image: md.makeImage,
  };

  function runAction(name) {
    if (name === "footnote") {
      applyFootnote();
      return true;
    }
    if (name === "image") {
      runImageAction();
      return true;
    }
    var fn = actions[name];
    if (!fn) return false;
    replaceRange(
      fn(contentEl.value, contentEl.selectionStart, contentEl.selectionEnd),
    );
    return true;
  }

  // --- Image uploads (Blossom) ------------------------------------------------------
  // Three entry points — the toolbar button, drag-and-drop, and paste — all
  // funnel through uploadAndInsert(): drop an "![uploading…]()" placeholder at
  // the caret, PUT the bytes to Blossom, then swap the EXACT placeholder text
  // for the final "![](<url>)". Matching on the placeholder text (not a caret
  // offset) keeps the swap correct even if the user keeps typing mid-upload;
  // if they delete it, the result is silently dropped.

  var blossom = globalThis.NbreadBlossom;
  var signer = globalThis.NbreadSigner;
  var statusEl = document.getElementById("editor-status");
  var ACCEPT_IMAGES = "image/png,image/jpeg,image/webp,image/gif";
  var uploadSeq = 0;
  var fileInput = null;

  function setStatus(msg) {
    if (statusEl) statusEl.textContent = msg;
  }

  // Synchronous readiness gate (a file picker must open in the user gesture,
  // so we can't await signer.ready()): an upload is possible when Blossom is
  // loaded, a signer method is configured, and it is NOT the Amber redirect
  // signer (whose signEvent navigates away and never resolves).
  function canUpload() {
    return !!(
      blossom &&
      signer &&
      typeof signer.method === "function" &&
      signer.method() &&
      !(typeof signer.isRedirectSigner === "function" && signer.isRedirectSigner())
    );
  }

  function imageFilesFrom(fileList) {
    var out = [];
    if (!fileList) return out;
    for (var i = 0; i < fileList.length; i++) {
      var f = fileList[i];
      if (f && typeof f.type === "string" && f.type.indexOf("image/") === 0) {
        out.push(f);
      }
    }
    return out;
  }

  // clipboardData exposes pasted images via files on modern browsers and via
  // items elsewhere — check both.
  function imageFilesFromClipboard(cd) {
    var out = imageFilesFrom(cd.files);
    if (out.length === 0 && cd.items) {
      for (var i = 0; i < cd.items.length; i++) {
        var it = cd.items[i];
        if (it.kind === "file" && it.type && it.type.indexOf("image/") === 0) {
          var f = it.getAsFile();
          if (f) out.push(f);
        }
      }
    }
    return out;
  }

  function dragHasImage(dt) {
    if (!dt) return false;
    if (dt.items && dt.items.length) {
      for (var i = 0; i < dt.items.length; i++) {
        if (
          dt.items[i].kind === "file" &&
          dt.items[i].type &&
          dt.items[i].type.indexOf("image/") === 0
        ) {
          return true;
        }
      }
      return false;
    }
    if (dt.types) {
      for (var j = 0; j < dt.types.length; j++) {
        if (dt.types[j] === "Files") return true;
      }
    }
    return false;
  }

  function insertPlaceholder(placeholder) {
    var s = contentEl.selectionStart;
    var e = contentEl.selectionEnd;
    replaceRange({
      start: s,
      end: e,
      text: placeholder,
      selStart: s + placeholder.length,
      selEnd: s + placeholder.length,
    });
  }

  // Swap the first occurrence of `placeholder` for `replacement`, through the
  // undo-safe seam. Returns false when the placeholder is gone (user deleted).
  function replacePlaceholder(placeholder, replacement) {
    var idx = contentEl.value.indexOf(placeholder);
    if (idx === -1) return false;
    // preserveFocus: this is an async swap that may fire while the user is
    // typing in another field — don't steal focus back to the textarea.
    replaceRange(
      {
        start: idx,
        end: idx + placeholder.length,
        text: replacement,
        selStart: idx + replacement.length,
        selEnd: idx + replacement.length,
      },
      true,
    );
    return true;
  }

  function uploadAndInsert(file) {
    if (!blossom) return;
    var id = ++uploadSeq;
    var placeholder = "![uploading… #" + id + "]()";
    insertPlaceholder(placeholder);
    setStatus("Uploading image…");
    blossom.uploadBlob(file, { signer: signer }).then(
      function (res) {
        replacePlaceholder(placeholder, "![](" + res.url + ")");
        setStatus("Image uploaded.");
      },
      function (err) {
        // Pull the placeholder back out on failure so no broken token remains.
        replacePlaceholder(placeholder, "");
        setStatus(
          (err && err.message) || "Image upload failed. Please try again.",
        );
      },
    );
  }

  function ensureFileInput() {
    if (fileInput) return fileInput;
    fileInput = document.createElement("input");
    fileInput.type = "file";
    fileInput.accept = ACCEPT_IMAGES;
    fileInput.style.display = "none";
    fileInput.addEventListener("change", function () {
      var f = fileInput.files && fileInput.files[0];
      fileInput.value = ""; // let the same file be re-picked later
      if (f) uploadAndInsert(f);
    });
    document.body.appendChild(fileInput);
    return fileInput;
  }

  // Toolbar "image" button: open the picker when uploads are possible; else
  // fall back to the classic URL-template insert so the button still works.
  function runImageAction() {
    if (canUpload()) {
      ensureFileInput().click();
      return;
    }
    replaceRange(
      md.makeImage(contentEl.value, contentEl.selectionStart, contentEl.selectionEnd),
    );
  }

  // Drag-and-drop image files onto the textarea.
  contentEl.addEventListener("dragover", function (e) {
    if (dragHasImage(e.dataTransfer)) e.preventDefault();
  });
  contentEl.addEventListener("drop", function (e) {
    var files = e.dataTransfer ? imageFilesFrom(e.dataTransfer.files) : [];
    if (files.length === 0) return; // let native drop (e.g. text) proceed
    e.preventDefault();
    if (!canUpload()) {
      setStatus(
        "Configure a signing key (not Amber) to upload images, or paste an image URL.",
      );
      return;
    }
    for (var i = 0; i < files.length; i++) uploadAndInsert(files[i]);
  });

  // --- Toolbar: click delegation + roving tabindex ----------------------------------

  var toolbar = document.querySelector(".editor-toolbar");
  if (toolbar) {
    // Buttons must never steal the textarea's selection: swallowing
    // mousedown keeps focus (and the selection) where the edit applies.
    toolbar.addEventListener("mousedown", function (e) {
      e.preventDefault();
    });
    toolbar.addEventListener("click", function (e) {
      var btn = e.target.closest ? e.target.closest("[data-md-action]") : null;
      if (btn) runAction(btn.getAttribute("data-md-action"));
    });

    // Roving tabindex: the toolbar is ONE tab stop; arrows move inside it.
    var buttons = Array.prototype.slice.call(
      toolbar.querySelectorAll("[data-md-action]"),
    );
    var focusIndex = 0;
    function setTabStops() {
      for (var i = 0; i < buttons.length; i++) {
        buttons[i].tabIndex = i === focusIndex ? 0 : -1;
      }
    }
    setTabStops();
    toolbar.addEventListener("focusin", function (e) {
      var i = buttons.indexOf(e.target);
      if (i !== -1) {
        focusIndex = i;
        setTabStops();
      }
    });
    toolbar.addEventListener("keydown", function (e) {
      var delta = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
      if (delta === 0 || buttons.length === 0) return;
      e.preventDefault();
      focusIndex = (focusIndex + delta + buttons.length) % buttons.length;
      setTabStops();
      buttons[focusIndex].focus();
    });
  }

  // --- Keyboard shortcuts + list Enter/Tab behavior ---------------------------------

  var isMac = /Mac|iP(hone|ad|od)/.test(navigator.platform || "");

  contentEl.addEventListener("keydown", function (e) {
    // An Enter that commits an IME composition (CJK input) must never run
    // list continuation; keyCode 229 covers engines where isComposing is
    // unreliable (older WebKit / Android).
    if (e.isComposing || e.keyCode === 229) return;
    if (e.altKey) return; // nothing Alt-based, ever (AltGr composes chars)

    if (e.key === "Enter" && !e.ctrlKey && !e.metaKey && !e.shiftKey) {
      // Only continue lists on a collapsed caret; a selection keeps the
      // native replace-selection-with-newline behavior.
      if (contentEl.selectionStart !== contentEl.selectionEnd) return;
      var cont = md.listContinuation(contentEl.value, contentEl.selectionStart);
      if (cont) {
        e.preventDefault();
        replaceRange(cont);
      }
      return;
    }

    if (e.key === "Tab" && !e.ctrlKey && !e.metaKey) {
      var ind = md.listIndent(
        contentEl.value,
        contentEl.selectionStart,
        contentEl.selectionEnd,
        e.shiftKey ? -1 : 1,
      );
      if (ind) {
        e.preventDefault();
        replaceRange(ind);
      }
      // null → native Tab keeps moving focus out of the textarea (a11y).
      return;
    }

    var mod = isMac ? e.metaKey : e.ctrlKey;
    if (!mod) return;
    var name = null;
    if (e.shiftKey) {
      // Digits/period by e.code: with Shift held, e.key is layout-dependent
      // ("&", "*", ">", …) but the physical key is stable.
      if (e.code === "Digit7") name = "ol";
      else if (e.code === "Digit8") name = "ul";
      else if (e.code === "Digit9") name = "task";
      else if (e.code === "Period") name = "quote";
      else if (e.key === "x" || e.key === "X") name = "strike";
    } else {
      var k = e.key.toLowerCase();
      if (k === "b") name = "bold";
      else if (k === "i") name = "italic";
      else if (k === "k") name = "link";
      else if (k === "e") name = "code";
    }
    if (name) {
      e.preventDefault();
      runAction(name);
    }
  });

  // Pasting a URL over a non-empty, non-URL selection makes a link instead
  // of overwriting the selected text.
  contentEl.addEventListener("paste", function (e) {
    if (!e.clipboardData) return;
    // A pasted image takes priority over the text-URL-to-link behavior below.
    var imgFiles = imageFilesFromClipboard(e.clipboardData);
    if (imgFiles.length > 0) {
      e.preventDefault();
      if (!canUpload()) {
        setStatus(
          "Configure a signing key (not Amber) to upload images, or paste an image URL.",
        );
        return;
      }
      for (var pi = 0; pi < imgFiles.length; pi++) uploadAndInsert(imgFiles[pi]);
      return;
    }
    var pasted = (e.clipboardData.getData("text/plain") || "").trim();
    if (!URL_RE.test(pasted)) return;
    var s = contentEl.selectionStart;
    var en = contentEl.selectionEnd;
    if (s === en) return;
    var sel = contentEl.value.slice(s, en);
    if (sel.trim() === "" || URL_RE.test(sel.trim())) return;
    e.preventDefault();
    var text = "[" + sel + "](" + pasted + ")";
    replaceRange({
      start: s,
      end: en,
      text: text,
      selStart: s + text.length,
      selEnd: s + text.length,
    });
  });

  // --- Char/word counter -------------------------------------------------------------

  // Caps mirror the server: renderPost truncates markdown past 32,768 chars
  // (MAX_MARKDOWN_LENGTH) and /api/mirror rejects events past 256 KiB.
  var RENDER_CAP = 32768;
  var PUBLISH_CAP = 262144;
  var counterTimer = null;

  function updateCounter() {
    if (!metaEl) return;
    var v = contentEl.value;
    var words = v.trim() === "" ? 0 : v.trim().split(/\s+/).length;
    var text = v.length + " chars · " + words + " words";
    metaEl.classList.remove("warn", "danger");
    if (v.length > PUBLISH_CAP) {
      metaEl.classList.add("danger");
      text += " · too large to publish";
    } else if (v.length > RENDER_CAP) {
      metaEl.classList.add("warn");
      text += " · over the 32,768-char render cap";
    }
    metaEl.textContent = text;
  }

  contentEl.addEventListener("input", function () {
    if (counterTimer !== null) return; // throttle: one repaint per ~200ms
    counterTimer = setTimeout(function () {
      counterTimer = null;
      updateCounter();
    }, 200);
  });
  updateCounter();

  // --- Draft autosave (localStorage, best-effort) --------------------------------------

  var storageKey = md.draftKey(
    typeof cfg.pubkey === "string" ? cfg.pubkey : "",
    cfg.mode === "edit" ? "edit" : "new",
    typeof cfg.slug === "string" ? cfg.slug : "",
  );
  var MAX_DRAFT_CONTENT = 300000; // don't chew localStorage quota on huge pastes
  var draftsDisabled = false;
  var draftTimer = null;

  // Server-seeded values at load: a draft identical to these is noise.
  function snapshot() {
    return {
      title: titleEl ? titleEl.value : "",
      slug: slugEl && !slugEl.readOnly ? slugEl.value : "",
      summary: summaryEl ? summaryEl.value : "",
      content: contentEl.value,
    };
  }
  var served = snapshot();

  function sameAsServed(d) {
    return (
      d.title === served.title &&
      d.slug === served.slug &&
      d.summary === served.summary &&
      d.content === served.content
    );
  }

  // Every localStorage touch is wrapped: quota/private-mode failures mean
  // autosave is silently off, never a broken editor.
  function writeDraft() {
    if (draftsDisabled) return;
    var d = snapshot();
    if (d.content.length > MAX_DRAFT_CONTENT) return;
    try {
      if (sameAsServed(d)) {
        localStorage.removeItem(storageKey);
        return;
      }
      d.savedAt = Date.now();
      localStorage.setItem(storageKey, JSON.stringify(d));
    } catch (e) {
      /* autosave off */
    }
  }

  function scheduleDraft() {
    if (draftTimer !== null) clearTimeout(draftTimer);
    draftTimer = setTimeout(function () {
      draftTimer = null;
      writeDraft();
    }, 1000);
  }

  var draftFields = [titleEl, slugEl, summaryEl, contentEl];
  for (var fi = 0; fi < draftFields.length; fi++) {
    if (draftFields[fi]) draftFields[fi].addEventListener("input", scheduleDraft);
  }
  window.addEventListener("beforeunload", writeDraft);

  window.NbreadDraft = {
    // Called by editor.js after a successful publish/delete: drop the draft
    // and disable further writes so the unload flush cannot re-save the
    // just-published content as a phantom draft.
    clear: function () {
      draftsDisabled = true;
      if (draftTimer !== null) {
        clearTimeout(draftTimer);
        draftTimer = null;
      }
      try {
        localStorage.removeItem(storageKey);
      } catch (e) {
        /* nothing to clear */
      }
    },
  };

  function relativeTime(ts) {
    var s = Math.max(0, Math.round((Date.now() - ts) / 1000));
    if (s < 60) return "moments ago";
    var m = Math.round(s / 60);
    if (m < 60) return m + (m === 1 ? " minute ago" : " minutes ago");
    var h = Math.round(m / 60);
    if (h < 24) return h + (h === 1 ? " hour ago" : " hours ago");
    var d = Math.round(h / 24);
    return d + (d === 1 ? " day ago" : " days ago");
  }

  // On load: offer to restore a stored draft that differs from the server
  // values; silently drop one that matches (it already got published).
  (function offerDraft() {
    var noticeEl = document.getElementById("draft-notice");
    var noticeText = document.getElementById("draft-notice-text");
    var restoreBtn = document.getElementById("draft-restore");
    var discardBtn = document.getElementById("draft-discard");
    var raw = null;
    try {
      raw = localStorage.getItem(storageKey);
    } catch (e) {
      return;
    }
    if (!raw) return;
    var stored;
    try {
      stored = JSON.parse(raw);
    } catch (e) {
      stored = null;
    }
    if (!stored || typeof stored !== "object" || typeof stored.content !== "string") {
      try {
        localStorage.removeItem(storageKey);
      } catch (e) {
        /* ignore */
      }
      return;
    }
    var draft = {
      title: typeof stored.title === "string" ? stored.title : "",
      slug: typeof stored.slug === "string" ? stored.slug : "",
      summary: typeof stored.summary === "string" ? stored.summary : "",
      content: stored.content,
    };
    if (sameAsServed(draft)) {
      try {
        localStorage.removeItem(storageKey);
      } catch (e) {
        /* ignore */
      }
      return;
    }
    if (!noticeEl || !noticeText || !restoreBtn || !discardBtn) return;
    var savedAt = typeof stored.savedAt === "number" ? stored.savedAt : Date.now();
    noticeText.textContent = "Unsaved draft from " + relativeTime(savedAt) + ".";
    noticeEl.hidden = false;
    restoreBtn.addEventListener("click", function () {
      if (titleEl) titleEl.value = draft.title;
      if (slugEl && !slugEl.readOnly && draft.slug) slugEl.value = draft.slug;
      if (summaryEl) summaryEl.value = draft.summary;
      // Through the undo-safe primitive so the restore is one undoable step
      // (a direct .value assignment would wipe the undo stack, destroying
      // any typing done before clicking Restore). replaceRange also fires
      // the input event both seams need (counter + preview-stale cache).
      replaceRange({
        start: 0,
        end: contentEl.value.length,
        text: draft.content,
        selStart: draft.content.length,
        selEnd: draft.content.length,
      });
      noticeEl.hidden = true;
    });
    discardBtn.addEventListener("click", function () {
      try {
        localStorage.removeItem(storageKey);
      } catch (e) {
        /* ignore */
      }
      noticeEl.hidden = true;
    });
  })();

  // --- Write / Preview tabs (ARIA tab pattern) ------------------------------------------

  var tabWrite = document.getElementById("tab-write");
  var tabPreview = document.getElementById("tab-preview");
  var writePanel = document.getElementById("write-panel");
  var previewPanel = document.getElementById("preview");

  function selectTab(which) {
    var previewing = which === "preview";
    if (tabWrite) {
      tabWrite.setAttribute("aria-selected", String(!previewing));
      tabWrite.tabIndex = previewing ? -1 : 0;
    }
    if (tabPreview) {
      tabPreview.setAttribute("aria-selected", String(previewing));
      tabPreview.tabIndex = previewing ? 0 : -1;
    }
    if (writePanel) writePanel.hidden = previewing;
    if (previewPanel) previewPanel.hidden = !previewing;
    if (previewing) {
      document.dispatchEvent(new CustomEvent("nbread:preview-requested"));
    }
  }

  if (tabWrite && tabPreview) {
    tabWrite.addEventListener("click", function () {
      selectTab("write");
    });
    tabPreview.addEventListener("click", function () {
      selectTab("preview");
    });
    // Two tabs: either arrow key toggles focus AND selection (APG pattern
    // with automatic activation).
    function onTabArrow(e) {
      if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
      e.preventDefault();
      var next = document.activeElement === tabWrite ? tabPreview : tabWrite;
      next.focus();
      selectTab(next === tabPreview ? "preview" : "write");
    }
    tabWrite.addEventListener("keydown", onTabArrow);
    tabPreview.addEventListener("keydown", onTabArrow);
  }
})();

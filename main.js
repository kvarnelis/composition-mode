const { Plugin, PluginSettingTab, Setting, MarkdownView, Scope } = require('obsidian');
const { StateField, StateEffect } = require('@codemirror/state');
const { Decoration, WidgetType, EditorView } = require('@codemirror/view');

const DEFAULT_SETTINGS = {
  paperSize: 'letter',
  defaultBackgroundFade: 0.35,
  defaultPaperWidth: 90,
  showPageBreaks: true,
  pageGapHeight: 60,
  pageWordCount: 400,
  debugMode: false,
  zoomLevels: {}
};

const MIN_PAPER_WIDTH = 60;
const MAX_PAPER_WIDTH = 95;
const MIN_VISUAL_ZOOM = 0.25;
const MAX_VISUAL_ZOOM = 2;

const PAPER_SIZES = {
  letter: { label: 'Letter', width: 8.5, height: 11 },
  a4: { label: 'A4', width: 8.27, height: 11.69 }
};

let DEBUG_MODE_ENABLED = false;

function setDebugModeEnabled(value) {
  DEBUG_MODE_ENABLED = !!value;
}


// --- Page break StateField (block-widget pagination) ---------------------
// Strategy: pure-math pixel-accurate pagination. Once per rebuild, snapshot
// the rendered font metrics (line-height, font shorthand, content width)
// from the active editor's DOM. From there, paragraph heights are computed
// analytically — no further DOM reads — and page boundaries fall at fixed
// pageHeight intervals from doc top. A block widget at each boundary
// (anchored to the next paragraph's start position with side: -1) fills
// the unused bottom of the closing page plus the gray bar plus a
// breathing gap below.
//
// Why one-shot math instead of measuring the editor's geometry: an earlier
// ViewPlugin read each paragraph's `block.top`, which already reflects the
// heights of widgets above. Subtracting current widget heights to derive
// "natural" positions, then redispatching new heights, fired CM6's
// `geometryChanged` event → re-measure → slightly different heights →
// redispatch → ad infinitum. The user-visible effect was gray bars
// jumping for ~30 seconds after every rebuild. Pure doc-layer math has
// no such feedback path: widget heights flow OUT of computePageBreaks
// and never flow back in.
//
// Limitations (acceptable for current scope):
//   - Heading lines use a simple multiplier on lineHeight (headingScale).
//     Exotic theme CSS that makes h1 several times body line-height will
//     under-count.
//   - Image heights are exact for every cached file (derived from natural
//     dimensions + contentWidth). Images whose Image() preload is still
//     in flight contribute 0 height for the current pass; the preload's
//     load event schedules another rebuild with correct dimensions.
//   - Canvas measureText divides total text width by content width;
//     this can be off by 0-1 visual line vs. true word-wrap. Sub-1%
//     drift at typical paragraph sizes.

const pageBreakConfig = {
  enabled: false,
  wordsPerPage: 400,         // kept for the words-per-page UI; not used
                             //   in pixel-based pagination computation.
  gapHeight: 60,
  paperRatio: 11 / 8.5,      // height / width; updated in triggerEditors()
  pageHeight: 0,             // px; = chosen page-surface clientWidth * paperRatio
  pageMarginY: 32,           // px; top/bottom page margin inside the paper
  lineHeight: 24,            // px; from .cm-line computed line-height
  contentWidth: 0,           // px; from .cm-content.clientWidth
  fontSpec: '400 16px sans-serif', // canvas font shorthand from .cm-line
  imageHeightMap: new Map(), // Map<filename, displayedHeight px>; rebuilt on
                             //   every triggerEditors() from the plugin's
                             //   natural-dims cache. No fallback — every
                             //   image in the doc is a known file with
                             //   deterministic natural dimensions, so
                             //   heights are always computed exactly.
  normalizeForLivePreview: false, // true when the active CM6 editor is Live
                                  // Preview, where markdown syntax such as
                                  // link destinations is hidden from layout.
  suppressFrontmatter: false,     // true when LP properties UI replaces the
                                  // top YAML block and composition mode hides
                                  // that widget, so the frontmatter should
                                  // not consume page height.
  headingScale: 1.3,         // multiplier on lineHeight for h1-h3
  _v: 0
};

// Single-line-per-rebuild debug log. Spam-proof: no tight-loop writes.
async function dbg(msg) {
  if (!DEBUG_MODE_ENABLED) return;
  try {
    const path = 'working/composition-mode-page-break-debug.md';
    const timestamp = new Date().toISOString();
    const line = `- ${timestamp} ${msg}\n`;
    if (!(await app.vault.adapter.exists(path))) {
      await app.vault.create(path, '# Composition Mode Debug Log\n\n');
    }
    await app.vault.adapter.append(path, line);
  } catch (e) {
    console.error('Composition Mode Debug Error:', e);
  }
}

function fmtRect(r) {
  return r
    ? `${Math.round(r.left)}→${Math.round(r.right)}(w=${Math.round(r.width)} h=${Math.round(r.height)})`
    : 'null';
}

function shortCls(node, n = 3) {
  return (node?.className && typeof node.className === 'string')
    ? node.className.split(/\s+/).filter(c => c.length).slice(0, n).join('.')
    : '';
}

function nodeToken(node) {
  if (!node) return 'null';
  const tag = node.tagName?.toLowerCase?.() || 'node';
  const cls = shortCls(node, 4);
  return cls ? `${tag}.${cls}` : tag;
}

function pxNum(value) {
  const n = parseFloat(value);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : value;
}

function isImageLine(text) {
  const t = text.trim();
  return /^!\[\[.+?\]\]/.test(t) || /^!\[.*?\]\(.+?\)/.test(t);
}

// Extract a stable lookup key for an image embed line. Supports both
// Obsidian wikilink syntax (![[file.png]], ![[folder/file.png|alias]],
// ![[file.png#heading]]) and standard markdown (![alt](path/to/file.png)).
// Returns the basename lowercased — matching the `basename` stored in
// imageDimsCache so estimateParagraphHeight can look up the height for
// this image line from the plugin's natural-dimensions cache.
// Filename collisions across folders are possible in theory but rare in
// practice; an Obsidian wikilink with just a filename already assumes
// the name is unique in the vault.
function extractImageKey(text) {
  if (!text) return null;
  const t = text.trim();

  // ![[file.png]] / ![[folder/file.png|alias]] / ![[file.png#heading]]
  let m = /^!\[\[([^\]|#]+?)(?:[|#][^\]]*)?\]\]/.exec(t);
  if (m) {
    const base = m[1].trim().split('/').pop();
    return (base || '').toLowerCase() || null;
  }

  // ![alt](path/to/file.png) / ![alt](<path with spaces.png> "title")
  m = /^!\[[^\]]*\]\(\s*<?([^\s)>]+)>?/.exec(t);
  if (m) {
    const raw = m[1];
    let base;
    try {
      base = decodeURIComponent(raw.split('/').pop().split('?')[0].split('#')[0]);
    } catch (e) {
      base = raw.split('/').pop();
    }
    return (base || '').toLowerCase() || null;
  }

  return null;
}

function basenameFromUrlish(value) {
  if (!value || typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const withoutQuery = trimmed.split('?')[0].split('#')[0];
  const candidate = withoutQuery.split('/').pop();
  if (!candidate) return null;
  try {
    return decodeURIComponent(candidate).toLowerCase();
  } catch (e) {
    return candidate.toLowerCase();
  }
}

// Whether the entire line (ignoring leading/trailing whitespace) is a
// single image embed and nothing else. This is the stricter variant of
// isImageLine: isImageLine is satisfied by any line that STARTS with an
// image embed, but Obsidian only renders an image as its own block when
// that's the whole line. Block-break boundaries in the page-break
// algorithm should fire on pure image lines so neighboring text and the
// image don't get glued into one oversized, unsplittable block.
function isPureImageLine(text) {
  const t = text.trim();
  return /^!\[\[[^\]|#]+?(?:[|#][^\]]*)?\]\]$/.test(t) ||
         /^!\[[^\]]*\]\([^\s)]+\)$/.test(t);
}

// Split a source line into alternating text and image segments. Each
// image embed anywhere in the line becomes its own segment; surrounding
// text becomes text segments. Returns an array of
// { type: 'text'|'image', text, imageKey? } entries. A line with no
// image embeds yields a single text segment. The caller uses this only
// when a line contains at least one inline image embed — pure image
// lines are handled separately as their own blocks, and pure text
// lines skip this path entirely.
function splitLineIntoImageSegments(text) {
  const segments = [];
  const re = /!\[\[[^\]|#]+?(?:[|#][^\]]*)?\]\]|!\[[^\]]*\]\([^\s)]+\)/g;
  let lastIndex = 0;
  let m;
  while ((m = re.exec(text)) !== null) {
    if (m.index > lastIndex) {
      segments.push({
        type: 'text',
        text: text.slice(lastIndex, m.index),
        from: lastIndex,
        to: m.index
      });
    }
    segments.push({
      type: 'image',
      text: m[0],
      imageKey: extractImageKey(m[0]),
      from: m.index,
      to: re.lastIndex
    });
    lastIndex = re.lastIndex;
  }
  if (lastIndex < text.length) {
    segments.push({
      type: 'text',
      text: text.slice(lastIndex),
      from: lastIndex,
      to: text.length
    });
  }
  return segments;
}

// If the note starts with YAML frontmatter and Live Preview has replaced it
// with Obsidian's metadata widget (which composition mode hides), those top
// source lines no longer consume vertical space. The paginator must skip them
// or page 1 ends early with phantom whitespace.
function getFrontmatterEndLine(doc) {
  if (!doc || doc.lines < 2) return 0;
  if (doc.line(1).text.trim() !== '---') return 0;
  for (let lineNum = 2; lineNum <= doc.lines; lineNum++) {
    const text = doc.line(lineNum).text.trim();
    if (text === '---' || text === '...') return lineNum;
  }
  return 0;
}

// Live Preview hides significant markdown syntax from visual layout:
// markdown-link destinations/titles, wiki-link plumbing, heading markers,
// emphasis fences, inline-code ticks, etc. Measuring the raw source text
// overcounts wrapped-line height, especially in citation- and link-heavy
// opening paragraphs. Normalize to something closer to the rendered LP text
// before feeding the line into the canvas measurer.
function normalizeLineForMeasurement(text, cfg) {
  if (!text) return '';
  if (!cfg?.normalizeForLivePreview) return text;

  let out = text;
  out = out.replace(/^\s{0,3}#{1,6}\s+/, '');
  out = out.replace(/^\[\^([^\]]+)\]:\s*/, '$1 ');
  out = out.replace(/\[\^([^\]]+)\]/g, '$1');
  out = out.replace(/`([^`]+)`/g, '$1');
  out = out.replace(/\[\[([^\]|#]+?)(?:#[^\]|]+)?(?:\|([^\]]+))?\]\]/g, (_, target, alias) => {
    return alias || target.split('/').pop() || target;
  });
  out = out.replace(/\[([^\]]+)\]\((?:[^()]|\([^)]*\))*\)/g, '$1');
  out = out.replace(/(\*\*|__)(.*?)\1/g, '$2');
  out = out.replace(/(\*|_)(.*?)\1/g, '$2');
  out = out.replace(/~~(.*?)~~/g, '$1');
  out = out.replace(/==(.*?)==/g, '$1');
  out = out.replace(/\\([\\`*_[\]{}()#+.!~-])/g, '$1');
  return out;
}

// Lazily-initialized canvas for text measurement. Reused across rebuilds —
// only the .font property is reset when fontSpec changes. Allocating one
// canvas per rebuild would still be cheap, but module-level caching keeps
// allocations to one for the plugin's lifetime.
let _measureCanvas = null;
let _measureCtx = null;
function getMeasureCtx() {
  if (!_measureCtx) {
    _measureCanvas = document.createElement('canvas');
    _measureCtx = _measureCanvas.getContext('2d');
  }
  return _measureCtx;
}

// Build a per-rebuild measurer closure. It takes a single source line of
// text and returns the number of visual lines it occupies when wrapped to
// contentWidth in fontSpec. Approximation: total advance width / content
// Word-level wrapping simulation. The old approach (total text width /
// contentWidth, ceil) systematically undercounts visual lines because it
// treats text as a continuous ribbon, ignoring that browsers wrap at WORD
// boundaries. Each visual line wastes some space between the last word and
// the right margin. Over a 15-line paragraph the cumulative undercount
// can reach 2-3 lines (10-20%), enough to make the paginator think four
// paragraphs fit on one page when they don't.
//
// This version splits text into words and simulates the browser's wrapping
// algorithm: add words one by one; when the next word won't fit, start a
// new line. Canvas.measureText on individual words is fast (~3000 calls
// per rebuild at 56 blocks — sub-millisecond total).
function makeMeasurer(fontSpec, contentWidth) {
  const ctx = getMeasureCtx();
  ctx.font = fontSpec;
  const spaceWidth = ctx.measureText(' ').width;
  return (text) => {
    if (!text) return 1;
    if (!contentWidth || contentWidth <= 0) return 1;
    const words = text.split(/\s+/);
    let lines = 1;
    let lineWidth = 0;
    for (const word of words) {
      if (!word) continue;
      const wordWidth = ctx.measureText(word).width;
      if (wordWidth > contentWidth) {
        // Word wider than column (long URLs, etc.) — browser force-breaks
        // it across multiple lines. Finish the current line if occupied,
        // then add the extra lines the oversized word produces.
        if (lineWidth > 0) { lines++; }
        const extraLines = Math.ceil(wordWidth / contentWidth);
        lines += extraLines - 1;
        lineWidth = wordWidth % contentWidth || contentWidth;
      } else if (lineWidth > 0 && lineWidth + spaceWidth + wordWidth > contentWidth) {
        lines++;
        lineWidth = wordWidth;
      } else {
        lineWidth += (lineWidth > 0 ? spaceWidth : 0) + wordWidth;
      }
    }
    return Math.max(1, lines);
  };
}

// Px height for a paragraph block. Sums per-source-line heights:
//   image line  → cfg.imageHeightMap.get(line.imageKey); exact
//                 height derived from the file's natural dimensions
//                 and current contentWidth. If not yet in the map
//                 (preload hasn't completed for this file), height
//                 contributes 0 — pagination will refresh once the
//                 preload load event fires.
//   heading 1-3 → visualLines × lineHeight × cfg.headingScale
//   default     → visualLines × lineHeight
function estimateParagraphHeight(block, cfg, measurer) {
  const { lineHeight, headingScale, imageHeightMap } = cfg;
  const lookupImageHeight = (key) => {
    if (!key || !imageHeightMap || typeof imageHeightMap.get !== 'function') return 0;
    return imageHeightMap.get(key) || 0;
  };
  let height = 0;
  for (const line of block.lines) {
    if (line.isImage) {
      height += lookupImageHeight(line.imageKey);
      continue;
    }
    // Mixed text/image line: each inline image embed renders as its own
    // block-level slab, breaking the surrounding text into separate
    // paragraphs in the DOM. Sum each segment independently — text
    // segments through the measurer, image segments through the height
    // map. This gives an honest height for lines like
    //   "…shore for long. ![[foo.jpg]]"
    // where the naive measurer-on-raw-text would treat the 28 chars of
    // wikilink syntax as a fraction of a text line and lose ~300+px of
    // image height.
    if (line.segments) {
      for (const seg of line.segments) {
        if (seg.type === 'image') {
          height += lookupImageHeight(seg.imageKey);
          continue;
        }
        const measuredText = normalizeLineForMeasurement(seg.text, cfg);
        if (measuredText && measuredText.trim()) {
          height += measurer(measuredText) * lineHeight;
        }
      }
      continue;
    }
    const measuredText = normalizeLineForMeasurement(line.text, cfg);
    const visualLines = measurer(measuredText);
    if (line.headingLevel >= 1 && line.headingLevel <= 3) {
      height += visualLines * lineHeight * headingScale;
    } else {
      height += visualLines * lineHeight;
    }
  }
  return height;
}

// PageGapWidget renders two nested divs:
//   outer (composition-mode-page-break) — fixed layout container with
//     explicit height = totalHeight, padding-top = spaceAbove, padding-bottom
//     = pageMarginY. No background.
//   inner bar (composition-mode-page-gap) — the visible gray bar.
//     CSS handles horizontal bleed (via --composition-mode-page-margin-x-px)
//     and background color. JS only sets height.
// spaceAbove is variable: it represents the unused bottom of the previous
// page, computed in computePageBreaks as nextPageBoundary - y (the gap
// between where content ended and where the page boundary lies).
// totalHeight = unusedHeight + barHeight + pageMarginY.
class PageGapWidget extends WidgetType {
  constructor(totalHeight, barHeight, pageMarginY) {
    super();
    this.totalHeight = totalHeight;
    this.barHeight = barHeight;
    this.pageMarginY = pageMarginY;
    this.spaceAbove = Math.max(0, totalHeight - barHeight - pageMarginY);
  }
  // Identity: same dimensions → equal, so CM won't re-render unchanged widgets.
  eq(other) {
    return other instanceof PageGapWidget &&
           other.totalHeight === this.totalHeight &&
           other.barHeight === this.barHeight &&
           other.pageMarginY === this.pageMarginY;
  }
  // Height hint for the CM6 height-map; avoids layout thrash on first paint.
  get estimatedHeight() {
    return this.totalHeight;
  }
  toDOM() {
    // Increment a module-level counter and write a dedupe'd marker to
    // window for later inspection via the log, without calling dbg()
    // (which is async + writes to disk — plausible culprit for silent
    // toDOM failure). The logBarDiagnostic reads this counter in the
    // same pass as the bar query.
    window.__compositionToDOMCalls = (window.__compositionToDOMCalls || 0) + 1;
    const outer = document.createElement('div');
    outer.className = 'composition-mode-page-break';
    const rootStyle = getComputedStyle(document.documentElement);
    const bleedLeft =
      parseFloat(rootStyle.getPropertyValue('--composition-mode-page-margin-left-px')) ||
      parseFloat(rootStyle.getPropertyValue('--composition-mode-page-margin-x-px')) ||
      0;
    const bleedRight =
      parseFloat(rootStyle.getPropertyValue('--composition-mode-page-margin-right-px')) ||
      parseFloat(rootStyle.getPropertyValue('--composition-mode-page-margin-x-px')) ||
      0;
    const totalBleed = bleedLeft + bleedRight;
    const expandedExpr = `calc(100% + ${totalBleed}px)`;
    outer.style.height = this.totalHeight + 'px';
    outer.style.paddingTop = this.spaceAbove + 'px';
    outer.style.paddingBottom = this.pageMarginY + 'px';
    outer.style.boxSizing = 'border-box';
    // Shotgun width/position enforcement. Several earlier single-path
    // approaches silently no-op'd on the live block widget, so we express
    // the same geometry multiple ways at once. The key is asymmetry:
    // the OUTER widget shifts left once to the page edge, then the INNER
    // bar simply fills that widened outer box. A previous version shifted
    // both outer and inner, which fixed the left edge but stranded the
    // right edge at the text column.
    outer.style.marginLeft = '0';
    outer.style.marginRight = '0';
    outer.style.width = expandedExpr;
    outer.style.minWidth = expandedExpr;
    outer.style.maxWidth = 'none';
    outer.style.setProperty('inline-size', expandedExpr);
    outer.style.setProperty('min-inline-size', expandedExpr);
    outer.style.setProperty('max-inline-size', 'none');
    outer.style.flex = '0 0 auto';
    outer.style.alignSelf = 'flex-start';
    outer.style.overflow = 'visible';
    outer.style.display = 'block';
    outer.style.position = 'relative';
    outer.style.left = `${-bleedLeft}px`;
    outer.style.transform = 'none';
    outer.style.transformOrigin = 'initial';
    outer.style.setProperty('contain', 'none', 'important');

    const bar = document.createElement('div');
    bar.className = 'composition-mode-page-gap';
    bar.style.height = this.barHeight + 'px';
    bar.style.width = '100%';
    bar.style.minWidth = '100%';
    bar.style.maxWidth = 'none';
    bar.style.setProperty('inline-size', '100%');
    bar.style.setProperty('min-inline-size', '100%');
    bar.style.setProperty('max-inline-size', 'none');
    bar.style.marginLeft = '0';
    bar.style.marginRight = '0';
    bar.style.display = 'block';
    bar.style.position = 'relative';
    bar.style.left = '0';
    bar.style.transform = 'none';
    bar.style.transformOrigin = 'initial';

    outer.appendChild(bar);

    // Mount-time telemetry for visible/virtualized bars. The delayed
    // diagnostic sometimes runs when no bars are mounted yet, which means
    // the log can miss the actual on-screen bar the user is looking at.
    // Logging one frame after mount captures the real rendered bar geometry
    // without asking the user to find the logs manually.
    requestAnimationFrame(() => {
      try {
        const barRect = bar.getBoundingClientRect();
        // Skip detached / never-mounted bars.
        if (!bar.isConnected || (!barRect.width && !barRect.height)) return;
        const outerRect = outer.getBoundingClientRect();
        const scroller = bar.closest('.cm-scroller');
        const leaf = bar.closest('.workspace-leaf-content');
        const sourceView = bar.closest('.markdown-source-view');
        const bs = getComputedStyle(bar);
        const rootStyle = getComputedStyle(document.documentElement);
        const chain = [];
        let node = bar;
        let hops = 0;
        while (node && hops < 12) {
          const cs = getComputedStyle(node);
          chain.push(
            `${nodeToken(node)}(rect=${fmtRect(node.getBoundingClientRect())}` +
            `,ox=${cs.overflowX},oy=${cs.overflowY}` +
            `,contain=${cs.contain || 'none'}` +
            `,clip=${cs.clipPath || 'none'}` +
            `,mask=${cs.maskImage || 'none'}` +
            `,disp=${cs.display},pos=${cs.position})`
          );
          if (node === scroller) break;
          node = node.parentElement;
          hops++;
        }
        dbg(
          `bar-mount: rect=${fmtRect(barRect)}` +
          ` outer=${fmtRect(outerRect)}` +
          ` ml=${bs.marginLeft} mr=${bs.marginRight}` +
          ` cssW=${bs.width}` +
          ` cssMinW=${bs.minWidth}` +
          ` cssMaxW=${bs.maxWidth}` +
          ` cssLeft=${bs.left}` +
          ` cssTransform=${bs.transform}` +
          ` client=${bar.clientWidth}` +
          ` scroll=${bar.scrollWidth}` +
          ` varL=${rootStyle.getPropertyValue('--composition-mode-page-margin-left-px').trim() || '(unset)'}` +
          ` varR=${rootStyle.getPropertyValue('--composition-mode-page-margin-right-px').trim() || '(unset)'}` +
          ` scroller=${fmtRect(scroller?.getBoundingClientRect?.())}` +
          ` leaf=${fmtRect(leaf?.getBoundingClientRect?.())}` +
          ` src=${fmtRect(sourceView?.getBoundingClientRect?.())}`
        );
        dbg(`bar-mount-chain: ${chain.join(' <- ')}`);
      } catch (e) {}
    });
    return outer;
  }
  // Don't swallow clicks into the editor's own event handling.
  ignoreEvent() {
    return true;
  }
}

const rebuildPageBreaks = StateEffect.define();

// Parse doc into paragraph blocks, compute each one's pixel height from
// font metrics, walk the doc accumulating y, and emit a block widget
// BEFORE any paragraph whose addition would cross the next page boundary
// (provided the closing page is already at least half full). One pass.
// No DOM reads — all geometry comes from the cfg snapshot taken in
// triggerEditors().
//
// Page-boundary model: nextPageBoundary starts at pageHeight and advances
// by pageHeight on each break. A giant paragraph (> pageHeight) is allowed
// to overshoot without a break; a guard at the top of each iteration
// fast-forwards nextPageBoundary so the next eligible boundary is the
// one immediately ahead of y.
//
// Each widget's total height = (nextPageBoundary - y) + barHeight +
// pageMarginY. The PageGapWidget renders as: unused-padding above,
// gray bar, top-margin-for-next-page below — visually placing the bar
// exactly at the page boundary.
function computePageBreaks(state) {
  if (!pageBreakConfig.enabled) return Decoration.none;

  const cfg = pageBreakConfig;
  const doc = state.doc;
  const barHeight = Math.max(20, cfg.gapHeight || 60);
  const pageHeight = cfg.pageHeight || 0;
  const pageMarginY = Math.max(24, cfg.pageMarginY || 32);
  const lineHeight = cfg.lineHeight || 24;
  const contentWidth = cfg.contentWidth || 0;
  const fontSpec = cfg.fontSpec || '400 16px sans-serif';
  // Kept for the debug-log line; not used in the computation itself.
  const targetWords = Math.max(50, cfg.wordsPerPage || 400);
  const skippedFrontmatterLines = cfg.suppressFrontmatter ? getFrontmatterEndLine(doc) : 0;

  // Without a known pageHeight (e.g. editor not laid out yet) or content
  // width, we can't compute pixel-accurate breaks. Skip and wait for the
  // next applyStyles → triggerEditors with valid metrics.
  if (pageHeight <= 0 || contentWidth <= 0) {
    dbg(`rebuild: skipped (no metrics) pageHeight=${Math.round(pageHeight)} contentWidth=${Math.round(contentWidth)}`);
    return Decoration.none;
  }

  const measurer = makeMeasurer(fontSpec, contentWidth);

  // First pass: collect blocks. A block is a contiguous run of non-blank
  // lines, with two exceptions that mirror Obsidian's rendering model:
  //   1. A line that is purely an image embed ends the current block and
  //      becomes its own one-line block. Obsidian renders such lines as
  //      standalone block-level elements, so the page-break algorithm
  //      should treat them as independently breakable. Grouping an image
  //      with neighboring text lines (when the author hasn't left a blank
  //      line between them) produces oversized blocks the second pass
  //      can't split across pages.
  //   2. A text line that contains an inline image embed has the image's
  //      height accounted for via a `segments` array on the line item.
  //      These lines stay in their enclosing block (CM6 widgets can't be
  //      placed mid-line), but the height estimator sees text+image as
  //      separate contributions instead of measuring the wikilink syntax
  //      as plain characters and losing the image height entirely.
  // Blank lines between blocks are tallied per-block (blankLinesBefore)
  // so y accounting matches real layout.
  const blocks = [];
  let current = null;
  let pendingBlankLines = 0;
  const totalLines = doc.lines;
  for (let lineNum = (skippedFrontmatterLines ? skippedFrontmatterLines + 1 : 1); lineNum <= totalLines; lineNum++) {
    const line = doc.line(lineNum);
    const text = line.text;
    if (text.trim() === '') {
      if (current) { blocks.push(current); current = null; }
      pendingBlankLines += 1;
      continue;
    }

    if (isPureImageLine(text)) {
      if (current) { blocks.push(current); current = null; }
      blocks.push({
        startPos: line.from,
        blankLinesBefore: pendingBlankLines,
        lines: [{
          text,
          isImage: true,
          imageKey: extractImageKey(text),
          headingLevel: 0,
          segments: null
        }]
      });
      pendingBlankLines = 0;
      continue;
    }

    if (!current) {
      current = {
        startPos: line.from,
        lines: [],
        blankLinesBefore: pendingBlankLines
      };
      pendingBlankLines = 0;
    }
    const headingMatch = /^(#{1,6})\s/.exec(text);
    // Detect inline image embeds mid-text so their heights reach the
    // estimator. Only populated when at least one image token is present;
    // pure text lines leave segments null to keep the estimator's plain
    // text path unchanged.
    const segments = splitLineIntoImageSegments(text);
    const hasInlineImage = segments.some(s => s.type === 'image');

    // Special case: a line that STARTS with an image embed and then continues
    // with prose is almost always author-intent for "image block, then
    // paragraph". Obsidian renders the embed as a block widget anyway, but if
    // we keep the whole source line as one logical paragraph block, pagination
    // can only break before BOTH the image and the prose together, which
    // leaves a visibly short previous page. Split this pattern into two
    // logical blocks with mid-line anchors so breaks can occur between the
    // image and the following text.
    const firstMeaningfulSeg = segments.find(s => s.text && s.text.trim());
    const imagePrefixWithTrailingText =
      hasInlineImage &&
      firstMeaningfulSeg?.type === 'image' &&
      segments.some((s, idx) => idx > segments.indexOf(firstMeaningfulSeg) && s.type === 'text' && s.text.trim());
    if (imagePrefixWithTrailingText) {
      if (current) { blocks.push(current); current = null; }

      let blankLinesBeforeForSeg = pendingBlankLines;
      for (const seg of segments) {
        if (!seg.text || !seg.text.trim()) continue;
        if (seg.type === 'image') {
          blocks.push({
            startPos: line.from + seg.from,
            blankLinesBefore: blankLinesBeforeForSeg,
            lines: [{
              text: seg.text,
              isImage: true,
              imageKey: seg.imageKey,
              headingLevel: 0,
              segments: null
            }]
          });
        } else {
          blocks.push({
            startPos: line.from + seg.from,
            blankLinesBefore: blankLinesBeforeForSeg,
            lines: [{
              text: seg.text,
              isImage: false,
              imageKey: null,
              headingLevel: 0,
              segments: null
            }]
          });
        }
        blankLinesBeforeForSeg = 0;
      }
      pendingBlankLines = 0;
      continue;
    }

    current.lines.push({
      text,
      isImage: false,
      imageKey: null,
      headingLevel: headingMatch ? headingMatch[1].length : 0,
      segments: hasInlineImage ? segments : null
    });
  }
  if (current) blocks.push(current);

  if (blocks.length === 0) return Decoration.none;

// Second pass: walk blocks, tracking cumulative y in px from doc top.
// Insert a page-gap widget BEFORE any block whose addition would overshoot
// the current page's *content* boundary, while still placing the gray bar
// at the page's *physical* boundary. This distinction matters now that
// top/bottom page margins are explicit: the text area on each page is
// pageHeight - (2 * pageMarginY), not pageHeight - pageMarginY.
//
// In other words:
//   - content starts at physicalTop + pageMarginY
//   - content must stop by physicalTop + pageHeight - pageMarginY
//   - the gray bar renders at physicalTop + pageHeight
//
// The 0.5 floor prevents anemic pages when a giant paragraph appears on a
// mostly-empty page — in that case we accept overshoot rather than emit a
// one-short-paragraph page followed by a giant one.
  const ranges = [];
  const pageContentHeight = Math.max(lineHeight * 3, pageHeight - (2 * pageMarginY));
  let pagePhysicalTopY = 0;
  let contentStartY = pagePhysicalTopY + pageMarginY;
  let y = contentStartY;
  let nextPageBoundary = pagePhysicalTopY + pageHeight;
  let contentBoundary = nextPageBoundary - pageMarginY;
  let breakCount = 0;

  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i];

    // Blank lines between previous block and this one are rendered before
    // the widget (their position in the doc precedes block.startPos), so
    // they belong to the closing page.
    y += block.blankLinesBefore * lineHeight;

    // If a giant previous block has already pushed y past the current
    // page's content area without a break, fast-forward so subsequent
    // breaks fall on actual upcoming pages instead of one already behind us.
    while (y > contentBoundary) {
      pagePhysicalTopY += pageHeight;
      contentStartY = pagePhysicalTopY + pageMarginY;
      nextPageBoundary = pagePhysicalTopY + pageHeight;
      contentBoundary = nextPageBoundary - pageMarginY;
    }

    const paraHeight = estimateParagraphHeight(block, cfg, measurer);

    if (i > 0 && paraHeight <= pageHeight) {
      const wouldOvershoot = (y + paraHeight) > contentBoundary;
      const heightUsed = y - contentStartY;
      const pageHasEnough = heightUsed >= pageContentHeight * 0.5;
      if (wouldOvershoot && pageHasEnough) {
        const unused = Math.max(0, nextPageBoundary - y);
        const totalHeight = unused + barHeight + pageMarginY;

        ranges.push(
          Decoration.widget({
            block: true,
            side: -1,
            widget: new PageGapWidget(totalHeight, barHeight, pageMarginY)
          }).range(block.startPos)
        );
        breakCount++;

        // Advance past the widget. The new page begins here.
        pagePhysicalTopY = nextPageBoundary + barHeight;
        contentStartY = pagePhysicalTopY + pageMarginY;
        y = contentStartY;
        nextPageBoundary = pagePhysicalTopY + pageHeight;
        contentBoundary = nextPageBoundary - pageMarginY;
      }
    }

    y += paraHeight;
  }

  dbg(`rebuild: blocks=${blocks.length} breaks=${breakCount} targetWords=${targetWords} pageHeight=${Math.round(pageHeight)} contentPageHeight=${Math.round(pageContentHeight)} lineHeight=${Math.round(lineHeight)} contentWidth=${Math.round(contentWidth)} livePreview=${cfg.normalizeForLivePreview ? 'yes' : 'no'} skippedFrontmatterLines=${skippedFrontmatterLines} enabled=${cfg.enabled}`);

  const deco = Decoration.set(ranges, true);
  // Confirm the DecorationSet has what we think it does before handing
  // to CM6. If size here equals breaks but toDOMCalls remains 0, the
  // problem is in the hand-off (provide facet / extension registration),
  // not in the set construction.
  dbg(`deco-set: size=${deco.size} ranges=${ranges.length}`);
  return deco;
}

// NOTE: no `provide: f => EditorView.decorations.from(f)` here. Decoration
// wiring goes through the explicit `EditorView.decorations.compute(...)` in
// onload(). Earlier we registered both as belt-and-braces when the provide
// path appeared silently broken (size=7 but toDOMCalls=0). Both paths
// firing produced duplicate stacked bars at each break. Single registration
// = one bar per break.
const pageBreakField = StateField.define({
  create(state) {
    return computePageBreaks(state);
  },
  update(value, tr) {
    for (const effect of tr.effects) {
      if (effect.is(rebuildPageBreaks)) {
        return computePageBreaks(tr.state);
      }
    }
    if (tr.docChanged) {
      return computePageBreaks(tr.state);
    }
    return value;
  }
});



// --- Main Plugin ---

class CompositionModePlugin extends Plugin {
  async onload() {
    await this.loadSettings();

    this.isActive = false;
    this.currentZoom = 1;
    this.paperWidth = this.clampPaperWidth(this.settings.defaultPaperWidth);
    this.backgroundFade = this.settings.defaultBackgroundFade;
    this.paperSize = this.settings.paperSize;
    this.showPageBreaks = this.settings.showPageBreaks;

    // Persistent natural-dimensions cache for every image the plugin
    // has ever resolved. Keyed by vault-relative file path; value is
    // { w, h, basename } where basename is the lowercased filename
    // used for lookup by estimateParagraphHeight() / buildImageHeightMap().
    // Survives across docs — switching notes never invalidates entries.
    // Populated by preloadImageDimensionsFromDoc(), which creates an
    // Image() per referenced file, reads naturalWidth/Height on load,
    // and caches here.
    this.imageDimsCache = new Map();
    // Paths for which an Image() load is in flight — prevents kicking
    // off a second preload for the same file before the first finishes.
    this.pendingImagePreloads = new Set();

    // Visual debug overlay flag. Keep the machinery available for future
    // debugging, but default it OFF now that full-width page-break rendering
    // has been verified. The toggle-debug-overlay command can re-enable it.
    this.debugVisualOverlay = false;

    this.addCommand({
      id: 'toggle-composition-mode',
      name: 'Toggle Composition Mode',
      callback: () => this.toggle()
    });

    this.addCommand({
      id: 'reset-zoom',
      name: 'Reset Zoom (Composition Mode)',
      callback: () => this.resetZoom(),
      hotkeys: [{ modifiers: ['Mod'], key: '0' }]
    });

    // Manual diagnostic trigger — fires logBarDiagnostic() on demand.
    // Use when the auto-fire setTimeouts miss the bar-render window
    // (e.g. CM6's measure cycle lands after 2.4s for some reason).
    // Prerequisite: composition mode active + bars visible on screen.
    this.addCommand({
      id: 'log-bar-diagnostic',
      name: 'Log Bar Diagnostic (Composition Mode Debug)',
      callback: () => {
        if (!this.settings.debugMode) return;
        this.logBarDiagnostic();
      }
    });

    // Toggle the visual debug overlay (red bar, colored outlines). Only
    // useful outside composition mode — command palette is blocked while
    // composition mode is active. To use: deactivate, run this command,
    // reactivate to see the new overlay state.
    this.addCommand({
      id: 'toggle-debug-overlay',
      name: 'Toggle Debug Overlay (Composition Mode Debug)',
      callback: () => {
        if (!this.settings.debugMode) {
          this.debugVisualOverlay = false;
          this.applyDebugOverlay();
          return;
        }
        this.debugVisualOverlay = !this.debugVisualOverlay;
        this.applyDebugOverlay();
      }
    });

    this.addSettingTab(new CompositionModeSettingTab(this.app, this));

    // Attach the page-break StateField to every MD editor. It stays
    // dormant (pageBreakConfig.enabled=false → StateField returns empty)
    // until composition mode activates and dispatches a rebuild effect.
    //
    // The field intentionally does NOT have a `provide` facet. Instead
    // we wire its value into CM6's decorations facet via an explicit
    // `EditorView.decorations.compute([pageBreakField], ...)`. This is
    // the path we proved works empirically; the `provide` equivalent
    // appeared to silently no-op in this codebase (size>0 but toDOM
    // never called). Registering both produced duplicate stacked bars.
    this.registerEditorExtension([
      pageBreakField,
      EditorView.decorations.compute([pageBreakField], state => {
        const v = state.field(pageBreakField, false);
        return v || Decoration.none;
      })
    ]);
  }

  onunload() {
    if (this.isActive) this.deactivate();
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    this.settings.defaultPaperWidth = this.clampPaperWidth(this.settings.defaultPaperWidth);
    setDebugModeEnabled(this.settings.debugMode);
  }

  async saveSettings() {
    setDebugModeEnabled(this.settings.debugMode);
    if (!this.settings.debugMode) {
      this.debugVisualOverlay = false;
      this.applyDebugOverlay?.();
    }
    await this.saveData(this.settings);
  }

  toggle() {
    this.isActive ? this.deactivate() : this.activate();
  }

  clampPaperWidth(value) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return DEFAULT_SETTINGS.defaultPaperWidth;
    return Math.max(MIN_PAPER_WIDTH, Math.min(MAX_PAPER_WIDTH, numeric));
  }

  // Resolve DOM nodes from the ACTUAL live CM6 editor first, then walk
  // outward to the paper container. The previous "active view" lookup can
  // land on the wrong leaf in composition mode (see log blocks with
  // paperWidth=720 but scrollerWidth=0/contentWidth=0 — that's the sidebar,
  // not the writing surface). In practice composition mode exposes one live
  // .cm-scroller, so anchor all geometry to that DOM node.
  getActiveCompositionElements() {
    const scrollers = Array.from(
      document.querySelectorAll('body.composition-mode-active .markdown-source-view.mod-cm6 .cm-scroller')
    ).filter(el => {
      const rect = el.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    });

    const scroller = scrollers[0] || null;
    const sourceView = scroller?.closest('.markdown-source-view.mod-cm6') || null;
    const leafContent = scroller?.closest('.workspace-leaf-content') || null;
    const container = leafContent?.closest('.workspace-leaf') || sourceView || null;
    const activeView = this.app.workspace.getActiveViewOfType(MarkdownView) || null;
    const cmContent = sourceView?.querySelector('.cm-content') || null;
    const cmLineCandidates = sourceView
      ? Array.from(sourceView.querySelectorAll('.cm-line'))
      : [];
    const cmLine =
      cmLineCandidates.find(line => {
        const text = line.textContent?.trim() || '';
        return text.length >= 20 && !line.classList.contains('HyperMD-header');
      }) ||
      cmLineCandidates.find(line => !line.classList.contains('HyperMD-header')) ||
      cmLineCandidates[0] ||
      null;
    return { activeView, container, leafContent, sourceView, scroller, cmContent, cmLine };
  }

  describeNode(label, node) {
    if (!node) return `${label}: null`;
    const rect = node.getBoundingClientRect();
    const cs = getComputedStyle(node);
    return (
      `${label}: ${nodeToken(node)}` +
      ` rect=${fmtRect(rect)}` +
      ` client=${node.clientWidth}x${node.clientHeight}` +
      ` offset=${node.offsetWidth}x${node.offsetHeight}` +
      ` scroll=${node.scrollWidth}x${node.scrollHeight}` +
      ` padL=${pxNum(cs.paddingLeft)} padR=${pxNum(cs.paddingRight)}` +
      ` marL=${pxNum(cs.marginLeft)} marR=${pxNum(cs.marginRight)}` +
      ` borL=${pxNum(cs.borderLeftWidth)} borR=${pxNum(cs.borderRightWidth)}` +
      ` ovx=${cs.overflowX} ovy=${cs.overflowY}` +
      ` bg=${cs.backgroundColor}` +
      ` pos=${cs.position} z=${cs.zIndex}`
    );
  }

  logMetricSnapshot(reason, elements, meta = {}) {
    const activeFile = this.app.workspace.getActiveFile();
    const activeFilePath = activeFile?.path || '(none)';
    const nodes = {
      workspaceLeaf: elements?.container || null,
      workspaceLeafContent: elements?.leafContent || null,
      viewContent: elements?.leafContent?.querySelector('.view-content') || null,
      markdownSourceView: elements?.sourceView || null,
      cmEditor: elements?.sourceView?.querySelector('.cm-editor') || null,
      cmScroller: elements?.scroller || null,
      cmSizer: elements?.sourceView?.querySelector('.cm-sizer') || null,
      cmContentContainer: elements?.sourceView?.querySelector('.cm-contentContainer') || null,
      cmContent: elements?.cmContent || null,
      cmLine: elements?.cmLine || null
    };

    const summary =
      `=== metric-snapshot: reason=${reason}` +
      ` file=${activeFilePath}` +
      ` active=${this.isActive ? 'yes' : 'no'}` +
      ` paperSize=${this.paperSize}` +
      ` paperWidthPct=${this.paperWidth}` +
      ` zoom=${Math.round((this.currentZoom || 1) * 1000) / 1000}` +
      ` bgFade=${Math.round((this.backgroundFade || 0) * 1000) / 1000}` +
      ` showBreaks=${this.showPageBreaks ? 'yes' : 'no'}` +
      ` gapHeight=${this.settings.pageGapHeight || 0}` +
      ` wordsPerPage=${this.settings.pageWordCount || 0}` +
      ` ratio=${Math.round((pageBreakConfig.paperRatio || 0) * 10000) / 10000}` +
      ` pageHeight=${Math.round(pageBreakConfig.pageHeight || 0)}` +
      ` lineHeight=${Math.round(pageBreakConfig.lineHeight || 0)}` +
      ` contentWidth=${Math.round(pageBreakConfig.contentWidth || 0)}` +
      ` imageMapSize=${pageBreakConfig.imageHeightMap?.size ?? 0}` +
      ` imageCacheSize=${this.imageDimsCache?.size ?? 0}` +
      ` fontSpec=${JSON.stringify(pageBreakConfig.fontSpec || '')}` +
      ` ===`;
    dbg(summary);

    dbg(
      `metric-source: selector=visible-cm-scroller` +
      ` pageHeightWidthSource=${meta.pageHeightWidthSource || '(unset)'}` +
      ` pageHeightWidthNode=${meta.pageHeightWidthNode || '(unset)'}` +
      ` pageHeightWidth=${Math.round(meta.pageHeightWidth || 0)}` +
      ` bleedSource=${meta.bleedSource || '(unset)'}` +
      ` bleedSourceNode=${meta.bleedSourceNode || '(unset)'}` +
      ` bleedLeft=${Math.round(meta.bleedLeft || 0)}` +
      ` bleedRight=${Math.round(meta.bleedRight || 0)}` +
      ` pageMarginY=${Math.round(meta.pageMarginY || 0)}` +
      ` scrollerPadL=${Math.round(meta.scrollerPaddingLeft || 0)}` +
      ` scrollerPadR=${Math.round(meta.scrollerPaddingRight || 0)}` +
      ` dispatchCount=${meta.dispatchCount ?? -1}` +
      ` fieldHits=${meta.fieldHits ?? -1}` +
      ` postDispatchSize=${meta.postDispatchSize ?? -1}`
    );

    Object.entries(nodes).forEach(([label, node]) => {
      dbg(this.describeNode(`node.${label}`, node));
    });
  }

  // The page-gap widget lives inside .cm-content, but visually it needs to
  // reach the actual white "paper", not the wider workspace leaf that may
  // surround it. Using workspace-leaf was a useful diagnostic step during the
  // clipping investigation, but once the widget geometry was fixed it made the
  // bar overrun the paper when the width slider increased. So the page surface
  // for bar bleed is the active workspace-leaf-content (falling back to the
  // scroller if needed).
  updatePageBreakBleedVars(elements = null) {
    const resolved = elements || this.getActiveCompositionElements();
    const { leafContent, scroller, cmContent } = resolved;
    let scrollerPaddingLeft = 0;
    let scrollerPaddingRight = 0;
    if (scroller) {
      const scrollerStyle = getComputedStyle(scroller);
      scrollerPaddingLeft = parseFloat(scrollerStyle.paddingLeft) || 0;
      scrollerPaddingRight = parseFloat(scrollerStyle.paddingRight) || 0;
    }

    let bleedLeft = scrollerPaddingLeft;
    let bleedRight = scrollerPaddingRight;
    const pageSurface = leafContent || scroller;
    if (pageSurface && cmContent) {
      const leafRect = pageSurface.getBoundingClientRect();
      const contentRect = cmContent.getBoundingClientRect();
      // Under CSS zoom, getBoundingClientRect() returns visual (zoom-scaled)
      // coordinates. Divide by zoom to get layout-space pixels so comparisons
      // with getComputedStyle values (which are layout-space) are consistent.
      const zoom = this.clampZoom(this.currentZoom || 1);
      bleedLeft = Math.max(bleedLeft, (contentRect.left - leafRect.left) / zoom);
      bleedRight = Math.max(bleedRight, (leafRect.right - contentRect.right) / zoom);
    }

    document.documentElement.style.setProperty(
      '--composition-mode-page-margin-left-px',
      `${bleedLeft}px`
    );
    document.documentElement.style.setProperty(
      '--composition-mode-page-margin-right-px',
      `${bleedRight}px`
    );
    // Legacy single-value var kept for existing diagnostics / fallback CSS.
    document.documentElement.style.setProperty(
      '--composition-mode-page-margin-x-px',
      `${Math.max(bleedLeft, bleedRight)}px`
    );
    let pageMarginY = 32; // default: 2rem at 16px base
    if (scroller) {
      const scrollerStyle = getComputedStyle(scroller);
      const topPad = parseFloat(scrollerStyle.paddingTop);
      if (Number.isFinite(topPad) && topPad > 0) {
        pageMarginY = topPad;
      }
    }

    return { bleedLeft, bleedRight, scrollerPaddingLeft, scrollerPaddingRight, pageMarginY };
  }

  activate() {
    if (this.isActive) return;
    this.isActive = true;

    const activeFile = this.app.workspace.getActiveFile();
    if (activeFile && this.settings.zoomLevels[activeFile.path]) {
      this.currentZoom = this.settings.zoomLevels[activeFile.path];
    } else {
      this.currentZoom = 1;
    }
    this.currentZoom = this.clampZoom(this.currentZoom);

    // Escape via Obsidian's Scope API
    this.escapeScope = new Scope(this.app.scope);
    this.escapeScope.register([], 'Escape', () => {
      this.deactivate();
      return false;
    });
    this.app.keymap.pushScope(this.escapeScope);

    document.body.classList.add('composition-mode-active');
    this.applyDebugOverlay();
    this.createBackdrop();
    this.injectStyleEl();
    this.createControlBar();
    this.createHoverZone();
    this.setupZoomHandlers();
    this.setupResizeHandler();
    this.applyStyles();
  }

  deactivate() {
    if (!this.isActive) return;
    this.isActive = false;

    // Clear page-gap widgets from every editor before tearing down the rest.
    // (triggerEditors sets pageBreakConfig.enabled=false → dispatches rebuild
    // → StateField returns Decoration.none → widgets removed from view.)
    this.triggerEditors();

    if (this.escapeScope) {
      this.app.keymap.popScope(this.escapeScope);
      this.escapeScope = null;
    }

    document.body.classList.remove('composition-mode-active');
    document.body.classList.remove('composition-debug-overlay');

    if (this.backdrop) { this.backdrop.remove(); this.backdrop = null; }
    if (this.styleEl) { this.styleEl.remove(); this.styleEl = null; }
    if (this.controlBar) { this.controlBar.remove(); this.controlBar = null; }
    if (this.hoverZone) { this.hoverZone.remove(); this.hoverZone = null; }

    if (this.zoomHandler) {
      document.removeEventListener('wheel', this.zoomHandler, true);
      this.zoomHandler = null;
    }
    if (this.gestureStartHandler) {
      document.removeEventListener('gesturestart', this.gestureStartHandler, true);
      this.gestureStartHandler = null;
    }
    if (this.gestureHandler) {
      document.removeEventListener('gesturechange', this.gestureHandler, true);
      this.gestureHandler = null;
    }
    if (this.wordCountInterval) {
      clearInterval(this.wordCountInterval);
      this.wordCountInterval = null;
    }
    if (this.resizeHandler) {
      window.removeEventListener('resize', this.resizeHandler);
      this.resizeHandler = null;
    }
    if (this.pendingMetricsFrame) {
      cancelAnimationFrame(this.pendingMetricsFrame);
      this.pendingMetricsFrame = null;
    }
  }

  // --- UI ---

  createBackdrop() {
    this.backdrop = document.createElement('div');
    this.backdrop.className = 'composition-mode-backdrop';
    document.body.appendChild(this.backdrop);
  }

  injectStyleEl() {
    this.styleEl = document.createElement('style');
    this.styleEl.id = 'composition-mode-dynamic';
    document.head.appendChild(this.styleEl);
  }

  getPaperTextScale() {
    return Math.max(0.88, Math.min(1.05, 1 + (this.paperWidth - DEFAULT_SETTINGS.defaultPaperWidth) * 0.004));
  }

  clampZoom(value) {
    if (!Number.isFinite(value)) return 1;
    return Math.max(MIN_VISUAL_ZOOM, Math.min(MAX_VISUAL_ZOOM, value));
  }

  // Parse all image references out of the current doc and kick off an
  // Image() preload for any we haven't cached yet. On load, naturalWidth /
  // naturalHeight go into this.imageDimsCache and a rebuild is scheduled
  // so pagination picks up the real dimensions.
  //
  // Why preload rather than read from the live <img> tags: CM6 virtualizes
  // large documents, so images below the fold may not have any <img> in
  // the DOM. We need dimensions for every image the doc references, not
  // just the visible ones, or pagination drifts based on what happens to
  // be rendered at the moment.
  //
  // Cache is plugin-lifetime — entries survive across doc switches and
  // composition-mode toggles. Image files are immutable at the byte level
  // (Obsidian rewrites by path, not by edit), so a cached dimension is
  // valid until the file is actually replaced.
  preloadImageDimensionsFromDoc(activeView) {
    if (!activeView || !activeView.file) return;
    const sourcePath = activeView.file.path;
    const docText = activeView.editor?.getValue?.() || '';
    if (!docText) return;

    const refs = [];
    // Obsidian wikilinks: ![[file.png]] / ![[folder/file.png|alias]]
    const reWiki = /!\[\[([^\]|#\n]+)(?:[|#][^\]\n]*)?\]\]/g;
    let m;
    while ((m = reWiki.exec(docText)) !== null) {
      refs.push(m[1].trim());
    }
    // Standard markdown: ![alt](path.png) — skip external URLs
    const reMd = /!\[[^\]]*\]\(\s*<?([^\s)>]+)>?(?:\s+"[^"]*")?\s*\)/g;
    while ((m = reMd.exec(docText)) !== null) {
      const raw = m[1].trim();
      if (/^https?:/i.test(raw) || /^data:/i.test(raw)) continue;
      try {
        refs.push(decodeURIComponent(raw));
      } catch (e) {
        refs.push(raw);
      }
    }

    for (const linkpath of refs) {
      const file = this.app.metadataCache.getFirstLinkpathDest(linkpath, sourcePath);
      if (!file) continue;
      if (this.imageDimsCache.has(file.path)) continue;
      if (this.pendingImagePreloads.has(file.path)) continue;

      this.pendingImagePreloads.add(file.path);
      const probe = new Image();
      const cleanup = (ok) => {
        this.pendingImagePreloads.delete(file.path);
        if (ok && probe.naturalWidth > 0 && probe.naturalHeight > 0) {
          this.imageDimsCache.set(file.path, {
            w: probe.naturalWidth,
            h: probe.naturalHeight,
            basename: file.name.toLowerCase()
          });
          if (this.isActive) this.scheduleMetricsRefreshAndRebuild();
        }
      };
      probe.addEventListener('load', () => cleanup(true), { once: true });
      probe.addEventListener('error', () => cleanup(false), { once: true });
      probe.src = this.app.vault.getResourcePath(file);
    }
  }

  // Read the currently rendered note DOM and capture any exact image
  // dimensions we can see right now. Live Preview / theme CSS may cap
  // image width well below cmContent.clientWidth, which means the
  // natural-dims fallback in buildImageHeightMap() can significantly
  // overestimate image height and end pages too early. Visible images
  // give us two useful signals:
  //   1. exact rendered heights for images already in the DOM
  //   2. a shared width cap we can reuse for off-screen images in the
  //      same note, since themes usually size all body images the same way
  getRenderedImageMetrics(elements = null) {
    const resolved = elements || this.getActiveCompositionElements();
    const root = resolved?.sourceView || resolved?.cmContent || null;
    const heightMap = new Map();
    let widthCap = 0;
    if (!root) return { heightMap, widthCap, count: 0 };

    const zoom = this.clampZoom(this.currentZoom || 1);
    const imgs = root.querySelectorAll('.cm-content .image-embed img, .cm-content .internal-embed img');
    imgs.forEach(img => {
      const width = img.clientWidth || Math.round((img.getBoundingClientRect().width || 0) / zoom);
      const height = img.clientHeight || Math.round((img.getBoundingClientRect().height || 0) / zoom);
      if (!(width > 0) || !(height > 0)) return;

      widthCap = Math.max(widthCap, width);

      const key =
        basenameFromUrlish(img.currentSrc) ||
        basenameFromUrlish(img.getAttribute('src')) ||
        basenameFromUrlish(img.getAttribute('alt')) ||
        basenameFromUrlish(img.closest('.internal-embed')?.getAttribute?.('src')) ||
        null;
      if (key) {
        heightMap.set(key, Math.round(height));
      }
    });

    return { heightMap, widthCap, count: heightMap.size };
  }

  // Build a filename → displayed-height map for every image in the
  // plugin's natural-dimensions cache. Height is
  //   min(naturalWidth, contentWidth) × (naturalHeight / naturalWidth)
  // — exactly how the browser lays the image out under `max-width: 100%`.
  //
  // No fallback. Every image referenced in the doc is a known vault
  // file; preloadImageDimensionsFromDoc() populates the cache; lookups
  // in estimateParagraphHeight() hit exact values. If a preload is
  // still in flight when a rebuild fires, the corresponding image gets
  // 0 height for this pass; the preload's load event will trigger
  // another rebuild with the real dimension.
  buildImageHeightMap(contentWidth, renderedImageMetrics = null) {
    const map = new Map();
    if (!contentWidth || contentWidth <= 0) return map;

    const exactHeights =
      renderedImageMetrics?.heightMap instanceof Map
        ? renderedImageMetrics.heightMap
        : null;
    const widthCap = Math.max(
      0,
      Math.min(
        contentWidth,
        renderedImageMetrics?.widthCap || 0
      )
    );
    const effectiveWidth = widthCap > 0 ? widthCap : contentWidth;

    for (const dims of this.imageDimsCache.values()) {
      if (!dims || !dims.basename || dims.w <= 0 || dims.h <= 0) continue;
      if (exactHeights?.has(dims.basename)) {
        map.set(dims.basename, exactHeights.get(dims.basename));
        continue;
      }
      const displayedWidth = Math.min(dims.w, effectiveWidth);
      const displayedHeight = displayedWidth * (dims.h / dims.w);
      map.set(dims.basename, Math.round(displayedHeight));
    }

    return map;
  }

  applyStyles() {
    if (!this.styleEl) return;

    const grayValue = Math.round(200 - this.backgroundFade * 200);
    const bgColor = `rgb(${grayValue}, ${grayValue}, ${grayValue})`;
    const textScale = this.getPaperTextScale();
    const visualZoom = this.clampZoom(this.currentZoom || 1);

    if (this.backdrop) {
      this.backdrop.style.backgroundColor = bgColor;
    }

    // Match the page-gap color to the backdrop so gaps look like paper
    // has been physically cut between pages (Google Docs style).
    document.documentElement.style.setProperty('--composition-mode-gap-color', bgColor);

    // Zoom via CSS zoom on .workspace-leaf-content.
    //
    // CSS zoom scales visual output without text reflow: layout is
    // computed at reference scale, then magnified. Page breaks depend
    // only on the reference layout, so they stay fixed across zoom.
    //
    // Scroll behavior: .cm-scroller is the scroll container and lives
    // INSIDE the zoomed element. Scroll distances scale with the zoom
    // naturally — no margin hacks needed.
    //
    // clientWidth / getComputedStyle: both return layout-space
    // (unscaled) values on elements inside the zoomed subtree, so
    // cmContent.clientWidth stays constant across zoom — exactly what
    // the page-break measurer needs. Note: getBoundingClientRect()
    // returns visual (zoom-scaled) values and must be divided by the
    // zoom factor when compared with layout-space measurements.

    this.styleEl.textContent = `
      body.composition-mode-active .workspace-leaf-content {
        width: ${this.paperWidth}% !important;
        min-width: min(160px, calc(100vw - 6rem)) !important;
        max-width: calc(100vw - 6rem) !important;
        box-sizing: border-box !important;
        background: var(--background-primary) !important;
        zoom: ${visualZoom};
      }
      body.composition-mode-active .cm-editor {
        --composition-mode-page-margin-x: 1.25in;
      }
      body.composition-mode-active .markdown-source-view.mod-cm6,
      body.composition-mode-active .cm-editor,
      body.composition-mode-active .cm-contentContainer,
      body.composition-mode-active .cm-content {
        background: transparent !important;
      }
      body.composition-mode-active .markdown-source-view.mod-cm6 {
        font-size: ${textScale}em;
      }
      body.composition-mode-active .cm-content {
        font-size: inherit;
      }
    `;

    this.updateZoomDisplay();

    // Fast path: if only zoom changed, skip the full rebuild. CSS zoom is
    // pure magnification — page breaks are identical at every zoom level.
    const zoomOnly = (
      visualZoom !== this._prevZoom &&
      textScale === this._prevTextScale &&
      this.paperWidth === this._prevPaperWidth
    );
    this._prevZoom = visualZoom;
    this._prevTextScale = textScale;
    this._prevPaperWidth = this.paperWidth;

    if (!zoomOnly) {
      // Re-measure and rebuild AFTER the new dynamic CSS has landed.
      // Doing triggerEditors() synchronously here races the browser's layout
      // update during width-slider changes, which leaves us rebuilding from
      // stale paper/scroller widths for one cycle. That is exactly the
      // "expand width -> bar does something weird" regression.
      this.scheduleMetricsRefreshAndRebuild();
    }
  }

  scheduleMetricsRefreshAndRebuild() {
    if (this.pendingMetricsFrame) {
      cancelAnimationFrame(this.pendingMetricsFrame);
    }
    this.pendingMetricsFrame = requestAnimationFrame(() => {
      this.pendingMetricsFrame = null;
      if (!this.isActive) return;
      this.updateScrollerMetrics();
      this.triggerEditors();
    });
  }

  // Read the scroller's rendered horizontal padding (= paper's horizontal
  // margin), but measured against the ACTIVE paper edges instead of the
  // first scroller found in the document. This exposes left/right bleed vars
  // so the page-gap bar can reach the full paper width even if the active
  // editor subtree is asymmetrically inset.
  updateScrollerMetrics() {
    if (!this.isActive) return;
    const elements = this.getActiveCompositionElements();
    if (!elements.scroller) return;
    this.updatePageBreakBleedVars(elements);
  }

  // Apply or remove the visual debug overlay class on document.body. When
  // present, the overlay CSS in styles.css paints the bar red with a yellow
  // outline, outlines .view-content in green, .cm-scroller in cyan, and
  // .workspace-leaf-content in magenta. Lets a single screenshot reveal
  // which element is the wide white "paper" the user perceives and whether
  // the bar's paint actually reaches that element's edges.
  applyDebugOverlay() {
    if (this.settings?.debugMode && this.debugVisualOverlay) {
      document.body.classList.add('composition-debug-overlay');
    } else {
      document.body.classList.remove('composition-debug-overlay');
    }
  }

  // Enumeration-first diagnostic. Produces multiple categorized dbg() lines
  // so the log block is scannable. Each pass covers:
  //   1. summary: bar count, leaf-content count, scroller count, toDOM
  //      calls, body active flag, viewport width
  //   2. bar[i]: rect, computed margins, and the rects of its closest
  //      .cm-scroller, .workspace-leaf-content, .markdown-source-view.
  //      Multiple bars with different scrollers = multi-pane; different
  //      widths = wrong-scroller hypothesis confirmed.
  //   3. leaf[i]: rect and background-color for every .workspace-leaf-
  //      content. Identifies which pane is painting white.
  //   4. scroller[i]: rect, computed padding-left/right, overflow-x/y.
  //      Tells us if a scroller has overflow:hidden clipping the bar's
  //      negative-margin bleed.
  //   5. bar-style: CSS-var value and the first bar's computed
  //      marginLeft/marginRight/width.
  //   6. ancestors: from the first bar's scroller up to body — width, bg,
  //      overflow-x, overflow-y, transform, clip-path, z-index, position.
  //      This is where hypothesis (1) and (4) become visible: any hop
  //      with overflow:hidden or a transform/clip-path is the culprit.
  //   7. elementFromPoint: four y-centered probes at the bar's left edge,
  //      scroller's left edge, scroller's right edge, and bar's center.
  //      If any probe returns something other than .composition-mode-
  //      page-gap where we expected it to, an element is painting on top
  //      of the bar's bleed (hypothesis 2) — the returned tag/class
  //      identifies the offender.
  //
  // NEVER writes back into any StateField or decoration — pure telemetry.
  logBarDiagnostic() {
    const allBars = document.querySelectorAll('.composition-mode-page-gap');
    const allLeafContents = document.querySelectorAll('.workspace-leaf-content');
    const allScrollers = document.querySelectorAll('.cm-scroller');
    const toDOMCalls = window.__compositionToDOMCalls || 0;
    const bodyActive = document.body.classList.contains('composition-mode-active') ? 'yes' : 'no';
    const elements = this.getActiveCompositionElements();

    // 1. Pass header / summary — makes each diagnostic block easy to locate
    //    when scanning the log.
    dbg(
      `=== diagnostic: totalBars=${allBars.length}` +
      ` totalLeafContents=${allLeafContents.length}` +
      ` totalScrollers=${allScrollers.length}` +
      ` toDOMCalls=${toDOMCalls}` +
      ` bodyActive=${bodyActive}` +
      ` vw=${window.innerWidth} ===`
    );
    this.logMetricSnapshot('logBarDiagnostic', elements, this.lastMetricMeta || {});

    if (allBars.length === 0) {
      dbg(`bar-enum: (no bars found)`);
      return;
    }

    // 2. Enumerate every bar with its ancestor rects. Multi-pane cases
    //    jump out immediately — different scroller widths or different
    //    leaf-content widths mean we're targeting the wrong one in
    //    updateScrollerMetrics().
    allBars.forEach((bar, i) => {
      const barRect = bar.getBoundingClientRect();
      const bs = getComputedStyle(bar);
      const scroller = bar.closest('.cm-scroller');
      const leaf = bar.closest('.workspace-leaf-content');
      const sourceView = bar.closest('.markdown-source-view');
      const scrollerRect = scroller ? scroller.getBoundingClientRect() : null;
      const leafRect = leaf ? leaf.getBoundingClientRect() : null;
      const srcRect = sourceView ? sourceView.getBoundingClientRect() : null;
      dbg(
        `bar[${i}]: rect=${fmtRect(barRect)}` +
        ` ml=${bs.marginLeft} mr=${bs.marginRight}` +
        ` scroller=${fmtRect(scrollerRect)}` +
        ` leaf=${fmtRect(leafRect)}` +
        ` src-view=${fmtRect(srcRect)}`
      );
    });

    // 3. Enumerate every workspace-leaf-content. bg-color identifies which
    //    is actually painting white (the one the user sees as "paper").
    allLeafContents.forEach((leaf, i) => {
      const r = leaf.getBoundingClientRect();
      const bg = getComputedStyle(leaf).backgroundColor;
      dbg(`leaf[${i}]: ${shortCls(leaf, 2)} rect=${fmtRect(r)} bg=${bg}`);
    });

    // 4. Enumerate every cm-scroller. overflow-x:hidden here would clip
    //    any negative-margin bleed; padding values confirm the horizontal
    //    margin computation.
    allScrollers.forEach((scroller, i) => {
      const r = scroller.getBoundingClientRect();
      const cs = getComputedStyle(scroller);
      dbg(
        `scroller[${i}]: rect=${fmtRect(r)}` +
        ` padL=${cs.paddingLeft} padR=${cs.paddingRight}` +
        ` ovx=${cs.overflowX} ovy=${cs.overflowY}`
      );
    });

    // 5. CSS var + first-bar computed values — prove the var-set negative
    //    margins are in fact computed.
    const bar = allBars[0];
    const barRect = bar.getBoundingClientRect();
    const scroller = bar.closest('.cm-scroller');
    const scrollerRect = scroller ? scroller.getBoundingClientRect() : null;
    const cssVar = getComputedStyle(document.documentElement)
      .getPropertyValue('--composition-mode-page-margin-x-px').trim() || '(unset)';
    const cssVarL = getComputedStyle(document.documentElement)
      .getPropertyValue('--composition-mode-page-margin-left-px').trim() || '(unset)';
    const cssVarR = getComputedStyle(document.documentElement)
      .getPropertyValue('--composition-mode-page-margin-right-px').trim() || '(unset)';
    const bs = getComputedStyle(bar);
    dbg(
      `bar-style: var=${cssVar}` +
      ` varL=${cssVarL} varR=${cssVarR}` +
      ` barML=${bs.marginLeft} barMR=${bs.marginRight} barCSSw=${bs.width}` +
      ` barClient=${bar.clientWidth} barScroll=${bar.scrollWidth}`
    );

    // 6. Ancestor walk from the first bar's scroller up to body. We log
    //    width, bg, overflow-x, overflow-y, transform, clip-path, z-index,
    //    position — any of which can be the root cause of a measurement-
    //    vs-paint mismatch. A hop with overflow:hidden is the most likely
    //    culprit for hypothesis (1). A transform or clip-path is
    //    hypothesis (4). A non-auto z-index or position:fixed is
    //    hypothesis (2). bg-color identifies which ancestor is painting
    //    the white the user sees as "paper".
    if (scroller) {
      const parts = [];
      let node = scroller;
      let hops = 0;
      while (node && hops < 20) {
        const r = node.getBoundingClientRect();
        const cs = getComputedStyle(node);
        const tag = node.tagName.toLowerCase();
        const cls = shortCls(node, 3);
        const bg = cs.backgroundColor;
        const bgShort = (bg === 'rgba(0, 0, 0, 0)' || bg === 'transparent') ? 't' : bg.replace(/\s+/g, '');
        const xf = cs.transform;
        const xfShort = (xf === 'none' || !xf) ? 'n' : xf.replace(/\s+/g, '').slice(0, 24);
        const cp = cs.clipPath;
        const cpShort = (cp === 'none' || !cp) ? 'n' : cp.replace(/\s+/g, '').slice(0, 24);
        parts.push(
          `${tag}${cls ? '.' + cls : ''}` +
          `(w=${Math.round(r.width)}` +
          `,bg=${bgShort}` +
          `,ox=${cs.overflowX},oy=${cs.overflowY}` +
          `,xf=${xfShort},cp=${cpShort}` +
          `,z=${cs.zIndex},p=${cs.position})`
        );
        if (node === document.body) break;
        node = node.parentElement;
        hops++;
      }
      dbg(`ancestors: ${parts.join(' <- ')}`);
    }

    // 7. elementFromPoint probes at y-center of the bar. If the bar visibly
    //    reaches where its rect says it does, every probe returns
    //    .composition-mode-page-gap (or the outer .composition-mode-page-
    //    break). If a probe returns something else where the bar should
    //    be (e.g. scrL+10, scrR-10 when bar rect ≡ scroller rect), an
    //    element is painting on top of the bleed area — the returned
    //    tag.class identifies it.
    const y = Math.round(barRect.top + barRect.height / 2);
    const probes = [
      { label: 'barL+2', x: Math.round(barRect.left + 2), y }
    ];
    if (scrollerRect) {
      probes.push({ label: 'scrL+10', x: Math.round(scrollerRect.left + 10), y });
      probes.push({ label: 'scrR-10', x: Math.round(scrollerRect.right - 10), y });
    }
    probes.push({ label: 'barCtr', x: Math.round((barRect.left + barRect.right) / 2), y });

    const probeLabels = probes.map(pt => {
      const el = document.elementFromPoint(pt.x, pt.y);
      if (!el) return `${pt.label}@(${pt.x},${pt.y})=null`;
      const tag = el.tagName.toLowerCase();
      const cls = shortCls(el, 2);
      return `${pt.label}@(${pt.x},${pt.y})=${tag}${cls ? '.' + cls : ''}`;
    });
    dbg(`elementFromPoint: ${probeLabels.join(' | ')}`);
  }

  triggerEditors() {
    pageBreakConfig.enabled = this.isActive && this.showPageBreaks;
    pageBreakConfig.wordsPerPage = this.settings.pageWordCount || 400;
    // Gap height at reference scale. CSS transform zoom handles visual
    // scaling — no need to multiply by zoom here.
    pageBreakConfig.gapHeight = this.settings.pageGapHeight || 60;
    const paperSizeDef = PAPER_SIZES[this.paperSize] || PAPER_SIZES.letter;
    pageBreakConfig.paperRatio = paperSizeDef.height / paperSizeDef.width;

    // One-shot geometry / font-metric reads. These are the ONLY DOM reads
    // in the page-break pipeline — downstream math is pure (see
    // computePageBreaks). On resize / paper-width slider / zoom,
    // applyStyles() → triggerEditors() refreshes them. Reading paragraph
    // y-positions instead would feed back into CM6's height-map and
    // produce the multi-second oscillation we explicitly avoid here.
    const elements = this.getActiveCompositionElements();
    const { container, leafContent, scroller, cmLine, cmContent } = elements;
    const pageSurface = leafContent || scroller || container || null;
    const isLivePreview = !!elements.sourceView?.classList?.contains('is-live-preview');
    const hasFrontmatter = !!(
      elements.activeView?.file &&
      this.app.metadataCache.getFileCache(elements.activeView.file)?.frontmatter
    );
    let scrollerClientWidth = 0;
    let scrollerPaddingLeft = 0;
    let scrollerPaddingRight = 0;
    let bleedLeft = 0;
    let bleedRight = 0;
    let pageMarginY = pageBreakConfig.pageMarginY || 32;
    let pageHeightWidth = 0;
    let pageHeightWidthSource = '(unset)';
    if (scroller) {
      scrollerClientWidth = scroller.clientWidth;
      const bleed = this.updatePageBreakBleedVars(elements);
      scrollerPaddingLeft = bleed.scrollerPaddingLeft;
      scrollerPaddingRight = bleed.scrollerPaddingRight;
      bleedLeft = bleed.bleedLeft;
      bleedRight = bleed.bleedRight;
      pageMarginY = bleed.pageMarginY || pageMarginY;
      pageHeightWidth = pageSurface?.clientWidth || scrollerClientWidth;
      pageHeightWidthSource = leafContent?.clientWidth
        ? 'workspace-leaf-content.clientWidth'
        : scroller?.clientWidth
          ? 'cm-scroller.clientWidth'
          : 'workspace-leaf.clientWidth';
      // Page height derives from the paper's physical aspect ratio,
      // not the viewport. Zoom is now CSS zoom — descendants report
      // clientWidth in reference (unzoomed) coordinates, so
      // pageHeightWidth stays constant regardless of zoom.
      // pageHeight = paperWidth × (11/8.5) for letter, giving each
      // "page" the proportions of a real sheet. Zoom-invariant.
      const paperRatio = pageBreakConfig.paperRatio || (11 / 8.5);
      pageBreakConfig.pageHeight = pageHeightWidth * paperRatio;
    } else {
      pageBreakConfig.pageHeight = 0;
    }
    pageBreakConfig.pageMarginY = pageMarginY;

    if (cmLine && cmContent) {
      const lineStyle = getComputedStyle(cmLine);
      let lineHeight = parseFloat(lineStyle.lineHeight);
      const fontSize = lineStyle.fontSize;
      const fontFamily = lineStyle.fontFamily;
      const fontWeight = lineStyle.fontWeight || '400';
      if (!Number.isFinite(lineHeight) || lineHeight <= 0) {
        // 'normal' or invalid → estimate at 1.5 × font-size
        const fontSizePx = parseFloat(fontSize) || 16;
        lineHeight = fontSizePx * 1.5;
      }
      pageBreakConfig.lineHeight = lineHeight;
      pageBreakConfig.fontSpec = `${fontWeight} ${fontSize} ${fontFamily}`;
      pageBreakConfig.contentWidth = cmContent.clientWidth || 0;
    } else {
      // Editor DOM not yet rendered (e.g. very first activate, pre-layout).
      // Fall back to defaults; the next applyStyles → triggerEditors call
      // (resize, next frame, toggle) will refresh with real values. With
      // contentWidth=0, computePageBreaks short-circuits to no widgets
      // until valid metrics arrive.
      pageBreakConfig.lineHeight = 24;
      pageBreakConfig.fontSpec = '400 16px sans-serif';
      pageBreakConfig.contentWidth = 0;
    }
    // Ensure every image referenced in the active doc has a cached
    // natural dimension. Cheap when the cache is already populated
    // (skips known files); kicks off Image() preloads otherwise. Each
    // completed preload schedules a rebuild via scheduleMetricsRefresh-
    // AndRebuild, so pagination self-corrects as dimensions arrive.
    this.preloadImageDimensionsFromDoc(elements.activeView);
    const renderedImageMetrics = this.getRenderedImageMetrics(elements);
    pageBreakConfig.imageHeightMap = this.buildImageHeightMap(
      pageBreakConfig.contentWidth,
      renderedImageMetrics
    );
    pageBreakConfig.normalizeForLivePreview = isLivePreview;
    pageBreakConfig.suppressFrontmatter = isLivePreview && hasFrontmatter;
    pageBreakConfig.headingScale = 1.3;

    // One-line diagnostic so we can confirm page-surface and bleed math
    // from the log. We keep both the chosen page-surface width and the
    // inner workspace-leaf-content width visible because the mismatch
    // between them is the bug under investigation.
    const pageSurfaceWidth = pageSurface ? pageSurface.clientWidth : 0;
    const paperWidth = leafContent ? leafContent.clientWidth : 0;
    dbg(
      `metrics: pageSurfaceWidth=${Math.round(pageSurfaceWidth)}` +
      ` paperWidth=${Math.round(paperWidth)}` +
      ` scrollerWidth=${Math.round(scrollerClientWidth)}` +
      ` scrollerPadL=${Math.round(scrollerPaddingLeft)}` +
      ` scrollerPadR=${Math.round(scrollerPaddingRight)}` +
      ` pageMarginY=${Math.round(pageMarginY)}` +
      ` bleedL=${Math.round(bleedLeft)}` +
      ` bleedR=${Math.round(bleedRight)}` +
      ` contentWidth=${Math.round(pageBreakConfig.contentWidth)}` +
      ` imageWidthCap=${Math.round(renderedImageMetrics?.widthCap || 0)}` +
      ` renderedImages=${renderedImageMetrics?.count || 0}` +
      ` imageMapSize=${pageBreakConfig.imageHeightMap?.size ?? 0}` +
      ` imageCacheSize=${this.imageDimsCache?.size ?? 0}` +
      ` pendingPreloads=${this.pendingImagePreloads?.size ?? 0}` +
      ` livePreview=${pageBreakConfig.normalizeForLivePreview ? 'yes' : 'no'}` +
      ` suppressFrontmatter=${pageBreakConfig.suppressFrontmatter ? 'yes' : 'no'}` +
      ` lineHeight=${Math.round(pageBreakConfig.lineHeight)}`
    );

    pageBreakConfig._v += 1;

    // Dispatch a rebuildPageBreaks effect into each editor. This is the
    // ONLY way to force the StateField to re-run computePageBreaks() when
    // the doc hasn't changed (e.g. toggling composition mode, changing
    // any setting). The effect has no payload — the field's update()
    // just sees tr.effects.some(e => e.is(rebuildPageBreaks)) and
    // rebuilds from the current pageBreakConfig.
    let dispatchCount = 0;
    let fieldHits = 0;
    let postDispatchSize = -1;
    this.app.workspace.iterateAllLeaves(leaf => {
      const view = leaf.view;
      if (view instanceof MarkdownView && view.editor && view.editor.cm) {
        try {
          view.editor.cm.dispatch({ effects: rebuildPageBreaks.of(null) });
          dispatchCount++;
          // Read back the field value from this editor's state. If the
          // field isn't installed on this editor, state.field returns
          // undefined; we catch to count as miss. If it IS installed,
          // we record the DecorationSet size.
          try {
            const val = view.editor.cm.state.field(pageBreakField);
            fieldHits++;
            if (val && typeof val.size === 'number') postDispatchSize = val.size;
          } catch (e) {}
        } catch (e) {}
      }
    });
    dbg(`dispatch: count=${dispatchCount} fieldHits=${fieldHits} postDispatchSize=${postDispatchSize}`);

    this.lastMetricMeta = {
      reason: 'triggerEditors',
      pageHeightWidth,
      pageHeightWidthSource,
      pageHeightWidthNode: nodeToken(pageSurface),
      bleedSource: 'page-surface <- cm-content rect delta',
      bleedSourceNode: `${nodeToken(pageSurface)} <- ${nodeToken(cmContent)}`,
      bleedLeft,
      bleedRight,
      pageMarginY,
      scrollerPaddingLeft,
      scrollerPaddingRight,
      dispatchCount,
      fieldHits,
      postDispatchSize
    };
    this.logMetricSnapshot('triggerEditors', elements, this.lastMetricMeta);

    // After the dispatch loop, the StateField has emitted new widgets but
    // CM6 commits them to the DOM during its next measure cycle. Since
    // removing the duplicate `provide` path, 250ms has proven too short
    // (see log 2026-04-19T20:11:27) — toDOM is called but after our
    // timeout, producing "totalBars=0" false negatives. Fire at 1200ms
    // AND again at 2400ms so one of them catches the bars regardless of
    // how CM6 schedules measurement.
    if (pageBreakConfig.enabled && this.settings.debugMode) {
      setTimeout(() => {
        this.applyDebugOverlay();
        this.logBarDiagnostic();
      }, 1200);
      setTimeout(() => {
        this.applyDebugOverlay();
        this.logBarDiagnostic();
      }, 2400);
    }
  }

  createHoverZone() {
    this.hoverZone = document.createElement('div');
    this.hoverZone.className = 'composition-mode-hover-zone';
    this.hoverZone.addEventListener('mouseenter', () => {
      if (this.controlBar) this.controlBar.classList.add('is-visible');
    });
    document.body.appendChild(this.hoverZone);
  }

  createControlBar() {
    this.controlBar = document.createElement('div');
    this.controlBar.className = 'composition-mode-control-bar';

    this.controlBar.addEventListener('mouseenter', () => {
      this.controlBar.classList.add('is-visible');
    });
    this.controlBar.addEventListener('mouseleave', () => {
      this.controlBar.classList.remove('is-visible');
    });

    // Zoom controls
    const zoomGroup = this.makeGroup('Zoom');
    const zoomMinus = this.makeEl('button', 'composition-mode-btn');
    zoomMinus.textContent = '−';
    zoomMinus.addEventListener('click', () => {
      this.currentZoom = this.clampZoom(this.currentZoom - 0.1);
      this.applyStyles();
      this.saveZoomLevel();
    });
    const zoomEl = this.makeEl('div', 'composition-mode-zoom-display');
    this.zoomDisplay = zoomEl;
    const zoomPlus = this.makeEl('button', 'composition-mode-btn');
    zoomPlus.textContent = '+';
    zoomPlus.addEventListener('click', () => {
      this.currentZoom = this.clampZoom(this.currentZoom + 0.1);
      this.applyStyles();
      this.saveZoomLevel();
    });
    const zoomReset = this.makeEl('button', 'composition-mode-btn');
    zoomReset.textContent = '1:1';
    zoomReset.addEventListener('click', () => {
      this.resetZoom();
    });
    zoomGroup.append(zoomMinus, zoomEl, zoomPlus, zoomReset);

    // Paper size toggle
    const paperSizeGroup = this.makeGroup('Paper');
    const paperSizeBtn = this.makeEl('button', 'composition-mode-btn');
    paperSizeBtn.textContent = PAPER_SIZES[this.paperSize].label;
    this.paperSizeBtn = paperSizeBtn;
    paperSizeBtn.addEventListener('click', () => {
      this.paperSize = this.paperSize === 'letter' ? 'a4' : 'letter';
      this.paperSizeBtn.textContent = PAPER_SIZES[this.paperSize].label;
      this.settings.paperSize = this.paperSize;
      this.saveSettings();
      this.applyStyles();
    });
    paperSizeGroup.appendChild(paperSizeBtn);

    // Pages toggle
    const pagesGroup = this.makeGroup('Pages');
    const pagesBtn = this.makeEl('button', 'composition-mode-btn');
    pagesBtn.textContent = this.showPageBreaks ? 'On' : 'Off';
    this.pagesBtn = pagesBtn;
    pagesBtn.addEventListener('click', () => {
      this.showPageBreaks = !this.showPageBreaks;
      pagesBtn.textContent = this.showPageBreaks ? 'On' : 'Off';
      this.settings.showPageBreaks = this.showPageBreaks;
      this.saveSettings();
      this.applyStyles();
    });
    pagesGroup.appendChild(pagesBtn);

    // Paper width — fixed at 90%, slider removed.
    // Keep the value so applyStyles() still has a width to work with.
    this.paperWidth = 90;

    // Background fade slider
    const fadeGroup = this.makeGroup('Background');
    const fadeSlider = this.makeSlider(0, 100, 5, this.backgroundFade * 100, (v) => {
      this.backgroundFade = v / 100;
      this.applyStyles();
    });
    fadeGroup.appendChild(fadeSlider);

    // Word count
    const wordCountEl = this.makeEl('div', 'composition-mode-word-count');
    this.wordCountEl = wordCountEl;
    this.updateWordCount();

    this.controlBar.append(zoomGroup, paperSizeGroup, pagesGroup, fadeGroup, wordCountEl);
    document.body.appendChild(this.controlBar);

    this.updateZoomDisplay();

    this.wordCountInterval = setInterval(() => {
      if (this.isActive) this.updateWordCount();
    }, 2000);
  }

  // --- Helpers ---

  makeEl(tag, className) {
    const el = document.createElement(tag);
    el.className = className;
    return el;
  }

  makeGroup(label) {
    const g = this.makeEl('div', 'composition-mode-control-group');
    const l = this.makeEl('span', 'composition-mode-label');
    l.textContent = label;
    g.appendChild(l);
    return g;
  }

  makeSlider(min, max, step, value, onChange) {
    const s = document.createElement('input');
    s.type = 'range';
    s.min = min;
    s.max = max;
    s.step = step;
    s.value = value;
    s.className = 'composition-mode-slider';
    s.addEventListener('input', (e) => onChange(parseFloat(e.target.value)));
    return s;
  }

  updateWordCount() {
    if (!this.wordCountEl) return;
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (view) {
      const text = view.editor.getValue();
      const words = text.trim().split(/\s+/).filter(w => w.length > 0).length;
      this.wordCountEl.textContent = `${words.toLocaleString()} words`;
    }
  }

  updateZoomDisplay() {
    if (this.zoomDisplay) {
      this.zoomDisplay.textContent = `${Math.round(this.currentZoom * 100)}%`;
    }
  }

  setupZoomHandlers() {
    this.zoomHandler = (e) => {
      if (!this.isActive) return;
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        const delta = e.deltaY > 0 ? -0.05 : 0.05;
        this.currentZoom = this.clampZoom(this.currentZoom + delta);
        this.applyStyles();
        this.saveZoomLevel();
      }
    };
    document.addEventListener('wheel', this.zoomHandler, { capture: true, passive: false });

    this.gestureStartHandler = (e) => {
      if (!this.isActive) return;
      e.preventDefault();
    };
    this.gestureHandler = (e) => {
      if (!this.isActive) return;
      e.preventDefault();
      const newZoom = this.currentZoom + (e.scale - 1) * 0.5;
      this.currentZoom = this.clampZoom(newZoom);
      this.applyStyles();
      this.saveZoomLevel();
    };
    document.addEventListener('gesturestart', this.gestureStartHandler, true);
    document.addEventListener('gesturechange', this.gestureHandler, true);
  }

  setupResizeHandler() {
    this.resizeHandler = () => {
      if (!this.isActive) return;
      this.applyStyles();
    };
    window.addEventListener('resize', this.resizeHandler);
  }

  resetZoom() {
    if (!this.isActive) return;
    this.currentZoom = 1;
    this.applyStyles();
    this.saveZoomLevel();
  }

  saveZoomLevel() {
    const activeFile = this.app.workspace.getActiveFile();
    if (activeFile) {
      this.settings.zoomLevels[activeFile.path] = this.currentZoom;
      this.saveSettings();
    }
  }
}

class CompositionModeSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl('h2', { text: 'Composition Mode' });

    new Setting(containerEl)
      .setName('Paper size')
      .setDesc('Default paper size for page surface')
      .addDropdown(d => d
        .addOption('letter', 'Letter (8.5 x 11)')
        .addOption('a4', 'A4 (210 x 297mm)')
        .setValue(this.plugin.settings.paperSize)
        .onChange(async (v) => {
          this.plugin.settings.paperSize = v;
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName('Show page breaks')
      .setDesc('Insert visible gray gaps between pages at paragraph boundaries')
      .addToggle(t => t
        .setValue(this.plugin.settings.showPageBreaks)
        .onChange(async (v) => {
          this.plugin.settings.showPageBreaks = v;
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName('Words per page')
      .setDesc('Target word-count per page. Breaks snap to the nearest paragraph boundary above this threshold. 400 is typical for a Letter/A4 manuscript page.')
      .addSlider(s => s
        .setLimits(150, 800, 25)
        .setValue(this.plugin.settings.pageWordCount)
        .setDynamicTooltip()
        .onChange(async (v) => {
          this.plugin.settings.pageWordCount = v;
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName('Page gap height')
      .setDesc('Height of the gray gap between pages, in pixels')
      .addSlider(s => s
        .setLimits(20, 120, 10)
        .setValue(this.plugin.settings.pageGapHeight)
        .setDynamicTooltip()
        .onChange(async (v) => {
          this.plugin.settings.pageGapHeight = v;
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName('Default paper width')
      .setDesc(`Percentage of screen width (${MIN_PAPER_WIDTH}-${MAX_PAPER_WIDTH})`)
      .addSlider(s => s
        .setLimits(MIN_PAPER_WIDTH, MAX_PAPER_WIDTH, 5)
        .setValue(this.plugin.settings.defaultPaperWidth)
        .setDynamicTooltip()
        .onChange(async (v) => {
          this.plugin.settings.defaultPaperWidth = this.plugin.clampPaperWidth(v);
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName('Default background')
      .setDesc('How dark the background (0 = light, 100 = near-black)')
      .addSlider(s => s
        .setLimits(0, 100, 5)
        .setValue(Math.round(this.plugin.settings.defaultBackgroundFade * 100))
        .setDynamicTooltip()
        .onChange(async (v) => {
          this.plugin.settings.defaultBackgroundFade = v / 100;
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName('Enable debug mode')
      .setDesc('Write verbose pagination logs to working/composition-mode-page-break-debug.md and enable automatic debug diagnostics. Off by default.')
      .addToggle(t => t
        .setValue(this.plugin.settings.debugMode)
        .onChange(async (v) => {
          this.plugin.settings.debugMode = v;
          await this.plugin.saveSettings();
        }));
  }
}

module.exports = CompositionModePlugin;

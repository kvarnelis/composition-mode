const { Plugin, PluginSettingTab, Setting, MarkdownView, Scope, Platform } = require('obsidian');
const { StateField, StateEffect } = require('@codemirror/state');
const { Decoration, WidgetType, EditorView } = require('@codemirror/view');

const DEFAULT_SETTINGS = {
  paperSize: 'letter',
  defaultBackgroundFade: 0.35,
  defaultPaperWidth: 90,
  maxPaperWidthPx: 1400,
  imageWidthPct: 100,
  fontSizePt: 12,
  pageMarginXIn: 1.25,
  pageMarginYIn: 1.0,
  showPageBreaks: true,
  pageGapHeight: 60,
  pageWordCount: 400,
  showStatusBar: true,
  debugMode: false,
  zoomLevels: {}
};

const MIN_PAPER_WIDTH = 60;
const MAX_PAPER_WIDTH = 95;
const MIN_VISUAL_ZOOM = 0.25;
const MAX_VISUAL_ZOOM = 2;
const MIN_FONT_SIZE_PT = 8;
const MAX_FONT_SIZE_PT = 24;
const BAR_AUTO_HIDE_DELAY_MS = 1500;
const BAR_REVEAL_ZONE_HEIGHT_PX = 40;
const OVERLAY_SCROLLBAR_IDLE_DELAY_MS = 1000;
const OVERLAY_SCROLLBAR_TRACK_WIDTH_PX = 16;
const OVERLAY_SCROLLBAR_MIN_THUMB_PX = 32;
// Matches Obsidian's own `--titlebar-height` fallback for its frameless window.
const MACOS_TITLEBAR_HEIGHT = 30;

const PAPER_SIZES = {
  trade6x9: { label: 'Trade 6 × 9', width: 6, height: 9 },
  academic7x10: { label: 'Academic 7 × 10', width: 7, height: 10 },
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
//     in flight use a capped placeholder; the preload's load event schedules
//     another rebuild with correct dimensions.
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
  imageWidthPct: 100,         // rendered image width as a percentage of the column
  pageContentHeight: 0,       // px; pageHeight minus top and bottom page margins
  pageCount: 1,               // status-bar snapshot from the latest active rebuild
  pageTopBoundaries: [0],     // cumulative layout-space top of each physical page
  imageAspectRatioMap: new Map(), // Map<image key, natural height / width>
  imageHeightMap: new Map(), // Map<filename, displayedHeight px>; rebuilt on
                             //   every triggerEditors() from the plugin's
                             //   natural-dims cache. Missing entries use a
                             //   capped placeholder until preload completes.
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

// Image discovery is initiated from both metric refreshes and document edits.
// The StateField cannot own plugin async work, so docChanged merely queues a
// module-level callback; the plugin instance performs resolution after the
// transaction has finished dispatching.
const imageKeysByEditorState = new WeakMap();
const paginationStatusByEditorState = new WeakMap();
let imageDiscoveryScheduler = null;
let zeroMetricRetryScheduler = null;
let zeroMetricRetrySucceeded = null;
let paginationStatusScheduler = null;
let statusDocChangeScheduler = null;
let overlayScrollbarUpdateScheduler = null;

// Single-line-per-rebuild debug log. Spam-proof: no tight-loop writes.
// Obsidian 1.11 removed the global `app`; the plugin registers its App
// instance here in onload so module-level helpers can reach the vault.
let pluginApp = null;

async function dbg(msg) {
  if (!DEBUG_MODE_ENABLED || !pluginApp) return;
  try {
    const path = 'working/composition-mode-page-break-debug.md';
    const timestamp = new Date().toISOString();
    const line = `- ${timestamp} ${msg}\n`;
    if (!(await pluginApp.vault.adapter.exists(path))) {
      await pluginApp.vault.create(path, '# Composition Mode Debug Log\n\n');
    }
    await pluginApp.vault.adapter.append(path, line);
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

function normalizeImagePathKey(value) {
  if (!value || typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (/^data:/i.test(trimmed)) return trimmed.toLowerCase();
  if (/^https?:/i.test(trimmed)) return basenameFromUrlish(trimmed);

  const withoutQuery = trimmed.split('?')[0].split('#')[0];
  let decoded = withoutQuery;
  try {
    decoded = decodeURIComponent(withoutQuery);
  } catch (e) {
    // A malformed escape should not make the entire image undiscoverable.
  }
  const normalized = decoded.replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\//, '');
  return normalized.toLowerCase() || null;
}

function extractMarkdownImageTarget(text) {
  if (!text) return null;
  const t = text.trim();
  const bracketed = /^!\[[^\]]*\]\(\s*<([^>]+)>/.exec(t);
  if (bracketed) return bracketed[1].trim() || null;

  const unbracketed = /^!\[[^\]]*\]\(\s*([\s\S]*?)\s*\)$/.exec(t);
  if (!unbracketed) return null;
  const withoutTitle = unbracketed[1].replace(/\s+"[^"]*"\s*$/, '').trim();
  return withoutTitle || null;
}

// Extract a stable lookup key for an image embed line. Supports both
// Obsidian wikilink syntax (![[file.png]], ![[folder/file.png|alias]],
// ![[file.png#heading]]) and standard markdown (![alt](path/to/file.png)).
// Folder-qualified local references retain their full lowercase vault path;
// plain references and external URLs use a lowercase basename.
function extractImageKey(text) {
  if (!text) return null;
  const t = text.trim();

  // ![[file.png]] / ![[folder/file.png|alias]] / ![[file.png#heading]]
  let m = /^!\[\[([^\]|#]+?)(?:[|#][^\]]*)?\]\]/.exec(t);
  if (m) {
    return normalizeImagePathKey(m[1]);
  }

  // ![alt](path/to/file.png) / ![alt](<path with spaces.png> "title")
  const target = extractMarkdownImageTarget(t);
  if (target) return normalizeImagePathKey(target);

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

function collectImageReferences(text) {
  const refs = [];
  if (!text) return refs;

  const reWiki = /!\[\[([^\]|#\n]+)(?:[|#][^\]\n]*)?\]\]/g;
  let m;
  while ((m = reWiki.exec(text)) !== null) {
    const linkpath = m[1].trim();
    const key = extractImageKey(m[0]);
    if (linkpath && key) refs.push({ key, linkpath, src: null });
  }

  const reMd = /!\[[^\]]*\]\(\s*(?:<[^>\n]+>|[^)\n]+)\s*\)/g;
  while ((m = reMd.exec(text)) !== null) {
    const raw = extractMarkdownImageTarget(m[0]);
    const key = extractImageKey(m[0]);
    if (!raw || !key) continue;
    let decoded = raw;
    try {
      decoded = decodeURIComponent(raw);
    } catch (e) {
      // Keep the original path when percent decoding is malformed; Obsidian
      // may still be able to resolve it, and external URLs remain usable.
    }
    const external = /^(?:https?:|data:)/i.test(raw);
    refs.push({ key, linkpath: external ? null : decoded, src: external ? raw : null });
  }

  return refs;
}

function extractImageWidthOverride(text) {
  if (!text) return null;
  const match = /!\[\[[^\]]*\|(\d+(?:\.\d+)?)(?:x\d+(?:\.\d+)?)?\]\]/.exec(text);
  if (!match) return null;
  const width = Number(match[1]);
  return Number.isFinite(width) && width > 0 ? width : null;
}

function rememberImageKeysForState(state) {
  const refs = collectImageReferences(state?.doc?.toString?.() || '');
  const keys = new Set(refs.map(ref => ref.key));
  if (state) imageKeysByEditorState.set(state, keys);
  return keys;
}

function scheduleUnknownImageDiscovery(tr) {
  if (!tr?.state) return;
  const docText = tr.state.doc.toString();
  const refs = collectImageReferences(docText);
  const currentKeys = new Set(refs.map(ref => ref.key));
  const previousKeys = imageKeysByEditorState.get(tr.startState) || new Set();
  imageKeysByEditorState.set(tr.state, currentKeys);
  const scheduler = imageDiscoveryScheduler;
  if (!refs.length || typeof scheduler !== 'function') return;

  const introducedKeys = new Set();
  const introducedRefs = refs.filter(ref => {
    if (previousKeys.has(ref.key) || introducedKeys.has(ref.key)) return false;
    introducedKeys.add(ref.key);
    return true;
  });
  if (!introducedRefs.length) return;

  // Carry the references found by this one edit-time scan into the async
  // plugin callback. If the callback can no longer associate this text with
  // the active note, deleting the new state's entry lets the next transaction
  // treat its references as newly introduced and retry safely.
  const retry = () => imageKeysByEditorState.delete(tr.state);
  setTimeout(() => scheduler({
    docText,
    refs: introducedRefs,
    state: tr.state,
    retry
  }), 0);
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
         /^!\[[^\]]*\]\(\s*(?:<[^>\n]+>|[^)\n]+)\s*\)$/.test(t);
}

// Detect a manual page-break marker on its own line. Accepts either an
// HTML comment (<!-- pagebreak -->) or Obsidian's native comment syntax
// (%%pagebreak%%). Case-insensitive, flexible whitespace. Must be the
// whole line — inline occurrences are ignored so that quoting the marker
// in prose doesn't accidentally trigger a break.
function isPageBreakMarker(text) {
  const t = text.trim();
  return /^(?:<!--\s*pagebreak\s*-->|%%\s*pagebreak\s*%%)$/i.test(t);
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
  const re = /!\[\[[^\]|#]+?(?:[|#][^\]]*)?\]\]|!\[[^\]]*\]\(\s*(?:<[^>\n]+>|[^)\n]+)\s*\)/g;
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

// Pure status-bar helpers. They deliberately know nothing about CodeMirror:
// tests can pin boundary semantics, and runtime callers can reuse the same
// whitespace-token definition without waking the paginator.
function countDocumentWords(text, suppressFrontmatter = false) {
  let body = typeof text === 'string' ? text : '';
  if (suppressFrontmatter) {
    const lines = body.split(/\r?\n/);
    if (lines.length >= 2 && lines[0].trim() === '---') {
      const end = lines.slice(1).findIndex(line => {
        const trimmed = line.trim();
        return trimmed === '---' || trimmed === '...';
      });
      if (end >= 0) body = lines.slice(end + 2).join('\n');
    }
  }
  const trimmed = body.trim();
  return trimmed ? trimmed.split(/\s+/).length : 0;
}

function currentPageFromScroll(scrollTop, viewportHeight, pageTopBoundaries) {
  const tops = Array.isArray(pageTopBoundaries) && pageTopBoundaries.length
    ? pageTopBoundaries
    : [0];
  const top = Number.isFinite(Number(scrollTop)) ? Math.max(0, Number(scrollTop)) : 0;
  const height = Number.isFinite(Number(viewportHeight)) ? Math.max(0, Number(viewportHeight)) : 0;
  const eyeY = top + (height * 0.5);

  // Upper-bound search: an eye position exactly on a page top belongs to
  // that new page, matching what the reader sees at the boundary.
  let low = 0;
  let high = tops.length;
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    if (Number(tops[mid]) <= eyeY) low = mid + 1;
    else high = mid;
  }
  return Math.max(1, Math.min(tops.length, low));
}

function publishPaginationStatus(state, pageTopBoundaries) {
  const boundaries = Array.isArray(pageTopBoundaries) && pageTopBoundaries.length
    ? pageTopBoundaries.slice()
    : [0];
  const status = {
    pageCount: boundaries.length,
    pageTopBoundaries: boundaries
  };
  paginationStatusByEditorState.set(state, status);
  paginationStatusScheduler?.();
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

function getPageContentHeightCap(cfg) {
  const configuredCap = Number(cfg.pageContentHeight) || 0;
  if (configuredCap > 0) return configuredCap;
  return Math.max(0, (Number(cfg.pageHeight) || 0) - (2 * (Number(cfg.pageMarginY) || 0)));
}

function getEstimatedImageWidth(cfg, tokenText = '') {
  const contentWidth = Math.max(0, Number(cfg.contentWidth) || 0);
  const override = extractImageWidthOverride(tokenText);
  if (override) return Math.min(contentWidth, override);
  const pct = Math.max(20, Math.min(100, Number(cfg.imageWidthPct) || 100));
  return contentWidth * (pct / 100);
}

function estimateImagePlaceholderHeight(cfg, tokenText = '') {
  const placeholder = getEstimatedImageWidth(cfg, tokenText) * 0.75;
  const cap = getPageContentHeightCap(cfg);
  return cap > 0 ? Math.min(placeholder, cap) : placeholder;
}

// Px height for a paragraph block. Sums per-source-line heights:
//   image line  → cfg.imageHeightMap.get(line.imageKey); exact when loaded
//                 height derived from the file's natural dimensions
//                 and current contentWidth. If not yet in the map, a
//                 conservative 4:3 placeholder prevents zero-height pages;
//                 pagination refreshes once preload completes.
//   heading 1-3 → visualLines × lineHeight × cfg.headingScale
//   default     → visualLines × lineHeight
function estimateParagraphHeight(block, cfg, measurer) {
  const { lineHeight, headingScale, imageHeightMap } = cfg;
  const lookupImageHeight = (key, tokenText) => {
    if (key && imageHeightMap && typeof imageHeightMap.get === 'function') {
      const knownHeight = imageHeightMap.get(key);
      if (knownHeight > 0) {
        const override = extractImageWidthOverride(tokenText);
        const ratio = cfg.imageAspectRatioMap?.get?.(key);
        if (override && ratio > 0) {
          const cap = getPageContentHeightCap(cfg);
          const overrideHeight = getEstimatedImageWidth(cfg, tokenText) * ratio;
          return cap > 0 ? Math.min(overrideHeight, cap) : overrideHeight;
        }
        return knownHeight;
      }
    }
    return estimateImagePlaceholderHeight(cfg, tokenText);
  };
  let height = 0;
  for (const line of block.lines) {
    if (line.isImage) {
      height += lookupImageHeight(line.imageKey, line.text);
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
          height += lookupImageHeight(seg.imageKey, seg.text);
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

function estimateTextHeight(text, headingLevel, cfg, measurer) {
  const measuredText = normalizeLineForMeasurement(text || '', cfg);
  const visualLines = measurer(measuredText);
  const scale = (headingLevel >= 1 && headingLevel <= 3) ? cfg.headingScale : 1;
  return visualLines * cfg.lineHeight * scale;
}

function chooseReadableSplitOffset(text, maxOffset) {
  const safeMax = Math.max(0, Math.min(text.length, maxOffset));
  const minOffset = Math.min(safeMax, 40);
  if (safeMax <= minOffset) return null;

  // Page breaks should behave like physical page bottoms, not like
  // editorial paragraph/sentence breaks. The visual-line estimator already
  // gives us the last word that fits on the page; choose the nearest word
  // boundary before that point. Earlier versions preferred sentence endings
  // first, which made the inserted page gap look like an intentional
  // paragraph break and could jump back several lines.
  const prefix = text.slice(0, safeMax);
  let best = null;
  let m;
  const whitespace = /\s+/g;
  while ((m = whitespace.exec(prefix)) !== null) {
    const candidate = m.index + m[0].length;
    if (candidate >= minOffset && candidate <= safeMax) best = candidate;
  }

  return best;
}

function findTextOffsetForVisualLines(text, cfg, maxLines) {
  if (!text || maxLines < 2 || !cfg.contentWidth || cfg.contentWidth <= 0) return null;

  const ctx = getMeasureCtx();
  ctx.font = cfg.fontSpec || '400 16px sans-serif';
  const spaceWidth = ctx.measureText(' ').width;
  const tokens = Array.from(text.matchAll(/\S+\s*/g));

  let lines = 1;
  let lineWidth = 0;
  let lastFitOffset = 0;

  for (const token of tokens) {
    const raw = token[0];
    const word = raw.trim();
    if (!word) continue;
    const wordWidth = ctx.measureText(word).width;
    const startsNewLine =
      wordWidth > cfg.contentWidth
        ? lineWidth > 0
        : lineWidth > 0 && lineWidth + spaceWidth + wordWidth > cfg.contentWidth;

    let lineCost = 0;
    if (wordWidth > cfg.contentWidth) {
      lineCost = (lineWidth > 0 ? 1 : 0) + Math.max(1, Math.ceil(wordWidth / cfg.contentWidth)) - 1;
    } else if (startsNewLine) {
      lineCost = 1;
    }

    if (lines + lineCost > maxLines) break;

    if (wordWidth > cfg.contentWidth) {
      if (lineWidth > 0) lines++;
      const wordLines = Math.max(1, Math.ceil(wordWidth / cfg.contentWidth));
      lines += wordLines - 1;
      lineWidth = wordWidth % cfg.contentWidth || cfg.contentWidth;
    } else if (startsNewLine) {
      lines++;
      lineWidth = wordWidth;
    } else {
      lineWidth += (lineWidth > 0 ? spaceWidth : 0) + wordWidth;
    }

    lastFitOffset = token.index + raw.length;
  }

  return lastFitOffset > 0 ? lastFitOffset : null;
}

function isSplittableTextBlock(block) {
  if (!block || !block.lines || block.lines.length !== 1) return null;
  const line = block.lines[0];
  return !!(
    line &&
    !line.isImage &&
    !line.segments &&
    line.headingLevel === 0 &&
    Number.isFinite(line.from) &&
    Number.isFinite(line.to)
  );
}

function findMidParagraphSplit(block, cfg, measurer, availableHeight, startOffset = 0) {
  if (!isSplittableTextBlock(block)) return null;
  const line = block.lines[0];
  const safeStartOffset = Math.max(0, Math.min(line.text.length - 1, startOffset || 0));
  const linesAvail = Math.floor(availableHeight / cfg.lineHeight);
  if (linesAvail < 2) return null;

  // A strict floor keeps the before-fragment inside the content boundary.
  // If measurement drift leaves a little unused space, prefer that honest
  // early gap to letting a rendered line poke past the page bottom.
  const remainingText = line.text.slice(safeStartOffset);
  const minFragmentHeight = 2 * cfg.lineHeight;

  // Pull the break earlier when the first candidate strands a one-line
  // widow. The loop is bounded by linesAvail and never returns unless the
  // absolute offset advances beyond the caller's current start offset.
  for (let maxLines = linesAvail; maxLines >= 2; maxLines--) {
    const rawOffset = findTextOffsetForVisualLines(remainingText, cfg, maxLines);
    const splitOffset = chooseReadableSplitOffset(remainingText, rawOffset || 0);
    const absoluteSplitOffset = safeStartOffset + (splitOffset || 0);
    if (!splitOffset || absoluteSplitOffset <= safeStartOffset || absoluteSplitOffset >= line.text.length) continue;

    const beforeText = line.text.slice(safeStartOffset, absoluteSplitOffset);
    const afterText = line.text.slice(absoluteSplitOffset);
    const beforeHeight = estimateTextHeight(beforeText, 0, cfg, measurer);
    const afterHeight = estimateTextHeight(afterText, 0, cfg, measurer);
    if (beforeHeight < minFragmentHeight) return null;
    if (beforeHeight > availableHeight || afterHeight < minFragmentHeight) continue;

    return {
      pos: line.from + absoluteSplitOffset,
      splitOffset: absoluteSplitOffset,
      beforeHeight,
      afterHeight
    };
  }

  return null;
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
      } catch (e) {
        dbg(`bar-mount: error=${e?.message || String(e)}`);
      }
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
  if (!pageBreakConfig.enabled) {
    publishPaginationStatus(state, [0]);
    return Decoration.none;
  }

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
    zeroMetricRetryScheduler?.();
    publishPaginationStatus(state, [0]);
    return Decoration.none;
  }
  zeroMetricRetrySucceeded?.();

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
  // Set true when we pass a <!-- pagebreak --> / %%pagebreak%% marker line.
  // Consumed by the next block created, which will force a page break before
  // itself regardless of how much content has accumulated on the current page.
  let forceBreakNext = false;
  const totalLines = doc.lines;
  for (let lineNum = (skippedFrontmatterLines ? skippedFrontmatterLines + 1 : 1); lineNum <= totalLines; lineNum++) {
    const line = doc.line(lineNum);
    const text = line.text;

    if (isPageBreakMarker(text)) {
      if (current) { blocks.push(current); current = null; }
      forceBreakNext = true;
      continue;
    }

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
        forceBreakBefore: forceBreakNext,
        lines: [{
          text,
          from: line.from,
          to: line.to,
          isImage: true,
          imageKey: extractImageKey(text),
          headingLevel: 0,
          segments: null
        }]
      });
      pendingBlankLines = 0;
      forceBreakNext = false;
      continue;
    }

    if (!current) {
      current = {
        startPos: line.from,
        lines: [],
        blankLinesBefore: pendingBlankLines,
        forceBreakBefore: forceBreakNext
      };
      pendingBlankLines = 0;
      forceBreakNext = false;
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
      let forceBreakForSeg = forceBreakNext;
      for (const seg of segments) {
        if (!seg.text || !seg.text.trim()) continue;
        if (seg.type === 'image') {
          blocks.push({
            startPos: line.from + seg.from,
            blankLinesBefore: blankLinesBeforeForSeg,
            forceBreakBefore: forceBreakForSeg,
            lines: [{
              text: seg.text,
              from: line.from + seg.from,
              to: line.from + seg.to,
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
            forceBreakBefore: forceBreakForSeg,
            lines: [{
              text: seg.text,
              from: line.from + seg.from,
              to: line.from + seg.to,
              isImage: false,
              imageKey: null,
              headingLevel: 0,
              segments: null
            }]
          });
        }
        blankLinesBeforeForSeg = 0;
        forceBreakForSeg = false;
      }
      pendingBlankLines = 0;
      forceBreakNext = false;
      continue;
    }

    current.lines.push({
      text,
      from: line.from,
      to: line.to,
      isImage: false,
      imageKey: null,
      headingLevel: headingMatch ? headingMatch[1].length : 0,
      segments: hasInlineImage ? segments : null
    });
  }
  if (current) blocks.push(current);

  if (blocks.length === 0) {
    publishPaginationStatus(state, [0]);
    return Decoration.none;
  }

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
// The 0.5 floor prevents anemic pages when the current page is mostly
// empty — in that case we accept overshoot rather than emit a one-short-
// paragraph page followed by a large one. Important: this check must NOT
// suppress breaks before paragraphs that are themselves taller than a page.
// On narrow book trims, ordinary paragraphs can exceed a page's content
// height; refusing to break before them makes the editor appear to have
// "lost" page breaks entirely.
  const ranges = [];
  const pageContentHeight = Math.max(lineHeight * 3, pageHeight - (2 * pageMarginY));
  cfg.pageContentHeight = pageContentHeight;
  let pagePhysicalTopY = 0;
  let contentStartY = pagePhysicalTopY + pageMarginY;
  let y = contentStartY;
  let nextPageBoundary = pagePhysicalTopY + pageHeight;
  let contentBoundary = nextPageBoundary - pageMarginY;
  let breakCount = 0;
  const pageTopBoundaries = [0];

  const insertPageBreakAt = (pos, contentEndY) => {
    const unused = Math.max(0, nextPageBoundary - contentEndY);
    const totalHeight = unused + barHeight + pageMarginY;

    ranges.push(
      Decoration.widget({
        block: true,
        side: -1,
        widget: new PageGapWidget(totalHeight, barHeight, pageMarginY)
      }).range(pos)
    );
    breakCount++;

    pagePhysicalTopY = Math.max(nextPageBoundary, contentEndY) + barHeight;
    pageTopBoundaries.push(pagePhysicalTopY);
    contentStartY = pagePhysicalTopY + pageMarginY;
    y = contentStartY;
    nextPageBoundary = pagePhysicalTopY + pageHeight;
    contentBoundary = nextPageBoundary - pageMarginY;
  };

  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i];

    // Blank lines between previous block and this one are rendered before
    // the widget (their position in the doc precedes block.startPos), so
    // they belong to the closing page.
    y += block.blankLinesBefore * lineHeight;
    let forceBreak = !!block.forceBreakBefore;

    // If the previous block already overflowed the current page, still
    // render a visible page gap before this block. We can't split inside the
    // oversized paragraph, but we can prevent all subsequent page breaks from
    // silently disappearing behind a fast-forwarded y position.
    if (i > 0 && y > contentBoundary) {
      insertPageBreakAt(block.startPos, y);
      forceBreak = false;
    }

    const paraHeight = estimateParagraphHeight(block, cfg, measurer);

    // A manual <!-- pagebreak --> / %%pagebreak%% marker forces a break
    // before this block regardless of how full the page is. Oversized
    // paragraphs are allowed to start on a fresh page.
    if (i > 0 && forceBreak) {
      insertPageBreakAt(block.startPos, y);
      forceBreak = false;
    }

    // Plain single-line prose paragraphs can be split by placing multiple
    // block widgets at word-boundaries inside the source line. This lets
    // book-sized pages behave like actual pages instead of forcing every
    // long paragraph to remain an indivisible block.
    if (isSplittableTextBlock(block)) {
      const line = block.lines[0];
      let consumedOffset = 0;
      let safety = 0;

      while (consumedOffset < line.text.length && safety < 100) {
        safety++;
        const remainingText = line.text.slice(consumedOffset);
        const remainingHeight = estimateTextHeight(remainingText, 0, cfg, measurer);

        if ((y + remainingHeight) <= contentBoundary) {
          y += remainingHeight;
          consumedOffset = line.text.length;
          break;
        }

        const availableHeight = Math.max(0, contentBoundary - y);
        const split = findMidParagraphSplit(block, cfg, measurer, availableHeight, consumedOffset);
        if (!split) {
          // Give the remainder a fresh page whenever this page already has
          // content. On the fresh page y === contentStartY, so a second
          // failure falls through without creating an infinite break loop.
          if (y > contentStartY) {
            insertPageBreakAt(line.from + consumedOffset, y);
            continue;
          }
          // True last resort: even a fresh page has no safe word-boundary
          // split (for example, one unbreakable token taller than the page).
          // Consume the remainder to guarantee termination.
          y += remainingHeight;
          consumedOffset = line.text.length;
          break;
        }

        insertPageBreakAt(split.pos, y + split.beforeHeight);
        consumedOffset = split.splitOffset;
      }

      continue;
    }

    if (i > 0) {
      const wouldOvershoot = (y + paraHeight) > contentBoundary;
      const heightUsed = y - contentStartY;
      const pageHasEnough = heightUsed >= pageContentHeight * 0.5;

      if (wouldOvershoot && pageHasEnough) {
        insertPageBreakAt(block.startPos, y);
      }
    }

    y += paraHeight;
  }

  dbg(`rebuild: blocks=${blocks.length} breaks=${breakCount} targetWords=${targetWords} pageHeight=${Math.round(pageHeight)} contentPageHeight=${Math.round(pageContentHeight)} lineHeight=${Math.round(lineHeight)} contentWidth=${Math.round(contentWidth)} livePreview=${cfg.normalizeForLivePreview ? 'yes' : 'no'} skippedFrontmatterLines=${skippedFrontmatterLines} enabled=${cfg.enabled}`);
  publishPaginationStatus(state, pageTopBoundaries);

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
    rememberImageKeysForState(state);
    return computePageBreaks(state);
  },
  update(value, tr) {
    if (tr.docChanged) {
      scheduleUnknownImageDiscovery(tr);
    } else {
      const previousKeys = imageKeysByEditorState.get(tr.startState);
      if (previousKeys) imageKeysByEditorState.set(tr.state, previousKeys);
    }
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
    pluginApp = this.app;
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
    this.imageWidthObserver = null;
    this.pendingImageWidthSyncFrame = null;
    this.currentImageKeyResolutions = new Map();
    imageDiscoveryScheduler = ({ docText, refs, retry }) => {
      if (!this.isActive) {
        retry();
        return;
      }
      const activeView = this.getActiveCompositionElements().activeView;
      if (!activeView?.file) {
        retry();
        return;
      }
      // A StateField update can outlive a leaf switch. Never resolve the
      // captured text relative to a different note's path.
      if (activeView.editor?.getValue?.() !== docText) {
        retry();
        return;
      }
      this.preloadImageDimensionsFromText(docText, activeView.file.path, refs);
    };
    this.zeroMetricRetryCount = 0;
    this.pendingZeroMetricRetryFrame = null;
    zeroMetricRetryScheduler = () => this.scheduleZeroMetricRetry();
    zeroMetricRetrySucceeded = () => this.resetZeroMetricRetries();
    paginationStatusScheduler = () => this.scheduleStatusPageUpdate();
    statusDocChangeScheduler = () => this.scheduleStatusWordCountUpdate();
    overlayScrollbarUpdateScheduler = () => this.scheduleOverlayScrollbarUpdate();

    // Visual debug overlay flag. Keep the machinery available for future
    // debugging, but default it OFF now that full-width page-break rendering
    // has been verified. The toggle-debug-overlay command can re-enable it.
    this.debugVisualOverlay = false;

    this.addCommand({
      id: 'toggle-composition-mode',
      name: 'Toggle Composition Mode',
      callback: () => this.toggle(),
      hotkeys: [{ modifiers: ['Mod', 'Shift'], key: 'C' }]
    });

    this.addCommand({
      id: 'reset-zoom',
      name: 'Reset Zoom (Composition Mode)',
      callback: () => this.resetZoom(),
      hotkeys: [{ modifiers: ['Mod'], key: '0' }]
    });

    this.addCommand({
      id: 'zoom-in',
      name: 'Zoom In (Composition Mode)',
      callback: () => this.zoomIn()
    });

    this.addCommand({
      id: 'zoom-out',
      name: 'Zoom Out (Composition Mode)',
      callback: () => this.zoomOut()
    });

    this.addCommand({
      id: 'increase-type-size',
      name: 'Increase Type Size (Composition Mode)',
      callback: () => this.typeSizeBy(0.5)
    });

    this.addCommand({
      id: 'decrease-type-size',
      name: 'Decrease Type Size (Composition Mode)',
      callback: () => this.typeSizeBy(-0.5)
    });

    this.addCommand({
      id: 'toggle-status-bar',
      name: 'Toggle status bar',
      callback: () => this.toggleStatusBar()
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
      }),
      EditorView.updateListener.of(update => {
        if (update.docChanged) {
          statusDocChangeScheduler?.();
          overlayScrollbarUpdateScheduler?.();
        }
      })
    ]);

    this.registerEvent(this.app.workspace.on('active-leaf-change', () => {
      if (!this.isActive) return;
      this.startEditingToolbarHostBridge();
      this.scheduleEditorPaneBoundsUpdate();
      if (!this.settings.showStatusBar) return;
      this.setupStatusBarListeners();
      this.scheduleStatusWordCountUpdate(0);
      this.scheduleStatusPageUpdate();
    }));
  }

  onunload() {
    imageDiscoveryScheduler = null;
    this.stopImageWidthObserver();
    zeroMetricRetryScheduler = null;
    zeroMetricRetrySucceeded = null;
    paginationStatusScheduler = null;
    statusDocChangeScheduler = null;
    overlayScrollbarUpdateScheduler = null;
    this.resetZeroMetricRetries();
    if (this.isActive) this.deactivate();
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    this.settings.defaultPaperWidth = this.clampPaperWidth(this.settings.defaultPaperWidth);
    this.settings.fontSizePt = this.clampFontSizePt(this.settings.fontSizePt);
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

  clampFontSizePt(value) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return DEFAULT_SETTINGS.fontSizePt;
    const roundedToHalfPoint = Math.round(numeric * 2) / 2;
    return Math.max(MIN_FONT_SIZE_PT, Math.min(MAX_FONT_SIZE_PT, roundedToHalfPoint));
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
    const paperSizeDef = this.getPaperSizeDef();
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
      ` paperDims=${paperSizeDef.width}x${paperSizeDef.height}` +
      ` paperCssWidth=${paperSizeDef.width}in` +
      ` paperWidthPct=${this.paperWidth}` +
      ` marginX=${Math.round(this.getEffectivePageMarginXIn() * 100) / 100}` +
      ` marginY=${Math.round(this.getEffectivePageMarginYIn() * 100) / 100}` +
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
      // The status-bar settings panel is a transient layer, so Escape dismisses
      // it before Escape resumes its usual Composition Mode exit behavior.
      if (this.statusPopover && !this.statusPopover.hidden) {
        this.closeStatusPopover();
        return false;
      }
      this.deactivate();
      return false;
    });
    this.app.keymap.pushScope(this.escapeScope);

    document.body.classList.add('composition-mode-active');
    this.startEditingToolbarHostBridge();
    this.applyDebugOverlay();
    this.createBackdrop();
    this.injectStyleEl();
    this.applyStatusBarVisibility();
    this.setupBarAutoHide();
    this.setupOverlayScrollbar();
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

    // Editing Toolbar rebuilds its DOM on leaf/layout changes. Stop watching
    // before restoring the third-party hosts or our own restoration mutations
    // would immediately move them back into the workspace strip.
    this.stopEditingToolbarHostBridge();
    this.teardownBarAutoHide();
    this.teardownOverlayScrollbar();

    document.body.classList.remove('composition-mode-active');
    document.body.classList.remove('composition-debug-overlay');

    if (this.backdrop) { this.backdrop.remove(); this.backdrop = null; }
    if (this.styleEl) { this.styleEl.remove(); this.styleEl = null; }
    this.destroyStatusBar();
    this.stopEditorPaneBoundsTracking();

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
    if (this.resizeHandler) {
      window.removeEventListener('resize', this.resizeHandler);
      this.app.workspace.off('resize', this.resizeHandler);
      this.resizeHandler = null;
    }
    if (this.pendingMetricsFrame) {
      cancelAnimationFrame(this.pendingMetricsFrame);
      this.pendingMetricsFrame = null;
    }
    this.stopImageWidthObserver();
    this.resetZeroMetricRetries();
  }

  // --- UI ---

  // Editing Toolbar's top-style builder may insert into the active view, while
  // `appendMethod: workspace` inserts directly into .mod-vertical.mod-root.
  // Neither location is safe for Composition Mode: the view is paper-width /
  // zoom constrained, and the root split lays direct children out as columns.
  // Temporarily lift only the known hosts into our fixed, out-of-flow band.
  //
  // Editing Toolbar regenerates its controls after leaf, layout, and resize
  // events. Observe those insertions and make the accommodation idempotent.
  // Exact parent/sibling positions are retained so leaving Composition Mode
  // restores third-party DOM ownership without changing its saved settings.
  startEditingToolbarHostBridge() {
    this.stopEditingToolbarHostBridge();
    const enabledPlugins = this.app.plugins?.enabledPlugins;
    if (enabledPlugins?.has && !enabledPlugins.has('editing-toolbar')) return;
    this.editingToolbarOriginalHosts = new Map();

    const relocate = () => {
      if (!this.isActive) return;
      const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
      const viewContainer = activeView?.containerEl || null;
      // A top-style Editing Toolbar belongs to an active editor. In
      // particular, do not adopt a workspace-level host while a sidebar or
      // another non-markdown leaf is active.
      if (!viewContainer) {
        this.destroyEditingToolbarStrip();
        return;
      }
      const hostDocument = viewContainer?.ownerDocument || document;
      const workspaceRoot =
        viewContainer?.closest?.('.mod-vertical.mod-root') ||
        hostDocument.body?.querySelector('.mod-vertical.mod-root');
      if (!workspaceRoot) return;

      const selector = [
        '#editingToolbarModalBar[data-toolbar-style="top"]',
        '#editingToolbarPopoverBar[data-toolbar-style="top"]',
        '.editingToolbarModalBar[data-toolbar-style="top"]',
        '.editingToolbarPopoverBar[data-toolbar-style="top"]'
      ].join(', ');

      // The top toolbar is either inside the active view or a direct child of
      // that view's root split. Do not capture toolbar instances belonging to
      // another root/floating window.
      const candidates = new Set([
        ...(viewContainer?.querySelectorAll(selector) || []),
        ...workspaceRoot.querySelectorAll(`:scope > ${selector.replaceAll(', ', ', :scope > ')}`),
        ...(this.editingToolbarStrip?.querySelectorAll(selector) || [])
      ]);
      if (!candidates.size) {
        this.destroyEditingToolbarStrip();
        return;
      }

      const strip = this.createEditingToolbarStrip(hostDocument, viewContainer);
      if (!strip) return;

      for (const host of candidates) {
        if (host.parentElement === strip) continue;
        if (!this.editingToolbarOriginalHosts.has(host)) {
          this.editingToolbarOriginalHosts.set(host, {
            parent: host.parentNode,
            nextSibling: host.nextSibling
          });
        }
        strip.appendChild(host);
      }
      this.measureEditingToolbarStrip();
      if (this.barAutoHideToolbarPopupArmed || this.barAutoHideToolbarPopoverWasOpen) {
        this.refreshBarAutoHideForPointer();
      }
    };

    relocate();
    const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (!activeView?.containerEl) return;
    this.editingToolbarHostObserver = new MutationObserver(relocate);
    const hostBody = activeView?.containerEl?.ownerDocument?.body || document.body;
    this.editingToolbarHostObserver.observe(hostBody, {
      childList: true,
      subtree: true
    });
  }

  stopEditingToolbarHostBridge() {
    if (this.editingToolbarHostObserver) {
      this.editingToolbarHostObserver.disconnect();
      this.editingToolbarHostObserver = null;
    }

    if (this.editingToolbarOriginalHosts) {
      for (const [host, origin] of this.editingToolbarOriginalHosts) {
        if (!host.isConnected || !origin.parent?.isConnected) continue;
        if (origin.nextSibling?.parentNode === origin.parent) {
          origin.parent.insertBefore(host, origin.nextSibling);
        } else if (origin.nextSibling === null) {
          origin.parent.appendChild(host);
        } else {
          origin.parent.insertBefore(host, origin.parent.firstChild);
        }
      }
      this.editingToolbarOriginalHosts.clear();
      this.editingToolbarOriginalHosts = null;
    }

    this.destroyEditingToolbarStrip();
  }

  createEditingToolbarStrip(hostDocument, viewContainer) {
    if (this.editingToolbarStrip?.isConnected) return this.editingToolbarStrip;

    const appContainer =
      viewContainer?.closest?.('.app-container') ||
      hostDocument.body?.querySelector('.app-container') ||
      hostDocument.body;
    if (!appContainer) return null;

    const band = hostDocument.createElement('div');
    band.className = 'composition-mode-toolbar-band';
    const strip = hostDocument.createElement('div');
    strip.className = 'composition-mode-toolbar-strip';
    strip.setAttribute('role', 'toolbar');
    strip.setAttribute('aria-label', 'Editing toolbar');
    band.appendChild(strip);
    appContainer.appendChild(band);
    this.editingToolbarBand = band;
    this.editingToolbarStrip = strip;

    // The strip overlays the editor, but its rendered height still determines
    // where the overlay scrollbar track can safely begin.
    const ResizeObserverCtor = hostDocument.defaultView?.ResizeObserver;
    if (ResizeObserverCtor) {
      this.editingToolbarStripResizeObserver = new ResizeObserverCtor(() => {
        this.measureEditingToolbarStrip();
      });
      this.editingToolbarStripResizeObserver.observe(strip);
    }
    this.startEditingToolbarFullscreenTracking(hostDocument);
    this.updateEditingToolbarClearance();
    this.updateEditorPaneBounds();
    this.refreshBarAutoHideForPointer();
    return strip;
  }

  startEditingToolbarFullscreenTracking(hostDocument) {
    this.stopEditingToolbarFullscreenTracking();
    this.editingToolbarFullscreenDocument = hostDocument;
    this.editingToolbarFullscreenHandler = () => {
      if (!this.isActive) return;
      this.updateEditingToolbarClearance();
      this.scheduleEditorPaneBoundsUpdate();
    };
    hostDocument.addEventListener('fullscreenchange', this.editingToolbarFullscreenHandler);

    // Electron's native fullscreen does not use the DOM Fullscreen API.
    // Obsidian marks that state with body.is-fullscreen instead.
    const MutationObserverCtor = hostDocument.defaultView?.MutationObserver;
    if (hostDocument.body && MutationObserverCtor) {
      this.editingToolbarFullscreenObserver = new MutationObserverCtor(
        this.editingToolbarFullscreenHandler
      );
      this.editingToolbarFullscreenObserver.observe(hostDocument.body, {
        attributes: true,
        attributeFilter: ['class']
      });
    }
  }

  stopEditingToolbarFullscreenTracking() {
    if (this.editingToolbarFullscreenDocument && this.editingToolbarFullscreenHandler) {
      this.editingToolbarFullscreenDocument.removeEventListener(
        'fullscreenchange',
        this.editingToolbarFullscreenHandler
      );
    }
    this.editingToolbarFullscreenObserver?.disconnect();
    this.editingToolbarFullscreenObserver = null;
    this.editingToolbarFullscreenDocument = null;
    this.editingToolbarFullscreenHandler = null;
  }

  updateEditingToolbarClearance() {
    const strip = this.editingToolbarStrip;
    if (!strip?.isConnected) return;
    const hostDocument = strip.ownerDocument;
    const isFullscreen =
      !!hostDocument.fullscreenElement ||
      hostDocument.body?.classList.contains('is-fullscreen');
    let clearance = 0;
    if (Platform.isMacOS && !isFullscreen) {
      const titlebarHeight = parseFloat(
        hostDocument.defaultView?.getComputedStyle(hostDocument.body)
          .getPropertyValue('--titlebar-height')
      );
      clearance = Number.isFinite(titlebarHeight) && titlebarHeight > 0
        ? Math.ceil(titlebarHeight)
        : MACOS_TITLEBAR_HEIGHT;
    }
    if (clearance === this.editingToolbarClearance) return;
    this.editingToolbarClearance = clearance;
    hostDocument.documentElement.style.setProperty(
      '--composition-mode-toolbar-clearance',
      `${clearance}px`
    );
    this.scheduleEditorPaneBoundsUpdate();
  }

  measureEditingToolbarStrip() {
    const strip = this.editingToolbarStrip;
    if (!strip?.isConnected) return;
    // Constrain first: toolbar wrapping (and therefore its overlay height)
    // depends on the active markdown leaf's width.
    this.updateEditorPaneBounds();
    const height = Math.max(0, Math.ceil(strip.getBoundingClientRect().height || strip.offsetHeight || 0));
    if (height === this.editingToolbarStripHeight) return;
    this.editingToolbarStripHeight = height;
    // The overlay scrollbar's track starts below the overlaid strip, so a
    // height change moves its top edge. The unchanged-height early return
    // above keeps this from ping-ponging with updateEditorPaneBounds.
    this.scheduleEditorPaneBoundsUpdate();
  }

  destroyEditingToolbarStrip() {
    this.editingToolbarStripResizeObserver?.disconnect();
    this.editingToolbarStripResizeObserver = null;

    const strip = this.editingToolbarStrip;
    const band = this.editingToolbarBand;
    const hadToolbar = !!(band || strip);
    const hostDocument =
      strip?.ownerDocument ||
      band?.ownerDocument ||
      this.editingToolbarFullscreenDocument ||
      document;
    this.stopEditingToolbarFullscreenTracking();
    if (band) band.remove();
    else if (strip) strip.remove();
    this.editingToolbarBand = null;
    this.editingToolbarStrip = null;
    this.editingToolbarStripHeight = 0;
    this.editingToolbarClearance = 0;
    this.barAutoHideToolbarPopupArmed = false;
    this.barAutoHideToolbarPopupBaseline = null;
    this.barAutoHideToolbarPopoverWasOpen = false;
    this.clearBarAutoHideTimer('toolbar');
    if (this.barAutoHidePointerLock === 'toolbar') this.barAutoHidePointerLock = null;
    hostDocument.documentElement?.style.removeProperty('--composition-mode-toolbar-clearance');
    if (hadToolbar) this.scheduleEditorPaneBoundsUpdate();
  }

  getActiveMarkdownLeafElement() {
    const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
    const viewContainer = activeView?.containerEl || null;
    return viewContainer?.closest?.('.workspace-leaf') || viewContainer;
  }

  updateEditorPaneBounds() {
    if (!this.isActive) return;
    const leaf = this.getActiveMarkdownLeafElement();
    const targets = [
      this.editingToolbarBand,
      this.controlBar,
      this.barAutoHideTopZone,
      this.barAutoHideBottomZone,
      this.overlayScrollbar
    ].filter(Boolean);

    if (leaf !== this.editorPaneBoundsLeaf) {
      this.editorPaneBoundsResizeObserver?.disconnect();
      this.editorPaneBoundsResizeObserver = null;
      this.editorPaneBoundsLeaf = leaf?.isConnected ? leaf : null;
      const ResizeObserverCtor = leaf?.ownerDocument?.defaultView?.ResizeObserver;
      if (leaf?.isConnected && ResizeObserverCtor) {
        this.editorPaneBoundsResizeObserver = new ResizeObserverCtor(() => {
          this.scheduleEditorPaneBoundsUpdate();
        });
        this.editorPaneBoundsResizeObserver.observe(leaf);
      }
    }

    if (!leaf?.isConnected) {
      for (const target of targets) target.style.visibility = 'hidden';
      return;
    }

    const rect = leaf.getBoundingClientRect();
    if (!Number.isFinite(rect.left) || !Number.isFinite(rect.width) || rect.width <= 0) {
      for (const target of targets) target.style.visibility = 'hidden';
      return;
    }

    for (const target of targets) {
      target.style.left = `${rect.left}px`;
      target.style.right = 'auto';
      target.style.width = `${rect.width}px`;
      target.style.visibility = '';
    }
    if (this.editingToolbarBand) {
      this.editingToolbarBand.style.top = `${rect.top}px`;
    }
    if (this.barAutoHideTopZone) {
      this.barAutoHideTopZone.style.top = `${rect.top}px`;
    }
    if (this.barAutoHideBottomZone) {
      const hostHeight = leaf.ownerDocument?.defaultView?.innerHeight || window.innerHeight;
      this.barAutoHideBottomZone.style.bottom = `${Math.max(0, hostHeight - rect.bottom)}px`;
    }
    if (this.overlayScrollbar) {
      this.overlayScrollbar.style.left = `${rect.right - OVERLAY_SCROLLBAR_TRACK_WIDTH_PX}px`;
      this.overlayScrollbar.style.width = `${OVERLAY_SCROLLBAR_TRACK_WIDTH_PX}px`;
      // CSS composes the band from clearance padding + the measured strip.
      // Read the resulting box so the track starts at the exact painted edge,
      // including during fullscreen and toolbar-wrapping transitions.
      // 5px breathing room so the track never touches the band's bottom rule.
      const toolbarInset = this.editingToolbarBand
        ? Math.max(0, this.editingToolbarBand.getBoundingClientRect().height) + 5
        : 0;
      this.overlayScrollbar.style.top = `${rect.top + toolbarInset}px`;
      this.overlayScrollbar.style.height = `${Math.max(0, rect.height - toolbarInset)}px`;
      this.updateOverlayScrollbar();
    }
  }

  scheduleEditorPaneBoundsUpdate() {
    if (!this.isActive || this.editorPaneBoundsFrame) return;
    const hostWindow =
      this.getActiveMarkdownLeafElement()?.ownerDocument?.defaultView ||
      window;
    this.editorPaneBoundsFrameWindow = hostWindow;
    this.editorPaneBoundsFrame = hostWindow.requestAnimationFrame(() => {
      this.editorPaneBoundsFrame = null;
      this.editorPaneBoundsFrameWindow = null;
      this.updateEditorPaneBounds();
      this.measureEditingToolbarStrip();
      this.scheduleStatusPageUpdate();
      this.scheduleOverlayScrollbarUpdate();
    });
  }

  stopEditorPaneBoundsTracking() {
    this.editorPaneBoundsResizeObserver?.disconnect();
    this.editorPaneBoundsResizeObserver = null;
    this.editorPaneBoundsLeaf = null;
    if (this.editorPaneBoundsFrame) {
      (this.editorPaneBoundsFrameWindow || window).cancelAnimationFrame(
        this.editorPaneBoundsFrame
      );
      this.editorPaneBoundsFrame = null;
      this.editorPaneBoundsFrameWindow = null;
    }
  }

  setupOverlayScrollbar() {
    this.teardownOverlayScrollbar();

    const track = document.createElement('div');
    track.className = 'composition-mode-overlay-scrollbar';
    track.setAttribute('aria-hidden', 'true');
    track.hidden = true;
    const thumb = document.createElement('div');
    thumb.className = 'composition-mode-overlay-scrollbar-thumb';
    track.appendChild(thumb);
    document.body.appendChild(track);
    this.overlayScrollbar = track;
    this.overlayScrollbarThumb = thumb;

    this.overlayScrollbarScrollHandler = () => {
      this.scheduleOverlayScrollbarUpdate();
      this.revealOverlayScrollbar();
    };
    this.overlayScrollbarPointerEnterHandler = () => {
      this.overlayScrollbarHovered = true;
      this.revealOverlayScrollbar(false);
    };
    this.overlayScrollbarPointerLeaveHandler = () => {
      this.overlayScrollbarHovered = false;
      if (!this.overlayScrollbarDrag) this.scheduleOverlayScrollbarFade();
    };
    this.overlayScrollbarTrackPointerDownHandler = event => {
      if (event.button !== 0 || event.target === thumb || track.hidden) return;
      const scroller = this.overlayScrollbarScroller;
      if (!scroller) return;
      event.preventDefault();
      const thumbRect = thumb.getBoundingClientRect();
      const direction = event.clientY < thumbRect.top ? -1 : 1;
      scroller.scrollTop += direction * Math.max(1, scroller.clientHeight * 0.9);
      this.revealOverlayScrollbar();
    };
    this.overlayScrollbarThumbPointerDownHandler = event => {
      if (event.button !== 0 || track.hidden) return;
      event.preventDefault();
      event.stopPropagation();
      this.overlayScrollbarDrag = {
        pointerId: event.pointerId,
        startClientY: event.clientY,
        startScrollTop: this.overlayScrollbarScroller?.scrollTop || 0
      };
      thumb.setPointerCapture(event.pointerId);
      track.classList.add('is-dragging');
      this.revealOverlayScrollbar(false);
    };
    this.overlayScrollbarThumbPointerMoveHandler = event => {
      const drag = this.overlayScrollbarDrag;
      const scroller = this.overlayScrollbarScroller;
      if (!drag || drag.pointerId !== event.pointerId || !scroller) return;
      const maxScroll = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
      const availableTrack = Math.max(1, track.clientHeight - thumb.offsetHeight);
      // clientY and availableTrack are both native-scale visual pixels, while
      // maxScroll and scrollTop are both zoom-independent layout pixels. Their
      // ratios map directly, including at non-100% CSS zoom.
      scroller.scrollTop = drag.startScrollTop +
        ((event.clientY - drag.startClientY) * maxScroll / availableTrack);
    };
    this.overlayScrollbarThumbPointerUpHandler = event => {
      if (this.overlayScrollbarDrag?.pointerId !== event.pointerId) return;
      this.overlayScrollbarDrag = null;
      track.classList.remove('is-dragging');
      if (thumb.hasPointerCapture(event.pointerId)) thumb.releasePointerCapture(event.pointerId);
      if (!this.overlayScrollbarHovered) this.scheduleOverlayScrollbarFade();
    };

    track.addEventListener('pointerenter', this.overlayScrollbarPointerEnterHandler);
    track.addEventListener('pointerleave', this.overlayScrollbarPointerLeaveHandler);
    track.addEventListener('pointerdown', this.overlayScrollbarTrackPointerDownHandler);
    thumb.addEventListener('pointerdown', this.overlayScrollbarThumbPointerDownHandler);
    thumb.addEventListener('pointermove', this.overlayScrollbarThumbPointerMoveHandler);
    thumb.addEventListener('pointerup', this.overlayScrollbarThumbPointerUpHandler);
    thumb.addEventListener('pointercancel', this.overlayScrollbarThumbPointerUpHandler);
    thumb.addEventListener('lostpointercapture', this.overlayScrollbarThumbPointerUpHandler);

    const ResizeObserverCtor = document.defaultView?.ResizeObserver;
    if (ResizeObserverCtor) {
      this.overlayScrollbarResizeObserver = new ResizeObserverCtor(() => {
        this.scheduleOverlayScrollbarUpdate();
      });
    }
    this.updateEditorPaneBounds();
  }

  bindOverlayScrollbarScroller(scroller) {
    if (scroller === this.overlayScrollbarScroller) return;
    this.overlayScrollbarScroller?.removeEventListener(
      'scroll',
      this.overlayScrollbarScrollHandler
    );
    this.overlayScrollbarResizeObserver?.disconnect();
    this.overlayScrollbarScroller = scroller?.isConnected ? scroller : null;
    if (!this.overlayScrollbarScroller) return;

    this.overlayScrollbarScroller.addEventListener(
      'scroll',
      this.overlayScrollbarScrollHandler,
      { passive: true }
    );
    this.overlayScrollbarResizeObserver?.observe(this.overlayScrollbarScroller);
    const sizer = this.overlayScrollbarScroller.querySelector('.cm-sizer');
    if (sizer) this.overlayScrollbarResizeObserver?.observe(sizer);
  }

  updateOverlayScrollbar() {
    const track = this.overlayScrollbar;
    const thumb = this.overlayScrollbarThumb;
    if (!this.isActive || !track || !thumb) return;

    const { scroller } = this.getActiveCompositionElements();
    this.bindOverlayScrollbarScroller(scroller);
    const activeScroller = this.overlayScrollbarScroller;
    // [hidden] means display:none, so clientHeight reads 0 while hidden and
    // the track could never unhide. Unhide before measuring; the bail
    // branches below re-hide without an intermediate paint.
    track.hidden = false;
    const trackHeight = track.clientHeight;
    if (!activeScroller || trackHeight <= 0) {
      track.hidden = true;
      return;
    }

    const scrollHeight = activeScroller.scrollHeight;
    const clientHeight = activeScroller.clientHeight;
    const maxScroll = Math.max(0, scrollHeight - clientHeight);
    if (maxScroll <= 1 || scrollHeight <= 0) {
      track.hidden = true;
      return;
    }

    track.hidden = false;
    const thumbHeight = Math.min(
      trackHeight,
      Math.max(OVERLAY_SCROLLBAR_MIN_THUMB_PX, trackHeight * clientHeight / scrollHeight)
    );
    const availableTrack = Math.max(0, trackHeight - thumbHeight);
    const thumbTop = availableTrack * activeScroller.scrollTop / maxScroll;
    thumb.style.height = `${thumbHeight}px`;
    thumb.style.transform = `translateY(${Math.max(0, Math.min(availableTrack, thumbTop))}px)`;
  }

  scheduleOverlayScrollbarUpdate() {
    if (!this.isActive || !this.overlayScrollbar || this.overlayScrollbarFrame) return;
    this.overlayScrollbarFrame = requestAnimationFrame(() => {
      this.overlayScrollbarFrame = null;
      this.updateOverlayScrollbar();
    });
  }

  revealOverlayScrollbar(scheduleFade = true) {
    if (!this.overlayScrollbar || this.overlayScrollbar.hidden) return;
    if (this.overlayScrollbarFadeTimer) {
      clearTimeout(this.overlayScrollbarFadeTimer);
      this.overlayScrollbarFadeTimer = null;
    }
    this.overlayScrollbar.classList.add('is-active');
    if (scheduleFade && !this.overlayScrollbarHovered && !this.overlayScrollbarDrag) {
      this.scheduleOverlayScrollbarFade();
    }
  }

  scheduleOverlayScrollbarFade() {
    if (!this.overlayScrollbar || this.overlayScrollbarHovered || this.overlayScrollbarDrag) return;
    if (this.overlayScrollbarFadeTimer) clearTimeout(this.overlayScrollbarFadeTimer);
    this.overlayScrollbarFadeTimer = setTimeout(() => {
      this.overlayScrollbarFadeTimer = null;
      this.overlayScrollbar?.classList.remove('is-active');
    }, OVERLAY_SCROLLBAR_IDLE_DELAY_MS);
  }

  teardownOverlayScrollbar() {
    if (this.overlayScrollbarFrame) {
      cancelAnimationFrame(this.overlayScrollbarFrame);
      this.overlayScrollbarFrame = null;
    }
    if (this.overlayScrollbarFadeTimer) {
      clearTimeout(this.overlayScrollbarFadeTimer);
      this.overlayScrollbarFadeTimer = null;
    }
    this.overlayScrollbarScroller?.removeEventListener(
      'scroll',
      this.overlayScrollbarScrollHandler
    );
    this.overlayScrollbarResizeObserver?.disconnect();
    this.overlayScrollbarResizeObserver = null;
    this.overlayScrollbar?.removeEventListener(
      'pointerenter',
      this.overlayScrollbarPointerEnterHandler
    );
    this.overlayScrollbar?.removeEventListener(
      'pointerleave',
      this.overlayScrollbarPointerLeaveHandler
    );
    this.overlayScrollbar?.removeEventListener(
      'pointerdown',
      this.overlayScrollbarTrackPointerDownHandler
    );
    this.overlayScrollbarThumb?.removeEventListener(
      'pointerdown',
      this.overlayScrollbarThumbPointerDownHandler
    );
    this.overlayScrollbarThumb?.removeEventListener(
      'pointermove',
      this.overlayScrollbarThumbPointerMoveHandler
    );
    this.overlayScrollbarThumb?.removeEventListener(
      'pointerup',
      this.overlayScrollbarThumbPointerUpHandler
    );
    this.overlayScrollbarThumb?.removeEventListener(
      'pointercancel',
      this.overlayScrollbarThumbPointerUpHandler
    );
    this.overlayScrollbarThumb?.removeEventListener(
      'lostpointercapture',
      this.overlayScrollbarThumbPointerUpHandler
    );
    this.overlayScrollbar?.remove();
    this.overlayScrollbar = null;
    this.overlayScrollbarThumb = null;
    this.overlayScrollbarScroller = null;
    this.overlayScrollbarScrollHandler = null;
    this.overlayScrollbarPointerEnterHandler = null;
    this.overlayScrollbarPointerLeaveHandler = null;
    this.overlayScrollbarTrackPointerDownHandler = null;
    this.overlayScrollbarThumbPointerDownHandler = null;
    this.overlayScrollbarThumbPointerMoveHandler = null;
    this.overlayScrollbarThumbPointerUpHandler = null;
    this.overlayScrollbarHovered = false;
    this.overlayScrollbarDrag = null;
  }

  setupBarAutoHide() {
    this.teardownBarAutoHide();

    this.barAutoHideTopZone = document.createElement('div');
    this.barAutoHideTopZone.className = 'composition-mode-reveal-zone composition-mode-reveal-zone-top';
    this.barAutoHideTopZone.setAttribute('aria-hidden', 'true');
    this.barAutoHideTopZone.style.height = `${BAR_REVEAL_ZONE_HEIGHT_PX}px`;
    this.barAutoHideBottomZone = document.createElement('div');
    this.barAutoHideBottomZone.className = 'composition-mode-reveal-zone composition-mode-reveal-zone-bottom';
    this.barAutoHideBottomZone.setAttribute('aria-hidden', 'true');
    this.barAutoHideBottomZone.style.height = `${BAR_REVEAL_ZONE_HEIGHT_PX}px`;
    document.body.append(this.barAutoHideTopZone, this.barAutoHideBottomZone);

    this.barAutoHideLastPointer = null;
    this.barAutoHidePointerLock = null;
    this.barAutoHideToolbarPopupArmed = false;
    this.barAutoHideToolbarPopupBaseline = null;
    this.barAutoHideToolbarPopoverWasOpen = false;
    this.barAutoHideToolbarVisible = true;
    this.barAutoHideStatusVisible = true;

    this.barAutoHidePointerMoveHandler = (event) => {
      this.barAutoHideLastPointer = {
        x: event.clientX,
        y: event.clientY,
        target: event.target
      };
      this.refreshBarAutoHideForPointer();
    };
    this.barAutoHidePointerDownHandler = (event) => {
      this.barAutoHideLastPointer = {
        x: event.clientX,
        y: event.clientY,
        target: event.target
      };
      const bar = this.getBarForEventTarget(event.target);
      if (!bar) {
        this.refreshBarAutoHideForPointer();
        const eventDocument = event.target?.ownerDocument || document;
        eventDocument.defaultView?.requestAnimationFrame(() => {
          this.refreshBarAutoHideForPointer();
        });
        return;
      }
      if (bar === 'toolbar') {
        this.barAutoHideToolbarPopupArmed = true;
        this.barAutoHideToolbarPopupBaseline = new Set(
          this.getVisibleToolbarPortalPopups(event.target?.ownerDocument || document)
        );
      }
      this.barAutoHidePointerLock = bar;
      this.setBarAutoHideVisible(bar, true);
      this.clearBarAutoHideTimer(bar);
    };
    this.barAutoHidePointerUpHandler = (event) => {
      if (!this.barAutoHidePointerLock) return;
      const releasedBar = this.barAutoHidePointerLock;
      const eventDocument = event.target?.ownerDocument || document;
      this.barAutoHideLastPointer = {
        x: event.clientX,
        y: event.clientY,
        target: eventDocument.elementFromPoint?.(event.clientX, event.clientY) || event.target
      };
      this.barAutoHidePointerLock = null;
      if (releasedBar === 'toolbar') {
        // Toolbar click handlers open portalled menus after pointerup.
        eventDocument.defaultView?.requestAnimationFrame(() => {
          this.refreshBarAutoHideForPointer();
        });
      } else {
        this.refreshBarAutoHideForPointer();
      }
    };
    this.barAutoHideKeyDownHandler = (event) => {
      if (!event.target?.closest?.('.cm-editor')) return;
      for (const bar of ['toolbar', 'status']) {
        if (this.isBarAutoHideProtected(bar)) {
          this.clearBarAutoHideTimer(bar);
          this.setBarAutoHideVisible(bar, true);
        } else {
          this.clearBarAutoHideTimer(bar);
          this.setBarAutoHideVisible(bar, false);
        }
      }
    };
    this.barAutoHideWindowBlurHandler = () => {
      this.scheduleBarAutoHide('toolbar');
      this.scheduleBarAutoHide('status');
    };

    document.addEventListener('pointermove', this.barAutoHidePointerMoveHandler, true);
    document.addEventListener('pointerdown', this.barAutoHidePointerDownHandler, true);
    document.addEventListener('pointerup', this.barAutoHidePointerUpHandler, true);
    document.addEventListener('pointercancel', this.barAutoHidePointerUpHandler, true);
    document.addEventListener('keydown', this.barAutoHideKeyDownHandler, true);
    window.addEventListener('blur', this.barAutoHideWindowBlurHandler);
    this.updateEditorPaneBounds();
    this.scheduleBarAutoHide('toolbar');
    this.scheduleBarAutoHide('status');
  }

  teardownBarAutoHide() {
    this.clearBarAutoHideTimer('toolbar');
    this.clearBarAutoHideTimer('status');
    if (this.barAutoHidePointerMoveHandler) {
      document.removeEventListener('pointermove', this.barAutoHidePointerMoveHandler, true);
      document.removeEventListener('pointerdown', this.barAutoHidePointerDownHandler, true);
      document.removeEventListener('pointerup', this.barAutoHidePointerUpHandler, true);
      document.removeEventListener('pointercancel', this.barAutoHidePointerUpHandler, true);
      document.removeEventListener('keydown', this.barAutoHideKeyDownHandler, true);
      window.removeEventListener('blur', this.barAutoHideWindowBlurHandler);
    }
    this.barAutoHideTopZone?.remove();
    this.barAutoHideBottomZone?.remove();
    this.barAutoHideTopZone = null;
    this.barAutoHideBottomZone = null;
    this.barAutoHidePointerMoveHandler = null;
    this.barAutoHidePointerDownHandler = null;
    this.barAutoHidePointerUpHandler = null;
    this.barAutoHideKeyDownHandler = null;
    this.barAutoHideWindowBlurHandler = null;
    this.barAutoHideLastPointer = null;
    this.barAutoHidePointerLock = null;
    this.barAutoHideToolbarPopupArmed = false;
    this.barAutoHideToolbarPopupBaseline = null;
    this.barAutoHideToolbarPopoverWasOpen = false;
    this.barAutoHideToolbarVisible = null;
    this.barAutoHideStatusVisible = null;
    this.editingToolbarBand?.classList.remove('composition-mode-bar-hidden');
    this.controlBar?.classList.remove('composition-mode-bar-hidden');
  }

  getBarForEventTarget(target) {
    if (this.editingToolbarBand?.contains(target)) return 'toolbar';
    if (this.controlBar?.contains(target)) return 'status';
    return null;
  }

  isPointerInBarRevealZone(bar) {
    const pointer = this.barAutoHideLastPointer;
    const leaf = this.editorPaneBoundsLeaf || this.getActiveMarkdownLeafElement();
    if (!pointer || !leaf?.isConnected) return false;
    const rect = leaf.getBoundingClientRect();
    if (pointer.x < rect.left || pointer.x > rect.right ||
        pointer.y < rect.top || pointer.y > rect.bottom) return false;
    if (bar === 'toolbar') {
      return pointer.y <= rect.top + BAR_REVEAL_ZONE_HEIGHT_PX;
    }
    return pointer.y >= rect.bottom - BAR_REVEAL_ZONE_HEIGHT_PX;
  }

  isBarAutoHideProtected(bar) {
    if (this.barAutoHidePointerLock === bar) return true;
    if (bar === 'toolbar' && this.isEditingToolbarPopoverOpen()) return true;
    if (bar === 'status' && this.statusPopover && !this.statusPopover.hidden) return true;
    const pointerTarget = this.barAutoHideLastPointer?.target;
    return this.getBarForEventTarget(pointerTarget) === bar ||
      this.isPointerOverBar(bar) ||
      this.isPointerInBarRevealZone(bar);
  }

  isEditingToolbarPopoverOpen() {
    const band = this.editingToolbarBand;
    if (!band?.isConnected) return false;
    if (band.querySelector('[aria-expanded="true"]')) {
      this.barAutoHideToolbarPopoverWasOpen = true;
      return true;
    }

    const hostDocument = band.ownerDocument;
    try {
      const triggers = [...band.querySelectorAll('[popovertarget]')];
      for (const popover of hostDocument.querySelectorAll(':popover-open')) {
        if (band.contains(popover) || triggers.some(trigger =>
          trigger.getAttribute('popovertarget') === popover.id)) {
          this.barAutoHideToolbarPopoverWasOpen = true;
          return true;
        }
      }
    } catch (_) {
      // Older Electron versions do not support the Popover API selector.
    }

    // Obsidian menus are generally portalled to body. Remember that the
    // interaction began in the strip, then protect the band only while one of
    // those portal surfaces remains rendered.
    if (!this.barAutoHideToolbarPopupArmed) {
      this.barAutoHideToolbarPopoverWasOpen = false;
      return false;
    }
    const baseline = this.barAutoHideToolbarPopupBaseline;
    const popup = this.getVisibleToolbarPortalPopups(hostDocument)
      .find(element => !baseline?.has(element));
    if (popup) {
      this.barAutoHideToolbarPopoverWasOpen = true;
      return true;
    }
    this.barAutoHideToolbarPopupArmed = false;
    this.barAutoHideToolbarPopupBaseline = null;
    this.barAutoHideToolbarPopoverWasOpen = false;
    return false;
  }

  getVisibleToolbarPortalPopups(hostDocument) {
    return [...hostDocument.querySelectorAll('.menu, .popover, .suggestion-container')]
      .filter(element => !element.hidden && element.getClientRects().length > 0);
  }

  isPointerOverBar(bar) {
    const pointer = this.barAutoHideLastPointer;
    const element = bar === 'toolbar' ? this.editingToolbarBand : this.controlBar;
    if (!pointer || !element?.isConnected) return false;
    const rect = element.getBoundingClientRect();
    return pointer.x >= rect.left && pointer.x <= rect.right &&
      pointer.y >= rect.top && pointer.y <= rect.bottom;
  }

  refreshBarAutoHideForPointer() {
    if (!this.isActive || !this.barAutoHidePointerMoveHandler) return;
    for (const bar of ['toolbar', 'status']) {
      if (this.isBarAutoHideProtected(bar)) {
        this.clearBarAutoHideTimer(bar);
        this.setBarAutoHideVisible(bar, true);
      } else {
        this.scheduleBarAutoHide(bar);
      }
    }
  }

  setBarAutoHideVisible(bar, visible) {
    const element = bar === 'toolbar' ? this.editingToolbarBand : this.controlBar;
    if (bar === 'status' && this.settings.showStatusBar === false) visible = false;
    if (bar === 'toolbar') this.barAutoHideToolbarVisible = visible;
    else this.barAutoHideStatusVisible = visible;
    element?.classList.toggle('composition-mode-bar-hidden', !visible);
  }

  scheduleBarAutoHide(bar) {
    if (!this.isActive || this.isBarAutoHideProtected(bar)) {
      this.clearBarAutoHideTimer(bar);
      return;
    }
    if (bar === 'status' && this.settings.showStatusBar === false) return;
    this.clearBarAutoHideTimer(bar);
    const timerName = bar === 'toolbar'
      ? 'barAutoHideToolbarTimer'
      : 'barAutoHideStatusTimer';
    this[timerName] = setTimeout(() => {
      this[timerName] = null;
      if (!this.isBarAutoHideProtected(bar)) this.setBarAutoHideVisible(bar, false);
    }, BAR_AUTO_HIDE_DELAY_MS);
  }

  clearBarAutoHideTimer(bar) {
    const timerName = bar === 'toolbar'
      ? 'barAutoHideToolbarTimer'
      : 'barAutoHideStatusTimer';
    if (!this[timerName]) return;
    clearTimeout(this[timerName]);
    this[timerName] = null;
  }

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

  getPaperSizeDef() {
    return PAPER_SIZES[this.paperSize] || PAPER_SIZES.letter;
  }

  getEffectivePageMarginXIn() {
    const requested = Number(this.settings.pageMarginXIn ?? DEFAULT_SETTINGS.pageMarginXIn);
    const clampedRequested = Number.isFinite(requested) ? Math.max(0.25, Math.min(3, requested)) : DEFAULT_SETTINGS.pageMarginXIn;
    const paperWidth = this.getPaperSizeDef().width;
    // Small book trims become unusable with manuscript margins. Keep at
    // least a 4-inch text block when possible: Trade caps at 1.0in,
    // Academic at 1.5in, while Letter/A4 remain generous.
    const maxMarginForReadableColumn = Math.max(0.45, (paperWidth - 4.0) / 2);
    return Math.min(clampedRequested, maxMarginForReadableColumn);
  }

  getEffectivePageMarginYIn() {
    const requested = Number(this.settings.pageMarginYIn ?? DEFAULT_SETTINGS.pageMarginYIn);
    const clampedRequested = Number.isFinite(requested) ? Math.max(0.25, Math.min(2.5, requested)) : DEFAULT_SETTINGS.pageMarginYIn;
    const paperHeight = this.getPaperSizeDef().height;
    // Keep at least ~6.5in of vertical content on smaller book pages.
    const maxMarginForReadablePage = Math.max(0.5, (paperHeight - 6.5) / 2);
    return Math.min(clampedRequested, maxMarginForReadablePage);
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

    this.preloadImageDimensionsFromText(docText, sourcePath);
  }

  preloadImageDimensionsFromText(docText, sourcePath, discoveredRefs = null) {
    const refs = discoveredRefs || collectImageReferences(docText);
    if (!refs.length) return;

    // Full metric refreshes replace the active note's resolution table.
    // Edit-time discovery carries only the already-scanned unknown refs, so
    // merge those into the existing table without rescanning the document.
    if (!discoveredRefs) this.currentImageKeyResolutions = new Map();

    for (const ref of refs) {
      const file = ref.linkpath
        ? this.app.metadataCache.getFirstLinkpathDest(ref.linkpath, sourcePath)
        : null;
      if (!file && !ref.src) continue;
      const cacheKey = file?.path || `external:${ref.src}`;
      this.currentImageKeyResolutions.set(ref.key, cacheKey);
      if (this.imageDimsCache.has(cacheKey)) {
        // The dimensions are already known, but edit-time resolution may
        // have introduced a new note-local alias. Rebuild so that mapping is
        // applied without waiting for another activation or settings change.
        if (discoveredRefs && this.isActive) this.scheduleMetricsRefreshAndRebuild();
        continue;
      }
      if (this.pendingImagePreloads.has(cacheKey)) continue;

      this.pendingImagePreloads.add(cacheKey);
      const probe = new Image();
      const cleanup = (ok) => {
        this.pendingImagePreloads.delete(cacheKey);
        if (ok && probe.naturalWidth > 0 && probe.naturalHeight > 0) {
          this.imageDimsCache.set(cacheKey, {
            w: probe.naturalWidth,
            h: probe.naturalHeight,
            basename: file?.name?.toLowerCase?.() || ref.key,
            keys: Array.from(new Set([
              ref.key,
              file?.name?.toLowerCase?.(),
              file?.path?.toLowerCase?.()
            ].filter(Boolean)))
          });
          if (this.isActive) this.scheduleMetricsRefreshAndRebuild();
        }
      };
      probe.addEventListener('load', () => cleanup(true), { once: true });
      probe.addEventListener('error', () => cleanup(false), { once: true });
      probe.src = ref.src || this.app.vault.getResourcePath(file);
    }
  }

  // Read the currently rendered note DOM for diagnostics. Pagination uses
  // natural aspect ratios plus the configured CSS width so visible and
  // virtualized embeds follow the same deterministic sizing rule.
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

  // Obsidian places an authored ![[image|400]] width on the embed wrapper
  // when that signal is available, so it is authoritative even when the
  // requested width happens to equal naturalWidth. Older render paths put
  // width on the image itself; only there do we compare against naturalWidth
  // to distinguish an override from Obsidian's intrinsic-size attribute.
  syncImageEmbedWidthOverrides(elements = null) {
    const resolved = elements || this.getActiveCompositionElements();
    const root = resolved?.sourceView || resolved?.cmContent || null;
    if (!root) return;

    root.querySelectorAll('.cm-content .image-embed img, .cm-content .internal-embed img').forEach(img => {
      const wrapper = img.closest('.image-embed, .internal-embed');
      if (!wrapper) return;
      const wrapperWidth = Number(wrapper.getAttribute('width')) || 0;
      const imageWidth = Number(img.getAttribute('width')) || 0;
      const naturalWidth = Number(img.naturalWidth) || 0;
      let overrideWidth = wrapperWidth > 0 ? wrapperWidth : 0;

      if (!overrideWidth && !naturalWidth) {
        wrapper.classList.remove('composition-mode-image-width-override');
        wrapper.style.removeProperty('--composition-mode-image-embed-width');
        if (!img.__compositionModeWidthLoadBound) {
          img.__compositionModeWidthLoadBound = true;
          img.addEventListener('load', () => this.scheduleImageWidthSync(), { once: true });
        }
        return;
      }

      if (!overrideWidth && imageWidth > 0 && Math.abs(imageWidth - naturalWidth) > 0.5) {
        overrideWidth = imageWidth;
      }

      if (overrideWidth > 0) {
        wrapper.classList.add('composition-mode-image-width-override');
        wrapper.style.setProperty('--composition-mode-image-embed-width', `${overrideWidth}px`);
      } else {
        wrapper.classList.remove('composition-mode-image-width-override');
        wrapper.style.removeProperty('--composition-mode-image-embed-width');
      }
    });
  }

  scheduleImageWidthSync() {
    if (!this.isActive || this.pendingImageWidthSyncFrame) return;
    this.pendingImageWidthSyncFrame = requestAnimationFrame(() => {
      this.pendingImageWidthSyncFrame = null;
      if (!this.isActive) return;
      this.syncImageEmbedWidthOverrides();
    });
  }

  observeImageEmbedWidths(elements) {
    const root = elements?.sourceView || null;
    if (!root || this.imageWidthObserverRoot === root) return;
    this.stopImageWidthObserver();
    this.imageWidthObserverRoot = root;
    this.imageWidthObserver = new MutationObserver(() => this.scheduleImageWidthSync());
    // Watch only source/width signals plus inserted embeds. Excluding class
    // and style prevents our own override updates from feeding the observer.
    this.imageWidthObserver.observe(root, {
      childList: true,
      attributes: true,
      attributeFilter: ['width', 'src'],
      subtree: true
    });
  }

  stopImageWidthObserver() {
    this.imageWidthObserver?.disconnect();
    this.imageWidthObserver = null;
    this.imageWidthObserverRoot = null;
    if (this.pendingImageWidthSyncFrame) {
      cancelAnimationFrame(this.pendingImageWidthSyncFrame);
      this.pendingImageWidthSyncFrame = null;
    }
  }

  // Build a filename → displayed-height map for every cached image. CSS
  // deliberately stretches image embeds to their configured share of the
  // column, even when that exceeds naturalWidth, so the estimator uses the
  // same effective width rather than imposing an intrinsic-size cap.
  buildImageHeightMap(contentWidth) {
    const map = new Map();
    this.imageAspectRatioMap = new Map();
    if (!contentWidth || contentWidth <= 0) return map;

    const pct = Math.max(20, Math.min(100, this.settings.imageWidthPct || 100));
    const effectiveWidth = contentWidth * (pct / 100);
    const pageContentHeight = Math.max(0, pageBreakConfig.pageContentHeight || 0);

    for (const dims of this.imageDimsCache.values()) {
      if (!dims || !dims.basename || dims.w <= 0 || dims.h <= 0) continue;
      const ratio = dims.h / dims.w;
      const displayedHeight = effectiveWidth * ratio;
      const cappedHeight = pageContentHeight > 0
        ? Math.min(displayedHeight, pageContentHeight)
        : displayedHeight;
      for (const key of (dims.keys || [dims.basename])) {
        this.imageAspectRatioMap.set(key, ratio);
        map.set(key, Math.round(cappedHeight));
      }
    }

    // Reapply every key referenced by the active note after the cache walk.
    // This includes the metadata-cache resolution for plain basenames, so
    // two same-named files cannot make cache insertion order choose which
    // dimensions the unqualified reference receives.
    for (const [referenceKey, cacheKey] of this.currentImageKeyResolutions || []) {
      const dims = this.imageDimsCache.get(cacheKey);
      if (!dims || dims.w <= 0 || dims.h <= 0) continue;
      const ratio = dims.h / dims.w;
      const displayedHeight = effectiveWidth * ratio;
      const cappedHeight = pageContentHeight > 0
        ? Math.min(displayedHeight, pageContentHeight)
        : displayedHeight;
      this.imageAspectRatioMap.set(referenceKey, ratio);
      map.set(referenceKey, Math.round(cappedHeight));
    }

    return map;
  }

  applyStyles() {
    if (!this.styleEl) return;

    const grayValue = Math.round(200 - this.backgroundFade * 200);
    const bgColor = `rgb(${grayValue}, ${grayValue}, ${grayValue})`;
    const textScale = this.getPaperTextScale();
    const visualZoom = this.clampZoom(this.currentZoom || 1);
    const fontSizePt = this.clampFontSizePt(this.settings.fontSizePt);
    const effectiveFontSizePt = Math.round(fontSizePt * textScale * 100) / 100;
    const paperSizeDef = this.getPaperSizeDef();
    const paperWidthCss = `${paperSizeDef.width}in`;
    const effectiveMarginXIn = this.getEffectivePageMarginXIn();
    const effectiveMarginYIn = this.getEffectivePageMarginYIn();

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
      body.composition-mode-active .workspace-leaf-content[data-type="markdown"] {
        width: ${paperWidthCss} !important;
        min-width: min(160px, calc(100vw - 6rem)) !important;
        max-width: min(calc(100vw - 6rem), ${Math.max(400, this.settings.maxPaperWidthPx || 1400)}px) !important;
        box-sizing: border-box !important;
        background: var(--background-primary) !important;
        zoom: ${visualZoom};
      }
      body.composition-mode-active .workspace-leaf-content[data-type="markdown"] .cm-editor {
        --composition-mode-page-margin-x: ${effectiveMarginXIn}in;
        --composition-mode-page-margin-y-px: ${effectiveMarginYIn}in;
        --composition-mode-page-content-height-px: ${(paperSizeDef.height - (2 * effectiveMarginYIn))}in;
      }
      body.composition-mode-active .workspace-leaf-content[data-type="markdown"] .markdown-source-view.mod-cm6,
      body.composition-mode-active .workspace-leaf-content[data-type="markdown"] .cm-editor,
      body.composition-mode-active .workspace-leaf-content[data-type="markdown"] .cm-contentContainer,
      body.composition-mode-active .workspace-leaf-content[data-type="markdown"] .cm-content {
        background: transparent !important;
      }
      body.composition-mode-active .workspace-leaf-content[data-type="markdown"] .markdown-source-view.mod-cm6 {
        font-size: ${effectiveFontSizePt}pt;
      }
      body.composition-mode-active .workspace-leaf-content[data-type="markdown"] .cm-content {
        font-size: inherit;
      }
      body.composition-mode-active .workspace-leaf-content[data-type="markdown"] .internal-embed.image-embed,
      body.composition-mode-active .workspace-leaf-content[data-type="markdown"] .cm-content .image-embed {
        width: ${Math.max(20, Math.min(100, this.settings.imageWidthPct || 100))}% !important;
        max-width: ${Math.max(20, Math.min(100, this.settings.imageWidthPct || 100))}% !important;
        margin-left: auto !important;
        margin-right: auto !important;
      }
      body.composition-mode-active .workspace-leaf-content[data-type="markdown"] .internal-embed.image-embed.composition-mode-image-width-override,
      body.composition-mode-active .workspace-leaf-content[data-type="markdown"] .cm-content .image-embed.composition-mode-image-width-override {
        width: min(100%, var(--composition-mode-image-embed-width)) !important;
        max-width: 100% !important;
      }
    `;

    this.updateZoomDisplay();
    this.updateTypeDisplay();
    this.scheduleEditorPaneBoundsUpdate();
    this.scheduleOverlayScrollbarUpdate();

    // Fast path: if only zoom changed, skip the full rebuild. CSS zoom is
    // pure magnification — page breaks are identical at every zoom level.
    const zoomOnly = (
      visualZoom !== this._prevZoom &&
      fontSizePt === this._prevFontSizePt &&
      this.paperSize === this._prevPaperSize &&
      textScale === this._prevTextScale &&
      this.paperWidth === this._prevPaperWidth
    );
    this._prevZoom = visualZoom;
    this._prevFontSizePt = fontSizePt;
    this._prevPaperSize = this.paperSize;
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

  scheduleZeroMetricRetry() {
    if (!this.isActive || !this.showPageBreaks) return;
    if (this.pendingZeroMetricRetryFrame || this.zeroMetricRetryCount >= 3) return;

    this.zeroMetricRetryCount += 1;
    this.pendingZeroMetricRetryFrame = requestAnimationFrame(() => {
      this.pendingZeroMetricRetryFrame = null;
      if (!this.isActive || !this.showPageBreaks) {
        this.zeroMetricRetryCount = 0;
        return;
      }
      this.updateScrollerMetrics();
      this.triggerEditors();
    });
  }

  resetZeroMetricRetries() {
    this.zeroMetricRetryCount = 0;
    if (this.pendingZeroMetricRetryFrame) {
      cancelAnimationFrame(this.pendingZeroMetricRetryFrame);
      this.pendingZeroMetricRetryFrame = null;
    }
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
    pageBreakConfig.imageWidthPct = Math.max(20, Math.min(100, this.settings.imageWidthPct || 100));
    // Gap height at reference scale. CSS transform zoom handles visual
    // scaling — no need to multiply by zoom here.
    pageBreakConfig.gapHeight = this.settings.pageGapHeight || 60;
    const paperSizeDef = this.getPaperSizeDef();
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
    pageBreakConfig.pageContentHeight = Math.max(0, pageBreakConfig.pageHeight - (2 * pageMarginY));
    document.documentElement.style.setProperty(
      '--composition-mode-page-content-height-px',
      `${pageBreakConfig.pageContentHeight}px`
    );
    elements.sourceView?.querySelector('.cm-editor')?.style?.setProperty(
      '--composition-mode-page-content-height-px',
      `${pageBreakConfig.pageContentHeight}px`
    );

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
    this.observeImageEmbedWidths(elements);
    this.syncImageEmbedWidthOverrides(elements);
    const renderedImageMetrics = this.getRenderedImageMetrics(elements);
    pageBreakConfig.imageHeightMap = this.buildImageHeightMap(pageBreakConfig.contentWidth);
    pageBreakConfig.imageAspectRatioMap = this.imageAspectRatioMap || new Map();
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
          } catch (e) {
            dbg(`dispatch: field-read error=${e?.message || String(e)}`);
          }
        } catch (e) {
          dbg(`dispatch: editor error=${e?.message || String(e)}`);
        }
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

  applyStatusBarVisibility() {
    if (!this.isActive) return;
    if (this.settings.showStatusBar !== false) {
      if (!this.controlBar) this.createControlBar();
      this.setupStatusBarListeners();
      this.refreshBarAutoHideForPointer();
    } else {
      this.destroyStatusBar();
    }
  }

  toggleStatusBar() {
    this.settings.showStatusBar = this.settings.showStatusBar === false;
    this.saveSettings();
    if (this.isActive) this.applyStatusBarVisibility();
  }

  destroyStatusBar() {
    this.teardownStatusBarListeners();
    this.clearBarAutoHideTimer('status');
    if (this.barAutoHidePointerLock === 'status') this.barAutoHidePointerLock = null;
    if (this.statusPopoverOutsideHandler) {
      document.removeEventListener('pointerdown', this.statusPopoverOutsideHandler, true);
      this.statusPopoverOutsideHandler = null;
    }
    if (this.controlBar) this.controlBar.remove();
    this.controlBar = null;
    this.pageStatusEl = null;
    this.wordCountEl = null;
    this.zoomDisplay = null;
    this.zoomSlider = null;
    this.typeDisplay = null;
    this.paperSizeBtn = null;
    this.pagesBtn = null;
    this.statusPopover = null;
    this.statusPopoverTrigger = null;
  }

  createControlBar() {
    this.controlBar = document.createElement('div');
    this.controlBar.className = 'composition-mode-control-bar';

    // Word's useful grammar is informational state on the left and editing /
    // view controls on the right. This remains Obsidian-native and reuses every
    // existing Composition Mode setting path; no formatting controls are added.
    const left = this.makeEl('div', 'composition-mode-status-left');
    const pageStatusEl = this.makeEl('span', 'composition-mode-page-status');
    this.pageStatusEl = pageStatusEl;
    const separator = this.makeEl('span', 'composition-mode-status-separator');
    separator.textContent = '·';
    const wordCountEl = this.makeEl('span', 'composition-mode-word-count');
    this.wordCountEl = wordCountEl;
    left.append(pageStatusEl, separator, wordCountEl);

    const right = this.makeEl('div', 'composition-mode-status-right');
    const settingsWrap = this.makeEl('div', 'composition-mode-status-settings');
    const settingsBtn = this.makeEl('button', 'composition-mode-btn composition-mode-settings-trigger');
    settingsBtn.type = 'button';
    settingsBtn.textContent = 'Aa';
    settingsBtn.setAttribute('aria-label', 'Document settings');
    settingsBtn.setAttribute('aria-haspopup', 'true');
    settingsBtn.setAttribute('aria-expanded', 'false');
    settingsBtn.setAttribute('title', 'Document settings');
    this.statusPopoverTrigger = settingsBtn;

    // The former wall of document controls now lives in one quiet, transient
    // panel. The controls and their event paths below are intentionally the
    // same ones the status bar used before; only their DOM home changes.
    const settingsPopover = this.makeEl('div', 'composition-mode-status-popover');
    settingsPopover.hidden = true;
    settingsPopover.setAttribute('role', 'dialog');
    settingsPopover.setAttribute('aria-label', 'Document settings');
    this.statusPopover = settingsPopover;

    // Existing type-size controls.
    const typeGroup = this.makeGroup('Type size');
    const typeMinus = this.makeEl('button', 'composition-mode-btn');
    typeMinus.textContent = '−';
    typeMinus.addEventListener('click', () => this.typeSizeBy(-0.5));
    const typeEl = this.makeEl('div', 'composition-mode-type-display');
    this.typeDisplay = typeEl;
    const typePlus = this.makeEl('button', 'composition-mode-btn');
    typePlus.textContent = '+';
    typePlus.addEventListener('click', () => this.typeSizeBy(0.5));
    typeGroup.append(typeMinus, typeEl, typePlus);

    // Paper size toggle
    const paperSizeGroup = this.makeGroup('Paper size');
    const paperSizeBtn = this.makeEl('button', 'composition-mode-btn');
    paperSizeBtn.textContent = (PAPER_SIZES[this.paperSize] || PAPER_SIZES.letter).label;
    this.paperSizeBtn = paperSizeBtn;
    paperSizeBtn.addEventListener('click', () => {
      const paperSizeKeys = Object.keys(PAPER_SIZES);
      const currentIndex = paperSizeKeys.indexOf(this.paperSize);
      const nextIndex = ((currentIndex >= 0 ? currentIndex : 0) + 1) % paperSizeKeys.length;
      this.paperSize = paperSizeKeys[nextIndex];
      this.paperSizeBtn.textContent = (PAPER_SIZES[this.paperSize] || PAPER_SIZES.letter).label;
      this.settings.paperSize = this.paperSize;
      this.saveSettings();
      this.applyStyles();
    });
    paperSizeGroup.appendChild(paperSizeBtn);

    // Pages toggle
    const pagesGroup = this.makeGroup('Page gaps');
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

    // Side margins slider
    const sideMarginGroup = this.makeGroup('Side margin');
    const sideMarginSlider = this.makeSlider(0.25, 2.5, 0.25, this.settings.pageMarginXIn ?? 1.25, (v) => {
      this.settings.pageMarginXIn = v;
      this.saveSettings();
      this.applyStyles();
    });
    sideMarginGroup.appendChild(sideMarginSlider);

    // Top/bottom margins slider
    const topMarginGroup = this.makeGroup('Top / bottom');
    const topMarginSlider = this.makeSlider(0.25, 2, 0.25, this.settings.pageMarginYIn ?? 1.0, (v) => {
      this.settings.pageMarginYIn = v;
      this.saveSettings();
      this.applyStyles();
    });
    topMarginGroup.appendChild(topMarginSlider);

    // Background fade slider
    const fadeGroup = this.makeGroup('Background');
    const fadeSlider = this.makeSlider(0, 100, 5, this.backgroundFade * 100, (v) => {
      this.backgroundFade = v / 100;
      this.applyStyles();
    });
    fadeGroup.appendChild(fadeSlider);

    // Exit button
    const exitBtn = this.makeEl('button', 'composition-mode-btn composition-mode-exit-btn');
    exitBtn.textContent = 'Exit';
    exitBtn.addEventListener('click', () => this.deactivate());

    // Word-style zoom cluster: step buttons, the existing per-note zoom value
    // on a slider, and a tabular readout. All three call the same apply/save
    // path as keyboard, wheel, and gesture zoom.
    const zoomGroup = this.makeGroup('Zoom');
    zoomGroup.classList.add('composition-mode-zoom-group');
    const zoomMinus = this.makeEl('button', 'composition-mode-btn composition-mode-zoom-step');
    zoomMinus.textContent = '−';
    zoomMinus.addEventListener('click', () => this.zoomOut());
    const zoomSlider = this.makeSlider(
      MIN_VISUAL_ZOOM,
      MAX_VISUAL_ZOOM,
      0.1,
      this.currentZoom,
      (value) => {
        this.currentZoom = this.clampZoom(value);
        this.applyStyles();
        this.saveZoomLevel();
      }
    );
    zoomSlider.classList.add('composition-mode-zoom-slider');
    this.zoomSlider = zoomSlider;
    const zoomPlus = this.makeEl('button', 'composition-mode-btn composition-mode-zoom-step');
    zoomPlus.textContent = '+';
    zoomPlus.addEventListener('click', () => this.zoomIn());
    const zoomEl = this.makeEl('div', 'composition-mode-zoom-display');
    this.zoomDisplay = zoomEl;
    zoomGroup.append(zoomMinus, zoomSlider, zoomPlus, zoomEl);

    settingsPopover.append(typeGroup, paperSizeGroup, pagesGroup, sideMarginGroup, topMarginGroup, fadeGroup);
    settingsWrap.append(settingsBtn, settingsPopover);
    settingsBtn.addEventListener('click', () => this.toggleStatusPopover());

    // Word's calm grammar: document status owns the left; the right is only
    // document settings, zoom, then the unambiguous way out.
    right.append(settingsWrap, zoomGroup, exitBtn);
    this.controlBar.append(left, right);
    document.body.appendChild(this.controlBar);
    this.updateEditorPaneBounds();
    this.setBarAutoHideVisible('status', this.barAutoHideStatusVisible !== false);

    this.statusPopoverOutsideHandler = (event) => {
      if (!this.statusPopover || this.statusPopover.hidden) return;
      if (this.statusPopover.contains(event.target) || this.statusPopoverTrigger?.contains(event.target)) return;
      this.closeStatusPopover();
    };
    document.addEventListener('pointerdown', this.statusPopoverOutsideHandler, true);

    this.updateZoomDisplay();
    this.updateTypeDisplay();
    this.updateWordCount();
    this.updatePageStatus();
  }

  toggleStatusPopover() {
    if (!this.statusPopover || !this.statusPopoverTrigger) return;
    if (this.statusPopover.hidden) {
      this.statusPopover.hidden = false;
      this.statusPopoverTrigger.setAttribute('aria-expanded', 'true');
      this.clearBarAutoHideTimer('status');
      this.setBarAutoHideVisible('status', true);
    } else {
      this.closeStatusPopover();
    }
  }

  closeStatusPopover() {
    if (!this.statusPopover) return;
    this.statusPopover.hidden = true;
    this.statusPopoverTrigger?.setAttribute('aria-expanded', 'false');
    this.refreshBarAutoHideForPointer();
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
      const elements = this.getActiveCompositionElements();
      const hasFrontmatter = !!(
        elements.activeView?.file &&
        this.app.metadataCache.getFileCache(elements.activeView.file)?.frontmatter
      );
      const suppressFrontmatter =
        !!elements.sourceView?.classList?.contains('is-live-preview') &&
        hasFrontmatter;
      const words = countDocumentWords(text, suppressFrontmatter);
      this.wordCountEl.textContent = `${words.toLocaleString()} words`;
    }
  }

  scheduleStatusWordCountUpdate(delay = 120) {
    if (!this.isActive || this.settings.showStatusBar === false || !this.controlBar) return;
    if (this.statusWordCountTimer) clearTimeout(this.statusWordCountTimer);
    this.statusWordCountTimer = setTimeout(() => {
      this.statusWordCountTimer = null;
      this.updateWordCount();
    }, delay);
  }

  setupStatusBarListeners() {
    if (!this.controlBar || this.settings.showStatusBar === false) return;
    const { scroller } = this.getActiveCompositionElements();
    if (this.statusScroller === scroller && this.statusScrollHandler) return;
    this.teardownStatusBarScrollListener();
    if (!scroller) return;

    this.statusScroller = scroller;
    this.statusScrollHandler = () => this.scheduleStatusPageUpdate();
    scroller.addEventListener('scroll', this.statusScrollHandler, { passive: true });
    this.scheduleStatusPageUpdate();
  }

  teardownStatusBarScrollListener() {
    if (this.statusScroller && this.statusScrollHandler) {
      this.statusScroller.removeEventListener('scroll', this.statusScrollHandler);
    }
    this.statusScroller = null;
    this.statusScrollHandler = null;
    if (this.statusPageFrame) {
      cancelAnimationFrame(this.statusPageFrame);
      this.statusPageFrame = null;
    }
  }

  teardownStatusBarListeners() {
    this.teardownStatusBarScrollListener();
    if (this.statusWordCountTimer) {
      clearTimeout(this.statusWordCountTimer);
      this.statusWordCountTimer = null;
    }
  }

  scheduleStatusPageUpdate() {
    if (!this.isActive || this.settings.showStatusBar === false || !this.controlBar) return;
    if (this.statusPageFrame) return;
    this.statusPageFrame = requestAnimationFrame(() => {
      this.statusPageFrame = null;
      this.updatePageStatus();
    });
  }

  updatePageStatus() {
    if (!this.pageStatusEl) return;
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    const editorState = view?.editor?.cm?.state;
    const status = editorState ? paginationStatusByEditorState.get(editorState) : null;
    if (status) {
      pageBreakConfig.pageCount = status.pageCount;
      pageBreakConfig.pageTopBoundaries = status.pageTopBoundaries.slice();
    }
    const tops = pageBreakConfig.pageTopBoundaries || [0];
    const totalPages = Math.max(1, pageBreakConfig.pageCount || tops.length || 1);
    const { scroller } = this.getActiveCompositionElements();
    // `.cm-scroller` is inside the CSS-zoomed paper, but CSSOM scrollTop and
    // clientHeight are reported in the same unscaled layout-space coordinates
    // as the page tops captured by computePageBreaks (the same invariant used
    // for clientWidth in applyStyles/triggerEditors).
    const currentPage = currentPageFromScroll(
      scroller?.scrollTop || 0,
      scroller?.clientHeight || 0,
      tops
    );
    this.pageStatusEl.textContent = `Page ${Math.min(currentPage, totalPages)} of ${totalPages}`;
  }

  updateZoomDisplay() {
    if (this.zoomDisplay) {
      this.zoomDisplay.textContent = `${Math.round(this.currentZoom * 100)}%`;
    }
    if (this.zoomSlider) this.zoomSlider.value = this.currentZoom;
    this.scheduleStatusPageUpdate();
  }

  updateTypeDisplay() {
    if (this.typeDisplay) {
      const fontSizePt = this.clampFontSizePt(this.settings.fontSizePt);
      const label = Number.isInteger(fontSizePt) ? `${fontSizePt}` : `${fontSizePt.toFixed(1)}`;
      this.typeDisplay.textContent = `${label} pt`;
    }
  }

  zoomBy(delta) {
    if (!this.isActive) return;
    this.currentZoom = this.clampZoom((this.currentZoom || 1) + delta);
    this.applyStyles();
    this.saveZoomLevel();
  }

  zoomIn() {
    this.zoomBy(0.1);
  }

  zoomOut() {
    this.zoomBy(-0.1);
  }

  typeSizeBy(delta) {
    if (!this.isActive) return;
    this.settings.fontSizePt = this.clampFontSizePt((this.settings.fontSizePt ?? DEFAULT_SETTINGS.fontSizePt) + delta);
    this.updateTypeDisplay();
    this.applyStyles();
    this.saveSettings();
  }

  setupZoomHandlers() {
    this.zoomHandler = (e) => {
      if (!this.isActive) return;
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        const delta = e.deltaY > 0 ? -0.05 : 0.05;
        this.zoomBy(delta);
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
      this.scheduleEditorPaneBoundsUpdate();
      this.applyStyles();
    };
    window.addEventListener('resize', this.resizeHandler);
    this.app.workspace.on('resize', this.resizeHandler);
    this.updateEditorPaneBounds();
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
        .addOptions(Object.fromEntries(
          Object.entries(PAPER_SIZES).map(([key, def]) => [
            key,
            `${def.label} (${def.width} × ${def.height} in)`
          ])
        ))
        .setValue(this.plugin.settings.paperSize)
        .onChange(async (v) => {
          this.plugin.settings.paperSize = v;
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName('Show page breaks')
      .setDesc('Insert visible gray gaps between pages; long prose paragraphs can split at word boundaries')
      .addToggle(t => t
        .setValue(this.plugin.settings.showPageBreaks)
        .onChange(async (v) => {
          this.plugin.settings.showPageBreaks = v;
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName('Words per page')
      .setDesc('Legacy target used by older pagination. Current page breaks are based on paper size, margins, type size, and measured text height.')
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
      .setName('Image width')
      .setDesc('Width of embedded images as a percentage of the text column. 100% fills the column edge-to-edge; 90% leaves a thin breathing margin. Individual images can still be overridden with ![[img.jpg|400]] syntax.')
      .addSlider(s => s
        .setLimits(50, 100, 5)
        .setValue(this.plugin.settings.imageWidthPct || 100)
        .setDynamicTooltip()
        .onChange(async (v) => {
          this.plugin.settings.imageWidthPct = v;
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName('Type size (points)')
      .setDesc('Body text size in typographic points. Typical manuscript text is 12 pt; printed book interiors often land around 10–11 pt.')
      .addSlider(s => s
        .setLimits(MIN_FONT_SIZE_PT, MAX_FONT_SIZE_PT, 0.5)
        .setValue(this.plugin.settings.fontSizePt ?? DEFAULT_SETTINGS.fontSizePt)
        .setDynamicTooltip()
        .onChange(async (v) => {
          this.plugin.settings.fontSizePt = this.plugin.clampFontSizePt(v);
          await this.plugin.saveSettings();
          if (this.plugin.isActive) this.plugin.applyStyles();
        }));

    new Setting(containerEl)
      .setName('Side margin (inches)')
      .setDesc('Left/right margin between paper edge and text column. On small book trims, the plugin caps this to preserve a readable text block.')
      .addSlider(s => s
        .setLimits(0.5, 2.5, 0.05)
        .setValue(this.plugin.settings.pageMarginXIn ?? 1.25)
        .setDynamicTooltip()
        .onChange(async (v) => {
          this.plugin.settings.pageMarginXIn = v;
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName('Top/bottom margin (inches)')
      .setDesc('Vertical margin above and below the text on each page. On small book trims, the plugin caps this to preserve usable page depth.')
      .addSlider(s => s
        .setLimits(0.5, 2.0, 0.05)
        .setValue(this.plugin.settings.pageMarginYIn ?? 1.0)
        .setDynamicTooltip()
        .onChange(async (v) => {
          this.plugin.settings.pageMarginYIn = v;
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName('Max paper width (px)')
      .setDesc('Absolute cap on paper width in pixels. Prevents the page from growing too wide on large external monitors. Typical values: 1100–1600.')
      .addSlider(s => s
        .setLimits(800, 2400, 50)
        .setValue(this.plugin.settings.maxPaperWidthPx || 1400)
        .setDynamicTooltip()
        .onChange(async (v) => {
          this.plugin.settings.maxPaperWidthPx = v;
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
      .setName('Show status bar')
      .setDesc('Show page position, live word count, document controls, and zoom at the bottom of Composition Mode.')
      .addToggle(t => t
        .setValue(this.plugin.settings.showStatusBar !== false)
        .onChange(async (v) => {
          this.plugin.settings.showStatusBar = v;
          await this.plugin.saveSettings();
          if (this.plugin.isActive) this.plugin.applyStatusBarVisibility();
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

// Test seam: expose pure pagination helpers without changing plugin runtime
// behavior or introducing a production dependency on a test framework.
CompositionModePlugin.__testables = {
  makeMeasurer,
  estimateParagraphHeight,
  estimateTextHeight,
  findTextOffsetForVisualLines,
  chooseReadableSplitOffset,
  findMidParagraphSplit,
  extractImageKey,
  currentPageFromScroll,
  countDocumentWords
};

module.exports = CompositionModePlugin;

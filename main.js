'use strict';

// 外部依存なし。'obsidian' モジュールは Obsidian 本体が実行時に提供する。
const { Plugin, Scope, setIcon } = require('obsidian');

// Obsidian 標準の画像ライトボックスに合わせた設定値
const ANIM_DURATION = 200;
const ANIM_ZOOM_DURATION = 250;
const ANIM_EASING = 'cubic-bezier(0.4, 0, 0.22, 1)';
const BG_OPACITY = '0.9';
const MIN_ZOOM = 1;
const MAX_ZOOM = 10;
const DOUBLE_CLICK_ZOOM = 2.5;
const KEY_ZOOM_STEP = 1.2;

// 図を画面にフィットさせるときの余白（上下は閉じるボタンと重ならない幅を確保）
const FIT_MARGIN_X = 16;
const FIT_MARGIN_Y = 48;

// 複製した SVG から取り除く要素（スクリプトや外部コンテンツの埋め込み）
const BLOCKED_TAGS = new Set(['script', 'iframe', 'object', 'embed', 'frame', 'frameset', 'base', 'meta', 'link']);

let cloneCounter = 0;

function createDiv(parent, cls) {
  const el = parent.ownerDocument.createElement('div');
  el.className = cls;
  parent.appendChild(el);
  return el;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function escapeRegExp(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function isJavaScriptUrl(value) {
  // ブラウザは URL 中の制御文字・空白を無視するため、取り除いてから判定する
  return /^(javascript|vbscript):/i.test(value.replace(/[\u0000- \u007f]/g, ''));
}

/**
 * 表示用に複製した SVG を安全な状態にする。
 * - スクリプトや埋め込み要素、イベントハンドラ属性、javascript: URL を除去
 * - 拡大画面は閲覧専用のため、リンクは無効化
 */
function sanitizeSvg(svg) {
  for (const el of [svg, ...svg.querySelectorAll('*')]) {
    if (BLOCKED_TAGS.has(el.localName.toLowerCase())) {
      el.remove();
      continue;
    }
    const isLink = el.localName.toLowerCase() === 'a';
    for (const attr of [...el.attributes]) {
      const name = attr.name.toLowerCase();
      const isHref = name === 'href' || name === 'xlink:href';
      if (name.startsWith('on') || (isHref && (isLink || isJavaScriptUrl(attr.value)))) {
        el.removeAttribute(attr.name);
      }
    }
  }
}

/**
 * 複製で文書内に同じ id が 2 つできないよう、id とその参照をすべて振り直す。
 * （矢印マーカーやスタイルが元の図の要素を参照してしまうのを防ぐ）
 */
function uniquifyIds(svg) {
  const suffix = `-mermaid-lightbox-${++cloneCounter}`;
  const idMap = new Map();
  for (const el of [svg, ...svg.querySelectorAll('[id]')]) {
    if (!el.id) continue;
    idMap.set(el.id, el.id + suffix);
    el.id = el.id + suffix;
  }
  if (idMap.size === 0) return;

  const renameRef = (id) => idMap.get(id) || id;
  const urlRef = /url\(\s*(['"]?)#([^'")\s]+)\1\s*\)/g;
  const idRefAttrs = new Set(['aria-labelledby', 'aria-describedby', 'aria-controls', 'aria-owns']);

  for (const el of [svg, ...svg.querySelectorAll('*')]) {
    for (const attr of [...el.attributes]) {
      const name = attr.name.toLowerCase();
      const value = attr.value;
      let next = value;
      if ((name === 'href' || name === 'xlink:href') && value.startsWith('#')) {
        next = '#' + renameRef(value.slice(1));
      } else if (idRefAttrs.has(name)) {
        next = value.split(/\s+/).map(renameRef).join(' ');
      } else if (value.includes('url(')) {
        next = value.replace(urlRef, (m, q, id) => (idMap.has(id) ? `url(${q}#${idMap.get(id)}${q})` : m));
      }
      if (next !== value) el.setAttribute(attr.name, next);
    }
  }

  // <style> 内の #id セレクタと url(#id) を置き換える（長い id から順に照合）
  const ids = [...idMap.keys()].sort((a, b) => b.length - a.length).map(escapeRegExp);
  const selectorRef = new RegExp(`#(${ids.join('|')})(?![\\w-])`, 'g');
  for (const style of svg.querySelectorAll('style')) {
    style.textContent = style.textContent.replace(selectorRef, (m, id) => '#' + idMap.get(id));
  }
}

class MermaidLightbox {
  constructor(app, sourceSvg, onClose) {
    this.app = app;
    this.sourceSvg = sourceSvg;
    this.onCloseCallback = onClose;
    this.doc = sourceSvg.ownerDocument;
    this.win = this.doc.defaultView;
    this.zoom = 1;
    this.panX = 0;
    this.panY = 0;
    this.pointers = new Map();
    this.drag = null;
    this.pinch = null;
    this.suppressClick = false;
    this.isOpen = false;
    this.previousFocus = null;
    this.onResize = () => this.fit();
    this.build();
  }

  // Obsidian の画像ライトボックスと同じ DOM 構造・クラス名で組み立てる
  build() {
    const containerEl = this.containerEl = this.doc.createElement('div');
    containerEl.className = 'lightbox mermaid-lightbox';
    containerEl.tabIndex = -1;
    containerEl.setAttribute('role', 'dialog');
    containerEl.setAttribute('aria-modal', 'true');
    containerEl.setAttribute('aria-label', 'Mermaid diagram');

    this.bgEl = createDiv(containerEl, 'lightbox-bg');
    const viewerEl = createDiv(containerEl, 'lightbox-content');
    this.mediaEl = createDiv(viewerEl, 'lightbox-media');
    const wrapperEl = createDiv(this.mediaEl, 'media-wrapper');
    this.titlebarEl = createDiv(containerEl, 'lightbox-titlebar');
    createDiv(this.titlebarEl, 'lightbox-titlebar-text');

    const closeEl = createDiv(containerEl, 'modal-close-button mod-raised clickable-icon');
    closeEl.setAttribute('role', 'button');
    closeEl.setAttribute('aria-label', 'Close');
    setIcon(closeEl, 'x');
    closeEl.addEventListener('click', () => this.close());

    // ダークテーマでは Obsidian が `.mermaid > svg` に色反転フィルタをかけるため、
    // 同じ見た目になるよう `.mermaid` の直下に置く
    this.surfaceEl = createDiv(wrapperEl, 'mermaid mermaid-lightbox-surface');

    // innerHTML は使わず、描画済み SVG を DOM ごと複製してから無害化する
    const svg = this.svg = this.sourceSvg.cloneNode(true);
    sanitizeSvg(svg);
    uniquifyIds(svg);
    svg.removeAttribute('width');
    svg.removeAttribute('height');
    svg.removeAttribute('style');
    svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
    if (!svg.getAttribute('viewBox')) {
      try {
        const box = this.sourceSvg.getBBox();
        svg.setAttribute('viewBox', `${box.x} ${box.y} ${box.width} ${box.height}`);
      } catch (e) {
        // 取得できない場合は表示サイズから縦横比を求める
      }
    }
    this.surfaceEl.appendChild(svg);

    this.mediaEl.addEventListener('click', (evt) => this.handleClick(evt));
    this.mediaEl.addEventListener('wheel', (evt) => this.handleWheel(evt), { passive: false });
    this.mediaEl.addEventListener('pointerdown', (evt) => this.handlePointerDown(evt));
    this.mediaEl.addEventListener('pointermove', (evt) => this.handlePointerMove(evt));
    this.mediaEl.addEventListener('pointerup', (evt) => this.handlePointerUp(evt));
    this.mediaEl.addEventListener('pointercancel', (evt) => this.handlePointerUp(evt));
    this.mediaEl.addEventListener('lostpointercapture', (evt) => this.handlePointerUp(evt));
    this.surfaceEl.addEventListener('dblclick', (evt) => this.handleDoubleClick(evt));
  }

  get animationsEnabled() {
    return !this.win.matchMedia('(prefers-reduced-motion: reduce)').matches;
  }

  open() {
    this.previousFocus = this.doc.activeElement;
    this.doc.body.appendChild(this.containerEl);
    this.containerEl.focus({ preventScroll: true });
    this.isOpen = true;

    this.scope = new Scope(this.app.scope);
    this.scope.register([], 'Escape', () => { this.close(); return false; });
    this.scope.register([], '=', () => { this.zoomByKey(KEY_ZOOM_STEP); return false; });
    this.scope.register([], '-', () => { this.zoomByKey(1 / KEY_ZOOM_STEP); return false; });
    this.app.keymap.pushScope(this.scope);
    this.win.addEventListener('resize', this.onResize);

    this.fit();
    this.bgEl.style.opacity = BG_OPACITY;

    // 元の図の位置から拡大するアニメーション
    const from = this.animationsEnabled ? this.getSourceTransform(true) : null;
    if (!from) return;
    const to = this.surfaceEl.style.transform;
    const timing = { duration: ANIM_DURATION, easing: ANIM_EASING };
    this.surfaceEl.animate([{ transform: from }, { transform: to }], timing);
    this.bgEl.animate([{ opacity: 0 }, { opacity: BG_OPACITY }], timing);
    this.titlebarEl.animate([{ opacity: 0 }, { opacity: 1 }], timing);
  }

  close(immediate = false) {
    if (!this.isOpen) return;
    this.isOpen = false;
    this.app.keymap.popScope(this.scope);
    this.win.removeEventListener('resize', this.onResize);
    this.doc.body.classList.remove('is-grabbing');
    if (this.previousFocus && this.previousFocus.isConnected) {
      this.previousFocus.focus({ preventScroll: true });
    }
    if (this.onCloseCallback) this.onCloseCallback(this);

    // 拡大していない場合のみ、元の図の位置へ戻るアニメーション（Obsidian と同じ挙動）
    const to = !immediate && this.animationsEnabled && this.zoom === 1
      ? this.getSourceTransform(false)
      : null;
    if (!to) {
      this.containerEl.remove();
      return;
    }
    const timing = { duration: ANIM_DURATION, easing: ANIM_EASING, fill: 'forwards' };
    const from = this.surfaceEl.style.transform;
    this.containerEl.style.pointerEvents = 'none';
    this.bgEl.animate([{ opacity: BG_OPACITY }, { opacity: 0 }], timing);
    this.titlebarEl.animate([{ opacity: 1 }, { opacity: 0 }], timing);
    this.surfaceEl.animate([{ transform: from }, { transform: to }], timing)
      .addEventListener('finish', () => this.containerEl.remove());
  }

  // 元の図と拡大後の図の位置・大きさの差分を transform で表す
  getSourceTransform(opening) {
    if (!this.sourceSvg.isConnected) return null;
    const src = this.sourceSvg.getBoundingClientRect();
    const dst = this.svg.getBoundingClientRect();
    if (!src.width || !src.height || !dst.width || !dst.height) return null;
    const scale = opening
      ? Math.max(src.width / dst.width, src.height / dst.height)
      : Math.min(src.width / dst.width, src.height / dst.height);
    const dx = src.left + src.width / 2 - (dst.left + dst.width / 2);
    const dy = src.top + src.height / 2 - (dst.top + dst.height / 2);
    return `translate(${dx}px, ${dy}px) scale(${scale})`;
  }

  // 縦横比を保ったまま画面いっぱいに収まるサイズを SVG に設定する
  fit() {
    const vb = this.svg.viewBox && this.svg.viewBox.baseVal;
    let w = vb && vb.width;
    let h = vb && vb.height;
    if (!w || !h) {
      const rect = this.sourceSvg.getBoundingClientRect();
      w = rect.width || 1;
      h = rect.height || 1;
    }
    const style = this.win.getComputedStyle(this.surfaceEl);
    const padX = parseFloat(style.paddingLeft) + parseFloat(style.paddingRight);
    const padY = parseFloat(style.paddingTop) + parseFloat(style.paddingBottom);
    const availW = this.mediaEl.clientWidth - FIT_MARGIN_X * 2 - padX;
    const availH = this.mediaEl.clientHeight - FIT_MARGIN_Y * 2 - padY;
    const scale = Math.max(0, Math.min(availW / w, availH / h));
    this.svg.style.width = `${w * scale}px`;
    this.svg.style.height = `${h * scale}px`;
    this.apply();
  }

  apply() {
    this.clampPan();
    this.containerEl.classList.toggle('is-zoomed', this.zoom > 1);
    this.surfaceEl.style.transform = `translate(${this.panX}px, ${this.panY}px) scale(${this.zoom})`;
  }

  // 図が画面外へ行き過ぎないよう移動量を制限する
  clampPan() {
    const maxX = Math.max(0, (this.surfaceEl.offsetWidth * this.zoom - this.mediaEl.clientWidth) / 2);
    const maxY = Math.max(0, (this.surfaceEl.offsetHeight * this.zoom - this.mediaEl.clientHeight) / 2);
    this.panX = clamp(this.panX, -maxX, maxX);
    this.panY = clamp(this.panY, -maxY, maxY);
  }

  // 指定した画面座標を中心にズームする
  zoomAt(clientX, clientY, nextZoom) {
    const next = clamp(nextZoom, MIN_ZOOM, MAX_ZOOM);
    const rect = this.mediaEl.getBoundingClientRect();
    const ax = clientX - rect.left - rect.width / 2;
    const ay = clientY - rect.top - rect.height / 2;
    const ratio = next / this.zoom;
    this.panX = (this.panX - ax) * ratio + ax;
    this.panY = (this.panY - ay) * ratio + ay;
    this.zoom = next;
    if (this.zoom <= 1) {
      this.panX = 0;
      this.panY = 0;
    }
    this.apply();
  }

  zoomByKey(factor) {
    const rect = this.mediaEl.getBoundingClientRect();
    this.zoomAt(rect.left + rect.width / 2, rect.top + rect.height / 2, this.zoom * factor);
  }

  animateTo(zoom, panX, panY) {
    const from = this.surfaceEl.style.transform;
    this.zoom = zoom;
    this.panX = panX;
    this.panY = panY;
    this.apply();
    if (!this.animationsEnabled) return;
    const to = this.surfaceEl.style.transform;
    this.surfaceEl.animate([{ transform: from }, { transform: to }],
      { duration: ANIM_ZOOM_DURATION, easing: ANIM_EASING });
  }

  handleClick(evt) {
    // 図の外（背景）をクリックしたら閉じる。ドラッグ直後のクリックは無視する
    if (this.suppressClick) {
      this.suppressClick = false;
      return;
    }
    if (this.surfaceEl.contains(evt.target)) return;
    this.close();
  }

  handleWheel(evt) {
    evt.preventDefault();
    let delta = evt.deltaY;
    if (evt.deltaMode === 1) delta *= 40;
    else if (evt.deltaMode === 2) delta *= 800;
    // トラックパッドのピンチ（ctrl+wheel、小さな delta）は感度を上げる。
    // Windows の Ctrl+マウスホイール（大きな delta）は通常のホイールと同じ感度にする
    const isPinch = evt.ctrlKey && Math.abs(delta) < 50;
    const factor = Math.exp(-delta * (isPinch ? 0.01 : 0.002));
    this.zoomAt(evt.clientX, evt.clientY, this.zoom * factor);
  }

  handleDoubleClick(evt) {
    if (this.zoom > 1) {
      this.animateTo(1, 0, 0);
      return;
    }
    // クリックした位置を中心に拡大する
    const rect = this.mediaEl.getBoundingClientRect();
    const ox = (evt.clientX - rect.left - rect.width / 2 - this.panX) / this.zoom;
    const oy = (evt.clientY - rect.top - rect.height / 2 - this.panY) / this.zoom;
    this.animateTo(DOUBLE_CLICK_ZOOM, -ox * DOUBLE_CLICK_ZOOM, -oy * DOUBLE_CLICK_ZOOM);
  }

  handlePointerDown(evt) {
    if (evt.pointerType === 'mouse' && evt.button !== 0) return;
    const onSurface = this.surfaceEl.contains(evt.target);
    if (!onSurface && this.pointers.size === 0) return;

    if (this.pointers.size === 0) this.suppressClick = false;
    this.pointers.set(evt.pointerId, { x: evt.clientX, y: evt.clientY });
    // 図にキャプチャすることで、図上のクリック／ダブルクリックが背景扱いにならないようにする
    this.surfaceEl.setPointerCapture(evt.pointerId);

    if (this.pointers.size === 2) {
      // 2本指のピンチ操作
      const [a, b] = [...this.pointers.values()];
      this.drag = null;
      this.pinch = {
        dist: Math.hypot(a.x - b.x, a.y - b.y) || 1,
        zoom: this.zoom,
        cx: (a.x + b.x) / 2,
        cy: (a.y + b.y) / 2,
      };
    } else if (this.pointers.size === 1 && this.zoom > 1) {
      // 拡大中のみドラッグで移動できる（Obsidian と同じ挙動）
      this.drag = { x: evt.clientX, y: evt.clientY, startX: evt.clientX, startY: evt.clientY };
      if (evt.pointerType === 'mouse') this.doc.body.classList.add('is-grabbing');
    }
  }

  handlePointerMove(evt) {
    if (!this.pointers.has(evt.pointerId)) return;
    this.pointers.set(evt.pointerId, { x: evt.clientX, y: evt.clientY });

    if (this.pinch && this.pointers.size === 2) {
      const [a, b] = [...this.pointers.values()];
      const cx = (a.x + b.x) / 2;
      const cy = (a.y + b.y) / 2;
      const dist = Math.hypot(a.x - b.x, a.y - b.y);
      this.panX += cx - this.pinch.cx;
      this.panY += cy - this.pinch.cy;
      this.pinch.cx = cx;
      this.pinch.cy = cy;
      this.suppressClick = true;
      this.zoomAt(cx, cy, this.pinch.zoom * dist / this.pinch.dist);
    } else if (this.drag) {
      this.panX += evt.clientX - this.drag.x;
      this.panY += evt.clientY - this.drag.y;
      this.drag.x = evt.clientX;
      this.drag.y = evt.clientY;
      if (Math.hypot(evt.clientX - this.drag.startX, evt.clientY - this.drag.startY) > 3) {
        this.suppressClick = true;
      }
      this.apply();
    }
  }

  handlePointerUp(evt) {
    if (!this.pointers.delete(evt.pointerId)) return;
    if (this.pointers.size < 2) this.pinch = null;
    if (this.pointers.size === 0) {
      this.drag = null;
      this.doc.body.classList.remove('is-grabbing');
    }
  }
}

module.exports = class MermaidLightboxPlugin extends Plugin {
  onload() {
    this.activeLightbox = null;
    this.handledDocs = new WeakSet();

    // Mermaid は非同期で描画されるため、ドキュメント全体でのイベント委譲で拾う
    this.watchDocument(document);

    // 有効化前から開いていたポップアウトウィンドウと、今後開くウィンドウにも登録する
    this.app.workspace.onLayoutReady(() => {
      this.app.workspace.iterateAllLeaves((leaf) => {
        this.watchDocument(leaf.view.containerEl.ownerDocument);
      });
    });
    this.registerEvent(
      this.app.workspace.on('window-open', (_workspaceWindow, win) => {
        this.watchDocument(win.document);
      })
    );
  }

  onunload() {
    // 拡大表示中に無効化された場合も、画面やキー操作の状態を残さない
    if (this.activeLightbox) this.activeLightbox.close(true);
  }

  watchDocument(doc) {
    if (!doc || this.handledDocs.has(doc)) return;
    this.handledDocs.add(doc);
    this.registerDomEvent(doc, 'click', (evt) => this.onClick(evt));
  }

  onClick(evt) {
    if (this.activeLightbox) return;

    const target = evt.target;
    if (!target || typeof target.closest !== 'function') return;

    // 図中のリンク（Mermaid の click 指定や内部リンク）は通常どおり動作させる
    if (target.closest('a')) return;

    const container = target.closest('.mermaid');
    if (!container) return;

    // リーディングビューのみ対象（ライブプレビュー／ソースモード、拡大表示中は除外）
    if (!container.closest('.markdown-reading-view')) return;
    if (container.closest('.markdown-source-view')) return;
    if (container.closest('.mermaid-lightbox')) return;

    const svg = container.querySelector('svg');
    if (!svg) return;

    evt.preventDefault();
    this.activeLightbox = new MermaidLightbox(this.app, svg, (lightbox) => {
      if (this.activeLightbox === lightbox) this.activeLightbox = null;
    });
    this.activeLightbox.open();
  }
};

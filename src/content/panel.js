/**
 * The in-player control.
 *
 * Deliberately almost invisible: a small pill in the corner that follows the
 * player's own auto-hide behaviour, appearing when the pointer moves and
 * fading out with the rest of the chrome. It only opens into a real panel when
 * clicked, and it never covers the middle of the picture.
 *
 * Lives in a shadow root attached to `#movie_player`, so it survives
 * fullscreen and cannot collide with YouTube's stylesheet in either direction.
 */
(() => {
  'use strict';

  const YD = (globalThis.YD = globalThis.YD || {});
  if (YD.panel) return;

  const STYLE = `
    :host { all: initial; }

    .root {
      position: absolute; top: 8px; right: 8px; z-index: 59;
      direction: rtl;
      font-family: "Segoe UI", Tahoma, system-ui, sans-serif;
      opacity: 0; visibility: hidden;
      transition: opacity .2s ease, visibility .2s ease;
    }
    /* Follows the player: visible while the controls are, plus whenever the
       panel itself is open or hovered. */
    .root.reveal, .root.open, .root:hover {
      opacity: 1; visibility: visible;
    }

    /* ---------------- collapsed pill ---------------- */
    .pill {
      display: flex; align-items: center; gap: 6px;
      height: 26px; padding: 0 9px;
      border-radius: 13px; cursor: pointer;
      background: rgba(0,0,0,.55);
      border: 1px solid rgba(255,255,255,.14);
      color: #f1f1f1; font-size: 11px; font-weight: 600;
      line-height: 1; white-space: nowrap;
      backdrop-filter: blur(6px);
      transition: background .15s;
      user-select: none;
    }
    .pill:hover { background: rgba(0,0,0,.78); }
    .root.open .pill { display: none; }

    .dot {
      width: 6px; height: 6px; border-radius: 50%;
      background: #9aa0a6; flex: none;
    }
    .dot.on   { background: #22c55e; box-shadow: 0 0 6px #22c55e99; }
    .dot.busy { background: #eab308; animation: pulse 1s infinite; }
    .dot.err  { background: #ef4444; }
    @keyframes pulse { 50% { opacity: .3 } }

    .pill .label { letter-spacing: .2px; }

    /* ---------------- expanded panel ---------------- */
    .card {
      display: none;
      width: 232px; padding: 10px;
      border-radius: 11px;
      background: rgba(16,16,18,.93);
      border: 1px solid rgba(255,255,255,.12);
      box-shadow: 0 6px 22px rgba(0,0,0,.5);
      backdrop-filter: blur(10px);
      color: #ececf1;
    }
    .root.open .card { display: block; }

    .head {
      display: flex; align-items: center; gap: 7px;
      margin-bottom: 9px; font-size: 11.5px; font-weight: 600;
    }
    .head .title { flex: 1; }
    .close {
      all: unset; cursor: pointer; color: #b0b0b8;
      font-size: 15px; line-height: 1; padding: 0 3px; border-radius: 4px;
    }
    .close:hover { background: rgba(255,255,255,.12); color: #fff; }

    button.go {
      all: unset; box-sizing: border-box; display: block; width: 100%;
      text-align: center; padding: 7px 0; border-radius: 8px;
      font-size: 12px; font-weight: 600; cursor: pointer;
      background: #7c5cff; color: #fff; transition: background .15s;
    }
    button.go:hover { background: #6b48ff; }
    button.go.stop { background: #3a3a42; }
    button.go.stop:hover { background: #4c4c56; }
    button.go[disabled] { opacity: .5; cursor: default; }

    .bar { height: 2px; border-radius: 2px; margin-top: 8px;
           background: rgba(255,255,255,.13); overflow: hidden; }
    .bar > i { display: block; height: 100%; width: 0; background: #7c5cff;
               transition: width .2s; }

    .status { margin-top: 7px; font-size: 10.5px; line-height: 1.6; color: #a8a8b2; }
    .status.err { color: #fca5a5; }

    .cue {
      display: none; margin-top: 7px; padding: 6px 7px;
      font-size: 11.5px; line-height: 1.7; color: #e6e6ec;
      background: rgba(255,255,255,.06); border-radius: 7px;
      max-height: 60px; overflow: hidden;
    }
    .cue.show { display: block; }

    .row { display: flex; align-items: center; gap: 7px;
           margin-top: 8px; font-size: 10.5px; color: #a8a8b2; }
    .row input[type=range] { all: revert; flex: 1; min-width: 0; }
    .row .val { flex: 0 0 26px; text-align: center; font-variant-numeric: tabular-nums; }

    a.link { display: inline-block; margin-top: 8px;
             color: #a5a1ff; font-size: 10.5px; text-decoration: none; }
    a.link:hover { text-decoration: underline; }

    .ease { margin-top: 6px; font-size: 10px; color: #fbbf24; display: none; }
    .ease.show { display: block; }
  `;

  const create = ({ onToggle, onOpenOptions, onRateChange }) => {
    const host = document.createElement('div');
    host.id = 'ytdub-panel-host';
    host.style.cssText = 'position:absolute;inset:0;pointer-events:none;';

    const shadow = host.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = STYLE;

    const root = document.createElement('div');
    root.className = 'root';
    root.style.pointerEvents = 'auto';
    root.innerHTML = `
      <div class="pill" title="دوبله فارسی — Shift+D">
        <span class="dot"></span><span class="label">دوبله</span>
      </div>
      <div class="card">
        <div class="head">
          <span class="dot"></span>
          <span class="title">دوبله فارسی</span>
          <button class="close" title="بستن">×</button>
        </div>
        <button class="go">شروع</button>
        <div class="bar"><i></i></div>
        <div class="status">آماده</div>
        <div class="ease">تصویر کمی آرام‌تر شد تا جمله جا شود</div>
        <div class="cue"></div>
        <div class="row">
          <span>سرعت</span>
          <input type="range" min="0.8" max="1.5" step="0.05" value="1">
          <span class="val">۱</span>
        </div>
        <a class="link" href="#">تنظیمات بیشتر…</a>
      </div>
    `;

    shadow.append(style, root);

    const el = {
      pill: root.querySelector('.pill'),
      dots: root.querySelectorAll('.dot'),
      label: root.querySelector('.pill .label'),
      card: root.querySelector('.card'),
      close: root.querySelector('.close'),
      go: root.querySelector('button.go'),
      bar: root.querySelector('.bar > i'),
      status: root.querySelector('.status'),
      cue: root.querySelector('.cue'),
      ease: root.querySelector('.ease'),
      rate: root.querySelector('input[type=range]'),
      val: root.querySelector('.val'),
      link: root.querySelector('a.link'),
    };

    const setOpen = (open) => root.classList.toggle('open', open);

    el.pill.addEventListener('click', (e) => {
      e.stopPropagation();
      setOpen(true);
    });
    el.close.addEventListener('click', (e) => {
      e.stopPropagation();
      setOpen(false);
    });
    el.go.addEventListener('click', (e) => {
      e.stopPropagation();
      onToggle();
    });
    el.link.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      onOpenOptions();
    });
    el.rate.addEventListener('input', () => {
      const value = Number(el.rate.value);
      el.val.textContent = value.toFixed(2).replace(/\.?0+$/, '');
      onRateChange(value);
    });

    // Clicks inside must not reach the player, or they toggle playback.
    ['click', 'dblclick', 'mousedown', 'keydown'].forEach((type) =>
      root.addEventListener(type, (e) => e.stopPropagation())
    );

    /* ------------------------------------------------------------------ *
     * Auto-hide, tied to the player's own controls
     * ------------------------------------------------------------------ */

    let observer = null;
    let idleTimer = null;

    const reveal = () => {
      root.classList.add('reveal');
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        // Never vanish while the user is actually using it.
        if (!root.classList.contains('open')) root.classList.remove('reveal');
      }, 2600);
    };

    const watchPlayer = (player) => {
      if (observer) observer.disconnect();
      // YouTube marks its own chrome hidden with `ytp-autohide`; matching that
      // keeps the pill in step with the controls instead of fighting them.
      const sync = () => {
        if (player.classList.contains('ytp-autohide')) {
          if (!root.classList.contains('open')) root.classList.remove('reveal');
        } else {
          reveal();
        }
      };
      observer = new MutationObserver(sync);
      observer.observe(player, { attributes: true, attributeFilter: ['class'] });
      player.addEventListener('mousemove', reveal);
      player.addEventListener('mouseleave', () => {
        if (!root.classList.contains('open')) root.classList.remove('reveal');
      });
      sync();
    };

    const api = {
      host,
      mount(player) {
        if (host.parentElement !== player) {
          player.appendChild(host);
          watchPlayer(player);
        }
      },
      remove() {
        if (observer) observer.disconnect();
        observer = null;
        clearTimeout(idleTimer);
        host.remove();
      },
      /** Pop the panel open, e.g. when the hotkey starts a run. */
      open() {
        setOpen(true);
        reveal();
      },
      setVisible(visible) {
        root.style.display = visible ? '' : 'none';
      },
      setState(state) {
        el.dots.forEach((dot) => {
          dot.className = 'dot' + (state ? ' ' + state : '');
        });
        // A run in progress is worth showing even when the controls hide.
        if (state === 'busy' || state === 'err') reveal();
      },
      setStatus(text, isError = false) {
        el.status.textContent = text;
        el.status.classList.toggle('err', !!isError);
      },
      setProgress(fraction) {
        el.bar.style.width = `${Math.round(clamp01(fraction) * 100)}%`;
      },
      setButton(label, { disabled = false, stop = false } = {}) {
        el.go.textContent = label;
        el.go.disabled = disabled;
        el.go.classList.toggle('stop', stop);
        el.label.textContent = stop ? 'دوبله روشن' : 'دوبله';
      },
      setCue(text) {
        el.cue.textContent = text || '';
        el.cue.classList.toggle('show', !!text);
      },
      setEasing(factor) {
        el.ease.classList.toggle('show', factor < 0.995);
      },
      setRate(value) {
        el.rate.value = String(value);
        el.val.textContent = Number(value).toFixed(2).replace(/\.?0+$/, '');
      },
    };

    return api;
  };

  const clamp01 = (value) => (value < 0 ? 0 : value > 1 ? 1 : value);

  YD.panel = { create };
})();

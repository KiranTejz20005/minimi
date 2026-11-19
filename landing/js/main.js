/* Sigil — interactions. No dependencies. */
(() => {
  'use strict';

  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const RM = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const FINE = matchMedia('(hover: hover) and (pointer: fine)').matches;
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  /* Each feature is isolated so one failure never blanks the page. */
  const run = (name, fn) => { try { fn(); } catch (e) { console.error('[sigil:' + name + ']', e); } };

  /* ───────────── Pixel icons ───────────── */
  const ICONS = {
    star: ['+...#...+', '.+..#..+.', '..+...+..', '...###...', '##.###.##', '...###...', '..+...+..', '.+..#..+.', '+...#...+'],
    logo: ['..#####..', '.##...##.', '##..#..##', '#...#...#', '#.#####.#', '#...#...#', '##..#..##', '.##...##.', '..#####..'],
    retrieve: ['.#######.', '#########', '.........', '#########', '.........', '#########', '.........', '#########', '.#######.'],
    tool: ['...###...', '...#.#...', '...#.#...', '####.####', '#.......#', '####.####', '...#.#...', '...#.#...', '...###...'],
    verify: ['#########', '#.......#', '#......##', '##....#.#', '#.#..#..#', '#..##...#', '#.......#', '#.......#', '#########'],
    respond: ['....#....', '...###...', '..#.#.#..', '.#..#..#.', '#...#...#', '....#....', '....#....', '....#....', '....#....'],
    arrow: ['.######', '.....##', '....#.#', '...#..#', '..#...#', '.#....#', '#......'],
    check: ['.......##', '......##.', '##...##..', '.##.##...', '..###....', '...#.....'],
    quote: ['###..###', '###..###', '###..###', '.##...##', '##...##.'],
    right: ['.....#...', '......#..', '.......#.', '#########', '.......#.', '......#..', '.....#...'],
    grid4: ['##.##', '##.##', '.....', '##.##', '##.##'],
    hex: ['..###..', '.#...#.', '#..#..#', '#..#..#', '#..#..#', '.#...#.', '..###..'],
    lines: ['#####..', '.......', '.#####.', '.......', '..#####'],
    parcel: ['#.....#', '##...##', '#######', '#######', '.#####.', '..###..', '...#...'],
  };
  ICONS.left = ICONS.right.map(r => [...r].reverse().join(''));
  const MARK = ['####..##..####', '####..##..####', '##..........##', '##..........##', '......##......', '......##......', '##..######..##', '##..######..##', '......##......', '......##......', '##..........##', '##..........##', '####..##..####', '####..##..####'];

  /* Merge horizontal runs of a bitmap into one path. */
  const pxPath = (rows, ch = '#') => {
    let d = '';
    rows.forEach((r, y) => {
      for (let x = 0; x < r.length; x++) {
        if (r[x] !== ch) continue;
        const s = x;
        while (x < r.length && r[x] === ch) x++;
        d += `M${s} ${y}h${x - s}v1h${s - x}z`;
      }
    });
    return d;
  };

  run('icons', () => {
    $$('svg[data-icon]').forEach(svg => {
      const rows = ICONS[svg.dataset.icon];
      if (!rows) return;
      svg.setAttribute('viewBox', `0 0 ${rows[0].length} ${rows.length}`);
      svg.setAttribute('shape-rendering', 'crispEdges');
      svg.setAttribute('aria-hidden', 'true');
      svg.setAttribute('focusable', 'false');
      const tw = pxPath(rows, '+');
      svg.innerHTML = `<path fill="currentColor" d="${pxPath(rows)}"/>` + (tw ? `<path class="tw" fill="currentColor" d="${tw}"/>` : '');
    });
  });

  /* ───────────── Generated bits: chart bars, meter, avatars ───────────── */
  const hash = s => { let h = 2166136261; for (const c of s) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619); } return h >>> 0; };
  const rng = seed => () => {
    seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  run('generated', () => {
    $$('[data-bars]').forEach(el => {
      const hs = [.32, .4, .36, .5, .44, .58, .52, .66, .6, .72, .64, .8, .7, .86, .78, .92, .84, 1];
      el.innerHTML = hs.map((h, i) => `<i style="--h:${h};--n:${i}"${i >= 14 ? ' class="hot"' : ''}></i>`).join('');
    });
    $$('[data-meter]').forEach(el => {
      const [on, total] = el.dataset.meter.split('/').map(Number);
      el.innerHTML = Array.from({ length: total }, (_, i) => `<i style="--n:${i}"${i < on ? ' class="on"' : ''}></i>`).join('');
    });
    /* Abstract pixel identicons stand in for portraits. */
    $$('[data-avatar]').forEach(el => {
      const r = rng(hash(el.dataset.avatar));
      let d1 = '', d2 = '';
      for (let y = 0; y < 8; y++) for (let x = 0; x < 4; x++) {
        const v = r();
        if (v < .46) continue;
        const cell = `M${x + 1} ${y + 1}h1v1h-1zM${8 - x} ${y + 1}h1v1h-1z`;
        if (v > .86) d2 += cell; else d1 += cell;
      }
      el.innerHTML = `<svg viewBox="0 0 10 10" shape-rendering="crispEdges" aria-hidden="true"><path fill="#1c1c1a" d="${d1}"/><path fill="#8c8c85" d="${d2}"/></svg>`;
    });
  });

  /* ───────────── Split headings into word units ───────────── */
  run('split', () => {
    $$('[data-split]').forEach(root => {
      let i = 0;
      const wrap = () => { const s = document.createElement('span'); s.className = 'w'; s.style.setProperty('--wi', i++); return s; };
      const walk = node => {
        [...node.childNodes].forEach(ch => {
          if (ch.nodeType === 3) {
            const frag = document.createDocumentFragment();
            ch.textContent.split(/(\s+)/).forEach(part => {
              if (!part) return;
              if (/^\s+$/.test(part)) { frag.append(' '); return; }
              const s = wrap(); s.textContent = part; frag.append(s);
            });
            ch.replaceWith(frag);
          } else if (ch.nodeType === 1) {
            if (ch.matches('svg,[data-unit]')) { const s = wrap(); ch.replaceWith(s); s.append(ch); }
            else walk(ch);
          }
        });
      };
      walk(root);
    });
  });

  /* ───────────── Text scramble (pixel words) ───────────── */
  const scramble = (el, delay = 0) => {
    const final = el.textContent;
    const pool = 'abcdefghijklmnopqrstuvwxyz#/+=_<>01';
    const t0 = performance.now() + delay;
    let last = 0;
    const tick = now => {
      const e = now - t0;
      if (e < 0) { requestAnimationFrame(tick); return; }
      if (now - last < 42) { requestAnimationFrame(tick); return; }
      last = now;
      let out = '', done = true;
      for (let i = 0; i < final.length; i++) {
        if (final[i] === ' ' || e >= 240 + i * 70) out += final[i];
        else { done = false; out += pool[(Math.random() * pool.length) | 0]; }
      }
      el.textContent = out;
      if (!done) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  };
  run('scramble', () => {
    if (RM) return;
    $$('[data-scramble]').forEach(el => {
      const host = el.closest('[data-split]');
      if (host) host.addEventListener('reveal', () => scramble(el, +(el.dataset.scrambleDelay || 0) + 200), { once: true });
    });
  });

  /* ───────────── Count-up numbers ───────────── */
  run('count', () => {
    if (RM || !('IntersectionObserver' in window)) return;
    const go = el => {
      const to = parseFloat(el.dataset.to), dec = +(el.dataset.dec || 0);
      const pre = el.dataset.pre || '', suf = el.dataset.suf || '';
      const dur = 1500, t0 = performance.now();
      el.style.display = 'inline-block';
      el.style.minWidth = el.getBoundingClientRect().width + 'px';
      const tick = now => {
        const k = clamp((now - t0) / dur, 0, 1), e = 1 - Math.pow(1 - k, 4);
        el.textContent = pre + (to * e).toFixed(dec) + suf;
        if (k < 1) requestAnimationFrame(tick); else el.style.minWidth = '';
      };
      requestAnimationFrame(tick);
    };
    const io = new IntersectionObserver(es => es.forEach(e => {
      if (e.isIntersecting) { go(e.target); io.unobserve(e.target); }
    }), { threshold: .6 });
    $$('[data-count]').forEach(el => io.observe(el));
  });

  /* ───────────── Header: nav indicator, scroll-spy, mobile menu ───────────── */
  run('nav', () => {
    const nav = $('.nav'), dot = $('.nav-dot'), links = $$('.nav a');
    if (!nav || !links.length) return;
    let active = links.find(a => a.classList.contains('is-active')) || links[0];
    const place = a => {
      if (!nav.offsetWidth) return;
      dot.style.setProperty('--x', a.offsetLeft + a.offsetWidth - 9 + 'px');
      dot.classList.add('is-ready');
    };
    const setActive = a => {
      if (a === active) return;
      active.classList.remove('is-active');
      active = a;
      a.classList.add('is-active');
      place(a);
    };
    links.forEach(a => {
      a.addEventListener('pointerenter', () => place(a));
      a.addEventListener('focus', () => place(a));
    });
    nav.addEventListener('pointerleave', () => place(active));
    nav.addEventListener('focusout', () => place(active));
    addEventListener('resize', () => place(active));
    (document.fonts ? document.fonts.ready : Promise.resolve()).then(() => place(active));
    place(active);

    if ('IntersectionObserver' in window) {
      const map = new Map(links.map(a => [a.getAttribute('href').slice(1), a]));
      const spy = new IntersectionObserver(es => es.forEach(e => {
        const a = map.get(e.target.id);
        if (e.isIntersecting && a) setActive(a);
      }), { rootMargin: '-35% 0px -60% 0px' });
      $$('[data-spy]').forEach(s => spy.observe(s));

      const cur = new IntersectionObserver(es => es.forEach(e => e.target.classList.toggle('is-current', e.isIntersecting)), { rootMargin: '-45% 0px -54% 0px' });
      $$('.row').forEach(r => { if ($('.row-idx', r)) cur.observe(r); });
    }

    const header = $('.site-header'), btn = $('.menu-btn'), label = $('.menu-btn-label');
    const setMenu = open => {
      header.classList.toggle('menu-open', open);
      btn.setAttribute('aria-expanded', String(open));
      label.textContent = open ? 'Close' : 'Menu';
    };
    btn.addEventListener('click', () => setMenu(!header.classList.contains('menu-open')));
    $$('.mobile-menu a').forEach(a => a.addEventListener('click', () => setMenu(false)));
    addEventListener('keydown', e => { if (e.key === 'Escape') setMenu(false); });
    matchMedia('(min-width: 901px)').addEventListener('change', e => { if (e.matches) setMenu(false); });
  });

  /* ───────────── Copy install command ───────────── */
  run('copy', () => {
    const legacyCopy = text => {
      const ta = document.createElement('textarea');
      ta.value = text; ta.setAttribute('readonly', ''); ta.style.cssText = 'position:fixed;top:-99px;opacity:0';
      document.body.append(ta); ta.select();
      let ok = false;
      try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
      ta.remove();
      return ok;
    };
    $$('[data-copy]').forEach(btn => {
      const toast = $('.install-toast', btn);
      let timer;
      btn.addEventListener('click', async () => {
        let ok = false;
        try { await navigator.clipboard.writeText(btn.dataset.copy); ok = true; }
        catch (e) { ok = legacyCopy(btn.dataset.copy); }
        toast.textContent = ok ? 'Copied' : 'Copy blocked — select the text instead';
        btn.classList.toggle('is-copied', ok);
        btn.classList.toggle('is-failed', !ok);
        clearTimeout(timer);
        timer = setTimeout(() => btn.classList.remove('is-copied', 'is-failed'), ok ? 1600 : 3200);
      });
    });
  });

  /* ───────────── Pipeline: run sequence, counter, dithered mound ───────────── */
  run('pipeline', () => {
    const pipe = $('#pipeline');
    if (!pipe) return;
    const cv = $('.mound', pipe), ctx = cv.getContext('2d');
    const nodes = $$('.node', pipe), tEls = nodes.map(n => $('.t', n));
    const base = nodes.map(n => parseFloat(n.dataset.t));
    const decs = nodes.map(n => (n.dataset.t.split('.')[1] || '').length);
    const runsEl = $('#runs');
    const mq = matchMedia('(max-width: 760px)');
    const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];
    let runs = 12408224, cw = 0, dpr = 1, lastW = 0;
    let pulses = [];
    const mouse = { x: .5, y: 0, a: 0, on: false };

    const draw = now => {
      if (!cw) return;
      const t = now / 1000, per = mq.matches ? 6 : 10;
      const px = cw / per * dpr;
      const nc = Math.ceil(cv.width / px), nr = Math.ceil(cv.height / px);
      ctx.clearRect(0, 0, cv.width, cv.height);
      ctx.fillStyle = '#ff4d00';
      const breath = RM ? 0 : .03 * Math.sin(t * .7);
      pulses = pulses.filter(p => now - p < 1700);
      for (let j = 0; j < nr; j++) {
        const yr = (j + .5) / per;
        const y1 = cv.height - Math.round(j * px), y0 = cv.height - Math.round((j + 1) * px);
        for (let i = 0; i < nc; i++) {
          const x = (i + .5) / nc;
          const dx = (x - .485) / .47, dy = yr / 1.6, d = Math.sqrt(dx * dx + dy * dy);
          let v = 1 - d + breath;
          if (!RM) v += .045 * Math.sin(x * 9.4 + t * 1.1) + .035 * Math.sin(x * 21 - t * .8 + yr * 3);
          for (const p of pulses) {
            const a = (now - p) / 1700, q = (d - a * 1.2) / .09;
            v += .16 * (1 - a) * Math.exp(-q * q);
          }
          if (mouse.a > .01) {
            const mx = (x - mouse.x) / .07, my = (yr - mouse.y) / .8;
            v += .55 * mouse.a * Math.exp(-(mx * mx + my * my));
          }
          if (v <= 0) continue;
          if (v * 1.42 > (BAYER[(j & 3) * 4 + (i & 3)] + .5) / 16) {
            const x0 = Math.round(i * px);
            ctx.fillRect(x0, y0, Math.round((i + 1) * px) - x0, y1 - y0);
          }
        }
      }
    };

    /* Snap the grid to whole pixels so every hairline stays crisp. */
    const layout = () => {
      const w = pipe.clientWidth;
      if (!w || w === lastW) return;
      lastW = w;
      const cols = mq.matches ? 8 : 14, rows = mq.matches ? 7 : 5;
      cw = Math.floor(w / cols);
      pipe.style.gridTemplateColumns = `repeat(${cols - 1}, ${cw}px) 1fr`;
      pipe.style.gridTemplateRows = `repeat(${rows}, ${cw}px)`;
      pipe.style.aspectRatio = 'auto';
      pipe.style.height = cw * rows + 'px';
      pipe.style.setProperty('--cw', cw + 'px');
      pipe.style.setProperty('--bgw', cw + 'px');
      pipe.style.setProperty('--bgh', cw + 'px');
      pipe.style.setProperty('--gw', (cols - 1) * cw + 1 + 'px');
      dpr = Math.min(devicePixelRatio || 1, 2);
      cv.style.height = cw * 2 + 'px';
      cv.width = Math.round(w * dpr);
      cv.height = Math.round(cw * 2 * dpr);
      draw(performance.now());
    };
    layout();
    if ('ResizeObserver' in window) new ResizeObserver(layout).observe(pipe);
    else addEventListener('resize', layout);
    mq.addEventListener('change', () => { lastW = 0; layout(); });

    if (RM) return;

    let cur = -1, t0 = 0, dur = 500, val = 0, raf = 0, lastDraw = 0, nextRun = 0;
    const fmt = (v, i) => v.toFixed(decs[i]);
    const step = now => {
      if (cur >= 0) {
        nodes[cur].classList.remove('is-active');
        tEls[cur].textContent = fmt(val, cur);
      }
      if (cur === nodes.length - 1) { cur = -1; t0 = now; dur = 700; return; }
      cur++;
      val = base[cur] * (.9 + Math.random() * .2);
      dur = 520 + val * 430;
      t0 = now;
      nodes[cur].style.setProperty('--dur', dur + 'ms');
      nodes[cur].classList.add('is-active');
      pulses.push(now);
    };
    const frame = now => {
      raf = requestAnimationFrame(frame);
      if (now - t0 >= dur) step(now);
      else if (cur >= 0) tEls[cur].textContent = fmt(val * (now - t0) / dur, cur);
      if (now >= nextRun) {
        runs += 1 + ((Math.random() * 3) | 0);
        runsEl.textContent = runs.toLocaleString('en-US');
        nextRun = now + 280 + Math.random() * 620;
      }
      mouse.a += ((mouse.on ? 1 : 0) - mouse.a) * .1;
      if (now - lastDraw > 33) { lastDraw = now; draw(now); }
    };
    let inView = false;
    const sync = () => {
      const on = inView && !document.hidden;
      if (on && !raf) { t0 = performance.now(); raf = requestAnimationFrame(frame); }
      else if (!on && raf) { cancelAnimationFrame(raf); raf = 0; }
    };
    if ('IntersectionObserver' in window) {
      new IntersectionObserver(es => { inView = es[es.length - 1].isIntersecting; sync(); }).observe(pipe);
    } else { inView = true; sync(); }
    document.addEventListener('visibilitychange', sync);

    if (FINE) {
      pipe.addEventListener('pointermove', e => {
        const r = pipe.getBoundingClientRect();
        mouse.x = (e.clientX - r.left) / r.width;
        mouse.y = Math.min((r.bottom - e.clientY) / cw, 1.5);
        mouse.on = true;
      });
      pipe.addEventListener('pointerleave', () => { mouse.on = false; });
    }
  });

  /* ───────────── Cursor spotlight on dark cells ───────────── */
  run('spot', () => {
    if (!FINE) return;
    $$('.spot').forEach(el => el.addEventListener('pointermove', e => {
      const r = el.getBoundingClientRect();
      el.style.setProperty('--px', e.clientX - r.left + 'px');
      el.style.setProperty('--py', e.clientY - r.top + 'px');
    }));
  });

  /* ───────────── Isometric illustrations ───────────── */
  const C30 = Math.cos(Math.PI / 6);
  const iso = (ox, oy, u) => (x, y, z = 0) => [(ox + (x - y) * C30 * u).toFixed(2), (oy + (x + y) * .5 * u - z * u).toFixed(2)];
  const pts = a => a.map(p => p.join(',')).join(' ');
  const faces = (p, x, y, z, w, d, h) => ({
    top: [p(x, y, z + h), p(x + w, y, z + h), p(x + w, y + d, z + h), p(x, y + d, z + h)],
    left: [p(x, y + d, z + h), p(x + w, y + d, z + h), p(x + w, y + d, z), p(x, y + d, z)],
    right: [p(x + w, y, z + h), p(x + w, y + d, z + h), p(x + w, y + d, z), p(x + w, y, z)],
  });
  const cube = (p, x, y, z, s, attrs, fills, stroke = '') => {
    const f = faces(p, x, y, z, s, s, s);
    const fill = k => (fills ? ` fill="${fills[k]}"` : '');
    return `<g ${attrs}><polygon points="${pts(f.left)}"${fill(1)} ${stroke}/><polygon points="${pts(f.right)}"${fill(2)} ${stroke}/><polygon points="${pts(f.top)}"${fill(0)} ${stroke}/></g>`;
  };
  const isoGrid = (id, u, vx, vy, color) => {
    const w = 2 * C30 * u;
    return `<defs><pattern id="${id}" width="${w.toFixed(3)}" height="${u}" patternUnits="userSpaceOnUse" x="${vx}" y="${vy - u / 2}"><path d="M0 ${u / 2}L${(w / 2).toFixed(3)} 0L${w.toFixed(3)} ${u / 2}L${(w / 2).toFixed(3)} ${u}Z" fill="none" stroke="${color}" stroke-width="1"/></pattern></defs><rect x="-50%" y="-50%" width="200%" height="200%" fill="url(#${id})"/>`;
  };

  run('cubes', () => {
    const svg = $('#iso-cubes');
    if (!svg) return;
    const u = 16, cx = 230, cy = 178, p = iso(cx, cy, u);
    const items = [];
    const edge = 'stroke="#7a7a72" stroke-width="1" stroke-linejoin="round"';
    [[-10.5, 0], [0, -10.5], [10.5, 0], [0, 10.5]].forEach(([x, y], i) => {
      items.push({ z: x + y, html: cube(p, x - 1.5, y - 1.5, 0, 3, `class="cube-big" style="--i:${i}"`, ['#1f1f1d', '#181817', '#131312'], edge) });
    });
    const R = 5.5, offs = [-4.6, -3.5, -2.4, -1.3, 1.3, 2.4, 3.5, 4.6];
    const ring = [
      ...offs.map(o => [o, -R]),
      ...offs.map(o => [R, o]),
      ...[...offs].reverse().map(o => [o, R]),
      ...[...offs].reverse().map(o => [-R, o]),
    ];
    ring.forEach(([x, y], i) => {
      items.push({ z: x + y, html: cube(p, x - .45, y - .45, 0, .9, `class="cube-s" style="--i:${i}"`, null) });
    });
    items.push({
      z: 0,
      html: `<ellipse class="core-glow" cx="${cx}" cy="${cy - 14}" rx="48" ry="32"/>` +
        cube(p, -1.15, -1.15, 0, 2.3, 'class="cube-core"', ['#ff5c16', '#ee4600', '#c63a00'], 'stroke="#ff8348" stroke-width=".8" stroke-linejoin="round"'),
    });
    items.sort((a, b) => a.z - b.z);
    svg.innerHTML = isoGrid('grid-dark', u, cx, cy, '#222220') + items.map(i => i.html).join('');
  });

  run('stack', () => {
    const svg = $('#iso-stack');
    if (!svg) return;
    const u = 25.6, ox = 260, oy = 62, p = iso(ox, oy, u);
    const S = 10, H = 1.65, PITCH = 2.3;
    const line = 'stroke="#111110" stroke-width="1.25" stroke-linejoin="round"';
    let html = isoGrid('grid-light', u, ox, oy, '#e5e5df');
    for (let k = 2; k >= 0; k--) {
      const z = -k * PITCH;
      const f = faces(p, 0, 0, z - H, S, S, H);
      let g = `<polygon points="${pts(f.left)}" fill="#fbfbf8" ${line}/><polygon points="${pts(f.right)}" fill="#e6e6e1" ${line}/><polygon points="${pts(f.top)}" fill="#fff" ${line}/>`;
      [.9, 1.5, 2.1, 2.7].forEach(x => {
        const a = p(x, S, z - .42), b = p(x, S, z - 1.2);
        g += `<line x1="${a[0]}" y1="${a[1]}" x2="${b[0]}" y2="${b[1]}" stroke="#55554f" stroke-width="1.1"/>`;
      });
      const quad = (y0, y1, zt, zb) => pts([p(S, y1, z - zt), p(S, y0, z - zt), p(S, y0, z - zb), p(S, y1, z - zb)]);
      g += `<polygon class="led" style="--k:${k}" points="${quad(8.5, 9.1, .52, 1.17)}" fill="#ff4d00"/>`;
      g += `<polygon points="${quad(7.55, 8.15, .5, 1.15)}" fill="none" stroke="#55554f" stroke-width="1"/>`;
      if (k === 0) {
        [[.95, .95], [9.05, .95], [9.05, 9.05], [.95, 9.05]].forEach(([x, y]) => {
          const c = p(x, y, 0);
          g += `<ellipse cx="${c[0]}" cy="${c[1]}" rx="6.4" ry="3.7" fill="#fff" stroke="#111110" stroke-width="1.1"/>`;
        });
        const c = .34, o = 5 - MARK.length * c / 2;
        let d = '';
        MARK.forEach((r, y) => {
          for (let x = 0; x < r.length; x++) {
            if (r[x] !== '#') continue;
            const s = x;
            while (x < r.length && r[x] === '#') x++;
            const q = [p(o + s * c, o + y * c), p(o + x * c, o + y * c), p(o + x * c, o + (y + 1) * c), p(o + s * c, o + (y + 1) * c)];
            d += 'M' + q.map(v => v.join(' ')).join('L') + 'Z';
          }
        });
        g += `<path d="${d}" fill="#ff4d00"/>`;
      }
      html += `<g class="slab" style="--k:${k}">${g}</g>`;
    }
    svg.innerHTML = html;
  });

  /* ───────────── Code window: type, then deploy ───────────── */
  run('code', () => {
    const win = $('#codewin');
    if (!win || RM || !('IntersectionObserver' in window)) return;
    const status = $('#deploy-status'), st = $('.st', status);
    const chars = [];
    $$('.cl .c', win).forEach((lineEl, line) => {
      const walker = document.createTreeWalker(lineEl, NodeFilter.SHOW_TEXT);
      const texts = [];
      while (walker.nextNode()) texts.push(walker.currentNode);
      texts.forEach(tn => {
        const frag = document.createDocumentFragment();
        for (const c of tn.textContent) {
          const s = document.createElement('span');
          s.className = 'ch'; s.textContent = c;
          frag.append(s);
          chars.push({ el: s, line, space: c === ' ' });
        }
        tn.replaceWith(frag);
      });
    });
    status.dataset.state = 'idle';
    st.textContent = 'Ready';
    const caret = document.createElement('i');
    caret.className = 'caret';
    const type = () => {
      status.dataset.state = 'busy';
      st.textContent = 'Deploying';
      let i = 0, next = performance.now() + 450;
      const tick = now => {
        while (i < chars.length && now >= next) {
          const c = chars[i++];
          c.el.classList.add('on');
          c.el.after(caret);
          const newline = i < chars.length && chars[i].line !== c.line;
          next += newline ? 150 : c.space ? 6 : 9 + Math.random() * 11;
        }
        if (i < chars.length) requestAnimationFrame(tick);
        else setTimeout(() => { caret.remove(); status.dataset.state = 'done'; st.textContent = 'Deployed'; }, 700);
      };
      requestAnimationFrame(tick);
    };
    new IntersectionObserver((es, o) => es.forEach(e => {
      if (e.isIntersecting) { o.disconnect(); type(); }
    }), { threshold: .45 }).observe(win);
  });

  /* ───────────── How it works: auto-advancing steps ───────────── */
  run('steps', () => {
    const root = $('#steps');
    if (!root) return;
    const steps = $$('.step', root);
    let idx = 0;
    const set = i => {
      idx = (i + steps.length) % steps.length;
      steps.forEach((s, k) => s.classList.toggle('is-active', k === idx));
    };
    if (!RM) {
      root.classList.add('is-auto');
      steps.forEach((s, i) => $('.step-bar i', s).addEventListener('animationend', e => {
        if (e.animationName === 'bar-fill') set(i + 1);
      }));
    }
    steps.forEach((s, i) => {
      const pick = () => { if (i !== idx) set(i); };
      s.addEventListener('pointerenter', pick);
      s.addEventListener('focus', pick);
      s.addEventListener('click', pick);
    });
  });

  /* ───────────── Testimonials carousel ───────────── */
  run('carousel', () => {
    const track = $('#t-track');
    if (!track) return;
    const cards = $$('.t-card', track), prev = $('.car-btn.prev'), next = $('.car-btn.next');
    let active = 0, lock = 0, timer;
    const pad = () => parseFloat(getComputedStyle(track).paddingLeft) || 0;
    const maxScroll = () => track.scrollWidth - track.clientWidth;
    const leftOf = c => c.getBoundingClientRect().left - track.getBoundingClientRect().left + track.scrollLeft;
    const paint = () => {
      cards.forEach((c, i) => c.classList.toggle('is-active', i === active));
      prev.disabled = active === 0;
      next.disabled = active === cards.length - 1;
    };
    const go = i => {
      active = clamp(i, 0, cards.length - 1);
      paint();
      lock = performance.now() + 800;
      track.scrollTo({ left: Math.min(leftOf(cards[active]) - pad(), maxScroll()), behavior: RM ? 'auto' : 'smooth' });
    };
    track.addEventListener('scroll', () => {
      if (performance.now() < lock) return;
      clearTimeout(timer);
      timer = setTimeout(() => {
        const x = track.scrollLeft + pad();
        let best = 0, bd = Infinity;
        cards.forEach((c, i) => { const d = Math.abs(leftOf(c) - x); if (d < bd) { bd = d; best = i; } });
        if (track.scrollLeft >= maxScroll() - 2) best = Math.max(best, active);
        active = best;
        paint();
      }, 90);
    }, { passive: true });
    prev.addEventListener('click', () => go(active - 1));
    next.addEventListener('click', () => go(active + 1));
    cards.forEach((c, i) => c.addEventListener('click', () => go(i)));
    track.addEventListener('keydown', e => {
      if (e.key === 'ArrowRight') { e.preventDefault(); go(active + 1); }
      if (e.key === 'ArrowLeft') { e.preventDefault(); go(active - 1); }
    });
    paint();
  });

  /* ───────────── Pricing toggle ───────────── */
  run('pricing', () => {
    const seg = $('#billing');
    if (!seg) return;
    const btns = $$('button', seg), prices = $$('.price-swap');
    const set = v => {
      if (seg.dataset.value === v) return;
      seg.dataset.value = v;
      btns.forEach(b => b.setAttribute('aria-checked', String(b.dataset.value === v)));
      prices.forEach(p => {
        p.classList.add('is-out');
        setTimeout(() => { p.textContent = p.dataset[v]; p.classList.remove('is-out'); }, RM ? 0 : 150);
      });
    };
    btns.forEach(b => b.addEventListener('click', () => set(b.dataset.value)));
    seg.addEventListener('keydown', e => {
      if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
      const v = seg.dataset.value === 'monthly' ? 'annual' : 'monthly';
      set(v);
      btns.find(b => b.dataset.value === v).focus();
    });
  });

  /* ───────────── FAQ accordion ───────────── */
  run('faq', () => {
    const items = $$('.faq-item');
    items.forEach(it => $('button', it).addEventListener('click', () => {
      const open = !it.classList.contains('open');
      items.forEach(o => {
        const on = o === it && open;
        o.classList.toggle('open', on);
        $('button', o).setAttribute('aria-expanded', String(on));
      });
    }));
  });

  /* ───────────── CTA: concentric rings ───────────── */
  run('rings', () => {
    const host = $('#rings');
    if (!host) return;
    const C = 240;
    const R = [
      { r: 226, dot: 1 },
      { r: 200, dot: 1, seg: 5, dur: 26 },
      { r: 174, seg: 9, dur: 19, rev: 1 },
      { r: 146, seg: 6, dur: 15 },
      { r: 118, dot: 1, seg: 4, dur: 22, rev: 1 },
      { r: 90, seg: 10, dur: 12 },
      { r: 60, seg: 8, dur: 9, rev: 1 },
    ];
    let html = '';
    R.forEach((o, i) => {
      const box = `x="${C - o.r}" y="${C - o.r}" width="${o.r * 2}" height="${o.r * 2}"`;
      html += `<g class="ring" style="--d:${((i + 1) * 1.5).toFixed(1)}"><g class="ring-in" style="--n:${R.length - i}">` +
        `<rect class="ring-base${o.dot ? ' dot' : ''}" ${box}/>` +
        (o.seg ? `<rect class="ring-run${o.rev ? ' rev' : ''}" pathLength="100" style="--seg:${o.seg};--dur:${o.dur}s" ${box}/>` : '') +
        `</g></g>`;
    });
    html += `<g class="ring" style="--d:${((R.length + 1) * 1.5).toFixed(1)}"><g class="ring-in ring-core" style="--n:0">` +
      `<rect x="${C - 30}" y="${C - 30}" width="60" height="60"/>` +
      `<g transform="translate(${C - 13.5} ${C - 13.5}) scale(3)" shape-rendering="crispEdges"><path d="${pxPath(ICONS.star)}"/><path class="tw" d="${pxPath(ICONS.star, '+')}"/></g>` +
      `</g></g>`;
    $('svg', host).innerHTML = html;

    if (FINE && !RM) {
      const cell = host.closest('.cell');
      cell.addEventListener('pointermove', e => {
        const r = host.getBoundingClientRect();
        host.style.setProperty('--mx', clamp((e.clientX - r.left - r.width / 2) / r.width, -1, 1).toFixed(3));
        host.style.setProperty('--my', clamp((e.clientY - r.top - r.height / 2) / r.height, -1, 1).toFixed(3));
      });
      cell.addEventListener('pointerleave', () => { host.style.setProperty('--mx', 0); host.style.setProperty('--my', 0); });
    }
  });

  /* ───────────── Footer wordmark: pixel letters that light under the cursor ───────────── */
  run('wordmark', () => {
    const host = $('#wordmark');
    if (!host) return;
    const svg = $('svg', host);
    const G = { M: ['##..............##', '####..........####', '##.##........##.##', '##..##......##..##', '##...##....##...##', '##....##..##....##', '##.....####.....##', '##......##......##', '##..............##', '##..............##', '##..............##', '##..............##', '##..............##', '##..............##', '##..............##', '##..............##', '##..............##', '##..............##', '##..............##'], N: ['##..............##', '###.............##', '####............##', '##.##...........##', '##..##..........##', '##...##.........##', '##....##........##', '##.....##.......##', '##......##......##', '##.......##.....##', '##........##....##', '##.........##...##', '##..........##..##', '##...........##.##', '##............####', '##.............###', '##..............##', '##..............##', '##..............##'], 
      S: ['...#######...', '.###########.', '.##.......##.', '##.........##', '##.........##', '##...........', '##...........', '.##..........', '.#####.......', '...#######...', '.......#####.', '..........##.', '...........##', '...........##', '##.........##', '##.........##', '.##.......##.', '.###########.', '...#######...'],
      I: Array(19).fill('##'),
      G: ['....########....', '..############..', '.###........###.', '.##..........##.', '##............##', '##..............', '##..............', '##..............', '##..............', '##......########', '##......########', '##............##', '##............##', '##............##', '##............##', '.##..........###', '.###........####', '..##############', '....########..##'],
      L: [...Array(17).fill('##..........'), '############', '############'],
    };
    const cells = [];
    let html = '';
    [['M', 0], ['I', 20], ['N', 24], ['I', 44], ['M', 48], ['I', 68]].forEach(([ch, ox]) => {
      G[ch].forEach((row, y) => {
        const tone = Math.round(44 - (y / 18) * 21);
        for (let x = 0; x < row.length; x++) {
          if (row[x] !== '#') continue;
          cells.push({ x: ox + x, y });
          html += `<rect x="${ox + x}" y="${y}" width="1.03" height="1.03" style="--x:${ox + x};--y:${y};--base:rgb(${tone},${tone},${tone - 2})"/>`;
        }
      });
    });
    svg.setAttribute('shape-rendering', 'crispEdges');
    svg.innerHTML = html;
    const rects = $$('rect', svg);
    cells.forEach((c, i) => { c.el = rects[i]; });

    if (!FINE || RM) return;
    svg.addEventListener('pointermove', e => {
      const r = svg.getBoundingClientRect();
      const x = (e.clientX - r.left) / r.width * 59, y = (e.clientY - r.top) / r.height * 19;
      for (const c of cells) {
        const dx = c.x + .5 - x, dy = c.y + .5 - y;
        if (dx * dx + dy * dy > 5.5) continue;
        c.el.classList.add('hot');
        clearTimeout(c.t);
        c.t = setTimeout(() => c.el.classList.remove('hot'), 110);
      }
    });
  });

  /* ───────────── Reveal on scroll (starts once fonts are ready) ───────────── */
  run('reveal', () => {
    $$('[data-stagger]').forEach(parent => [...parent.children].forEach((c, i) => {
      c.setAttribute('data-reveal', '');
      c.style.setProperty('--i', i);
    }));
    const targets = $$('[data-reveal],[data-split],[data-anim]');
    if (!('IntersectionObserver' in window)) {
      targets.forEach(t => t.classList.add('is-in', 'is-live'));
      return;
    }
    const enter = el => {
      el.classList.add('is-in');
      el.dispatchEvent(new CustomEvent('reveal'));
      if (el.hasAttribute('data-reveal')) {
        /* Hand transitions back to the component once the entrance has played. */
        const i = parseFloat(getComputedStyle(el).getPropertyValue('--i')) || 0;
        setTimeout(() => { el.removeAttribute('data-reveal'); el.classList.remove('is-in'); }, 1150 + i * 80);
      }
    };
    const io = new IntersectionObserver(es => es.forEach(e => {
      if (!e.isIntersecting) return;
      io.unobserve(e.target);
      enter(e.target);
    }), { rootMargin: '0px 0px 50px 0px', threshold: 0.01 });
    const live = new IntersectionObserver(es => es.forEach(e => e.target.classList.toggle('is-live', e.isIntersecting)), { rootMargin: '8% 0px' });
    const start = () => {
      targets.forEach(t => { const r = t.getBoundingClientRect(); if (r.top < window.innerHeight && r.bottom > 0) enter(t); io.observe(t); });
      $$('[data-anim]').forEach(t => live.observe(t));
    };
    const fonts = document.fonts ? document.fonts.ready : Promise.resolve();
    Promise.race([fonts, new Promise(r => setTimeout(r, 1200))]).then(() => requestAnimationFrame(start));
  });
})();

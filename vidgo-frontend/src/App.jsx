import { useState, useEffect, useMemo, useRef, useCallback, memo } from 'react';
import axios from 'axios';
import './App.css';

// vite dev server  -> backend on port 5000 of the same machine
// production build -> same address the page was opened from
const API = import.meta.env.VITE_API_URL ?? (import.meta.env.DEV ? `http://${window.location.hostname}:5000` : '');
axios.defaults.timeout = 60000;

const FORMATS = [['mp4', 'Video'], ['mp3', 'MP3'], ['m4a', 'M4A']];
const DEFAULT_RES = [2160, 1440, 1080, 720, 480, 360, 240, 144];
const TAG = { 2160: '4K', 1440: '2K', 1080: 'Full HD', 720: 'HD' };
const LIMITS = [['0', 'No limit'], ['10', '10 MB/s'], ['5', '5 MB/s'], ['2', '2 MB/s'], ['1', '1 MB/s']];
const VID = /(?:v=|youtu\.be\/|shorts\/|live\/|embed\/)([\w-]{11})/;
const LST = /[?&]list=((?:PL|UU|OL|FL|LL|WL|VL)[\w-]{8,62})/;
const parse = (u) => ({ vid: u.match(VID)?.[1], list: u.match(LST)?.[1] });
const IDLE = { percent: 0, status: '', speed: '', eta: '', label: '', mb_done: null, mb_total: null, state: '', ahead: 0 };
const BADGE = { wait: 'Waiting', run: 'Downloading', fail: 'Failed' };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const load = (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } };
const SAVED = load('vidgo_prefs', {});
const cancelErr = () => Object.assign(new Error('cancelled'), { cancelled: true });
const toSec = (s) => {
  if (!s) return null;
  const p = s.trim().split(':').map(Number);
  return p.some(isNaN) || p.length > 3 ? null : p.reduce((a, b) => a * 60 + b, 0);
};
const niceDate = (s) => s ? new Date(+s.slice(0, 4), +s.slice(4, 6) - 1, +s.slice(6)).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }) : '';
const views = (n) => n ? new Intl.NumberFormat('en', { notation: 'compact' }).format(n) + ' views' : '';
const langName = (c) => { try { return new Intl.DisplayNames(['en'], { type: 'language' }).of(c) || c; } catch { return c; } };

const chime = () => {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.connect(g); g.connect(ctx.destination);
    o.frequency.setValueAtTime(660, ctx.currentTime);
    o.frequency.exponentialRampToValueAtTime(990, ctx.currentTime + 0.18);
    g.gain.setValueAtTime(0.12, ctx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.7);
    o.start(); o.stop(ctx.currentTime + 0.7);
  } catch { /* audio not allowed */ }
};

const Svg = ({ d }) => (
  <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={d} /></svg>
);

const IC = {
  down: 'M12 3v12m0 0l-5-5m5 5l5-5M4 21h16',
  clock: 'M12 7v5l3 2M12 21a9 9 0 100-18 9 9 0 000 18z',
  sliders: 'M4 6h9m4 0h3M4 12h3m4 0h9M4 18h11m4 0h1M13 4v4M7 10v4M15 16v4',
  sun: 'M12 4V2m0 20v-2m8-8h2M2 12h2m13.7-5.7l1.4-1.4M4.9 19.1l1.4-1.4m0-11.4L4.9 4.9m14.2 14.2l-1.4-1.4M12 17a5 5 0 100-10 5 5 0 000 10z',
  moon: 'M21 12.8A9 9 0 1111.2 3a7 7 0 009.8 9.8z',
  x: 'M6 18L18 6M6 6l12 12', // Close icon added
};

const Row = memo(function Row({ e, on, st, locked, toggle }) {
  const s = st?.s;
  return (
    <label className={`prow${s ? ` ${s}` : ''}`}>
      <input type="checkbox" className="switch sm" checked={on} disabled={locked} onChange={() => toggle(e.id)} />
      <img src={e.thumb} alt="" loading="lazy" decoding="async" width="64" height="36" />
      <span className="ptitle">{e.title}</span>
      <span className="pmeta">
        {s === 'save' ? <a href={`${API}/api/file/${st.jid}`} onClick={(ev) => ev.stopPropagation()}>Tap to save</a>
          : s === 'done' ? (st.mb ? `${st.mb} MB` : 'Saved')
          : s ? BADGE[s] : e.done ? 'Saved before' : e.duration}
      </span>
    </label>
  );
});

export default function App() {
  const [text, setText] = useState('');
  const [format, setFormat] = useState(SAVED.format || 'mp4');
  const [quality, setQuality] = useState('1080');
  const [abr, setAbr] = useState(SAVED.abr || '192');
  const [limit, setLimit] = useState(SAVED.limit || '0');
  const [cover, setCover] = useState(SAVED.cover ?? true);
  const [notify, setNotify] = useState(SAVED.notify ?? false);
  const [fetchList, setFetchList] = useState(false);
  const [sub, setSub] = useState('');
  const [clip, setClip] = useState(false);
  const [start, setStart] = useState('');
  const [end, setEnd] = useState('');
  const [info, setInfo] = useState(null);
  const [pl, setPl] = useState(null);
  const [scope, setScope] = useState('video');
  const [picked, setPicked] = useState(() => new Set());
  const [rows, setRows] = useState({});
  const [failed, setFailed] = useState([]);
  const [pending, setPending] = useState([]);
  const [server, setServer] = useState({ up: null });
  const [phase, setPhase] = useState('idle');
  const [prog, setProg] = useState(IDLE);
  const [q, setQ] = useState({ i: 0, n: 0 });
  const [msg, setMsg] = useState(null);
  const [history, setHistory] = useState(() => load('vidgo_history', []));
  const [theme, setTheme] = useState(() => load('vidgo_theme', window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'));
  
  // NEW: State to control Settings & History Modal
  const [showSettings, setShowSettings] = useState(false);

  const cur = useRef({});
  const stop = useRef(false);
  const lock = useRef(null);
  const done = useRef(new Set(load('vidgo_done', [])));
  const busy = phase === 'processing';
  const pct = Math.round(prog.percent || 0);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem('vidgo_theme', JSON.stringify(theme));
    document.querySelector('meta[name=theme-color]')?.setAttribute('content', theme === 'dark' ? '#080a17' : '#e6eafc');
  }, [theme]);
  useEffect(() => { localStorage.setItem('vidgo_history', JSON.stringify(history)); }, [history]);
  useEffect(() => {
    localStorage.setItem('vidgo_prefs', JSON.stringify({ format, abr, limit, cover, notify }));
  }, [format, abr, limit, cover, notify]);
  useEffect(() => { document.title = busy ? `${pct}% | Vidgo` : 'Vidgo'; }, [busy, pct]);

  useEffect(() => {
    if (!busy) return undefined;
    const get = async () => { try { lock.current = await navigator.wakeLock?.request('screen'); } catch { /* unsupported */ } };
    get();
    const onVis = () => document.visibilityState === 'visible' && get();
    document.addEventListener('visibilitychange', onVis);
    return () => {
      document.removeEventListener('visibilitychange', onVis);
      lock.current?.release?.().catch(() => {});
      lock.current = null;
    };
  }, [busy]);

  useEffect(() => {
    let dead = false;
    (async () => {
      for (let n = 0; n < 30 && !dead; n++) {
        try {
          const { data } = await axios.get(`${API}/api/health`, { timeout: 15000 });
          if (!dead) setServer({ ...data, up: true });
          return;
        } catch {
          if (!dead) setServer((s) => ({ ...s, up: false }));
          await sleep(3000);
        }
      }
    })();
    return () => { dead = true; };
  }, []);

  const urls = useMemo(() => text.split(/\s+/).filter(Boolean), [text]);
  const multi = urls.length > 1;
  const single = urls.length === 1 ? urls[0] : '';
  const maxH = server.max_height || 2160;

  useEffect(() => {
    setInfo(null); setPl(null); setSub(''); setScope('video'); setRows({}); setFailed([]); setPending([]);
    const { vid, list } = parse(single);
    if (!vid && !list) { setPhase((p) => (p === 'fetching' ? 'idle' : p)); return undefined; }
    
    let dead = false;
    setPhase('fetching');
    setMsg(null);
    
    const t = setTimeout(async () => {
      const tasks = [];
      const doList = list && (fetchList || !vid);
      const doVid = vid && (!fetchList || !list);

      if (doVid) {
        tasks.push(axios.post(`${API}/api/info`, { url: single }).then(({ data }) => {
          if (dead) return;
          setInfo(data);
          const vs = data.options.map((o) => o.v);
          const ok = vs.filter((v) => v <= 1080);
          if (vs.length) setQuality(String(ok.length ? Math.max(...ok) : Math.min(...vs)));
          setScope('video');
        }));
      }
      if (doList) {
        tasks.push(axios.post(`${API}/api/playlist`, { url: single }).then(({ data }) => {
          if (dead) return;
          const entries = data.entries.map((e) => ({ ...e, done: done.current.has(e.id) }));
          setPl({ ...data, entries });
          setPicked(new Set(entries.filter((e) => !e.done).map((e) => e.id)));
          setScope('playlist');
        }));
      }

      const res = await Promise.allSettled(tasks);
      if (dead) return;
      if (res.every((r) => r.status === 'rejected')) {
        setMsg({ type: 'error', text: res[0].reason?.response?.data?.message || 'Cannot reach the server yet. Please wait a moment and try again.' });
      }
      setPhase('idle');
    }, 600);
    return () => { dead = true; clearTimeout(t); };
  }, [single, fetchList]);

  const opts = useMemo(() => {
    const one = single && info;
    if (format === 'mp4') {
      const base = info?.options?.length ? info.options : DEFAULT_RES.filter((v) => v <= maxH).map((v) => ({ v, mb: null }));
      return base.map((o) => ({ k: String(o.v), label: `${o.v}p`, tag: TAG[o.v], mb: one ? o.mb : null }));
    }
    if (format === 'mp3') {
      return ['320', '192', '128'].map((b) => ({ k: b, label: `${b} kbps`, tag: b === '320' ? 'Best' : b === '128' ? 'Small' : '', mb: one ? +(info.seconds * b / 8 / 1024).toFixed(1) : null }));
    }
    return [{ k: 'orig', label: 'Original', tag: 'No re-encode', mb: one ? info.audio_size : null }];
  }, [format, info, single, maxH]);
  
  const current = format === 'mp4' ? quality : format === 'mp3' ? abr : 'orig';
  const est = opts.find((o) => o.k === current)?.mb;
  const pickOpt = (k) => { if (format === 'mp4') setQuality(k); else if (format === 'mp3') setAbr(k); };

  const queueItems = useMemo(() => {
    if (multi) {
      const m = new Map();
      urls.forEach((u) => {
        const { vid } = parse(u);
        if (vid && !m.has(vid)) m.set(vid, { id: vid, url: u, title: u, thumb: `https://i.ytimg.com/vi/${vid}/default.jpg` });
      });
      return [...m.values()];
    }
    if (scope === 'playlist' && pl) {
      return pl.entries.filter((e) => picked.has(e.id))
        .map((e) => ({ id: e.id, url: `https://www.youtube.com/watch?v=${e.id}`, title: e.title, thumb: e.thumb }));
    }
    const { vid } = parse(single);
    return vid ? [{ id: vid, url: single, title: info?.title || single, thumb: info?.thumb }] : [];
  }, [multi, urls, scope, pl, picked, single, info]);

  const toggle = useCallback((id) => {
    setPicked((p) => { const n = new Set(p); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  }, []);

  const paste = async () => {
    try {
      const t = await navigator.clipboard.readText();
      setText((x) => (x.trim() ? `${x.trim()}\n${t}` : t));
    } catch { setMsg({ type: 'error', text: 'Allow clipboard access, or long-press in the box to paste.' }); }
  };

  const toggleNotify = async (on) => {
    setNotify(on);
    if (on && 'Notification' in window && Notification.permission === 'default') await Notification.requestPermission();
  };

  const remember = (it, res) => {
    done.current.add(it.id);
    localStorage.setItem('vidgo_done', JSON.stringify([...done.current].slice(-500)));
    setHistory((h) => [{
      id: Date.now() + Math.random(), url: it.url, title: it.title, thumb: it.thumb, size: res.size,
      type: format === 'mp4' ? `${quality}p video` : format === 'mp3' ? `MP3 ${abr}k` : 'M4A',
    }, ...h].slice(0, 12));
  };

  const runItem = async (item, label, extra) => {
    const ac = new AbortController();
    cur.current = { ac, jid: null };
    const { signal } = ac;
    const body = { url: item.url, format, quality, abr, limit, cover, sub: format === 'mp4' ? sub : '', ...extra };
    const { data } = await axios.post(`${API}/api/download`, body, { signal });
    const jid = data.job;
    cur.current.jid = jid;
    let fails = 0, wait = 900, s = null;
    for (;;) {
      if (stop.current) throw cancelErr();
      try {
        ({ data: s } = await axios.get(`${API}/api/status/${jid}`, { signal }));
        fails = 0;
        setProg({ ...IDLE, ...s, label });
        if (s.state === 'ready') break;
        if (s.state === 'error') throw new Error(s.error || 'Download failed.');
        if (s.state === 'cancelled') throw cancelErr();
        wait = s.state === 'queued' ? 2000 : 900;
      } catch (e) {
        if (axios.isCancel(e) || e.cancelled) throw cancelErr();
        if (!e.isAxiosError) throw e;
        if (e.response?.status === 404) throw new Error('The server restarted and lost this download. Please try again.');
        if (++fails > 6) throw new Error('Connection lost. Check your internet and try again.');
      }
      await sleep(wait);
    }
    setProg({ ...IDLE, ...s, label, status: 'Sending to your device' });
    const a = document.createElement('a');
    a.href = `${API}/api/file/${jid}`;
    a.download = '';
    document.body.appendChild(a); a.click(); a.remove();
    let saved = false;
    for (let t = 0; t < 12 && !saved && !stop.current; t++) {
      await sleep(1000);
      try {
        const { data: z } = await axios.get(`${API}/api/status/${jid}`, { signal });
        saved = z.state === 'sending' || z.state === 'delivered';
      } catch (e) {
        if (e.response?.status === 404) saved = true;
        else if (axios.isCancel(e)) break;
      }
    }
    return { jid, saved, size: s.size, name: s.name, note: s.note };
  };

  const runQueue = async (items, extra = {}) => {
    stop.current = false;
    setPhase('processing'); setMsg(null); setFailed([]); setPending([]);
    setRows(Object.fromEntries(items.map((it) => [it.id, { s: 'wait' }])));
    let ok = 0, unsaved = 0, lastErr = '', note = '';
    const bad = [];
    for (let i = 0; i < items.length && !stop.current; i++) {
      const it = items[i];
      const label = items.length > 1 ? `Video ${i + 1} of ${items.length}` : '';
      setQ({ i: i + 1, n: items.length });
      setProg({ ...IDLE, status: 'Connecting', label });
      setRows((r) => ({ ...r, [it.id]: { s: 'run' } }));
      let res = null;
      for (let a = 0; a < 2 && !res && !stop.current; a++) {
        try { res = await runItem(it, label, extra); }
        catch (e) {
          if (e.cancelled || axios.isCancel(e)) break;
          lastErr = e.response?.data?.message || e.message;
          const transient = e.isAxiosError || /restarted|Connection lost/.test(e.message);
          if (e.response?.status === 429) await sleep(6000);
          else if (!transient) break;
        }
      }
      if (res) {
        ok++;
        if (res.note) note = res.note;
        remember(it, res);
        if (!res.saved) { unsaved++; setPending((p) => [...p, { jid: res.jid, name: res.name, size: res.size }]); }
        setRows((r) => ({ ...r, [it.id]: res.saved ? { s: 'done', mb: res.size } : { s: 'save', jid: res.jid } }));
      } else if (!stop.current) {
        bad.push(it);
        setRows((r) => ({ ...r, [it.id]: { s: 'fail' } }));
      }
    }
    setFailed(bad);
    if (stop.current) {
      setRows((r) => Object.fromEntries(Object.entries(r).filter(([, v]) => v.s !== 'run' && v.s !== 'wait')));
      setMsg({ type: 'info', text: ok ? `Stopped. ${ok} saved before you cancelled.` : 'Download cancelled.' });
    } else if (!bad.length && !unsaved) {
      setMsg({ type: 'ok', text: `${ok > 1 ? `${ok} videos` : 'Your file'} saved to Chrome downloads (Ctrl+J).${note ? ` ${note}` : ''}` });
    } else if (unsaved) {
      setMsg({ type: 'info', text: 'Chrome is waiting for your permission. Allow downloads for this site, or tap Save below.' });
    } else {
      setMsg({ type: ok ? 'info' : 'error', text: ok ? `${ok} of ${items.length} saved. ${bad.length} failed: ${lastErr}` : lastErr });
    }
    if (ok && notify && !stop.current) {
      chime();
      if ('Notification' in window && Notification.permission === 'granted') new Notification('Vidgo', { body: 'Your download is ready.' });
    }
    setPhase('idle'); setProg(IDLE); setQ({ i: 0, n: 0 });
  };

  const download = () => {
    if (!queueItems.length) return setMsg({ type: 'error', text: 'Paste a YouTube link first.' });
    const useClip = clip && !multi && scope === 'video';
    const s = toSec(start), e = toSec(end);
    if (useClip && (s === null || e === null || e <= s)) {
      return setMsg({ type: 'error', text: 'Enter a valid clip range, for example 0:30 to 1:15.' });
    }
    return runQueue(queueItems, useClip ? { start: s, end: e } : {});
  };

  const cancel = () => {
    stop.current = true;
    const { ac, jid } = cur.current;
    if (jid) axios.post(`${API}/api/cancel`, { job: jid }).catch(() => {});
    ac?.abort();
  };

  const count = queueItems.length;
  const overall = q.n > 1 ? Math.min(100, ((q.i - 1 + pct / 100) / q.n) * 100) : pct;
  const mbText = prog.mb_done != null && prog.state === 'running' ? `${prog.mb_done}${prog.mb_total ? ` of ~${prog.mb_total}` : ''} MB` : '';
  const dlLabel = `Download${count > 1 ? ` ${count} videos` : ''}${est ? ` | ${est} MB` : ''}`;
  const hasSubs = single && info?.subs?.length;

  return (
    <div className="app">
      <div className="aurora" aria-hidden="true"><i /><i /><i /></div>

      <header className="appbar glass">
        <div className="brand"><span className={`reel${busy ? ' spin' : ''}`} aria-hidden="true" /><h1>Vidgo</h1></div>
        <div className="bar-right">
          <span className={`status ${server.up ? 'ok' : 'wait'}`}>{server.up ? 'Online' : 'Connecting'}</span>
          {/* Main Settings Button in Header */}
          <button className="icon-btn" onClick={() => setShowSettings(true)} aria-label="Settings and History">
            <Svg d={IC.sliders} />
          </button>
        </div>
      </header>

      <div className="layout" style={{ justifyContent: 'center' }}>
        <div className="main" style={{ margin: '0 auto' }}>
          <section className={`sec sec-download card glass${busy ? ' busy' : ''}`}>
            {server.up === false && (
              <div className="banner" role="status">Waking up the server. Free hosting sleeps when idle, this can take up to a minute.</div>
            )}

            <div className="field">
              <label className="head" htmlFor="link">Paste a link</label>
              <div className="row">
                <textarea id="link" rows={2} inputMode="url" autoCapitalize="off" autoCorrect="off" spellCheck="false"
                  placeholder="Video, Short or playlist link" value={text} disabled={busy}
                  onChange={(e) => { setText(e.target.value); setMsg(null); }}
                  onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey && !multi && !busy) { e.preventDefault(); download(); } }} />
                {text ? <button onClick={() => { setText(''); setMsg(null); }} disabled={busy}>Clear</button> : <button onClick={paste}>Paste</button>}
              </div>
              <label className="toggle" style={{ marginTop: '2px' }}>
                <input type="checkbox" className="switch sm" checked={fetchList} onChange={(e) => setFetchList(e.target.checked)} disabled={busy} />
                <span className="sub" style={{ fontSize: '0.9rem', color: 'var(--ink)' }}>Download whole playlist (if link has both)</span>
              </label>
              <p className="hint" style={{ marginTop: '4px' }}>Tip: paste several links (one per line) to download them one by one.</p>
            </div>

            {phase === 'fetching' && <div className="skel" aria-label="Loading video details" />}

            {!multi && info && (
              <div className="preview">
                <div className="thumb"><img src={info.thumb} alt="" width="320" height="180" /><b>{info.duration}</b></div>
                <div>
                  <p className="title" title={info.title}>{info.title}</p>
                  <p className="sub">{[info.channel, views(info.views), niceDate(info.date)].filter(Boolean).join(' | ')}</p>
                  <a className="link" href={info.thumbnail || info.thumb} target="_blank" rel="noreferrer">Open thumbnail</a>
                </div>
              </div>
            )}

            {!multi && pl && scope === 'playlist' && (
              <div className="plist">
                <div className="plist-head">
                  <div>
                    <p className="title">{pl.title}</p>
                    <p className="sub">
                      {pl.entries.length} videos{pl.total > pl.entries.length ? ` (first ${pl.limit} of ${pl.total})` : ''} | {picked.size} selected
                    </p>
                  </div>
                  <div className="row">
                    <button className="ghost" disabled={busy} onClick={() => setPicked(new Set(pl.entries.map((e) => e.id)))}>All</button>
                    <button className="ghost" disabled={busy} onClick={() => setPicked(new Set())}>None</button>
                  </div>
                </div>
                <div className="plist-body">
                  {pl.entries.map((e) => <Row key={e.id} e={e} on={picked.has(e.id)} st={rows[e.id]} locked={busy} toggle={toggle} />)}
                </div>
              </div>
            )}

            {multi && (
              <div className="plist">
                <div className="plist-head">
                  <div><p className="title">{count} videos in queue</p><p className="sub">They download one after another. One playlist link at a time.</p></div>
                </div>
              </div>
            )}

            <div className="seg" style={{ '--i': FORMATS.findIndex(([v]) => v === format), '--n': 3 }} role="group" aria-label="Format">
              {FORMATS.map(([v, l]) => (
                <button key={v} className={format === v ? 'on' : ''} onClick={() => setFormat(v)} disabled={busy} aria-pressed={format === v}>{l}</button>
              ))}
            </div>

            <div className="field">
              <span className="head">{format === 'mp4' ? 'Quality' : format === 'mp3' ? 'Audio quality' : 'Audio'}</span>
              <div className="chips" role="group" aria-label="Quality">
                {opts.map((o) => (
                  <button key={o.k} className={`opt${current === o.k ? ' on' : ''}`} disabled={busy} aria-pressed={current === o.k} onClick={() => pickOpt(o.k)}>
                    <span className="v">{o.label}{o.tag ? <small>{o.tag}</small> : null}</span>
                    <span className="mb">{o.mb ? `~${o.mb} MB` : '-'}</span>
                  </button>
                ))}
              </div>
              <p className="est">
                {count > 1 || (scope === 'playlist' && pl) ? 'Each video has its own size. Exact size shows when it is done.'
                  : est ? `Estimated file size: about ${est} MB` : 'Paste a link to see the file size.'}
                {format === 'mp4' && server.up && maxH < 2160 ? ` Server limit: ${maxH}p.` : ''}
              </p>
            </div>

            <details className="more">
              <summary>More options</summary>
              <div className="more-body">
                {format === 'mp4' && (
                  <label className="field">Subtitles (added inside the video)
                    <select value={sub} onChange={(e) => setSub(e.target.value)} disabled={busy || multi || !hasSubs}>
                      <option value="">{multi ? 'Single video only' : info && !hasSubs ? 'None available' : 'Off'}</option>
                      {(hasSubs ? info.subs : []).map((c) => <option key={c} value={c}>{langName(c)}</option>)}
                    </select>
                  </label>
                )}
                {!multi && scope === 'video' && (
                  <>
                    <label className="toggle">
                      <input type="checkbox" className="switch" checked={clip} onChange={(e) => setClip(e.target.checked)} disabled={busy} />
                      Download only a part of the video
                    </label>
                    {clip && (
                      <div className="grid2">
                        <label className="field">Start
                          <input placeholder="0:30" value={start} onChange={(e) => setStart(e.target.value)} disabled={busy} />
                        </label>
                        <label className="field">End {info && <span className="sub">(video is {info.duration})</span>}
                          <input placeholder="1:15" value={end} onChange={(e) => setEnd(e.target.value)} disabled={busy} />
                        </label>
                      </div>
                    )}
                  </>
                )}
                {format !== 'mp4' && <p className="sub">Cover art and song tags can be switched in Settings.</p>}
              </div>
            </details>
          </section>

          <div className="dock glass">
            {busy && (
              <div className="dock-prog">
                <div className="dock-top"><b>{prog.label || 'Downloading'}</b><span>{pct}%</span></div>
                <div className="film" role="progressbar" aria-valuenow={pct} aria-valuemin="0" aria-valuemax="100">
                  <div className="film-fill" style={{ width: `${pct}%` }} />
                </div>
                <div className="meta">
                  <span>{prog.state === 'queued' ? `Waiting in queue${prog.ahead ? ` (${prog.ahead} ahead)` : ''}` : prog.status}</span>
                  <span>{[mbText, prog.speed, prog.eta && `${prog.eta} left`].filter(Boolean).join(' | ')}</span>
                </div>
                {q.n > 1 && <div className="overall" aria-hidden="true"><i style={{ width: `${overall}%` }} /></div>}
              </div>
            )}
            {pending.map((p) => (
              <a key={p.jid} className="save" href={`${API}/api/file/${p.jid}`} onClick={() => setPending((x) => x.filter((y) => y.jid !== p.jid))}>
                Save {p.name}{p.size ? ` (${p.size} MB)` : ''}
              </a>
            ))}
            {msg && <div className={`msg ${msg.type}`} role="status">{msg.text}</div>}
            <div className="dock-actions">
              {busy
                ? <button className="danger" onClick={cancel}>Cancel</button>
                : <button className="primary" onClick={download} disabled={!count || phase === 'fetching'}>{dlLabel}</button>}
              {!busy && failed.length > 0 && <button className="ghost" onClick={() => runQueue(failed)}>Retry {failed.length} failed</button>}
            </div>
          </div>
        </div>
      </div>

      {/* NEW SETTINGS & HISTORY MODAL */}
      {showSettings && (
        <div style={{
          position: 'fixed', inset: 0, zIndex: 100, backgroundColor: 'rgba(0,0,0,0.6)',
          display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '1rem',
          backdropFilter: 'blur(5px)'
        }} onClick={() => setShowSettings(false)}>
          
          <div className="card glass" style={{
            width: '100%', maxWidth: '480px', maxHeight: '90vh', overflowY: 'auto',
            padding: '1.5rem', display: 'flex', flexDirection: 'column', gap: '2rem', position: 'relative'
          }} onClick={(e) => e.stopPropagation()}>
            
            <button className="icon-btn" style={{ position: 'absolute', top: '1.2rem', right: '1.2rem', opacity: 0.7 }} onClick={() => setShowSettings(false)}>
              <Svg d={IC.x} />
            </button>
            
            <section className="sec-history">
              <div className="hist-head" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem' }}>
                <h2 style={{ margin: 0, fontSize: '1.1rem' }}>Recent downloads</h2>
                {history.length > 0 && <button className="ghost sm" onClick={() => setHistory([])}>Clear</button>}
              </div>
              {history.length === 0 && <p className="sub">Your finished downloads will show up here.</p>}
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.8rem' }}>
                {history.map((h) => (
                  <div key={h.id} className="hitem" style={{ display: 'flex', gap: '1rem', alignItems: 'center' }}>
                    {h.thumb ? <img src={h.thumb} alt="" loading="lazy" width="72" height="40" style={{ borderRadius: '6px' }} /> : <span className="noimg" />}
                    <div className="hmeta" style={{ flex: 1, minWidth: 0 }}>
                      <p title={h.title} style={{ margin: 0, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', fontSize: '0.9rem', fontWeight: 600 }}>{h.title}</p>
                      <p className="sub" style={{ margin: 0, fontSize: '0.8rem' }}>{h.type}{h.size ? ` | ${h.size} MB` : ''}</p>
                    </div>
                    <button className="ghost sm" onClick={() => { setText(h.url); setShowSettings(false); window.scrollTo({ top: 0, behavior: 'smooth' }); }}>Again</button>
                  </div>
                ))}
              </div>
            </section>

            <div style={{ height: '1px', background: 'var(--border)' }}></div>

            <section className="sec-settings" style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
              <h2 style={{ margin: 0, fontSize: '1.1rem' }}>Settings</h2>
              <label className="set-row" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span>Dark theme</span>
                <input type="checkbox" className="switch" checked={theme === 'dark'} onChange={(e) => setTheme(e.target.checked ? 'dark' : 'light')} />
              </label>
              <label className="set-row" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span>Speed limit</span>
                <select value={limit} onChange={(e) => setLimit(e.target.value)} style={{ width: 'auto', padding: '4px 8px' }}>
                  {LIMITS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                </select>
              </label>
              <label className="set-row" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span>Cover art and tags in MP3</span>
                <input type="checkbox" className="switch" checked={cover} onChange={(e) => setCover(e.target.checked)} />
              </label>
              <label className="set-row" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span>Sound and notification when done</span>
                <input type="checkbox" className="switch" checked={notify} onChange={(e) => toggleNotify(e.target.checked)} />
              </label>
            </section>

          </div>
        </div>
      )}
    </div>
  );
}
import { useState, useEffect, useRef } from 'react';
import axios from 'axios';
import './App.css';

const API = ['localhost', '127.0.0.1'].includes(window.location.hostname)
  ? 'http://localhost:5000'
  : 'https://vidgo-tmmz.onrender.com';

const RES = [['2160', '4K (2160p)'], ['1440', '2K (1440p)'], ['1080', 'Full HD (1080p)'], ['720', 'HD (720p)'], ['480', '480p'], ['360', '360p'], ['144', '144p']];
const FORMATS = [['mp4', 'Video MP4'], ['mp3', 'Audio MP3'], ['m4a', 'Audio M4A']];
const LIMITS = [['0', 'No limit'], ['10', '10 MB/s'], ['5', '5 MB/s'], ['2', '2 MB/s'], ['1', '1 MB/s']];
const YT = /(youtu\.be\/|youtube\.com\/)/;
const IDLE = { percent: 0, status: '', speed: '', eta: '', label: '' };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const load = (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } };
const SAVED = load('vidgo_prefs', {});
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

export default function App() {
  const [url, setUrl] = useState('');
  const [links, setLinks] = useState('');
  const [batch, setBatch] = useState(false);
  const [format, setFormat] = useState(SAVED.format || 'mp4');
  const [quality, setQuality] = useState('1080');
  const [abr, setAbr] = useState(SAVED.abr || '192');
  const [limit, setLimit] = useState(SAVED.limit || '0');
  const [cover, setCover] = useState(SAVED.cover ?? true);
  const [notify, setNotify] = useState(SAVED.notify ?? false);
  const [sub, setSub] = useState('');
  const [clip, setClip] = useState(false);
  const [start, setStart] = useState('');
  const [end, setEnd] = useState('');
  const [info, setInfo] = useState(null);
  const [phase, setPhase] = useState('idle'); // idle | fetching | processing
  const [prog, setProg] = useState(IDLE);
  const [msg, setMsg] = useState(null);
  const [history, setHistory] = useState(() => load('vidgo_history', []));
  const [theme, setTheme] = useState(() => load('vidgo_theme', window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'));
  const job = useRef({});
  const stop = useRef(false);
  const busy = phase === 'processing';

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem('vidgo_theme', JSON.stringify(theme));
  }, [theme]);
  useEffect(() => { localStorage.setItem('vidgo_history', JSON.stringify(history)); }, [history]);
  useEffect(() => {
    localStorage.setItem('vidgo_prefs', JSON.stringify({ format, abr, limit, cover, notify }));
  }, [format, abr, limit, cover, notify]);

  // Load title, thumbnail, sizes and subtitles once the link settles
  useEffect(() => {
    setInfo(null);
    setSub('');
    if (!YT.test(url)) { setPhase((p) => (p === 'fetching' ? 'idle' : p)); return; }
    let dead = false;
    setPhase('fetching');
    setMsg(null);
    const t = setTimeout(async () => {
      try {
        const { data } = await axios.post(`${API}/api/info`, { url });
        if (dead) return;
        setInfo(data);
        const ok = data.heights.filter((h) => h <= 1080);
        setQuality(String(ok.length ? Math.max(...ok) : Math.max(...data.heights, 144)));
      } catch (e) {
        if (!dead) setMsg({ type: 'error', text: e.response?.data?.message || 'Cannot reach the server. Is app.py running?' });
      } finally {
        if (!dead) setPhase('idle');
      }
    }, 700);
    return () => { dead = true; clearTimeout(t); };
  }, [url]);

  const paste = async () => {
    try {
      const t = await navigator.clipboard.readText();
      batch ? setLinks((l) => (l ? l + '\n' : '') + t) : setUrl(t);
    } catch { setMsg({ type: 'error', text: 'Allow clipboard access, or paste the link manually.' }); }
  };

  const toggleNotify = async (on) => {
    setNotify(on);
    if (on && 'Notification' in window && Notification.permission === 'default') await Notification.requestPermission();
  };

  const runJob = async (link, label, extra) => {
    const taskId = `t${Date.now()}${Math.random().toString(36).slice(2, 6)}`;
    const ac = new AbortController();
    const es = new EventSource(`${API}/api/progress/${taskId}`);
    job.current = { taskId, es, ac };
    es.onmessage = (ev) => { try { setProg({ ...JSON.parse(ev.data), label }); } catch { /* ignore */ } };
    try {
      const { data } = await axios.post(
        `${API}/api/download`,
        { url: link, format, quality, abr, limit, cover, sub, task_id: taskId, ...extra },
        { signal: ac.signal }
      );
      setProg({ ...IDLE, percent: 100, status: 'Ready, handing over to Chrome', label });
      // Server sends Content-Disposition: attachment, so Chrome saves it straight to Downloads
      const a = document.createElement('a');
      a.href = `${API}/api/file/${taskId}`;
      a.download = '';
      document.body.appendChild(a); a.click(); a.remove();
      return data;
    } finally { es.close(); }
  };

  const download = async () => {
    const list = batch
      ? [...new Set(links.split(/\s+/).filter((u) => YT.test(u)))]
      : YT.test(url) ? [url] : [];
    if (!list.length) return setMsg({ type: 'error', text: batch ? 'Paste at least one YouTube link.' : 'Paste a valid YouTube link first.' });
    const useClip = clip && !batch;
    const s = toSec(start), e = toSec(end);
    if (useClip && (s === null || e === null || e <= s)) {
      return setMsg({ type: 'error', text: 'Enter a valid clip range, for example 0:30 to 1:15.' });
    }

    stop.current = false;
    setPhase('processing');
    setMsg(null);
    let ok = 0, lastErr = '';
    for (let i = 0; i < list.length && !stop.current; i++) {
      const label = list.length > 1 ? `Video ${i + 1} of ${list.length}` : '';
      setProg({ ...IDLE, status: 'Connecting...', label });
      try {
        const data = await runJob(list[i], label, useClip ? { start: s, end: e } : {});
        ok++;
        setHistory((h) => [{
          id: Date.now() + i, url: list[i], title: list.length > 1 ? list[i] : info?.title || list[i],
          thumb: list.length > 1 ? null : info?.thumbnail,
          type: format === 'mp4' ? `${quality}p video` : format === 'mp3' ? `MP3 ${abr}k` : 'M4A', size: data.size,
        }, ...h].slice(0, 8));
        if (i < list.length - 1) await sleep(1200);
      } catch (err) {
        if (axios.isCancel(err)) break;
        lastErr = err.response?.data?.message || 'Server is not reachable.';
        if (list.length === 1) break;
      }
    }

    if (stop.current) setMsg({ type: 'info', text: 'Download cancelled.' });
    else if (ok === list.length) {
      setMsg({ type: 'ok', text: `${ok > 1 ? `${ok} downloads` : 'Download'} started in Chrome. Press Ctrl+J to see them.` });
      if (notify) {
        chime();
        if ('Notification' in window && Notification.permission === 'granted') new Notification('Vidgo', { body: 'Your download is ready.' });
      }
    } else setMsg({ type: ok ? 'info' : 'error', text: ok ? `${ok} of ${list.length} finished. Last error: ${lastErr}` : lastErr });
    setTimeout(() => { setPhase('idle'); setProg(IDLE); }, ok ? 1500 : 0);
  };

  const cancel = () => {
    stop.current = true;
    const { taskId, es, ac } = job.current;
    axios.post(`${API}/api/cancel`, { task_id: taskId }).catch(() => {});
    ac?.abort();
    es?.close();
  };

  const resList = (() => {
    const f = info?.heights?.length ? RES.filter(([v]) => info.heights.includes(+v)) : [];
    return f.length ? f : RES;
  })();
  const est = batch ? null : !info ? null
    : format === 'mp4' ? info.sizes[quality]
    : format === 'mp3' ? +(info.seconds * abr / 8 / 1024).toFixed(1)
    : info.audio_size;
  const pct = Math.round(prog.percent || 0);
  const count = batch ? new Set(links.split(/\s+/).filter((u) => YT.test(u))).size : 0;

  return (
    <>
      <div className="aurora" aria-hidden="true"><i /><i /><i /></div>
      <main className="shell">
        <header className="top">
          <div className="brand"><span className={`reel${busy ? ' spin' : ''}`} aria-hidden="true" /><h1>Vidgo</h1></div>
          <button className="ghost glass" onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')} aria-label="Switch theme">
            {theme === 'dark' ? 'Light mode' : 'Dark mode'}
          </button>
        </header>
        <p className="lead">Paste a YouTube link, pick a quality, and the file goes straight to your Chrome downloads.</p>

        <section className={`panel glass${busy ? ' busy' : ''}`}>
          <div className="field">
            <div className="label-row">
              <span>{batch ? 'Video links' : 'Video link'}</span>
              <label className="toggle">
                <input type="checkbox" className="switch" checked={batch} disabled={busy} onChange={(e) => setBatch(e.target.checked)} />
                Batch mode
              </label>
            </div>
            {batch ? (
              <div className="row top-align">
                <textarea rows={4} placeholder={'One link per line\nhttps://youtu.be/...'} value={links} disabled={busy}
                  aria-label="Video links" onChange={(e) => setLinks(e.target.value)} />
                {links ? <button onClick={() => setLinks('')} disabled={busy}>Clear</button> : <button onClick={paste}>Paste</button>}
              </div>
            ) : (
              <div className="row">
                <input type="url" inputMode="url" placeholder="https://youtu.be/..." value={url} disabled={busy} aria-label="Video link"
                  onChange={(e) => setUrl(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && !busy && download()} />
                {url ? <button onClick={() => { setUrl(''); setMsg(null); }} disabled={busy}>Clear</button> : <button onClick={paste}>Paste</button>}
              </div>
            )}
          </div>

          {!batch && phase === 'fetching' && <div className="msg info" role="status">Loading video details...</div>}

          {!batch && info && (
            <div className="preview">
              <div className="thumb"><img src={info.thumbnail} alt="" /><b>{info.duration}</b></div>
              <div>
                <p className="title" title={info.title}>{info.title}</p>
                <p className="sub">{[info.channel, views(info.views), niceDate(info.date)].filter(Boolean).join(' | ')}</p>
                <a className="link" href={info.thumbnail} target="_blank" rel="noreferrer">Open thumbnail</a>
              </div>
            </div>
          )}

          <div className="seg" style={{ '--i': FORMATS.findIndex(([v]) => v === format) }} role="group" aria-label="Format">
            {FORMATS.map(([v, l]) => (
              <button key={v} className={format === v ? 'on' : ''} onClick={() => setFormat(v)} disabled={busy} aria-pressed={format === v}>{l}</button>
            ))}
          </div>

          <div className="grid2">
            {format === 'mp4' ? (
              <label className="field">Resolution
                <select value={quality} onChange={(e) => setQuality(e.target.value)} disabled={busy}>
                  {resList.map(([v, l]) => <option key={v} value={v}>{l}{!batch && info?.sizes?.[v] ? ` (~${info.sizes[v]} MB)` : ''}</option>)}
                </select>
              </label>
            ) : (
              <label className="field">Audio quality
                <select value={abr} onChange={(e) => setAbr(e.target.value)} disabled={busy || format === 'm4a'}>
                  {format === 'm4a' ? <option>Original (no re-encode)</option>
                    : ['320', '192', '128'].map((b) => <option key={b} value={b}>{b} kbps</option>)}
                </select>
              </label>
            )}
            <div className="field">{batch ? 'Queue' : 'Estimated size'}
              <div className="chip">{batch ? (count ? `${count} video${count > 1 ? 's' : ''}, one after another` : 'No links yet') : est ? `~${est} MB` : 'Paste a link to see'}</div>
            </div>
          </div>

          <details className="more">
            <summary>More options</summary>
            <div className="more-body">
              <label className="field">Speed limit
                <select value={limit} onChange={(e) => setLimit(e.target.value)} disabled={busy}>
                  {LIMITS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                </select>
              </label>
              {format === 'mp4' ? (
                <label className="field">Subtitles (embedded in the video)
                  <select value={sub} onChange={(e) => setSub(e.target.value)} disabled={busy || (!batch && !info?.subs?.length)}>
                    <option value="">{!batch && info && !info.subs.length ? 'None available' : 'Off'}</option>
                    {(batch ? ['en', 'hi'] : info?.subs || []).map((c) => <option key={c} value={c}>{langName(c)}</option>)}
                  </select>
                </label>
              ) : (
                <label className="toggle">
                  <input type="checkbox" className="switch" checked={cover} onChange={(e) => setCover(e.target.checked)} disabled={busy} />
                  Add cover art and song tags
                </label>
              )}
              <label className="toggle">
                <input type="checkbox" className="switch" checked={notify} onChange={(e) => toggleNotify(e.target.checked)} />
                Play a sound and notify me when done
              </label>
              {!batch && (
                <label className="toggle">
                  <input type="checkbox" className="switch" checked={clip} onChange={(e) => setClip(e.target.checked)} disabled={busy} />
                  Download only a part of the video
                </label>
              )}
              {clip && !batch && (
                <div className="grid2">
                  <label className="field">Start
                    <input placeholder="0:30" value={start} onChange={(e) => setStart(e.target.value)} disabled={busy} />
                  </label>
                  <label className="field">End {info && <span className="sub">(video is {info.duration})</span>}
                    <input placeholder="1:15" value={end} onChange={(e) => setEnd(e.target.value)} disabled={busy} />
                  </label>
                </div>
              )}
            </div>
          </details>

          {busy && (
            <div>
              <div className="film" role="progressbar" aria-valuenow={pct} aria-valuemin="0" aria-valuemax="100">
                <div className="film-fill" style={{ width: `${pct}%` }} />
              </div>
              <div className="meta">
                <span>{[prog.label, prog.status].filter(Boolean).join(': ')}</span>
                <span>{pct}%{prog.speed ? ` | ${prog.speed}` : ''}{prog.eta ? ` | ${prog.eta} left` : ''}</span>
              </div>
            </div>
          )}

          {busy
            ? <button className="danger" onClick={cancel}>Cancel download</button>
            : <button className="primary" onClick={download} disabled={batch ? !count : !url || phase === 'fetching'}>
                {batch && count > 1 ? `Download ${count} videos` : 'Download'}
              </button>}

          {msg && <div className={`msg ${msg.type}`} role="status">{msg.text}</div>}
        </section>

        {history.length > 0 && (
          <section className="hist glass">
            <div className="hist-head">
              <h2>Recent downloads</h2>
              <button className="ghost" onClick={() => setHistory([])}>Clear list</button>
            </div>
            {history.map((h) => (
              <div key={h.id} className="hitem">
                {h.thumb ? <img src={h.thumb} alt="" /> : <span className="noimg" />}
                <div className="hmeta">
                  <p title={h.title}>{h.title}</p>
                  <p className="sub">{h.type}{h.size ? ` | ${h.size} MB` : ''}</p>
                </div>
                <button className="ghost" onClick={() => { setBatch(false); setUrl(h.url); window.scrollTo({ top: 0, behavior: 'smooth' }); }}>Use again</button>
              </div>
            ))}
          </section>
        )}
      </main>
    </>
  );
}
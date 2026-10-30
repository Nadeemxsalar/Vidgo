"""Vidgo backend. Same code runs on localhost and on Render (limits switch automatically)."""
import os, re, time, uuid, shutil, tempfile, threading, contextlib, mimetypes, importlib.util
from urllib.parse import quote
from flask import Flask, request, jsonify, Response, send_from_directory, abort
from flask_cors import CORS
import yt_dlp
from yt_dlp.utils import download_range_func, DownloadCancelled

BASE = os.path.dirname(os.path.abspath(__file__))
IS_RENDER = bool(os.environ.get('RENDER'))

def env_int(name, default):
    try:
        return int(os.environ.get(name, default))
    except ValueError:
        return default

# ---- Limits (override with environment variables) --------------------------------------
MAX_JOBS = env_int('MAX_JOBS', 1 if IS_RENDER else 2)
MAX_QUEUE = env_int('MAX_QUEUE', 12)
MAX_PER_IP = env_int('MAX_PER_IP', 3)
MAX_HEIGHT = env_int('MAX_HEIGHT', 1080 if IS_RENDER else 2160)   # Render par 4K chahiye to MAX_HEIGHT=2160 set karo
MAX_PLAYLIST = env_int('MAX_PLAYLIST', 50 if IS_RENDER else 200)
MAX_MB = env_int('MAX_MB', 800 if IS_RENDER else 0)               # 0 = no size limit (4K files badi hoti hain)
MIN_FREE_MB = env_int('MIN_FREE_MB', 300)
READY_TTL = 600

# Optional: YouTube player clients force karne ke liye, e.g. YT_CLIENTS="default,mweb".
# Khali chhodo = yt-dlp ke apne default clients (recommended, wo har release me update hote rehte hain).
YT_CLIENTS = [c.strip() for c in os.environ.get('YT_CLIENTS', '').split(',') if c.strip()]
# YT_DEBUG=1 set karoge to yt-dlp ka poora verbose log terminal me aayega.
YT_DEBUG = bool(os.environ.get('YT_DEBUG'))

TMP = os.path.join(tempfile.gettempdir(), 'vidgo_tmp')
shutil.rmtree(TMP, ignore_errors=True)
os.makedirs(TMP, exist_ok=True)

COOKIE_SRC = next((p for p in (os.environ.get('COOKIES_FILE'), '/etc/secrets/cookies.txt',
                               os.path.join(BASE, 'cookies.txt')) if p and os.path.isfile(p)), None)

def find_ffmpeg():
    if shutil.which('ffmpeg'):
        return None
    try:
        import imageio_ffmpeg
        return imageio_ffmpeg.get_ffmpeg_exe()
    except Exception:
        return None

FFMPEG = find_ffmpeg()

app = Flask(__name__, static_folder='dist', static_url_path='/')
CORS(app)

ANSI = re.compile(r'\x1b\[[0-9;]*m')
VID = re.compile(r'(?:v=|youtu\.be/|shorts/|live/|embed/)([\w-]{11})')
LST = re.compile(r'[?&]list=((?:PL|UU|OL|FL|LL|WL|VL)[\w-]{8,62})')
MEDIA = ('.mp4', '.mp3', '.m4a', '.mkv', '.webm', '.opus')
STD_RES = {144, 240, 360, 480, 720, 1080, 1440, 2160}
MBPS = {144: .15, 240: .3, 360: .6, 480: 1.0, 720: 2.5, 1080: 4.5, 1440: 9, 2160: 20}
JOBS, CACHE, LOCK = {}, {}, threading.Lock()
SEM = threading.BoundedSemaphore(MAX_JOBS)

HARD = ('private video', 'confirm your age', 'age-restricted', 'members-only', 'join this channel',
        'not available in your country', 'blocked it', 'live event', 'premieres', 'video unavailable',
        'removed by the uploader', 'sign in', 'not a bot', '429', 'too many requests')

def clean(s):
    return ANSI.sub('', str(s or '')).strip()

def parse(u):
    u = u or ''
    v, l = VID.search(u), LST.search(u)
    return (v.group(1) if v else None), (l.group(1) if l else None)

def fmt_dur(s):
    h, r = divmod(int(s), 3600)
    m, s = divmod(r, 60)
    return f'{h}:{m:02d}:{s:02d}' if h else f'{m}:{s:02d}'

def is_hard(e):
    low = clean(e).lower()
    return any(k in low for k in HARD)

def friendly(e):
    m = clean(e).replace('ERROR: ', '')
    low = m.lower()
    if 'private video' in low: return 'This video is private.'
    if 'confirm your age' in low or 'age-restricted' in low: return 'Age-restricted video. Add cookies.txt from a logged-in account to download it.'
    if 'members-only' in low or 'join this channel' in low: return 'Members-only video. It needs cookies from a member account.'
    if 'not available in your country' in low or 'blocked it' in low: return "This video is blocked in the server's country."
    if 'live event' in low or 'premieres' in low: return 'This is a live stream or premiere that is not finished yet.'
    if 'video unavailable' in low or 'removed by the uploader' in low: return 'This video is unavailable or was removed.'
    if '429' in m or 'too many requests' in low: return 'YouTube is rate limiting the server. Wait a minute and retry.'
    if 'sign in' in low or 'not a bot' in low: return 'YouTube wants a sign-in check from this server. Add cookies.txt.'
    if '403' in m: return 'YouTube refused the file (HTTP 403). Run: python -m pip install -U "yt-dlp[default]"'
    if 'requested format is not available' in low: return 'No downloadable format was found for this video. Update yt-dlp and make sure Deno or Node is installed.'
    return m[:300]

@contextlib.contextmanager
def scratch():
    d = tempfile.mkdtemp(dir=TMP)
    try: yield d
    finally: shutil.rmtree(d, ignore_errors=True)

def base_opts(workdir):
    o = {
        'quiet': not YT_DEBUG, 'no_warnings': not YT_DEBUG, 'verbose': YT_DEBUG, 'noplaylist': True,
        'retries': 3, 'fragment_retries': 3,
        'socket_timeout': 15,
        # YouTube ke n-challenge ke liye JS runtime (Deno ya Node) + yt-dlp-ejs chahiye, warna sirf 360p milta hai.
        'js_runtimes': {'deno': {}, 'node': {}}, 'remote_components': ['ejs:github'],
        'source_address': '0.0.0.0',
    }
    # NOTE: pehle yahan player_client = ios/android/web force kiya tha. Wahi 360p ki problem thi:
    # ios/android clients ko PO token chahiye hota hai (nahi mila to sirf format 18 = 360p milta hai),
    # aur ios client cookies ignore karta hai. Isliye ab yt-dlp ke default clients use hote hain.
    if YT_CLIENTS:
        o['extractor_args'] = {'youtube': {'player_client': YT_CLIENTS}}
    if FFMPEG:
        o['ffmpeg_location'] = FFMPEG
    if COOKIE_SRC:
        c = os.path.join(workdir, 'cookies.txt')
        shutil.copyfile(COOKIE_SRC, c)
        o['cookiefile'] = c
    elif os.environ.get('COOKIES_BROWSER'):
        o['cookiesfrombrowser'] = (os.environ['COOKIES_BROWSER'],)
    return o

def cached(key, fn, ttl=600):
    now = time.time()
    hit = CACHE.get(key)
    if hit and now - hit[0] < ttl: return hit[1]
    val = fn()
    CACHE[key] = (now, val)
    if len(CACHE) > 60:
        for k in sorted(CACHE, key=lambda k: CACHE[k][0])[:20]:
            CACHE.pop(k, None)
    return val

def client_ip():
    return (request.headers.get('X-Forwarded-For') or request.remote_addr or '').split(',')[0].strip()

def wipe(jid, only_idle=False):
    j = JOBS.get(jid)
    if only_idle and j and j['conns'] > 0: return
    JOBS.pop(jid, None)
    shutil.rmtree(os.path.join(TMP, jid), ignore_errors=True)

def guess_mb(res, secs):
    near = min(MBPS, key=lambda k: abs(k - res))
    return round((MBPS[near] * 125000 * secs + 16000 * secs) / 1048576, 1)

def res_of(f):
    m = re.match(r'(\d{3,4})p', f.get('format_note') or '')
    if m: return int(m.group(1))
    w, h = f.get('width'), f.get('height')
    return min(w, h) if w and h else (h or 0)

def video_summary(vid):
    with scratch() as d:
        with yt_dlp.YoutubeDL({**base_opts(d), 'skip_download': True}) as y:
            i = y.extract_info(f'https://www.youtube.com/watch?v={vid}', download=False)
    secs = int(i.get('duration') or 0)
    fm = i.get('formats') or []

    def size(f):
        return f.get('filesize') or f.get('filesize_approx') or ((f.get('tbr') or 0) * 125 * secs) or 0

    a_fmts = [f for f in fm if f.get('vcodec') == 'none' and f.get('acodec') not in (None, 'none')]
    pool = [f for f in a_fmts if f.get('ext') == 'm4a'] or a_fmts
    audio = max([size(f) for f in pool] or [0]) or 16000 * secs

    groups = {}
    for f in fm:
        if f.get('vcodec') not in (None, 'none') and res_of(f):
            groups.setdefault(res_of(f), []).append(f)
    keys = [r for r in groups if r in STD_RES] or list(groups)
    options = []
    for r in sorted(keys, reverse=True):
        if r > MAX_HEIGHT: continue
        g = groups[r]
        cand = [f for f in g if str(f.get('vcodec') or '').startswith('avc1')] or g
        s = max(size(f) for f in cand)
        options.append(dict(v=r, mb=round((s + audio) / 1048576, 1) if s else guess_mb(r, secs)))

    print(f'INFO {vid}: heights found = {sorted(groups, reverse=True)[:8]}')
    manual = {k for k in (i.get('subtitles') or {}) if k != 'live_chat'}
    auto = i.get('automatic_captions') or {}
    return dict(
        status='success', title=i.get('title', 'Untitled'), channel=i.get('uploader'), views=i.get('view_count'),
        date=i.get('upload_date'), thumb=f'https://i.ytimg.com/vi/{vid}/mqdefault.jpg', thumbnail=i.get('thumbnail'),
        seconds=secs, duration=fmt_dur(secs), options=options, audio_size=round(audio / 1048576, 1),
        subs=sorted(manual)[:20] + [l for l in ('en', 'hi') if l in auto and l not in manual],
    )

@app.post('/api/info')
def info():
    vid, _ = parse((request.get_json(silent=True) or {}).get('url'))
    if not vid: return jsonify(status='error', message='Invalid YouTube link.'), 400
    try: return jsonify(cached('v:' + vid, lambda: video_summary(vid)))
    except Exception as e:
        print('INFO ERROR:', clean(e))
        return jsonify(status='error', message=friendly(e)), 400

def playlist_summary(lst):
    with scratch() as d:
        o = {**base_opts(d), 'noplaylist': False, 'extract_flat': 'in_playlist', 'skip_download': True, 'playlistend': MAX_PLAYLIST}
        with yt_dlp.YoutubeDL(o) as y:
            i = y.extract_info(f'https://www.youtube.com/playlist?list={lst}', download=False)
    entries = []
    for e in i.get('entries') or []:
        if not e or not re.fullmatch(r'[\w-]{11}', e.get('id') or ''): continue
        if (e.get('title') or '') in ('[Private video]', '[Deleted video]'): continue
        entries.append(dict(id=e['id'], title=e.get('title') or e['id'],
                            duration=fmt_dur(e['duration']) if e.get('duration') else '',
                            thumb=f"https://i.ytimg.com/vi/{e['id']}/default.jpg"))
    return dict(status='success', title=i.get('title') or 'Playlist', channel=i.get('uploader') or i.get('channel'),
                entries=entries, total=i.get('playlist_count') or len(entries), limit=MAX_PLAYLIST)

@app.post('/api/playlist')
def playlist():
    _, lst = parse((request.get_json(silent=True) or {}).get('url'))
    if not lst: return jsonify(status='error', message='This link has no playlist.'), 400
    try: return jsonify(cached('p:' + lst, lambda: playlist_summary(lst)))
    except Exception as e:
        print('PLAYLIST ERROR:', clean(e))
        return jsonify(status='error', message=friendly(e)), 400

def run_job(job, p):
    jobdir = os.path.join(TMP, job['id'])
    streams = 2 if p['fmt'] == 'mp4' else 1
    seen = {'n': 0, 'b': 0}

    def touch(**kw):
        job.update(kw)
        job['updated'] = time.time()

    def hook(h):
        if job['cancel']: raise DownloadCancelled('Cancelled')
        if not (h.get('info_dict') or {}).get('format_id'): return
        if h['status'] == 'downloading':
            dl = h.get('downloaded_bytes') or 0
            tot = h.get('total_bytes') or h.get('total_bytes_estimate') or 0
            frac = min(dl / tot, 1) if tot else 0
            mb = (seen['b'] + dl) / 1048576
            total = max(job['est'], mb) if job['est'] else None
            touch(percent=min(round((seen['n'] + frac) / streams * 92, 1), 92), status='Downloading',
                  speed=clean(h.get('_speed_str')), eta=clean(h.get('_eta_str')),
                  mb_done=round(mb, 1), mb_total=round(total, 1) if total else None)
        elif h['status'] == 'finished':
            seen['n'] += 1
            seen['b'] += h.get('total_bytes') or h.get('downloaded_bytes') or 0
            if seen['n'] >= streams:
                touch(percent=95, status='Processing', speed='', eta='')

    def build(extras, basic):
        o = base_opts(jobdir)
        o.update(outtmpl=f'{jobdir}/%(title).80s.%(ext)s', progress_hooks=[hook], concurrent_fragment_downloads=4 if IS_RENDER else 8)
        if IS_RENDER: o['postprocessor_args'] = {'ffmpeg': ['-threads', '2']}
        if MAX_MB: o['max_filesize'] = MAX_MB * 1048576
        pps = []
        if p['fmt'] == 'mp4':
            if basic: o['format'] = 'b'
            else:
                # 1080p tak h264 (sabse compatible). 1440p/2160p par YouTube sirf VP9/AV1 deta hai,
                # isliye wahan VP9 prefer karte hain (AV1 se kam heavy, zyada players me chalta hai).
                codec = 'vcodec:h264' if p['q'] <= 1080 else 'vcodec:vp9'
                o.update(format='bv*+ba/b', format_sort=[f"res:{p['q']}", codec, 'acodec:aac'])
            o['merge_output_format'] = 'mp4'
            if extras and p['sub']:
                o.update(writesubtitles=True, writeautomaticsub=True, subtitleslangs=[p['sub']])
                pps.append({'key': 'FFmpegEmbedSubtitle'})
        else:
            o['format'] = 'bestaudio[ext=m4a]/bestaudio/best'
            pps.append({'key': 'FFmpegExtractAudio', 'preferredcodec': p['fmt'], 'preferredquality': p['abr']})
            if extras and p['cover']:
                o['writethumbnail'] = True
                pps = ([{'key': 'FFmpegThumbnailsConvertor', 'format': 'jpg', 'when': 'before_dl'}] + pps +
                       [{'key': 'FFmpegMetadata', 'add_metadata': True}, {'key': 'EmbedThumbnail'}])
        o['postprocessors'] = pps
        if p['limit']: o['ratelimit'] = p['limit']
        if p['clip']: o.update(download_ranges=download_range_func(None, [p['clip']]), force_keyframes_at_cuts=True)
        return o

    def run(extras, basic):
        seen.update(n=0, b=0)
        with yt_dlp.YoutubeDL(build(extras, basic)) as y:
            y.download([f"https://www.youtube.com/watch?v={p['vid']}"])

    plan = [(True, False)]
    if p['sub'] or p['cover']: plan.append((False, False))
    if p['fmt'] == 'mp4': plan.append((False, True))

    with SEM:
        if job['cancel']: return touch(state='cancelled', status='Cancelled')
        touch(state='running', status='Starting')
        try:
            os.makedirs(jobdir, exist_ok=True)
            err = first = None
            for n, (extras, basic) in enumerate(plan):
                try:
                    if n:
                        shutil.rmtree(jobdir, ignore_errors=True)
                        os.makedirs(jobdir)
                        touch(status='Trying a simpler format')
                    run(extras, basic)
                    if basic: job['note'] = 'Saved in a lower quality because the best format was not available.'
                    elif n and (p['sub'] or p['cover']): job['note'] = 'Saved without subtitles/cover art because they could not be added.'
                    err = None
                    break
                except Exception as ex:
                    print(f'ATTEMPT {n + 1}/{len(plan)} FAILED:', clean(ex))
                    if job['cancel'] or is_hard(ex): raise
                    first = first or ex   # pehli (asli) error dikhayenge, 360p fallback ki nahi
                    err = ex
            if err is not None: raise first
            files = [f for f in os.listdir(jobdir) if f.lower().endswith(MEDIA)]
            if not files: raise RuntimeError('Nothing was downloaded. The video may be bigger than the server limit; try a lower quality.')
            f = max(files, key=lambda n: os.path.getsize(os.path.join(jobdir, n)))
            path = os.path.join(jobdir, f)
            size = round(os.path.getsize(path) / 1048576, 1)
            touch(state='ready', percent=100, status='Ready', speed='', eta='', file=path, name=f, size=size, mb_done=size, mb_total=size)
        except Exception as ex:
            was = job['cancel']
            shutil.rmtree(jobdir, ignore_errors=True)
            print('DOWNLOAD ERROR:', clean(ex))
            touch(state='cancelled' if was else 'error', status='Cancelled' if was else 'Failed', error=None if was else friendly(ex))

@app.post('/api/download')
def download():
    d = request.get_json(silent=True) or {}
    vid, _ = parse(d.get('url'))
    if not vid: return jsonify(status='error', message='Invalid YouTube link.'), 400
    ip = client_ip()
    with LOCK:
        live = [j for j in JOBS.values() if j['state'] in ('queued', 'running')]
        if len(live) >= MAX_QUEUE or sum(j['ip'] == ip for j in live) >= MAX_PER_IP:
            return jsonify(status='error', message='Server is busy. Please try again in a minute.'), 429
    if shutil.disk_usage(TMP).free / 1048576 < MIN_FREE_MB:
        return jsonify(status='error', message='Server storage is almost full. Please try again shortly.'), 503

    fmt = d.get('format') if d.get('format') in ('mp4', 'mp3', 'm4a') else 'mp4'
    q = str(d.get('quality', '1080'))
    s, e = d.get('start'), d.get('end')
    p = dict(
        vid=vid, fmt=fmt, q=min(int(q) if q.isdigit() else 1080, MAX_HEIGHT),
        abr=str(d.get('abr')) if str(d.get('abr')) in ('128', '192', '320') else '192',
        sub=re.sub(r'[^\w-]', '', str(d.get('sub') or ''))[:12] if fmt == 'mp4' else '',
        cover=fmt != 'mp4' and bool(d.get('cover', True)),
        limit=int(float(d['limit']) * 1048576) if str(d.get('limit')) in ('1', '2', '5', '10') else 0,
        clip=(s, e) if isinstance(s, (int, float)) and isinstance(e, (int, float)) and e > s >= 0 else None,
    )
    est = None
    hit = CACHE.get('v:' + vid)
    if hit:
        sm = hit[1]
        if fmt == 'mp4': est = next((o['mb'] for o in sm['options'] if o['v'] == p['q']), None)
        elif fmt == 'm4a': est = sm['audio_size']
        else: est = round(sm['seconds'] * int(p['abr']) / 8 / 1024, 1)
    jid = uuid.uuid4().hex[:16]
    job = dict(id=jid, state='queued', percent=0, status='Waiting in queue', speed='', eta='', ip=ip,
               created=time.time(), updated=time.time(), cancel=False, file=None, name=None, size=None,
               error=None, conns=0, est=est, mb_done=0, mb_total=est, note=None)
    JOBS[jid] = job
    threading.Thread(target=run_job, args=(job, p), daemon=True).start()
    return jsonify(status='success', job=jid)

@app.get('/api/status/<jid>')
def status(jid):
    j = JOBS.get(re.sub(r'\W', '', jid))
    if not j: return jsonify(state='gone'), 404
    out = {k: j[k] for k in ('state', 'percent', 'status', 'speed', 'eta', 'name', 'size', 'error', 'mb_done', 'mb_total', 'note')}
    out['ahead'] = sum(1 for x in JOBS.values() if x['state'] == 'queued' and x['created'] < j['created']) if j['state'] == 'queued' else 0
    return jsonify(out)

@app.post('/api/cancel')
def cancel():
    jid = re.sub(r'\W', '', str((request.get_json(silent=True) or {}).get('job') or ''))
    j = JOBS.get(jid)
    if j:
        j['cancel'] = True
        if j['state'] in ('ready', 'delivered'): wipe(jid, True)
    return jsonify(status='ok')

@app.get('/api/file/<jid>')
def get_file(jid):
    jid = re.sub(r'\W', '', jid)
    j = JOBS.get(jid)
    if not j or j['state'] not in ('ready', 'sending', 'delivered') or not j.get('file') or not os.path.isfile(j['file']): abort(404)
    with LOCK: j['conns'] += 1
    j.update(state='sending', updated=time.time())

    def done():
        with LOCK:
            j['conns'] -= 1
            idle = j['conns'] <= 0
        if idle:
            j.update(state='delivered', updated=time.time())
            t = threading.Timer(15, wipe, args=(jid, True))
            t.daemon = True
            t.start()

    def body():
        try:
            with open(j['file'], 'rb') as f:
                while True:
                    chunk = f.read(262144)
                    if not chunk: break
                    yield chunk
        finally: done()

    name = j['name']
    ascii_name = name.encode('ascii', 'ignore').decode().replace('"', '') or 'video.mp4'
    resp = Response(body(), mimetype=mimetypes.guess_type(name)[0] or 'application/octet-stream')
    resp.headers['Content-Length'] = str(os.path.getsize(j['file']))
    resp.headers['Content-Disposition'] = f'attachment; filename="{ascii_name}"; filename*=UTF-8\'\'{quote(name)}'
    resp.headers['Cache-Control'] = 'no-store'
    resp.headers['X-Accel-Buffering'] = 'no'
    return resp

@app.get('/api/health')
def health():
    return jsonify(
        ok=True, yt_dlp=yt_dlp.version.__version__, render=IS_RENDER,
        ffmpeg=bool(shutil.which('ffmpeg') or FFMPEG), node=bool(shutil.which('node')), deno=bool(shutil.which('deno')),
        ejs=importlib.util.find_spec('yt_dlp_ejs') is not None, clients=YT_CLIENTS or 'default',
        cookies=bool(COOKIE_SRC), max_height=MAX_HEIGHT, max_playlist=MAX_PLAYLIST, max_mb=MAX_MB, max_jobs=MAX_JOBS,
        jobs=len(JOBS), free_mb=int(shutil.disk_usage(TMP).free / 1048576),
    )

def janitor():
    while True:
        time.sleep(30)
        now = time.time()
        for jid, j in list(JOBS.items()):
            age = now - j['updated']
            st = j['state']
            if (st == 'ready' and age > READY_TTL) or (st == 'sending' and age > 3600) or (st in ('delivered', 'error', 'cancelled') and age > 120):
                wipe(jid, True)
            elif st == 'running' and age > 3600: j['cancel'] = True
        for n in os.listdir(TMP):
            p = os.path.join(TMP, n)
            try:
                if n not in JOBS and now - os.path.getmtime(p) > 300: shutil.rmtree(p, ignore_errors=True)
            except OSError: pass

threading.Thread(target=janitor, daemon=True).start()

@app.route('/')
def index():
    try: return send_from_directory(app.static_folder, 'index.html')
    except Exception: return jsonify(ok=True, message='Vidgo API is running. Build the frontend into ./dist to serve the UI here.')

@app.route('/<path:path>')
def static_proxy(path):
    return send_from_directory(app.static_folder, path)

if __name__ == '__main__':
    app.run(host='0.0.0.0', port=int(os.environ.get('PORT', 5000)), threaded=True)
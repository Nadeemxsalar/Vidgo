import os, re, time, json, uuid, shutil, tempfile, threading
from flask import Flask, request, jsonify, send_file, Response, send_from_directory, abort
from flask_cors import CORS
import yt_dlp
from yt_dlp.utils import download_range_func, DownloadCancelled

BASE = os.path.dirname(os.path.abspath(__file__))
# Files are built in the OS temp folder (NOT inside your project) and wiped right after Chrome receives them.
TMP = os.path.join(tempfile.gettempdir(), 'vidgo_tmp')
COOKIES = os.path.join(BASE, 'cookies.txt')   # optional: cookies exported from Chrome (Netscape format)
os.makedirs(TMP, exist_ok=True)

app = Flask(__name__, static_folder='dist', static_url_path='/')
CORS(app, expose_headers=['Content-Disposition'])

IS_RENDER = bool(os.environ.get('RENDER'))
progress, cancelled, jobs = {}, set(), {}
ANSI = re.compile(r'\x1b\[[0-9;]*m')
VID = re.compile(r'(?:v=|youtu\.be/|shorts/|live/|embed/)([\w-]{11})')
MEDIA = ('.mp4', '.mp3', '.m4a', '.mkv', '.webm', '.opus')


def clean(s):
    return ANSI.sub('', str(s or '')).strip()


def clean_url(u):
    m = VID.search(u or '')
    return f'https://www.youtube.com/watch?v={m.group(1)}' if m else None


def fmt_dur(s):
    h, r = divmod(int(s), 3600)
    m, s = divmod(r, 60)
    return f'{h}:{m:02d}:{s:02d}' if h else f'{m}:{s:02d}'


def friendly(e):
    m = clean(e).replace('ERROR: ', '')
    if '403' in m:
        m += ' | Fix: python -m pip install -U "yt-dlp[default]" and restart app.py.'
    elif 'Sign in' in m or 'bot' in m.lower():
        m += ' | Fix: export YouTube cookies to cookies.txt next to app.py.'
    return m


def base_opts():
    o = {
        'quiet': True, 'no_warnings': True, 'noplaylist': True,
        'nocheckcertificate': True, 'retries': 5, 'fragment_retries': 5,
        'js_runtimes': {'deno': {}, 'node': {}},
        'remote_components': ['ejs:github'],
    }
    if os.path.exists(COOKIES):
        o['cookiefile'] = COOKIES
    elif os.environ.get('COOKIES_BROWSER'):
        o['cookiesfrombrowser'] = (os.environ['COOKIES_BROWSER'],)
    return o


def wipe(tid):
    jobs.pop(tid, None)
    progress.pop(tid, None)
    shutil.rmtree(os.path.join(TMP, tid), ignore_errors=True)


@app.post('/api/info')
def info():
    url = clean_url((request.json or {}).get('url'))
    if not url:
        return jsonify(status='error', message='Invalid YouTube link.'), 400
    try:
        with yt_dlp.YoutubeDL({**base_opts(), 'skip_download': True}) as y:
            i = y.extract_info(url, download=False)
    except Exception as e:
        print('INFO ERROR:', clean(e))
        return jsonify(status='error', message=friendly(e)), 400

    secs = int(i.get('duration') or 0)
    fm = i.get('formats') or []

    def size(f):
        return f.get('filesize') or f.get('filesize_approx') or ((f.get('tbr') or 0) * 125 * secs) or 0

    audio = max([size(f) for f in fm if f.get('vcodec') == 'none' and f.get('acodec') != 'none'] or [0])
    sizes = {}
    heights = {f['height'] for f in fm if f.get('vcodec') not in (None, 'none') and f.get('height')}
    for h in (144, 360, 480, 720, 1080, 1440, 2160):
        s = max([size(f) for f in fm if f.get('height') == h and f.get('vcodec') != 'none'] or [0])
        if s:
            sizes[str(h)] = round((s + audio) / 1048576, 1)

    manual = {k for k in (i.get('subtitles') or {}) if k != 'live_chat'}
    auto = i.get('automatic_captions') or {}
    subs = sorted(manual)[:20] + [l for l in ('en', 'hi') if l in auto and l not in manual]

    return jsonify(
        status='success', title=i.get('title', 'Untitled'), channel=i.get('uploader'),
        views=i.get('view_count'), date=i.get('upload_date'), thumbnail=i.get('thumbnail'),
        seconds=secs, duration=fmt_dur(secs), heights=sorted(heights), sizes=sizes, subs=subs,
        audio_size=round(audio / 1048576, 1) if audio else None,
    )


@app.get('/api/progress/<tid>')
def stream(tid):
    def gen():
        while True:
            d = progress.get(tid, {'percent': 0, 'status': 'Waiting for server...'})
            yield f'data: {json.dumps(d)}\n\n'
            if d['percent'] >= 100 or d.get('error'):
                break
            time.sleep(0.5)
    return Response(gen(), mimetype='text/event-stream',
                    headers={'Cache-Control': 'no-cache', 'X-Accel-Buffering': 'no'})


@app.post('/api/cancel')
def cancel():
    tid = (request.json or {}).get('task_id')
    if tid:
        cancelled.add(tid)
    return jsonify(status='ok')


@app.post('/api/download')
def download():
    d = request.json or {}
    url = clean_url(d.get('url'))
    if not url:
        return jsonify(status='error', message='Invalid YouTube link.'), 400

    tid = re.sub(r'[^\w-]', '', str(d.get('task_id') or '')) [:48] or uuid.uuid4().hex
    fmt = d.get('format') if d.get('format') in ('mp4', 'mp3', 'm4a') else 'mp4'
    q = str(d.get('quality', '1080'))
    q = q if q.isdigit() else '1080'
    abr = str(d.get('abr', '192'))
    abr = abr if abr in ('128', '192', '320') else '192'
    sub = re.sub(r'[^\w-]', '', str(d.get('sub') or ''))[:12] if fmt == 'mp4' else ''
    want_cover = fmt != 'mp4' and bool(d.get('cover', True))
    limit = int(float(d['limit']) * 1048576) if str(d.get('limit')) in ('1', '2', '5', '10') else 0
    s, e = d.get('start'), d.get('end')
    clip = isinstance(s, (int, float)) and isinstance(e, (int, float)) and e > s >= 0

    jobdir = os.path.join(TMP, tid)
    shutil.rmtree(jobdir, ignore_errors=True)
    os.makedirs(jobdir)
    streams = 2 if fmt == 'mp4' else 1
    seen = {'n': 0}
    progress[tid] = {'percent': 0, 'status': 'Starting...'}

    def hook(h):
        if tid in cancelled:
            raise DownloadCancelled('Cancelled')
        if not (h.get('info_dict') or {}).get('format_id'):   # ignore subtitle/thumbnail events
            return
        if h['status'] == 'downloading':
            tot = h.get('total_bytes') or h.get('total_bytes_estimate') or 0
            frac = min(h.get('downloaded_bytes', 0) / tot, 1) if tot else 0
            progress[tid] = {
                'percent': min(round((seen['n'] + frac) / streams * 92, 1), 92), 'status': 'Downloading',
                'speed': clean(h.get('_speed_str')), 'eta': clean(h.get('_eta_str')),
            }
        elif h['status'] == 'finished':
            seen['n'] += 1
            if seen['n'] >= streams:
                progress[tid] = {'percent': 95, 'status': 'Processing with ffmpeg'}

    def build(cover):
        o = base_opts()
        o.update(outtmpl=f'{jobdir}/%(title).80s.%(ext)s', progress_hooks=[hook],
                 concurrent_fragment_downloads=4 if IS_RENDER else 8)
        pps = []
        if fmt == 'mp4':
            o.update(format=f'bv*[height<={q}]+ba/b[height<={q}]',
                     format_sort=['res', 'vcodec:h264', 'acodec:aac'], merge_output_format='mp4')
            if sub:
                o.update(writesubtitles=True, writeautomaticsub=True, subtitleslangs=[sub])
                pps.append({'key': 'FFmpegEmbedSubtitle'})
        else:
            o['format'] = 'bestaudio[ext=m4a]/bestaudio/best'
            pps.append({'key': 'FFmpegExtractAudio', 'preferredcodec': fmt, 'preferredquality': abr})
            if cover:   # cover art + title/artist tags inside the audio file
                o['writethumbnail'] = True
                pps = ([{'key': 'FFmpegThumbnailsConvertor', 'format': 'jpg', 'when': 'before_dl'}] + pps +
                       [{'key': 'FFmpegMetadata', 'add_metadata': True}, {'key': 'EmbedThumbnail'}])
        o['postprocessors'] = pps
        if limit:
            o['ratelimit'] = limit
        if clip:
            o.update(download_ranges=download_range_func(None, [(s, e)]), force_keyframes_at_cuts=True)
        return o

    def run(cover):
        seen['n'] = 0
        with yt_dlp.YoutubeDL(build(cover)) as y:
            y.download([url])

    try:
        try:
            run(want_cover)
        except Exception:
            if not want_cover or tid in cancelled:
                raise
            shutil.rmtree(jobdir, ignore_errors=True)   # cover art failed -> retry without it
            os.makedirs(jobdir)
            run(False)
        files = [f for f in os.listdir(jobdir) if f.lower().endswith(MEDIA)]
        if not files:
            raise RuntimeError('File not found after processing.')
        f = max(files, key=lambda n: os.path.getsize(os.path.join(jobdir, n)))
        jobs[tid] = os.path.join(jobdir, f)
        progress[tid] = {'percent': 100, 'status': 'Ready'}
        return jsonify(status='success', filename=f, size=round(os.path.getsize(jobs[tid]) / 1048576, 1))
    except Exception as ex:
        was_cancelled = tid in cancelled
        cancelled.discard(tid)
        progress[tid] = {'percent': 0, 'status': 'Cancelled' if was_cancelled else 'Failed', 'error': True}
        shutil.rmtree(jobdir, ignore_errors=True)
        print('DOWNLOAD ERROR:', clean(ex))
        return jsonify(status='error', message='Cancelled' if was_cancelled else friendly(ex)), 499 if was_cancelled else 500


@app.get('/api/file/<tid>')
def get_file(tid):
    tid = re.sub(r'[^\w-]', '', tid)
    p = jobs.get(tid)
    if not p or not os.path.isfile(p):
        abort(404)
    resp = send_file(p, as_attachment=True, download_name=os.path.basename(p))   # Chrome saves it directly
    resp.call_on_close(lambda: threading.Timer(30, wipe, args=(tid,)).start())   # wipe after it is sent
    return resp


def janitor():
    """Safety net: remove leftover temp folders older than 15 minutes."""
    while True:
        time.sleep(300)
        now = time.time()
        for n in os.listdir(TMP):
            p = os.path.join(TMP, n)
            try:
                if now - os.path.getmtime(p) > 900:
                    shutil.rmtree(p, ignore_errors=True)
                    jobs.pop(n, None)
            except OSError:
                pass


threading.Thread(target=janitor, daemon=True).start()


@app.route('/')
def index():
    return send_from_directory(app.static_folder, 'index.html')


@app.route('/<path:path>')
def static_proxy(path):
    return send_from_directory(app.static_folder, path)


if __name__ == '__main__':
    app.run(host='0.0.0.0', port=int(os.environ.get('PORT', 5000)), threaded=True)
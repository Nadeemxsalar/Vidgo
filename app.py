import os
import glob
import uuid
import time
import re
import json
from flask import Flask, request, jsonify, send_file, Response, send_from_directory
from flask_cors import CORS
import yt_dlp

app = Flask(__name__, static_folder='dist', static_url_path='/')
CORS(app)

DOWNLOAD_FOLDER = 'downloads'
if not os.path.exists(DOWNLOAD_FOLDER):
    os.makedirs(DOWNLOAD_FOLDER)

IS_RENDER = os.environ.get('RENDER') is not None
progress_tracker = {}

# 🌟 LINK CLEANER FUNCTION 🌟
def clean_url(url):
    if not url: return ""
    if '?si=' in url:
        return url.split('?si=')[0]
    elif '&si=' in url:
        return url.split('&si=')[0]
    return url

# 🌟 ULTIMATE BYPASS SETTINGS (Render Anti-Bot Bypass) 🌟
def get_bypass_opts():
    return {
        'quiet': True,
        'no_warnings': True,
        'nocheckcertificate': True,
        # 'geo_bypass' ko hata diya hai kyuki Render par ye YouTube ko alert kar deta hai
        
        # ios aur mweb (Mobile Web) sabse zyada safe hain bot detection bypass ke liye
        'extractor_args': {'youtube': ['player_client=ios,mweb,android']},
        
        'http_headers': {
            # Ekdum real iPhone ka User-Agent taaki Render ka IP mobile jaisa lage
            'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1',
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            'Accept-Language': 'en-US,en;q=0.9',
            'Sec-Fetch-Mode': 'navigate',
        },
        'sleep_interval_requests': 1, # YouTube ko lage ki insaan click kar raha hai (1 sec delay)
    }

@app.route('/')
def serve():
    return send_from_directory(app.static_folder, 'index.html')

@app.route('/<path:path>')
def static_proxy(path):
    return send_from_directory(app.static_folder, path)

# 🌟 1. Video Info Fetcher 🌟
@app.route('/api/info', methods=['POST'])
def get_info():
    raw_url = request.json.get('url', '')
    url = clean_url(raw_url)
    
    try:
        info_opts = get_bypass_opts()
        
        with yt_dlp.YoutubeDL(info_opts) as ydl:
            info = ydl.extract_info(url, download=False)
            formats = info.get('formats', [])
            
            best_audio_size = 0
            for f in formats:
                if f.get('vcodec') == 'none' and f.get('acodec') != 'none':
                    size = f.get('filesize') or f.get('filesize_approx') or 0
                    if size > best_audio_size:
                        best_audio_size = size
            
            sizes_mb = {}
            for res in ["144", "360", "480", "720", "1080", "1440", "2160"]:
                res_size = 0
                for f in formats:
                    if str(f.get('height')) == res:
                        size = f.get('filesize') or f.get('filesize_approx') or 0
                        if size > res_size:
                            res_size = size
                
                if res_size > 0:
                    total_size = res_size + best_audio_size
                    sizes_mb[res] = round(total_size / (1024 * 1024), 1)
            
            audio_mb = round(best_audio_size / (1024 * 1024), 1) if best_audio_size > 0 else None

            return jsonify({
                "title": info.get('title', 'Vidgo Media'),
                "duration": f"{info.get('duration', 0) // 60}:{info.get('duration', 0) % 60:02d}",
                "thumbnail": info.get('thumbnail'),
                "sizes": sizes_mb,        
                "audio_size": audio_mb,   
                "status": "success"
            })
    except Exception as e:
        print(f"❌ INFO API ERROR: {str(e)}")
        return jsonify({"status": "error", "message": str(e)}), 400

# 🌟 2. Real-time Progress Stream (Fixed JSON Format) 🌟
@app.route('/api/progress/<task_id>')
def progress_stream(task_id):
    def generate():
        while True:
            data = progress_tracker.get(task_id, {"percent": 0, "status": "Starting..."})
            yield f"data: {json.dumps(data)}\n\n"
            if data.get("percent") >= 100 or data.get("status") == "Error":
                break
            time.sleep(0.5)
    return Response(generate(), mimetype='text/event-stream')

# 🌟 3. Main Downloader & Merger 🌟
@app.route('/api/download', methods=['POST'])
def download_video():
    data = request.json
    raw_url = data.get('url', '')
    url = clean_url(raw_url)
    quality = data.get('quality', '1080')
    format_type = data.get('format', 'mp4')
    task_id = data.get('task_id') 
    
    unique_prefix = f"{uuid.uuid4().hex[:8]}" 
    progress_tracker[task_id] = {"percent": 0, "status": "Initializing..."}

    def progress_hook(d):
        if d['status'] == 'downloading':
            percent_str = re.sub(r'\x1b\[[0-9;]*m', '', d.get('_percent_str', '0%')).replace('%', '').strip()
            try:
                percent = float(percent_str)
                progress_tracker[task_id] = {"percent": percent, "status": f"Downloading at {d.get('_speed_str', 'N/A')}"}
            except:
                pass
        elif d['status'] == 'finished':
            progress_tracker[task_id] = {"percent": 99, "status": "Merging Audio/Video (Please wait)..."}

    ydl_opts = get_bypass_opts()
    ydl_opts.update({
        'outtmpl': f'{DOWNLOAD_FOLDER}/{unique_prefix}_%(title)s.%(ext)s',
        'progress_hooks': [progress_hook],
    })

    # 🌟 MAX SPEED SETTINGS 🌟
    if IS_RENDER:
        # Render Free Tier RAM limit bypass with maximum safe speed
        ydl_opts['concurrent_fragment_downloads'] = 4 
        ydl_opts['http_chunk_size'] = 10485760 
        postprocessor_args = ['-threads', '2', '-max_muxing_queue_size', '2048'] 
    else:
        # Localhost Ultimate Speed
        ydl_opts['concurrent_fragment_downloads'] = 8
        postprocessor_args = ['-threads', '0'] 

    if format_type == 'mp3':
        ydl_opts.update({
            'format': 'bestaudio/best',
            'postprocessors': [{'key': 'FFmpegExtractAudio', 'preferredcodec': 'mp3', 'preferredquality': '192'}],
            'postprocessor_args': postprocessor_args
        })
    else:
        ydl_opts.update({
            'format': f'bestvideo[height<={quality}][ext=mp4]+bestaudio[ext=m4a]/best[height<={quality}][ext=mp4]/best',
            'merge_output_format': 'mp4',
            'postprocessor_args': postprocessor_args
        })

    try:
        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            ydl.download([url])

        progress_tracker[task_id] = {"percent": 100, "status": "Ready!"}
        
        files = glob.glob(f'{DOWNLOAD_FOLDER}/{unique_prefix}_*')
        if not files:
            raise Exception("File not found after processing!")
            
        filename = os.path.basename(files[0])
        return jsonify({"status": "success", "filename": filename})
        
    except Exception as e:
        progress_tracker[task_id] = {"percent": 0, "status": "Error"}
        print(f"❌ DOWNLOAD API ERROR: {str(e)}")
        return jsonify({"status": "error", "message": str(e)}), 500

@app.route('/api/serve/<path:filename>', methods=['GET'])
def serve_file(filename):
    return send_file(os.path.join(DOWNLOAD_FOLDER, filename), as_attachment=True)

@app.route('/api/cleanup', methods=['GET'])
def cleanup():
    now = time.time()
    for f in os.listdir(DOWNLOAD_FOLDER):
        filepath = os.path.join(DOWNLOAD_FOLDER, f)
        if os.stat(filepath).st_mtime < now - 3600:
            os.remove(filepath)
    return jsonify({"status": "cleaned"})

if __name__ == '__main__':
    port = int(os.environ.get("PORT", 5000))
    app.run(host='0.0.0.0', port=port, threaded=True)
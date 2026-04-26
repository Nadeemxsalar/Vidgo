import yt_dlp

def download_4k_video(video_url, download_folder='.'):
    ydl_opts = {
        'format': 'bestvideo[height<=2160][ext=mp4]+bestaudio[ext=m4a]/best[height<=2160][ext=mp4]/best',
        'outtmpl': f'{download_folder}/%(title)s.%(ext)s',
        'merge_output_format': 'mp4',
        'quiet': False, 
    }

    try:
        print("\n⏳ Video details fetch ho rahi hain, thoda wait kijiye...")
        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            ydl.download([video_url])
        print("\n✅ Badhai ho! Video 4K quality mein successfully download aur merge ho gayi hai!")
    
    except Exception as e:
        print(f"\n❌ Ek error aayi: {e}")

if __name__ == "__main__":
    print("="*40)
    print("   🚀 NADEEM'S 4K VIDEO DOWNLOADER   ")
    print("="*40)
    
    url = input("\n👉 YouTube Video ka URL paste karein: ")
    download_4k_video(url)
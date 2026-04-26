import { useState, useEffect } from 'react';
import axios from 'axios';
import './App.css'; 

// 🌟 Render & Localhost Auto-Detection 🌟
const API_BASE_URL = window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1"
  ? "http://localhost:5000"
  : "https://vidgo-tmmz.onrender.com";

function App() {
  const [url, setUrl] = useState('');
  const [quality, setQuality] = useState('1080'); // Default to Full HD
  const [format, setFormat] = useState('mp4');
  const [status, setStatus] = useState('');
  const [history, setHistory] = useState([]);
  
  const [videoInfo, setVideoInfo] = useState(null);
  const [phase, setPhase] = useState('idle'); // idle, fetching, processing
  const [progress, setProgress] = useState(0);
  const [liveMessage, setLiveMessage] = useState('');

  // 1. Smart API Fetcher (Thumbnail, Title & Size)
  useEffect(() => {
    const fetchInfo = async () => {
      if (!url.includes('youtu')) return;
      setPhase('fetching');
      try {
        // Dynamic URL used here
        const res = await axios.post(`${API_BASE_URL}/api/info`, { url });
        if (res.data.status === 'success') {
          setVideoInfo(res.data);
        }
      } catch (err) {
        console.log("Info error", err);
      }
      setPhase('idle');
    };

    const timer = setTimeout(() => {
      if (url) fetchInfo();
    }, 800);
    return () => clearTimeout(timer);
  }, [url]);

  const handlePaste = async () => {
    try {
      const text = await navigator.clipboard.readText();
      setUrl(text);
    } catch (err) {
      alert("Clipboard access required!");
    }
  };

  // 2. The Advanced Download Flow (Real-Time SSE)
  const handleDownload = async () => {
    if (!url) {
      setStatus('⚠️ Kripya valid YouTube URL enter karein!');
      return;
    }

    setPhase('processing');
    setProgress(0);
    setStatus('');
    setLiveMessage('📡 Server se connect ho raha hai...');
    
    // Generate unique Task ID for SSE Stream
    const taskId = `task_${Date.now()}`;
    
    // Start listening to real-time progress from backend (Dynamic URL)
    const eventSource = new EventSource(`${API_BASE_URL}/api/progress/${taskId}`);
    
    eventSource.onmessage = (event) => {
      // Safely parsing Python dict string to JSON
      const rawData = event.data.replace(/'/g, '"'); 
      try {
          const data = JSON.parse(rawData);
          setProgress(Math.round(data.percent));
          setLiveMessage(data.status);
          
          if (data.percent >= 100 || data.status === "Error") {
              eventSource.close();
          }
      } catch(e) {}
    };

    try {
      // Send download request with taskId (Dynamic URL)
      const response = await axios.post(`${API_BASE_URL}/api/download`, { url, quality, format, task_id: taskId });
      
      eventSource.close();
      setProgress(100);
      setLiveMessage('✅ File Ready! Chrome mein bhej rahe hain...');
      
      // Trigger Chrome Native Download directly (Dynamic URL)
      const fileName = encodeURIComponent(response.data.filename);
      window.location.href = `${API_BASE_URL}/api/serve/${fileName}`;

      setStatus('✅ Download Chrome mein start ho gaya hai!');
      
      // Add to Session History
      const newItem = {
        id: Date.now(),
        title: videoInfo ? videoInfo.title : url.substring(0, 30) + '...',
        type: format === 'mp4' ? `${quality}p Video` : 'Audio (MP3)'
      };
      setHistory([newItem, ...history].slice(0, 4));

      setTimeout(() => {
        setPhase('idle');
        setProgress(0);
        setLiveMessage('');
      }, 3500);
      
    } catch (error) {
      eventSource.close();
      setPhase('idle');
      setProgress(0);
      setLiveMessage('');
      setStatus('❌ Server error: Python terminal check karein.');
    }
  };

  // Professional SVG Icons Collection
  const Icons = {
    Link: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="icon"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"></path><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"></path></svg>,
    Video: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="icon"><rect x="2" y="2" width="20" height="20" rx="2.18" ry="2.18"></rect><line x1="7" y1="2" x2="7" y2="22"></line><line x1="17" y1="2" x2="17" y2="22"></line><line x1="2" y1="12" x2="22" y2="12"></line><line x1="2" y1="7" x2="7" y2="7"></line><line x1="2" y1="17" x2="7" y2="17"></line><line x1="17" y1="17" x2="22" y2="17"></line><line x1="17" y1="7" x2="22" y2="7"></line></svg>,
    Audio: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="icon"><path d="M9 18V5l12-2v13"></path><circle cx="6" cy="18" r="3"></circle><circle cx="18" cy="16" r="3"></circle></svg>,
    Settings: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="icon"><circle cx="12" cy="12" r="3"></circle><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"></path></svg>,
    Download: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="icon-btn"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="7 10 12 15 17 10"></polyline><line x1="12" y1="15" x2="12" y2="3"></line></svg>
  };

  const getStatusClass = () => {
    if (status.includes('✅')) return 'status-success';
    if (status.includes('❌') || status.includes('⚠️')) return 'status-error';
    return '';
  };

  return (
    <div className="glass-card">
      <div className="header">
        <h1 className="header-title">VIDGO PRO</h1>
        <p className="header-subtitle">Ultimate Creator Engine</p>
      </div>

      <div className="form-container">
        
        {/* Media Link Section */}
        <div className="input-group">
          <label className="input-label">Media Link</label>
          <div className="input-row">
            <div className="input-wrapper">
              {Icons.Link}
              <input 
                type="text" 
                placeholder="Paste YouTube link here..."
                className="custom-input with-icon"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                disabled={phase === 'processing'}
              />
            </div>
            {url ? (
              <button className="action-btn clear-btn" onClick={() => {setUrl(''); setVideoInfo(null); setStatus('');}} disabled={phase === 'processing'}>Clear</button>
            ) : (
              <button className="action-btn paste-btn" onClick={handlePaste}>Paste</button>
            )}
          </div>
        </div>

        {/* Live Video Preview Box */}
        {phase === 'fetching' && <div className="status-msg status-loading" style={{padding: '10px', marginTop: '0', marginBottom: '20px'}}>⏳ Generating Secure Preview...</div>}
        {videoInfo && phase !== 'fetching' && (
          <div className="preview-card">
            <img src={videoInfo.thumbnail} alt="Thumbnail" className="preview-thumbnail" />
            <div className="preview-info">
              <span className="preview-badge">{videoInfo.duration} MINS</span>
              <p className="preview-title" title={videoInfo.title}>{videoInfo.title}</p>
            </div>
          </div>
        )}

        {/* Configuration Row with Dynamic File Sizes */}
        <div className="flex-row">
          <div className="input-group">
            <label className="input-label">Format</label>
            <div className="input-wrapper">
              {format === 'mp4' ? Icons.Video : Icons.Audio}
              <select className="custom-input with-icon" value={format} onChange={(e) => setFormat(e.target.value)} disabled={phase === 'processing'}>
                <option value="mp4">Video (MP4)</option>
                <option value="mp3">Audio (MP3) {videoInfo?.audio_size ? `(~${videoInfo.audio_size} MB)` : ''}</option>
              </select>
            </div>
          </div>
          <div className="input-group">
            <label className="input-label">Resolution</label>
            <div className="input-wrapper">
              {Icons.Settings}
              <select className="custom-input with-icon" value={quality} onChange={(e) => setQuality(e.target.value)} disabled={format === 'mp3' || phase === 'processing'}>
                <option value="2160">4K Ultra HD (2160p) {videoInfo?.sizes?.['2160'] ? `(~${videoInfo.sizes['2160']} MB)` : ''}</option>
                <option value="1440">2K Quad HD (1440p) {videoInfo?.sizes?.['1440'] ? `(~${videoInfo.sizes['1440']} MB)` : ''}</option>
                <option value="1080">Full HD (1080p) {videoInfo?.sizes?.['1080'] ? `(~${videoInfo.sizes['1080']} MB)` : ''}</option>
                <option value="720">HD (720p) {videoInfo?.sizes?.['720'] ? `(~${videoInfo.sizes['720']} MB)` : ''}</option>
                <option value="480">Standard (480p) {videoInfo?.sizes?.['480'] ? `(~${videoInfo.sizes['480']} MB)` : ''}</option>
                <option value="360">Low (360p) {videoInfo?.sizes?.['360'] ? `(~${videoInfo.sizes['360']} MB)` : ''}</option>
                <option value="144">Lowest (144p) {videoInfo?.sizes?.['144'] ? `(~${videoInfo.sizes['144']} MB)` : ''}</option>
              </select>
            </div>
          </div>
        </div>

        {/* Dynamic Progress Indicator */}
        {phase === 'processing' && (
          <div className="progress-container">
            <div className="progress-header">
              <span className="progress-text">{liveMessage}</span>
              <span className="progress-percent">{progress}%</span>
            </div>
            <div className="progress-track">
              <div className="progress-fill" style={{ width: `${progress}%` }}></div>
            </div>
          </div>
        )}

        {/* Action Button */}
        <button className="download-btn" onClick={handleDownload} disabled={phase === 'processing' || !url}>
          {phase === 'processing' ? (
            <><span className="spinner"></span> Processing...</>
          ) : (
            <>{Icons.Download} START DOWNLOAD</>
          )}
        </button>

        {status && <div className={`status-msg ${getStatusClass()}`}>{status}</div>}

        {/* History Tracker */}
        {history.length > 0 && (
          <div className="history-section">
            <label className="input-label" style={{color: '#38bdf8'}}>Recent Activity Tracker</label>
            {history.map((item) => (
              <div key={item.id} className="history-item">
                <span className="history-link" title={item.title}>{item.title}</span>
                <span className="history-type">{item.type}</span>
              </div>
            ))}
          </div>
        )}

      </div>
    </div>
  );
}

export default App;
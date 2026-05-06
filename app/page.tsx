"use client";

import React, { useState, useRef, useEffect } from "react";

// เปลี่ยนเป็น URL ของ Backend เรียบร้อยแล้ว
const API_BASE = "https://kijnaphat-cloud-seg-api.hf.space";

// --- Hardcoded defaults ---
const DEFAULT_MODEL_PATH = "model_best_by_val_mean_iou_focus.h5";
const DEFAULT_PREPROCESS = "perband_minmax";
const DEFAULT_TILE = "480";
const DEFAULT_OVERLAP = "96";
const DEFAULT_BATCH_SIZE = "4";
const DEFAULT_THRESHOLD = "0.5";
const DEFAULT_THR_SHADOW = "0.5";

export default function CloudSegmentation() {
  const [busy, setBusy] = useState(false);
  const [health, setHealth] = useState({ text: "Checking...", ok: false });
  const [status, setStatus] = useState({ text: "พร้อมใช้งาน", type: "" });
  const [progress, setProgress] = useState({ pct: 0, msg: "ยังไม่ได้เริ่ม" });
  const [runId, setRunId] = useState<string | null>(null);
  const [outputs, setOutputs] = useState<any>({});

  const [files, setFiles] = useState<{ [key: string]: File | null }>({
    blue: null, green: null, red: null, nir: null,
  });

  const timerRef = useRef<NodeJS.Timeout | null>(null);

  useEffect(() => {
    fetch(`${API_BASE}/api/health`)
      .then((res) => res.json())
      .then((j) => {
        if (j.status === "ok") setHealth({ text: "Server ready", ok: true });
        else setHealth({ text: "Unknown", ok: false });
      })
      .catch(() => setHealth({ text: "Offline", ok: false }));
  }, []);

  const handleFileChange = (band: string, e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files[0]) {
      setFiles((prev) => ({ ...prev, [band]: e.target.files![0] }));
    }
  };

  const filesOK = () => files.blue && files.green && files.red && files.nir;

  const stopPoll = () => {
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
  };

  const startPoll = (currentRunId: string) => {
    stopPoll();
    timerRef.current = setInterval(async () => {
      if (!currentRunId) return;
      try {
        const res = await fetch(`${API_BASE}/api/progress/${currentRunId}?t=${Date.now()}`);
        const j = await res.json();
        setProgress({ pct: j.percent ?? 0, msg: j.message || j.stage || "" });

        if (j.status === "error") {
          stopPoll();
          setBusy(false);
          setStatus({ text: j.message || "failed", type: "err" });
        }
        if (j.status === "done") {
          stopPoll();
          setBusy(false);
          setOutputs((prev: any) => ({ ...prev, ...j }));
          setProgress({ pct: 100, msg: j.message || "เสร็จสิ้น" });
          setStatus({ text: "Segment เสร็จ ✓\ncloud · shadow masks + overlay พร้อมแล้ว", type: "ok" });
        }
      } catch (e) {}
    }, 700);
  };

  const doPreview = async () => {
    if (busy) return;
    if (!filesOK()) {
      setStatus({ text: "กรุณาเลือกไฟล์ให้ครบ 4 band", type: "warn" });
      return;
    }

    setBusy(true);
    stopPoll();
    setStatus({ text: "กำลัง preview...", type: "warn" });
    setProgress({ pct: 0, msg: "เตรียม preview" });

    try {
      const fd = new FormData();
      Object.entries(files).forEach(([key, file]) => {
        if (file) fd.append(key, file);
      });

      const res = await fetch(`${API_BASE}/api/preview`, { method: "POST", body: fd });
      const j = await res.json();

      if (j.error) {
        setStatus({ text: j.error, type: "err" });
        setProgress({ pct: 0, msg: "" });
        setBusy(false);
        return;
      }

      setRunId(j.run_id);
      setOutputs({ preview_url: j.preview_url });
      setProgress({ pct: 100, msg: "Preview เสร็จ" });
      setStatus({ text: "Preview เสร็จ ✓", type: "ok" });
    } catch (e: any) {
      setStatus({ text: "preview failed: " + e.message, type: "err" });
      setProgress({ pct: 0, msg: "" });
    } finally {
      setBusy(false);
    }
  };

  const doSegment = async () => {
    if (busy) return;
    if (!runId) {
      setStatus({ text: "ต้องกด Preview ก่อน", type: "warn" });
      return;
    }

    setBusy(true);
    setOutputs((prev: any) => ({ preview_url: prev.preview_url }));
    setProgress({ pct: 1, msg: "เริ่ม segment" });
    setStatus({ text: "กำลัง Segment...\ncloud = แดง · shadow = น้ำเงิน", type: "warn" });

    try {
      const fd = new FormData();
      fd.append("run_id", runId);
      // เปลี่ยน DEFAULT_MODEL_PATH หรือพารามิเตอร์อื่นๆ ถ้าใน Backend บน HF มีการแก้ไข Path
      fd.append("model_path", DEFAULT_MODEL_PATH);
      fd.append("tile", DEFAULT_TILE);
      fd.append("overlap", DEFAULT_OVERLAP);
      fd.append("threshold", DEFAULT_THRESHOLD);
      fd.append("shadow_threshold", DEFAULT_THR_SHADOW);
      fd.append("preprocess", DEFAULT_PREPROCESS);
      fd.append("batch_size", DEFAULT_BATCH_SIZE);

      startPoll(runId);
      const res = await fetch(`${API_BASE}/api/segment`, { method: "POST", body: fd });
      const j = await res.json();

      if (j.error) {
        stopPoll();
        setBusy(false);
        setStatus({ text: j.error, type: "err" });
        setProgress({ pct: 0, msg: "failed" });
        return;
      }

      stopPoll();
      setOutputs((prev: any) => ({ ...prev, ...j }));
      setProgress({ pct: 100, msg: "เสร็จสิ้น" });
      setStatus({ text: "Segment เสร็จ ✓\ncloud · shadow masks + overlay พร้อมแล้ว", type: "ok" });
    } catch (e: any) {
      stopPoll();
      setBusy(false);
      setStatus({ text: "segment failed: " + e.message, type: "err" });
      setProgress({ pct: 0, msg: "failed" });
    } finally {
      setBusy(false);
    }
  };

  const makeShp = async (which: string) => {
    if (busy) return;
    if (!runId) {
      setStatus({ text: "ยังไม่มี run_id", type: "warn" });
      return;
    }

    setBusy(true);
    setStatus({ text: `สร้าง Shapefile (${which})...`, type: "warn" });

    try {
      const fd = new FormData();
      fd.append("run_id", runId);
      fd.append("which", which);

      const res = await fetch(`${API_BASE}/api/shapefile`, { method: "POST", body: fd });
      const j = await res.json();

      if (j.error) {
        setStatus({ text: j.error, type: "err" });
        setBusy(false);
        return;
      }

      setOutputs((prev: any) => ({ ...prev, zip_url: j.zip_url }));
      setStatus({ text: "Shapefile พร้อมโหลด ✓", type: "ok" });
    } catch (e: any) {
      setStatus({ text: "shapefile failed: " + e.message, type: "err" });
    } finally {
      setBusy(false);
    }
  };

  const hasDownloads =
    outputs.mask_cloud_url || outputs.mask_shadow_url || outputs.mask_any_url || outputs.overlay_url || outputs.zip_url;

  return (
    <>
      <style>{`
        :root {
          --cream:   #f5f0e8;
          --cream2:  #ede8df;
          --cream3:  #e4ddd2;
          --paper:   #faf8f4;
          --white:   #ffffff;

          --ink:     #1a1714;
          --ink2:    #3d3830;
          --ink3:    #7a7468;
          --ink4:    #a89f94;
          --ink5:    #c8c0b4;

          --border:  rgba(26,23,20,0.09);
          --border2: rgba(26,23,20,0.14);

          --sage:    #5c7a5e;
          --sage-bg: rgba(92,122,94,0.08);
          --sage-border: rgba(92,122,94,0.2);

          --rust:    #9b4a2e;
          --rust-bg: rgba(155,74,46,0.07);
          --rust-border: rgba(155,74,46,0.2);

          --sky:     #2e5f7a;
          --sky-bg:  rgba(46,95,122,0.07);
          --sky-border: rgba(46,95,122,0.2);

          --amber:   #8a6a1e;
          --amber-bg: rgba(138,106,30,0.08);

          --serif: 'Instrument Serif', Georgia, serif;
          --sans:  'Geist', ui-sans-serif, system-ui, sans-serif;
          --mono:  'Geist Mono', ui-monospace, monospace;

          --r: 12px;
          --r-sm: 8px;
          --shadow-sm: 0 1px 3px rgba(26,23,20,0.06), 0 1px 2px rgba(26,23,20,0.04);
          --shadow:    0 4px 16px rgba(26,23,20,0.08), 0 1px 3px rgba(26,23,20,0.05);
        }

        html, body { height: 100%; margin: 0; padding: 0; box-sizing: border-box; }
        *, *::before, *::after { box-sizing: inherit; }

        body {
          font-family: var(--sans);
          color: var(--ink);
          background: var(--paper);
          font-size: 14px;
          line-height: 1.5;
          -webkit-font-smoothing: antialiased;
        }

        .topbar {
          position: sticky; top: 0; z-index: 50;
          background: rgba(250,248,244,0.92);
          backdrop-filter: blur(16px);
          -webkit-backdrop-filter: blur(16px);
          border-bottom: 1px solid var(--border);
        }
        .topbar-inner {
          max-width: 1400px; margin: 0 auto; padding: 0 24px;
          height: 58px; display: flex; align-items: center;
          justify-content: space-between; gap: 16px;
        }
        .brand { display: flex; align-items: center; gap: 12px; }
        .logo-mark {
          width: 32px; height: 32px; border-radius: 8px;
          background: var(--ink); display: flex; align-items: center;
          justify-content: center; flex-shrink: 0;
        }
        .brand-text h1 {
          font-family: var(--serif); font-size: 18px; font-weight: 400;
          font-style: italic; color: var(--ink); letter-spacing: -0.2px; line-height: 1; margin: 0;
        }
        .brand-text .tagline {
          font-size: 11px; color: var(--ink4); font-family: var(--mono); margin-top: 2px;
        }
        .top-right {
          display: flex; align-items: center; gap: 8px;
          flex-wrap: wrap; justify-content: flex-end;
        }

        .server-badge {
          display: flex; align-items: center; gap: 7px;
          padding: 5px 11px; border-radius: 999px;
          border: 1px solid var(--border2); background: var(--cream);
          font-size: 11.5px; font-family: var(--mono); color: var(--ink3);
        }
        .ping {
          width: 6px; height: 6px; border-radius: 50%;
          background: var(--sage); flex-shrink: 0; animation: blink 2.4s ease infinite;
        }
        .ping.off { background: var(--rust); animation: none; }
        @keyframes blink { 0%,100%{opacity:1} 50%{opacity:0.35} }

        .btn {
          display: inline-flex; align-items: center; gap: 6px;
          padding: 8px 14px; border-radius: var(--r-sm);
          border: 1px solid var(--border2); background: var(--white);
          color: var(--ink2); font-family: var(--sans); font-size: 13px;
          font-weight: 500; cursor: pointer; transition: all 0.12s ease;
          box-shadow: var(--shadow-sm); white-space: nowrap; outline: none;
        }
        .btn:hover:not(:disabled) {
          background: var(--cream); border-color: var(--border2);
          transform: translateY(-1px); box-shadow: var(--shadow);
        }
        .btn:active:not(:disabled) { transform: translateY(0); box-shadow: var(--shadow-sm); }
        .btn:disabled { opacity: 0.45; cursor: not-allowed; transform: none; box-shadow: var(--shadow-sm); }
        .btn-dark {
          background: var(--ink); color: var(--cream); border-color: var(--ink);
          box-shadow: 0 2px 8px rgba(26,23,20,0.2);
        }
        .btn-dark:hover:not(:disabled) {
          background: var(--ink2); border-color: var(--ink2);
          box-shadow: 0 4px 14px rgba(26,23,20,0.25);
        }
        .btn-sm { padding: 6px 11px; font-size: 12px; }
        .btn-full { width: 100%; justify-content: center; }

        .wrap { max-width: 1400px; margin: 0 auto; padding: 20px 24px; }
        .layout {
          display: grid; grid-template-columns: 360px 1fr;
          gap: 14px; align-items: start;
        }
        @media (max-width: 1050px) { .layout { grid-template-columns: 1fr; } }

        .card {
          background: var(--white); border: 1px solid var(--border);
          border-radius: var(--r); box-shadow: var(--shadow-sm); overflow: hidden;
        }
        .card-head {
          padding: 13px 16px 12px; border-bottom: 1px solid var(--border);
          display: flex; align-items: center; justify-content: space-between; gap: 10px;
        }
        .card-head-left { display: flex; align-items: center; gap: 9px; }
        .card-icon {
          width: 26px; height: 26px; border-radius: 6px;
          border: 1px solid var(--border2); background: var(--cream);
          display: flex; align-items: center; justify-content: center; flex-shrink: 0;
        }
        .card-title { font-size: 13px; font-weight: 600; color: var(--ink); letter-spacing: -0.1px; }
        .card-sub { font-size: 11px; color: var(--ink4); margin-top: 1px; }
        .card-body { padding: 14px 16px; }

        .band-row { display: flex; align-items: center; gap: 10px; margin-bottom: 6px; }
        .band-tag {
          font-family: var(--mono); font-size: 10px; font-weight: 500;
          width: 24px; height: 24px; border-radius: 5px;
          display: flex; align-items: center; justify-content: center; flex-shrink: 0;
        }
        .band-B { background: rgba(46,95,122,0.1);  color: var(--sky);  border: 1px solid var(--sky-border); }
        .band-G { background: var(--sage-bg);        color: var(--sage); border: 1px solid var(--sage-border); }
        .band-R { background: var(--rust-bg);        color: var(--rust); border: 1px solid var(--rust-border); }
        .band-N { background: var(--amber-bg);       color: var(--amber); border: 1px solid rgba(138,106,30,0.22); }

        .file-wrap { flex: 1; position: relative; }
        .file-wrap input[type="file"] { position: absolute; inset: 0; opacity: 0; cursor: pointer; z-index: 2; }
        .file-face {
          display: flex; align-items: center; gap: 7px;
          padding: 7px 10px; background: var(--cream);
          border: 1px solid var(--border); border-radius: var(--r-sm);
          font-size: 12px; color: var(--ink4);
          transition: all 0.12s; cursor: pointer; min-height: 34px;
        }
        .file-wrap:hover .file-face {
          border-color: var(--border2); background: var(--cream2); color: var(--ink2);
        }
        .file-chosen {
          font-size: 11.5px; color: var(--sage); font-family: var(--mono);
          overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 200px;
        }

        .progress-wrap { margin-top: 0; }
        .progress-top { display: flex; align-items: center; justify-content: space-between; margin-bottom: 6px; }
        .progress-label {
          font-size: 11px; font-family: var(--mono); color: var(--ink4);
          text-transform: uppercase; letter-spacing: 0.6px;
        }
        .progress-pct { font-size: 11.5px; font-family: var(--mono); font-weight: 500; color: var(--ink2); }
        .progress-track { height: 3px; border-radius: 99px; background: var(--cream3); overflow: hidden; }
        .progress-fill {
          height: 100%; border-radius: 99px; background: var(--ink);
          transition: width 0.45s cubic-bezier(0.4,0,0.2,1);
        }
        .progress-msg { margin-top: 6px; font-size: 11px; font-family: var(--mono); color: var(--ink4); min-height: 15px; }

        .status-box {
          margin-top: 12px; padding: 10px 12px; border-radius: var(--r-sm);
          border: 1px solid var(--border); background: var(--cream);
          font-size: 12px; font-family: var(--mono); color: var(--ink3);
          line-height: 1.55; white-space: pre-line;
        }
        .status-box.ok   { border-color: var(--sage-border);  background: var(--sage-bg);  color: var(--sage); }
        .status-box.warn { border-color: rgba(138,106,30,0.22); background: var(--amber-bg); color: var(--amber); }
        .status-box.err  { border-color: var(--rust-border);  background: var(--rust-bg);  color: var(--rust); }

        .right-col { display: flex; flex-direction: column; gap: 14px; }

        .preview-card {
          background: var(--white); border: 1px solid var(--border);
          border-radius: var(--r); box-shadow: var(--shadow-sm); overflow: hidden;
        }
        .preview-head {
          padding: 12px 16px; border-bottom: 1px solid var(--border);
          display: flex; align-items: center; justify-content: space-between; gap: 10px;
        }
        .preview-title { font-size: 13px; font-weight: 600; color: var(--ink); }
        .preview-sub { font-size: 11px; font-family: var(--mono); color: var(--ink4); margin-top: 2px; }
        .preview-body {
          min-height: 440px; display: flex; align-items: center;
          justify-content: center; padding: 20px; background: var(--cream);
        }
        .preview-body img {
          max-width: 100%; max-height: 480px;
          border-radius: var(--r-sm); border: 1px solid var(--border); box-shadow: var(--shadow);
        }
        .preview-empty { text-align: center; color: var(--ink5); }
        .preview-empty svg { width: 48px; height: 48px; margin: 0 auto 12px; display: block; opacity: 0.35; }
        .preview-empty p { font-size: 13px; line-height: 1.65; margin: 0; }
        .preview-empty strong { color: var(--ink3); }

        .bottom-grid { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 12px; }
        @media (max-width: 900px) { .bottom-grid { grid-template-columns: 1fr; } }

        .dl-list { display: flex; flex-direction: column; gap: 4px; }
        .dl-item {
          display: flex; align-items: center; gap: 8px; padding: 7px 10px;
          background: var(--cream); border: 1px solid var(--border);
          border-radius: var(--r-sm); text-decoration: none; color: var(--ink2);
          font-size: 12px; font-weight: 500; transition: all 0.1s;
        }
        .dl-item:hover { background: var(--cream2); border-color: var(--border2); }
        .dl-dot { width: 6px; height: 6px; border-radius: 50%; flex-shrink: 0; }
        .dl-empty { font-size: 12px; color: var(--ink5); font-family: var(--mono); text-align: center; padding: 8px 0; }

        .shp-list { display: flex; flex-direction: column; gap: 5px; }
        .shp-btn {
          display: flex; align-items: center; gap: 8px; padding: 8px 11px;
          border-radius: var(--r-sm); border: 1px solid var(--border);
          background: var(--cream); color: var(--ink2); font-family: var(--sans);
          font-size: 12.5px; font-weight: 500; cursor: pointer;
          transition: all 0.12s; box-shadow: var(--shadow-sm); width: 100%; text-align: left;
        }
        .shp-btn:hover:not(:disabled) { background: var(--cream2); border-color: var(--border2); transform: translateY(-1px); box-shadow: var(--shadow); }
        .shp-btn:active:not(:disabled) { transform: translateY(0); }
        .shp-btn:disabled { opacity: 0.4; cursor: not-allowed; transform: none; }

        @keyframes fadeUp { from{opacity:0;transform:translateY(8px)} to{opacity:1;transform:translateY(0)} }
        .card, .preview-card { animation: fadeUp 0.3s ease backwards; }
        .card:nth-child(2) { animation-delay: 0.04s; }

        ::-webkit-scrollbar { width: 5px; }
        ::-webkit-scrollbar-track { background: transparent; }
        ::-webkit-scrollbar-thumb { background: var(--cream3); border-radius: 3px; }
        ::-webkit-scrollbar-thumb:hover { background: var(--ink5); }
      `}</style>

      <div className="topbar">
        <div className="topbar-inner">
          <div className="brand">
            <div className="logo-mark">
              <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
                <path d="M3 13C3 13 5 9 9 9C13 9 15 5 15 5" stroke="#f5f0e8" strokeWidth="1.8" strokeLinecap="round" />
                <path d="M3 13C3 13 5 9 9 9C13 9 15 5 15 5" stroke="white" strokeWidth="3.5" strokeLinecap="round" opacity="0.15" />
                <circle cx="9" cy="14" r="2" fill="#f5f0e8" />
              </svg>
            </div>
            <div className="brand-text">
              <h1>Cloud Segmentation</h1>
              <div className="tagline">2-class · cloud + shadow · batch inference</div>
            </div>
          </div>

          <div className="top-right">
            <div className="server-badge">
              <div className={`ping ${health.ok ? "" : "off"}`}></div>
              <span>{health.text}</span>
              <span style={{ color: "var(--ink5)" }}>·</span>
              <span>kijnaphat-cloud-seg-api.hf.space</span>
            </div>
            <button className="btn btn-sm" disabled={busy} onClick={doPreview}>
              <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
                <path d="M1 6C2.8 2.5 6 2.5 6 2.5C6 2.5 9.2 2.5 11 6C9.2 9.5 6 9.5 6 9.5C6 9.5 2.8 9.5 1 6Z" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
                <circle cx="6" cy="6" r="1.5" fill="currentColor" />
              </svg>
              Preview
            </button>
            <button className="btn btn-dark btn-sm" disabled={busy} onClick={doSegment}>
              <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
                <path d="M2 1.5L8.5 5L2 8.5V1.5Z" fill="currentColor" />
              </svg>
              Segment
            </button>
          </div>
        </div>
      </div>

      <div className="wrap">
        <div className="layout">
          {/* LEFT */}
          <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
            
            <div className="card">
              <div className="card-head">
                <div className="card-head-left">
                  <div className="card-icon">
                    <svg width="13" height="13" viewBox="0 0 13 13" fill="none">
                      <rect x="1" y="1" width="5" height="5" rx="1" stroke="var(--ink3)" strokeWidth="1.2" />
                      <rect x="7" y="1" width="5" height="5" rx="1" stroke="var(--ink3)" strokeWidth="1.2" />
                      <rect x="1" y="7" width="5" height="5" rx="1" stroke="var(--ink3)" strokeWidth="1.2" />
                      <rect x="7" y="7" width="5" height="5" rx="1" stroke="var(--ink3)" strokeWidth="1.2" />
                    </svg>
                  </div>
                  <div>
                    <div className="card-title">Band Inputs</div>
                    <div className="card-sub">Upload 4-band GeoTIFF · B G R NIR</div>
                  </div>
                </div>
              </div>
              <div className="card-body">
                {["blue", "green", "red", "nir"].map((band, i) => {
                  const tagMap: any = { blue: "B", green: "G", red: "R", nir: "N" };
                  const file = files[band];
                  return (
                    <div className="band-row" key={band} style={band === "nir" ? { marginBottom: 0 } : {}}>
                      <div className={`band-tag band-${tagMap[band]}`}>{tagMap[band]}</div>
                      <div className="file-wrap">
                        <input type="file" accept=".tif,.tiff" onChange={(e) => handleFileChange(band, e)} />
                        <div className="file-face">
                          <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
                            <path d="M2 2h5.5L10 4.5V10H2V2Z" stroke="currentColor" strokeWidth="1.1" strokeLinejoin="round" />
                            <path d="M7.5 2v2.5H10" stroke="currentColor" strokeWidth="1.1" strokeLinejoin="round" />
                          </svg>
                          <span className={file ? "file-chosen" : ""}>{file ? file.name : "Choose file…"}</span>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>

            <div className="card">
              <div className="card-head">
                <div className="card-head-left">
                  <div className="card-icon">
                    <svg width="13" height="13" viewBox="0 0 13 13" fill="none">
                      <rect x="1" y="7.5" width="2.5" height="4.5" rx="0.8" fill="var(--ink3)" />
                      <rect x="5.25" y="5" width="2.5" height="7" rx="0.8" fill="var(--ink3)" />
                      <rect x="9.5" y="2" width="2.5" height="10" rx="0.8" fill="var(--ink3)" />
                    </svg>
                  </div>
                  <div>
                    <div className="card-title">Progress</div>
                    <div className="card-sub">{runId ? `run · ${runId}` : "—"}</div>
                  </div>
                </div>
              </div>
              <div className="card-body">
                <div className="progress-wrap">
                  <div className="progress-top">
                    <span className="progress-label">Progress</span>
                    <span className="progress-pct">{progress.pct}%</span>
                  </div>
                  <div className="progress-track">
                    <div className="progress-fill" style={{ width: `${progress.pct}%` }}></div>
                  </div>
                  <div className="progress-msg">{progress.msg}</div>
                </div>
                <div className={`status-box ${status.type}`}>{status.text}</div>
              </div>
            </div>

          </div>

          {/* RIGHT */}
          <div className="right-col">
            <div className="preview-card">
              <div className="preview-head">
                <div>
                  <div className="preview-title">RGB / Overlay Preview</div>
                  <div className="preview-sub">{runId ? `run_id · ${runId}` : "ยังไม่มีข้อมูล"}</div>
                </div>
                <button className="btn btn-sm" disabled={busy} onClick={doPreview}>
                  <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
                    <path d="M1 6C2.8 2.5 6 2.5 6 2.5C6 2.5 9.2 2.5 11 6C9.2 9.5 6 9.5 6 9.5C6 9.5 2.8 9.5 1 6Z" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
                    <circle cx="6" cy="6" r="1.5" fill="currentColor" />
                  </svg>
                  Preview
                </button>
              </div>
              <div className="preview-body">
                {outputs.overlay_url ? (
                  <img src={`${API_BASE}${outputs.overlay_url}?t=${Date.now()}`} alt="overlay" />
                ) : outputs.preview_url ? (
                  <img src={`${API_BASE}${outputs.preview_url}?t=${Date.now()}`} alt="preview" />
                ) : (
                  <div className="preview-empty">
                    <svg viewBox="0 0 48 48" fill="none" xmlns="http://www.w3.org/2000/svg">
                      <rect x="3" y="3" width="42" height="42" rx="9" stroke="currentColor" strokeWidth="1.8" />
                      <path d="M3 32L14 21L22 29L30 22L45 36" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
                      <circle cx="32" cy="17" r="4.5" stroke="currentColor" strokeWidth="1.8" />
                    </svg>
                    <p>อัปโหลด 4 band แล้วกด <strong>Preview</strong><br/>จากนั้นกด <strong>Segment</strong> เพื่อสร้าง mask</p>
                  </div>
                )}
              </div>
            </div>

            <div className="bottom-grid">
              <div className="card">
                <div className="card-head">
                  <div className="card-head-left">
                    <div className="card-icon">
                      <svg width="13" height="13" viewBox="0 0 13 13" fill="none"><path d="M3 2L10 6.5L3 11V2Z" fill="var(--ink3)" /></svg>
                    </div>
                    <div className="card-title">Run</div>
                  </div>
                </div>
                <div className="card-body" style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
                  <button className="btn btn-dark btn-full" disabled={busy} onClick={doSegment}>
                    <svg width="10" height="10" viewBox="0 0 10 10" fill="none"><path d="M2 1.5L8.5 5L2 8.5V1.5Z" fill="currentColor" /></svg>
                    Run Segment
                  </button>
                  <div style={{ fontSize: "11px", color: "var(--ink4)", fontFamily: "var(--mono)" }}>
                    model_best_by_val_mean_iou_focus · perband_minmax
                  </div>
                </div>
              </div>

              <div className="card">
                <div className="card-head">
                  <div className="card-head-left">
                    <div className="card-icon">
                      <svg width="13" height="13" viewBox="0 0 13 13" fill="none"><path d="M2 2h7L12 5v6H2V2Z" stroke="var(--ink3)" strokeWidth="1.2" strokeLinejoin="round" /><path d="M9 2v3h3" stroke="var(--ink3)" strokeWidth="1.2" strokeLinejoin="round" /></svg>
                    </div>
                    <div className="card-title">Shapefile</div>
                  </div>
                </div>
                <div className="card-body">
                  <div className="shp-list">
                    <button className="shp-btn" disabled={busy} onClick={() => makeShp("cloud")}>
                      <span style={{ width: "7px", height: "7px", borderRadius: "50%", background: "var(--rust)", flexShrink: 0 }}></span>Cloud mask
                    </button>
                    <button className="shp-btn" disabled={busy} onClick={() => makeShp("shadow")}>
                      <span style={{ width: "7px", height: "7px", borderRadius: "50%", background: "var(--sky)", flexShrink: 0 }}></span>Shadow mask
                    </button>
                    <button className="shp-btn" disabled={busy} onClick={() => makeShp("any")}>
                      <span style={{ width: "7px", height: "7px", borderRadius: "50%", background: "var(--sage)", flexShrink: 0 }}></span>Any (combined)
                    </button>
                  </div>
                </div>
              </div>

              <div className="card">
                <div className="card-head">
                  <div className="card-head-left">
                    <div className="card-icon">
                      <svg width="13" height="13" viewBox="0 0 13 13" fill="none"><path d="M6.5 2v7M6.5 9L4 6.5M6.5 9L9 6.5" stroke="var(--ink3)" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" /><path d="M2 11h9" stroke="var(--ink3)" strokeWidth="1.2" strokeLinecap="round" /></svg>
                    </div>
                    <div className="card-title">Downloads</div>
                  </div>
                </div>
                <div className="card-body">
                  <div className="dl-list">
                    {hasDownloads ? (
                      <>
                        {outputs.mask_cloud_url && (
                          <a href={`${API_BASE}${outputs.mask_cloud_url}`} className="dl-item" target="_blank" rel="noreferrer">
                            <span className="dl-dot" style={{ background: "var(--rust)" }}></span>mask_full_cloud.tif
                          </a>
                        )}
                        {outputs.mask_shadow_url && (
                          <a href={`${API_BASE}${outputs.mask_shadow_url}`} className="dl-item" target="_blank" rel="noreferrer">
                            <span className="dl-dot" style={{ background: "var(--sky)" }}></span>mask_full_shadow.tif
                          </a>
                        )}
                        {outputs.mask_any_url && (
                          <a href={`${API_BASE}${outputs.mask_any_url}`} className="dl-item" target="_blank" rel="noreferrer">
                            <span className="dl-dot" style={{ background: "var(--sage)" }}></span>mask_full.tif
                          </a>
                        )}
                        {outputs.overlay_url && (
                          <a href={`${API_BASE}${outputs.overlay_url}`} className="dl-item" target="_blank" rel="noreferrer">
                            <span className="dl-dot" style={{ background: "var(--ink3)" }}></span>overlay.png
                          </a>
                        )}
                        {outputs.zip_url && (
                          <a href={`${API_BASE}${outputs.zip_url}`} className="dl-item" target="_blank" rel="noreferrer">
                            <span className="dl-dot" style={{ background: "var(--amber)" }}></span>shapefile.zip
                          </a>
                        )}
                      </>
                    ) : (
                      <div className="dl-empty">No outputs yet</div>
                    )}
                  </div>
                </div>
              </div>

            </div>
          </div>
        </div>
      </div>
    </>
  );
}
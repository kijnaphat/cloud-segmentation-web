"use client";
import React, { useState, useRef, useEffect } from "react";

const API_BASE       = "https://kijnaphat-cloud-seg-api.hf.space";
const DEFAULT_MODEL  = "model_best_by_val_mean_iou_focus.h5";
const DEFAULT_PREP   = "perband_minmax";
const DEFAULT_TILE   = "480";
const DEFAULT_OVL    = "96";
const DEFAULT_BATCH  = "4";
const DEFAULT_THR    = "0.5";
const DEFAULT_THRS   = "0.5";

function fmt(s: number) {
  if (s < 60) return `${Math.round(s)}s`;
  return `${Math.floor(s / 60)}m ${Math.round(s % 60)}s`;
}

export default function CloudSegmentation() {
  const [busy, setBusy]       = useState(false);
  const [health, setHealth]   = useState({ ok: false, text: "Checking" });
  const [runId, setRunId]     = useState<string | null>(null);
  const [outputs, setOutputs] = useState<any>({});
  const [files, setFiles]     = useState<Record<string, File | null>>({ blue: null, green: null, red: null, nir: null });
  const [pct, setPct]         = useState(0);
  const [msg, setMsg]         = useState("");
  const [sType, setSType]     = useState<"" | "ok" | "warn" | "err">("");
  const [sText, setSText]     = useState("Select four GeoTIFF band files to begin.");

  // timing
  const [elapsed, setElapsed]     = useState<number | null>(null);
  const [eta, setEta]             = useState<number | null>(null);
  const [totalTime, setTotalTime] = useState<number | null>(null);
  const t0Ref      = useRef<number | null>(null);
  const timerRef   = useRef<NodeJS.Timeout | null>(null);

  // steps
  type SS   = "idle" | "running" | "done" | "error";
  type Step = { id: string; label: string; desc: string; status: SS; detail: string };
  const DEFS = [
    { id: "upload",    label: "Upload",         desc: "4-band GeoTIFF" },
    { id: "preview",   label: "RGB Preview",    desc: "Build thumbnail" },
    { id: "model",     label: "Load Model",     desc: "Keras H5 weights" },
    { id: "inference", label: "Tile Inference", desc: "Sliding-window CNN" },
    { id: "masks",     label: "Write Masks",    desc: "Cloud & Shadow GeoTIFF" },
    { id: "overlay",   label: "Render Overlay", desc: "Composite PNG" },
    { id: "done",      label: "Complete",       desc: "All outputs ready" },
  ];
  const [steps, setSteps] = useState<Step[]>(DEFS.map(d => ({ ...d, status: "idle", detail: "" })));
  const setS = (id: string, p: Partial<Step>) =>
    setSteps(prev => prev.map(s => s.id === id ? { ...s, ...p } : s));
  const resetFrom = (id: string) => {
    const i = DEFS.findIndex(d => d.id === id);
    setSteps(prev => prev.map((s, j) => j >= i ? { ...s, status: "idle", detail: "" } : s));
  };

  // tile grid
  type TS = "idle" | "active" | "done";
  const [tg, setTg] = useState<{ cols: number; rows: number; cells: TS[]; proc: number; total: number } | null>(null);
  const [partial, setPartial] = useState<string | null>(null);
  const pollRef = useRef<NodeJS.Timeout | null>(null);

  useEffect(() => {
    fetch(`${API_BASE}/api/health`).then(r => r.json())
      .then(j => setHealth(j.status === "ok" ? { ok: true, text: "Connected" } : { ok: false, text: "Unknown" }))
      .catch(() => setHealth({ ok: false, text: "Offline" }));
  }, []);

  const filesOK = () => Object.values(files).every(Boolean);

  const startClock = () => {
    t0Ref.current = Date.now();
    setElapsed(0); setEta(null); setTotalTime(null);
    timerRef.current = setInterval(() => {
      if (t0Ref.current) setElapsed(Math.round((Date.now() - t0Ref.current) / 1000));
    }, 1000);
  };
  const stopClock = () => {
    if (timerRef.current) clearInterval(timerRef.current);
    if (t0Ref.current) setTotalTime(Math.round((Date.now() - t0Ref.current) / 1000));
    t0Ref.current = null; setElapsed(null); setEta(null);
  };

  const stopPoll = () => { if (pollRef.current) clearInterval(pollRef.current); };
  const startPoll = (rid: string) => {
    stopPoll();
    pollRef.current = setInterval(async () => {
      try {
        const j = await fetch(`${API_BASE}/api/progress/${rid}?t=${Date.now()}`).then(r => r.json());
        const p: number = j.percent ?? 0;
        const sg: string = j.stage || "";
        const m: string  = j.message || "";
        setPct(p); setMsg(m);
        if (t0Ref.current && p > 5 && p < 100) {
          const el = (Date.now() - t0Ref.current) / 1000;
          setEta(Math.max(0, Math.round(el / (p / 100) - el)));
        }
        if (j.partial_overlay_url) setPartial(`${API_BASE}${j.partial_overlay_url}?t=${Date.now()}`);

        const stageMap: Record<string, string[]> = {
          model: ["segment_init","loading_model","precompute","preprocess","threshold"],
        };
        if (stageMap.model.includes(sg)) {
          setS("model", { status: "running", detail: m });
        } else if (sg === "segmenting") {
          setS("model", { status: "done" });
          setS("inference", { status: "running", detail: m });
          const match = m.match(/(\d+)\/(\d+)/);
          if (match) {
            const proc = +match[1], tot = +match[2];
            const C    = Math.min(Math.ceil(Math.sqrt(tot * 1.5)), 40);
            const R    = Math.min(Math.ceil(tot / C), 40);
            const N    = C * R;
            const dn   = Math.floor((proc / Math.max(tot, 1)) * N);
            setTg({ cols: C, rows: R, proc, total: tot,
              cells: Array(N).fill("idle").map((_, i) =>
                i < dn ? "done" : i === dn ? "active" : "idle") as TS[] });
          }
        } else if (sg === "writing_masks") {
          setS("inference", { status: "done" });
          setS("masks",     { status: "running", detail: m });
          setTg(p => p ? { ...p, cells: p.cells.map(() => "done" as TS), proc: p.total } : p);
        } else if (sg === "overlay") {
          setS("masks",   { status: "done" });
          setS("overlay", { status: "running", detail: m });
        }
        if (j.status === "error") {
          stopPoll(); stopClock(); setBusy(false);
          setSText(m || "An error occurred."); setSType("err");
          setS(sg || "inference", { status: "error", detail: m });
        }
        if (j.status === "done") {
          stopPoll(); stopClock(); setBusy(false);
          setOutputs((prev: any) => ({ ...prev, ...j }));
          setPct(100); setSText("Segmentation complete. Outputs are ready."); setSType("ok");
          setS("overlay", { status: "done" });
          setS("done",    { status: "done", detail: `${j.tiles_used} / ${j.tiles_total} tiles` });
        }
      } catch {}
    }, 700);
  };

  const doPreview = async () => {
    if (busy || !filesOK()) {
      if (!filesOK()) { setSText("Please upload all four band files."); setSType("warn"); }
      return;
    }
    setBusy(true); stopPoll(); setPct(0); setPartial(null); resetFrom("upload");
    setSText("Uploading bands and generating preview…"); setSType("warn");
    setS("upload", { status: "running", detail: "Uploading…" });
    startClock();
    try {
      const fd = new FormData();
      Object.entries(files).forEach(([k, f]) => { if (f) fd.append(k, f); });
      setS("upload",  { status: "done" });
      setS("preview", { status: "running", detail: "Building RGB thumbnail…" });
      const j = await fetch(`${API_BASE}/api/preview`, { method: "POST", body: fd }).then(r => r.json());
      if (j.error) throw new Error(j.error);
      setS("preview", { status: "done" });
      setRunId(j.run_id); setOutputs({ preview_url: j.preview_url });
      setPct(100); setSText("Preview ready. Run Segment to generate cloud and shadow masks."); setSType("ok");
    } catch (e: any) {
      setSText(e.message); setSType("err");
      setS("preview", { status: "error" });
    } finally { stopClock(); setBusy(false); }
  };

  const doSegment = async () => {
    if (busy || !runId) {
      if (!runId) { setSText("Please generate a preview first."); setSType("warn"); }
      return;
    }
    setBusy(true); setOutputs((p: any) => ({ preview_url: p.preview_url }));
    setPct(1); setPartial(null); setTg(null); resetFrom("model");
    setS("model", { status: "running", detail: "Loading model weights…" });
    setSText("Running segmentation — cloud (red) · shadow (blue)"); setSType("warn");
    startClock();
    try {
      const fd = new FormData();
      fd.append("run_id", runId!); fd.append("model_path", DEFAULT_MODEL);
      fd.append("tile", DEFAULT_TILE); fd.append("overlap", DEFAULT_OVL);
      fd.append("threshold", DEFAULT_THR); fd.append("shadow_threshold", DEFAULT_THRS);
      fd.append("preprocess", DEFAULT_PREP); fd.append("batch_size", DEFAULT_BATCH);
      startPoll(runId!);
      const j = await fetch(`${API_BASE}/api/segment`, { method: "POST", body: fd }).then(r => r.json());
      if (j.error) throw new Error(j.error);
      stopPoll(); stopClock();
      setOutputs((p: any) => ({ ...p, ...j }));
      setPct(100); setSText("Segmentation complete. Outputs are ready."); setSType("ok");
      setS("overlay", { status: "done" });
      setS("done",    { status: "done", detail: `${j.tiles_used} / ${j.tiles_total} tiles processed` });
    } catch (e: any) {
      stopPoll(); stopClock();
      setSText(e.message); setSType("err");
      setS("inference", { status: "error", detail: e.message });
    } finally { setBusy(false); }
  };

  const makeShp = async (which: string) => {
    if (busy || !runId) return;
    setBusy(true); setSText(`Exporting ${which} shapefile…`); setSType("warn");
    try {
      const fd = new FormData(); fd.append("run_id", runId!); fd.append("which", which);
      const j = await fetch(`${API_BASE}/api/shapefile`, { method: "POST", body: fd }).then(r => r.json());
      if (j.error) throw new Error(j.error);
      setOutputs((p: any) => ({ ...p, zip_url: j.zip_url }));
      setSText("Shapefile export complete."); setSType("ok");
    } catch (e: any) { setSText(e.message); setSType("err"); }
    finally { setBusy(false); }
  };

  const segDone     = !!outputs.overlay_url;
  const hasDL       = outputs.mask_cloud_url || outputs.mask_shadow_url || outputs.mask_any_url || outputs.overlay_url || outputs.zip_url;
  const activeStep  = steps.find(s => s.status === "running");
  const doneSteps   = steps.filter(s => s.status === "done").length;

  /* ─────────────────────────────────────────────── */
  return (
    <>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600&display=swap');

        :root {
          --white:   #ffffff;
          --off:     #f5f5f7;
          --off2:    #e8e8ed;
          --off3:    #d2d2d7;
          --text:    #1d1d1f;
          --text2:   #6e6e73;
          --text3:   #aeaeb2;
          --blue:    #0071e3;
          --blue2:   #0077ed;
          --green:   #1d8348;
          --green-l: #e8f5e9;
          --red:     #c0392b;
          --red-l:   #fdecea;
          --amber:   #7d4e00;
          --amber-l: #fff8e1;
          --cloud:   #e74c3c;
          --shadow:  #2980b9;
          --sans:    'Inter', -apple-system, BlinkMacSystemFont, 'Helvetica Neue', sans-serif;
          --r:       18px;
          --r2:      12px;
          --r3:      8px;
        }
        *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
        html, body { height: 100%; }
        body {
          font-family: var(--sans);
          background: var(--off);
          color: var(--text);
          font-size: 15px;
          line-height: 1.5;
          -webkit-font-smoothing: antialiased;
          -moz-osx-font-smoothing: grayscale;
        }

        /* ── NAV ── */
        nav {
          position: sticky; top: 0; z-index: 200;
          background: rgba(255,255,255,0.82);
          backdrop-filter: saturate(180%) blur(20px);
          -webkit-backdrop-filter: saturate(180%) blur(20px);
          border-bottom: 1px solid rgba(0,0,0,0.08);
        }
        .nav-in {
          max-width: 1200px; margin: 0 auto; padding: 0 24px;
          height: 52px; display: flex; align-items: center; justify-content: space-between;
        }
        .nav-brand {
          display: flex; align-items: center; gap: 10px;
        }
        .nav-logo {
          width: 28px; height: 28px; border-radius: 7px;
          background: var(--text); display: flex; align-items: center; justify-content: center;
        }
        .nav-name { font-size: 17px; font-weight: 600; letter-spacing: -0.3px; color: var(--text); }
        .nav-sub  { font-size: 11px; color: var(--text3); letter-spacing: 0.3px; font-weight: 400; }
        .nav-right { display: flex; align-items: center; gap: 12px; }
        .nav-badge {
          display: flex; align-items: center; gap: 6px;
          font-size: 12px; color: var(--text2); font-weight: 400;
        }
        .dot { width: 6px; height: 6px; border-radius: 50%; background: #34c759; flex-shrink: 0; }
        .dot.off { background: #ff3b30; }
        .nav-status {
          font-size: 12px; color: var(--text2);
          background: var(--off); border-radius: 999px; padding: 4px 12px;
          border: 1px solid var(--off3);
        }

        /* ── BUTTONS ── */
        .btn {
          display: inline-flex; align-items: center; justify-content: center; gap: 6px;
          padding: 8px 18px; border-radius: 980px;
          border: none; font-family: var(--sans); font-size: 13.5px; font-weight: 500;
          cursor: pointer; transition: all .16s ease; outline: none; white-space: nowrap;
          letter-spacing: -0.1px;
        }
        .btn-primary { background: var(--blue); color: #fff; }
        .btn-primary:hover:not(:disabled) { background: #0077ed; }
        .btn-secondary { background: rgba(0,0,0,0.06); color: var(--text); }
        .btn-secondary:hover:not(:disabled) { background: rgba(0,0,0,0.10); }
        .btn:disabled { opacity: 0.38; cursor: not-allowed; }
        .btn-sm { padding: 6px 14px; font-size: 12.5px; }

        /* ── LAYOUT ── */
        .page  { max-width: 1200px; margin: 0 auto; padding: 32px 24px; }
        .cols  { display: grid; grid-template-columns: 340px 1fr; gap: 20px; align-items: start; }
        @media (max-width: 960px) { .cols { grid-template-columns: 1fr; } }

        /* ── CARD ── */
        .card {
          background: var(--white); border-radius: var(--r);
          box-shadow: 0 2px 12px rgba(0,0,0,0.06), 0 0 0 1px rgba(0,0,0,0.04);
          overflow: hidden;
        }
        .card + .card { margin-top: 16px; }
        .card-head {
          padding: 20px 22px 18px;
          border-bottom: 1px solid var(--off2);
          display: flex; align-items: center; justify-content: space-between;
        }
        .card-title { font-size: 15px; font-weight: 600; letter-spacing: -0.2px; color: var(--text); }
        .card-sub   { font-size: 12px; color: var(--text3); margin-top: 2px; }
        .card-body  { padding: 20px 22px; }

        /* ── BAND ROWS ── */
        .band-rows { display: flex; flex-direction: column; gap: 8px; }
        .band-row  { display: flex; align-items: center; gap: 10px; }
        .band-pill {
          font-size: 10px; font-weight: 600; letter-spacing: 0.5px;
          width: 24px; height: 24px; border-radius: 6px;
          display: flex; align-items: center; justify-content: center; flex-shrink: 0;
        }
        .bB { background: #e5f0ff; color: #0057b8; }
        .bG { background: #e5f5ec; color: #1a6b35; }
        .bR { background: #fdecea; color: #b71c1c; }
        .bN { background: #fff8e1; color: #7d4e00; }
        .file-zone { flex: 1; position: relative; }
        .file-zone input[type=file] { position: absolute; inset: 0; opacity: 0; cursor: pointer; z-index: 2; }
        .file-face {
          display: flex; align-items: center; gap: 7px; padding: 7px 12px;
          background: var(--off); border: 1.5px solid var(--off2); border-radius: var(--r3);
          font-size: 12.5px; color: var(--text3); cursor: pointer; transition: all .14s;
          min-height: 36px;
        }
        .file-zone:hover .file-face { border-color: var(--blue); color: var(--blue); background: #f0f7ff; }
        .file-name { color: var(--green); font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 168px; }
        .file-check { color: var(--green); font-size: 13px; }

        .btn-row { display: flex; gap: 10px; margin-top: 18px; }
        .btn-row .btn { flex: 1; }

        /* ── STATUS ── */
        .status-area {
          padding: 13px 16px; border-radius: var(--r2); margin-bottom: 18px;
          font-size: 13px; color: var(--text2); background: var(--off); border: 1.5px solid var(--off2);
          line-height: 1.55;
        }
        .status-area.ok   { background: var(--green-l); border-color: #a5d6a7; color: var(--green); }
        .status-area.warn { background: var(--amber-l); border-color: #ffe082; color: var(--amber); }
        .status-area.err  { background: var(--red-l);   border-color: #ef9a9a; color: var(--red); }

        /* ── BIG PROGRESS ── */
        .pct-row { display: flex; align-items: baseline; gap: 6px; margin-bottom: 10px; }
        .pct-num { font-size: 48px; font-weight: 300; letter-spacing: -3px; color: var(--text); line-height: 1; }
        .pct-sym { font-size: 20px; font-weight: 300; color: var(--text3); }
        .pct-track { height: 4px; border-radius: 99px; background: var(--off2); overflow: hidden; margin-bottom: 8px; }
        .pct-fill  {
          height: 100%; border-radius: 99px; background: var(--blue);
          transition: width .5s cubic-bezier(.4,0,.2,1);
        }
        .pct-msg { font-size: 12px; color: var(--text3); min-height: 16px; }

        /* ── TIMING CHIPS ── */
        .chip-row { display: flex; gap: 8px; flex-wrap: wrap; margin: 12px 0 0; }
        .chip {
          display: flex; align-items: center; gap: 5px;
          padding: 4px 12px; border-radius: 999px; font-size: 12px; font-weight: 500;
          background: var(--off); border: 1.5px solid var(--off2); color: var(--text2);
        }
        .chip.ok     { background: var(--green-l); border-color: #a5d6a7; color: var(--green); }
        .chip.eta    { background: var(--amber-l); border-color: #ffe082; color: var(--amber); }

        /* ── STEPS ── */
        .step-section-label {
          font-size: 11px; font-weight: 600; letter-spacing: 0.6px; text-transform: uppercase;
          color: var(--text3); margin: 22px 0 12px;
        }
        .steps { display: flex; flex-direction: column; gap: 0; }
        .step  { display: flex; align-items: flex-start; gap: 14px; padding: 10px 0; position: relative; }
        .step:not(:last-child)::after {
          content: ''; position: absolute; left: 11px; top: 34px;
          width: 1.5px; bottom: -2px; background: var(--off2);
        }
        .step-circle {
          width: 24px; height: 24px; border-radius: 50%; flex-shrink: 0; margin-top: 2px;
          display: flex; align-items: center; justify-content: center; font-size: 11px;
          border: 1.5px solid var(--off3); background: var(--white); color: var(--text3);
          transition: all .2s; z-index: 1; position: relative;
        }
        .step-circle.running { border-color: var(--blue); background: #e8f2ff; color: var(--blue); animation: pulse-ring 1.4s ease infinite; }
        .step-circle.done    { border-color: var(--green); background: var(--green-l); color: var(--green); }
        .step-circle.error   { border-color: var(--red);   background: var(--red-l);   color: var(--red); }
        @keyframes pulse-ring {
          0%,100% { box-shadow: 0 0 0 0 rgba(0,113,227,.2); }
          50%      { box-shadow: 0 0 0 5px rgba(0,113,227,0); }
        }
        .step-body  { flex: 1; min-width: 0; }
        .step-label { font-size: 13.5px; font-weight: 500; color: var(--text3); transition: color .15s; letter-spacing: -0.1px; }
        .step-label.running { color: var(--blue); }
        .step-label.done    { color: var(--text); }
        .step-label.error   { color: var(--red); }
        .step-desc  { font-size: 11.5px; color: var(--text3); margin-top: 1px; }
        .step-detail { font-size: 11px; color: var(--text3); margin-top: 2px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        .step-end   { flex-shrink: 0; padding-top: 4px; font-size: 12px; }
        .step-end.ok   { color: var(--green); }
        .step-end.run  { color: var(--blue); animation: spin .9s linear infinite; display: inline-block; }
        .step-end.err  { color: var(--red); }
        @keyframes spin { to { transform: rotate(360deg); } }

        /* ── TILE GRID ── */
        .tile-panel {
          margin: 8px 0 6px 38px; padding: 12px 14px;
          background: var(--off); border-radius: var(--r2);
          border: 1.5px solid var(--off2);
        }
        .tile-hdr { display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px; }
        .tile-lbl { font-size: 11px; font-weight: 600; letter-spacing: 0.4px; color: var(--text3); text-transform: uppercase; }
        .tile-cnt { font-size: 12px; font-weight: 500; color: var(--text2); }
        .tgrid    { display: grid; gap: 2px; }
        .tc { aspect-ratio: 1; border-radius: 2px; background: var(--off2); transition: background .1s; }
        .tc.done   { background: var(--blue); opacity: 0.65; }
        .tc.active { background: var(--blue); animation: tpulse .65s ease infinite; }
        @keyframes tpulse { 0%,100%{opacity:1;transform:scale(1)} 50%{opacity:.45;transform:scale(.7)} }
        .tbar      { height: 2px; border-radius: 99px; background: var(--off2); overflow: hidden; margin-top: 8px; }
        .tbar-fill { height: 100%; border-radius: 99px; background: var(--blue); transition: width .4s ease; }

        /* ── PREVIEW ── */
        .preview-wrap {
          background: var(--white); border-radius: var(--r);
          box-shadow: 0 2px 12px rgba(0,0,0,0.06), 0 0 0 1px rgba(0,0,0,0.04);
          overflow: hidden;
        }
        .preview-head {
          padding: 18px 22px 16px;
          border-bottom: 1px solid var(--off2);
          display: flex; align-items: center; justify-content: space-between; gap: 14px;
        }
        .preview-title { font-size: 15px; font-weight: 600; letter-spacing: -0.2px; }
        .preview-meta  { font-size: 12px; color: var(--text3); margin-top: 2px; }
        .preview-body  {
          min-height: 420px; background: #f5f5f7;
          display: flex; align-items: center; justify-content: center;
          position: relative; overflow: hidden;
        }
        .preview-body img { max-width: 100%; max-height: 560px; }
        .preview-empty { text-align: center; padding: 48px 24px; color: var(--text3); }
        .preview-empty-icon { font-size: 40px; margin-bottom: 12px; opacity: 0.4; }
        .preview-empty p { font-size: 14px; line-height: 1.7; }
        .preview-empty strong { color: var(--text2); font-weight: 500; }

        /* live overlay badges */
        .live-badge {
          position: absolute; top: 14px; left: 14px;
          display: flex; align-items: center; gap: 6px;
          background: rgba(255,255,255,0.88); backdrop-filter: blur(8px);
          border: 1.5px solid rgba(0,0,0,0.08);
          border-radius: 999px; padding: 5px 12px;
          font-size: 11.5px; font-weight: 500; color: var(--text);
          letter-spacing: 0.2px;
        }
        .live-dot { width: 7px; height: 7px; border-radius: 50%; background: #ff3b30; animation: blink .9s ease infinite; }
        @keyframes blink { 0%,100%{opacity:1} 50%{opacity:.3} }
        .scan-bar  { position: absolute; bottom: 0; left: 0; right: 0; height: 3px; background: rgba(0,0,0,.06); }
        .scan-fill { height: 100%; background: var(--blue); transition: width .5s ease; }
        .tile-counter {
          position: absolute; bottom: 12px; right: 14px;
          background: rgba(255,255,255,.88); backdrop-filter: blur(6px);
          border: 1.5px solid rgba(0,0,0,.08); border-radius: 8px; padding: 4px 10px;
          font-size: 11px; font-weight: 500; color: var(--text2);
        }

        /* ── LEGEND ── */
        .legend { display: flex; gap: 16px; align-items: center; }
        .leg    { display: flex; align-items: center; gap: 5px; font-size: 12px; color: var(--text2); font-weight: 400; }
        .leg-dot { width: 8px; height: 8px; border-radius: 50%; }

        /* ── DOWNLOADS ── */
        .dl-list { display: flex; flex-direction: column; gap: 6px; }
        .dl-item {
          display: flex; align-items: center; gap: 12px;
          padding: 11px 14px; border-radius: var(--r2);
          background: var(--off); border: 1.5px solid var(--off2);
          text-decoration: none; color: var(--text); font-size: 13px; font-weight: 500;
          transition: all .14s;
        }
        .dl-item:hover { background: #f0f7ff; border-color: #90caf9; color: var(--blue); }
        .dl-icon { font-size: 18px; flex-shrink: 0; }
        .dl-name { flex: 1; font-size: 12.5px; }
        .dl-size { font-size: 11.5px; color: var(--text3); }
        .dl-arr  { font-size: 14px; color: var(--text3); margin-left: auto; }
        .dl-item:hover .dl-arr { color: var(--blue); transform: translateX(2px); }

        /* ── SHP BTNS ── */
        .shp-list { display: flex; flex-direction: column; gap: 7px; }
        .shp-btn {
          display: flex; align-items: center; gap: 10px; padding: 11px 14px;
          border-radius: var(--r2); border: 1.5px solid var(--off2);
          background: var(--off); color: var(--text); font-family: var(--sans);
          font-size: 13px; font-weight: 500; cursor: pointer; transition: all .14s;
          width: 100%; text-align: left;
        }
        .shp-btn:hover:not(:disabled) { background: #f0f7ff; border-color: #90caf9; color: var(--blue); }
        .shp-btn:disabled { opacity: 0.38; cursor: not-allowed; }
        .shp-color { width: 9px; height: 9px; border-radius: 50%; flex-shrink: 0; }

        /* ── INFO TABLE ── */
        .info-rows { display: flex; flex-direction: column; }
        .info-row  { display: flex; justify-content: space-between; padding: 9px 0; border-bottom: 1px solid var(--off2); font-size: 13px; }
        .info-row:last-child { border-bottom: none; }
        .info-key  { color: var(--text3); font-weight: 400; }
        .info-val  { color: var(--text); font-weight: 500; }
        .info-val.green { color: var(--green); }
        .info-val.amber { color: var(--amber); }
        .info-val.blue  { color: var(--blue); }

        ::-webkit-scrollbar { width: 5px; }
        ::-webkit-scrollbar-track { background: transparent; }
        ::-webkit-scrollbar-thumb { background: var(--off3); border-radius: 4px; }
      `}</style>

      {/* ── NAV ── */}
      <nav>
        <div className="nav-in">
          <div className="nav-brand">
            <div className="nav-logo">
              <svg width="16" height="16" viewBox="0 0 18 18" fill="none">
                <path d="M3.5 13s2-4 5.5-4 6-4 6-4" stroke="white" strokeWidth="1.8" strokeLinecap="round"/>
                <circle cx="9" cy="15" r="2" fill="white"/>
              </svg>
            </div>
            <div>
              <div className="nav-name">CloudSeg</div>
            </div>
          </div>

          <div className="nav-right">
            <div className="nav-badge">
              <div className={`dot${health.ok ? "" : " off"}`}/>
              {health.text}
            </div>
            <button className="btn btn-secondary btn-sm" disabled={busy} onClick={doPreview}>Preview</button>
            <button className="btn btn-primary btn-sm" disabled={busy} onClick={doSegment}>Run Segment</button>
          </div>
        </div>
      </nav>

      {/* ── PAGE ── */}
      <div className="page">
        <div className="cols">

          {/* ── LEFT ── */}
          <div>

            {/* Band Inputs */}
            <div className="card">
              <div className="card-head">
                <div>
                  <div className="card-title">Band Files</div>
                  <div className="card-sub">Upload four GeoTIFF bands</div>
                </div>
                {filesOK() && (
                  <span style={{fontSize:11.5,color:"var(--green)",fontWeight:500,background:"var(--green-l)",borderRadius:999,padding:"3px 10px",border:"1px solid #a5d6a7"}}>
                    Ready
                  </span>
                )}
              </div>
              <div className="card-body">
                <div className="band-rows">
                  {(["blue","green","red","nir"] as const).map(band => {
                    const t: Record<string,string> = {blue:"B",green:"G",red:"R",nir:"N"};
                    const n: Record<string,string> = {blue:"Blue — Band 2",green:"Green — Band 3",red:"Red — Band 4",nir:"NIR — Band 5"};
                    const f = files[band];
                    return (
                      <div className="band-row" key={band}>
                        <div className={`band-pill b${t[band]}`}>{t[band]}</div>
                        <div className="file-zone">
                          <input type="file" accept=".tif,.tiff"
                            onChange={e => { if (e.target.files?.[0]) setFiles(p => ({...p,[band]:e.target.files![0]})); }}/>
                          <div className="file-face">
                            {f
                              ? <><span className="file-check">✓</span><span className="file-name">{f.name}</span></>
                              : <><svg width="12" height="12" viewBox="0 0 12 12" fill="none" style={{flexShrink:0,color:"var(--text3)"}}>
                                  <path d="M2 2h5.5L10 4.5V10H2V2Z" stroke="currentColor" strokeWidth="1.1" strokeLinejoin="round"/>
                                  <path d="M7.5 2v2.5H10" stroke="currentColor" strokeWidth="1.1" strokeLinejoin="round"/>
                                </svg><span>{n[band]}</span></>}
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
                <div className="btn-row">
                  <button className="btn btn-secondary" disabled={busy} onClick={doPreview}>
                    Preview RGB
                  </button>
                  <button className="btn btn-primary" disabled={busy || !runId} onClick={doSegment}>
                    Run Segment
                  </button>
                </div>
              </div>
            </div>

            {/* Pipeline */}
            <div className="card">
              <div className="card-head">
                <div>
                  <div className="card-title">Pipeline</div>
                  <div className="card-sub">{runId ? `Run  ${runId}` : "Not started"}</div>
                </div>
                <div style={{fontSize:12,color:"var(--text3)",fontWeight:500}}>
                  {doneSteps} / {steps.length}
                </div>
              </div>
              <div className="card-body">

                {/* Progress */}
                <div className="pct-row">
                  <div className="pct-num">{pct}</div>
                  <div className="pct-sym">%</div>
                </div>
                <div className="pct-track">
                  <div className="pct-fill" style={{width:`${pct}%`}}/>
                </div>
                <div className="pct-msg">{msg || "—"}</div>

                {/* Timing */}
                <div className="chip-row">
                  {elapsed !== null && (
                    <div className="chip">⏱ {fmt(elapsed)}</div>
                  )}
                  {eta !== null && eta > 0 && (
                    <div className="chip eta">ETA  {fmt(eta)}</div>
                  )}
                  {totalTime !== null && !busy && (
                    <div className="chip ok">✓  Completed in {fmt(totalTime)}</div>
                  )}
                </div>

                {/* Status */}
                <div className={`status-area${sType ? " " + sType : ""}`} style={{marginTop:16}}>
                  {sText}
                </div>

                {/* Steps */}
                <div className="step-section-label">Pipeline Steps</div>
                <div className="steps">
                  {steps.map((step, i) => {
                    const isInf    = step.id === "inference";
                    const showGrid = isInf && tg && (step.status === "running" || step.status === "done");
                    return (
                      <div key={step.id}>
                        <div className="step">
                          <div className={`step-circle ${step.status}`}>
                            {step.status === "done"    ? "✓" :
                             step.status === "error"   ? "✕" :
                             step.status === "running" ? "↻" :
                             String(i + 1)}
                          </div>
                          <div className="step-body">
                            <div className={`step-label ${step.status}`}>{step.label}</div>
                            <div className="step-desc">{step.desc}</div>
                            {step.detail && !showGrid && <div className="step-detail">{step.detail}</div>}
                          </div>
                          {step.status === "done"    && <span className="step-end ok">✓</span>}
                          {step.status === "running" && <span className="step-end run">↻</span>}
                          {step.status === "error"   && <span className="step-end err">✕</span>}
                        </div>

                        {showGrid && tg && (
                          <div className="tile-panel">
                            <div className="tile-hdr">
                              <span className="tile-lbl">Tile Map</span>
                              <span className="tile-cnt">{tg.proc} / {tg.total} tiles</span>
                            </div>
                            <div className="tgrid" style={{gridTemplateColumns:`repeat(${tg.cols},1fr)`}}>
                              {tg.cells.map((st, ci) => (
                                <div key={ci} className={`tc${st==="done"?" done":st==="active"?" active":""}`}/>
                              ))}
                            </div>
                            <div className="tbar">
                              <div className="tbar-fill" style={{width:`${Math.round(tg.proc/Math.max(tg.total,1)*100)}%`}}/>
                            </div>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>
          </div>

          {/* ── RIGHT ── */}
          <div style={{display:"flex",flexDirection:"column",gap:16}}>

            {/* Preview */}
            <div className="preview-wrap">
              <div className="preview-head">
                <div>
                  <div className="preview-title">Satellite Image</div>
                  <div className="preview-meta">{runId ? `run_id · ${runId}` : "Upload bands and click Preview"}</div>
                </div>
                <div style={{display:"flex",alignItems:"center",gap:12}}>
                  {segDone && (
                    <div className="legend">
                      <div className="leg"><div className="leg-dot" style={{background:"var(--cloud)"}}/>Cloud</div>
                      <div className="leg"><div className="leg-dot" style={{background:"var(--shadow)"}}/>Shadow</div>
                    </div>
                  )}
                  <button className="btn btn-secondary btn-sm" disabled={busy} onClick={doPreview}>Refresh</button>
                </div>
              </div>
              <div className="preview-body">
                {outputs.overlay_url ? (
                  <img src={`${API_BASE}${outputs.overlay_url}?t=${Date.now()}`} alt="overlay"/>
                ) : partial ? (
                  <>
                    <img src={partial} alt="partial" style={{opacity:.93}}/>
                    <div className="live-badge"><span className="live-dot"/>Live inference</div>
                    <div className="scan-bar"><div className="scan-fill" style={{width:`${pct}%`}}/></div>
                    <div className="tile-counter">
                      {tg ? `${tg.proc} / ${tg.total} tiles` : `${pct}%`}
                    </div>
                  </>
                ) : outputs.preview_url ? (
                  <img src={`${API_BASE}${outputs.preview_url}?t=${Date.now()}`} alt="preview"/>
                ) : (
                  <div className="preview-empty">
                    <div className="preview-empty-icon">🛰</div>
                    <p>
                      Upload four GeoTIFF band files,<br/>
                      then click <strong>Preview RGB</strong>.<br/>
                      Run <strong>Segment</strong> to detect clouds.
                    </p>
                  </div>
                )}
              </div>
            </div>

            {/* Downloads */}
            {hasDL && (
              <div className="card">
                <div className="card-head">
                  <div>
                    <div className="card-title">Output Files</div>
                    <div className="card-sub">Click to download</div>
                  </div>
                  {segDone && (
                    <div className="legend">
                      <div className="leg"><div className="leg-dot" style={{background:"var(--cloud)"}}/>Cloud</div>
                      <div className="leg"><div className="leg-dot" style={{background:"var(--shadow)"}}/>Shadow</div>
                    </div>
                  )}
                </div>
                <div className="card-body">
                  <div className="dl-list">
                    {outputs.mask_cloud_url  && <a href={`${API_BASE}${outputs.mask_cloud_url}`}  className="dl-item" target="_blank" rel="noreferrer"><span className="dl-icon">🔴</span><span className="dl-name">mask_full_cloud.tif</span><span className="dl-arr">↓</span></a>}
                    {outputs.mask_shadow_url && <a href={`${API_BASE}${outputs.mask_shadow_url}`} className="dl-item" target="_blank" rel="noreferrer"><span className="dl-icon">🔵</span><span className="dl-name">mask_full_shadow.tif</span><span className="dl-arr">↓</span></a>}
                    {outputs.mask_any_url    && <a href={`${API_BASE}${outputs.mask_any_url}`}    className="dl-item" target="_blank" rel="noreferrer"><span className="dl-icon">🟢</span><span className="dl-name">mask_full.tif</span><span className="dl-arr">↓</span></a>}
                    {outputs.overlay_url     && <a href={`${API_BASE}${outputs.overlay_url}`}     className="dl-item" target="_blank" rel="noreferrer"><span className="dl-icon">🖼</span><span className="dl-name">overlay.png</span><span className="dl-arr">↓</span></a>}
                    {outputs.zip_url         && <a href={`${API_BASE}${outputs.zip_url}`}         className="dl-item" target="_blank" rel="noreferrer"><span className="dl-icon">📁</span><span className="dl-name">shapefile.zip</span><span className="dl-arr">↓</span></a>}
                  </div>
                </div>
              </div>
            )}

            {/* Export + Info row */}
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:16}}>

              {/* Shapefile export */}
              <div className="card">
                <div className="card-head">
                  <div>
                    <div className="card-title">Export</div>
                    <div className="card-sub">Shapefile (.shp)</div>
                  </div>
                </div>
                <div className="card-body">
                  <div className="shp-list">
                    <button className="shp-btn" disabled={busy||!segDone} onClick={()=>makeShp("cloud")}>
                      <span className="shp-color" style={{background:"var(--cloud)"}}/>Cloud mask
                    </button>
                    <button className="shp-btn" disabled={busy||!segDone} onClick={()=>makeShp("shadow")}>
                      <span className="shp-color" style={{background:"var(--shadow)"}}/>Shadow mask
                    </button>
                    <button className="shp-btn" disabled={busy||!segDone} onClick={()=>makeShp("any")}>
                      <span className="shp-color" style={{background:"#1a6b35"}}/>Combined
                    </button>
                  </div>
                  {!segDone && (
                    <p style={{fontSize:11.5,color:"var(--text3)",marginTop:10,textAlign:"center"}}>
                      Run Segment first
                    </p>
                  )}
                </div>
              </div>

              {/* Run info */}
              <div className="card">
                <div className="card-head">
                  <div>
                    <div className="card-title">Details</div>
                    <div className="card-sub">Run statistics</div>
                  </div>
                </div>
                <div className="card-body">
                  <div className="info-rows">
                    <div className="info-row">
                      <span className="info-key">Status</span>
                      <span className={`info-val${sType==="ok"?" green":busy?" blue":""}`}>
                        {sType==="ok"?"Done":busy?"Running":"Idle"}
                      </span>
                    </div>
                    {totalTime!==null&&!busy && <div className="info-row"><span className="info-key">Time</span><span className="info-val green">{fmt(totalTime)}</span></div>}
                    {elapsed!==null && <div className="info-row"><span className="info-key">Elapsed</span><span className="info-val blue">{fmt(elapsed)}</span></div>}
                    {eta!==null&&eta>0 && <div className="info-row"><span className="info-key">ETA</span><span className="info-val amber">~{fmt(eta)}</span></div>}
                    {outputs.tiles_total && <div className="info-row"><span className="info-key">Tiles</span><span className="info-val">{outputs.tiles_used}/{outputs.tiles_total}</span></div>}
                    {outputs.chosen_preprocess && <div className="info-row"><span className="info-key">Mode</span><span className="info-val">{outputs.chosen_preprocess}</span></div>}
                    {outputs.chosen_cloud_threshold!==undefined && (
                      <div className="info-row"><span className="info-key">Threshold</span><span className="info-val">{Number(outputs.chosen_cloud_threshold).toFixed(2)}</span></div>
                    )}
                    {!outputs.tiles_total && !elapsed && !totalTime && (
                      <div style={{fontSize:12,color:"var(--text3)",padding:"6px 0",textAlign:"center"}}>
                        Stats appear during processing
                      </div>
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
import Link from "next/link";

const STEPS = [
  { n: "01", title: "Upload",       desc: "อัปโหลด 4 band GeoTIFF (Blue, Green, Red, NIR) จากดาวเทียม Landsat หรือ Sentinel" },
  { n: "02", title: "Preview",      desc: "ระบบ render RGB preview จาก 3 bands ให้เห็นภาพดาวเทียมก่อนประมวลผล" },
  { n: "03", title: "Tile Inference",desc: "โมเดล CNN วิ่ง sliding-window บนภาพทีละ tile ขนาด 480×480 px แบบ batch" },
  { n: "04", title: "Output",       desc: "ได้ Cloud mask, Shadow mask, Overlay PNG และ Shapefile พร้อม download" },
];

const SPECS = [
  { label: "Model",      value: "DeepLabV3+  ·  Keras H5" },
  { label: "Classes",    value: "Cloud  ·  Shadow" },
  { label: "Tile size",  value: "480 × 480 px" },
  { label: "Overlap",    value: "96 px" },
  { label: "Preprocess", value: "Per-band Min-Max" },
  { label: "Backend",    value: "FastAPI  ·  HuggingFace Spaces" },
];

// เปลี่ยนชื่อไฟล์ตรง img ให้ตรงกับรูปที่คุณเอาไปใส่ในโฟลเดอร์ public
const DEVELOPERS = [
  { name: "Mr. Kijnaphat Suksod", role: "Developer", img: "/dev1.jpg" },
  { name: "Mr. Guntapong Rattanarun", role: "Developer", img: "/dev2.jpg" },
  { name: "Mr. Thanachot Ngamcharoensuktavorn", role: "Developer", img: "/dev3.jpg" },
  { name: "Mr. Wit Kasemsup", role: "Developer", img: "/dev4.jpg" },
];

// เปลี่ยนชื่อไฟล์ตรง img ให้ตรงกับรูปที่ปรึกษา
const ADVISOR = { name: "Asst. Prof. Dr. Wuttichai Boonpook", role: "Advisor", img: "/advisor.jpg" };

export default function HomePage() {
  return (
    <>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600&display=swap');
        :root {
          --white: #ffffff; --off: #f5f5f7; --off2: #e8e8ed; --off3: #d2d2d7;
          --text: #1d1d1f; --text2: #6e6e73; --text3: #aeaeb2;
          --blue: #0071e3; --blue-l: #e8f2ff;
          --green: #1d8348; --green-l: #e8f5e9;
          --sans: 'Inter', -apple-system, BlinkMacSystemFont, 'Helvetica Neue', sans-serif;
        }
        *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
        html, body { height: 100%; }
        body { font-family: var(--sans); background: var(--white); color: var(--text); -webkit-font-smoothing: antialiased; }
        a { text-decoration: none; color: inherit; }

        /* NAV */
        nav { position: sticky; top: 0; z-index: 100; background: rgba(255,255,255,.82); backdrop-filter: saturate(180%) blur(20px); border-bottom: 1px solid rgba(0,0,0,.06); }
        .nav-in { max-width: 1080px; margin: 0 auto; padding: 0 24px; height: 52px; display: flex; align-items: center; justify-content: space-between; }
        .nav-logo { display: flex; align-items: center; gap: 9px; }
        .logo-box { width: 26px; height: 26px; border-radius: 7px; background: var(--text); display: flex; align-items: center; justify-content: center; }
        .nav-logo-text { display: flex; align-items: baseline; gap: 4px; }
        .logo-name { font-size: 16px; font-weight: 600; letter-spacing: -.3px; }
        .logo-suffix { font-size: 11px; color: var(--text2); font-weight: 400; }
        .btn { display: inline-flex; align-items: center; gap: 6px; padding: 8px 20px; border-radius: 980px; font-family: var(--sans); font-size: 13.5px; font-weight: 500; cursor: pointer; transition: all .15s; border: none; letter-spacing: -.1px; }
        .btn-primary { background: var(--blue); color: #fff; }
        .btn-primary:hover { background: #0077ed; }
        .btn-ghost { background: transparent; color: var(--blue); }
        .btn-ghost:hover { background: var(--blue-l); }
        .btn-sm { padding: 6px 14px; font-size: 12.5px; }

        /* HERO */
        .hero { text-align: center; padding: 100px 24px 80px; background: var(--white); }
        .hero-eyebrow { font-size: 13px; font-weight: 500; letter-spacing: .8px; text-transform: uppercase; color: var(--blue); margin-bottom: 18px; }
        .hero-title { font-size: clamp(42px, 6vw, 72px); font-weight: 300; letter-spacing: -2.5px; line-height: 1.06; color: var(--text); margin-bottom: 20px; }
        .hero-title strong { font-weight: 600; }
        .hero-sub { font-size: clamp(17px, 2.2vw, 21px); color: var(--text2); font-weight: 300; line-height: 1.5; max-width: 600px; margin: 0 auto 40px; letter-spacing: -.2px; }
        .hero-btns { display: flex; align-items: center; justify-content: center; gap: 14px; flex-wrap: wrap; }
        .hero-note { font-size: 12px; color: var(--text3); margin-top: 18px; }

        /* PREVIEW MOCKUP */
        .mockup-wrap { max-width: 900px; margin: 0 auto; padding: 0 24px 80px; }
        .mockup { border-radius: 20px; overflow: hidden; box-shadow: 0 32px 80px rgba(0,0,0,0.12), 0 0 0 1px rgba(0,0,0,0.06); background: var(--off); }
        .mockup-bar { height: 40px; background: rgba(255,255,255,.9); border-bottom: 1px solid rgba(0,0,0,.06); display: flex; align-items: center; padding: 0 16px; gap: 7px; }
        .dot-r { width: 11px; height: 11px; border-radius: 50%; background: #ff5f57; }
        .dot-y { width: 11px; height: 11px; border-radius: 50%; background: #ffbd2e; }
        .dot-g { width: 11px; height: 11px; border-radius: 50%; background: #28c840; }
        .mockup-url { flex: 1; height: 24px; background: rgba(0,0,0,.05); border-radius: 5px; max-width: 320px; margin: 0 auto; display: flex; align-items: center; justify-content: center; font-size: 11px; color: var(--text3); }
        .mockup-screen { height: 460px; display: flex; align-items: center; justify-content: center; background: linear-gradient(135deg, #f5f5f7 0%, #e8e8ed 100%); position: relative; overflow: hidden; }
        .mockup-ui { width: 90%; height: 90%; border-radius: 12px; background: white; box-shadow: 0 4px 24px rgba(0,0,0,.08); display: flex; overflow: hidden; }
        .mockup-left { width: 280px; flex-shrink: 0; border-right: 1px solid #e8e8ed; padding: 20px; display: flex; flex-direction: column; gap: 14px; }
        .mock-card { background: #f5f5f7; border-radius: 12px; padding: 14px; }
        .mock-title { font-size: 11px; font-weight: 600; color: #1d1d1f; margin-bottom: 10px; }
        .mock-band { display: flex; align-items: center; gap: 8px; margin-bottom: 6px; }
        .mock-pill { width: 20px; height: 20px; border-radius: 5px; flex-shrink: 0; font-size: 9px; font-weight: 700; display: flex; align-items: center; justify-content: center; }
        .mock-bar-bg { flex: 1; height: 8px; border-radius: 4px; background: #e8e8ed; }
        .mock-bar-fill { height: 100%; border-radius: 4px; }
        .mock-step { display: flex; align-items: center; gap: 8px; padding: 6px 0; }
        .mock-circle { width: 18px; height: 18px; border-radius: 50%; border: 1.5px solid #d2d2d7; flex-shrink: 0; display: flex; align-items: center; justify-content: center; font-size: 8px; font-weight: 600; color: #aeaeb2; }
        .mock-circle.done { border-color: #1d8348; background: #e8f5e9; color: #1d8348; }
        .mock-circle.run  { border-color: #0071e3; background: #e8f2ff; color: #0071e3; }
        .mock-step-lbl { font-size: 10px; color: #6e6e73; }
        .mock-step-lbl.run { color: #0071e3; font-weight: 500; }
        .mockup-right { flex: 1; background: #f5f5f7; display: flex; align-items: center; justify-content: center; padding: 16px; }
        .mock-img { width: 100%; height: 100%; border-radius: 10px; background: linear-gradient(135deg, #1a2332 0%, #2d4a6b 40%, #1a3a55 70%, #0d1f33 100%); display: flex; align-items: center; justify-content: center; position: relative; overflow: hidden; }
        .mock-cloud-red { position: absolute; top: 20%; left: 15%; width: 45%; height: 35%; border-radius: 50% 60% 40% 55%; background: rgba(231,76,60,.35); }
        .mock-cloud-blue { position: absolute; bottom: 25%; right: 20%; width: 30%; height: 25%; border-radius: 55% 40% 60% 45%; background: rgba(41,128,185,.35); }
        .mock-img-label { font-size: 9px; font-weight: 600; color: rgba(255,255,255,.5); letter-spacing: .5px; text-transform: uppercase; z-index: 1; }

        /* DIVIDER */
        .divider { height: 1px; background: var(--off2); max-width: 1080px; margin: 0 auto; }

        /* SECTION COMMON */
        .section { max-width: 1080px; margin: 0 auto; padding: 80px 24px; }
        .section-eyebrow { font-size: 12px; font-weight: 600; letter-spacing: .8px; text-transform: uppercase; color: var(--blue); margin-bottom: 12px; }
        .section-title { font-size: clamp(28px, 3.5vw, 44px); font-weight: 300; letter-spacing: -1.5px; color: var(--text); line-height: 1.1; margin-bottom: 56px; }
        .section-title strong { font-weight: 600; }

        /* HOW IT WORKS */
        .steps-grid { display: grid; grid-template-columns: repeat(4,1fr); gap: 1px; background: var(--off2); border-radius: 16px; overflow: hidden; }
        @media (max-width: 768px) { .steps-grid { grid-template-columns: 1fr 1fr; } }
        @media (max-width: 480px) { .steps-grid { grid-template-columns: 1fr; } }
        .step-card { background: var(--white); padding: 28px 24px; }
        .step-num { font-size: 12px; font-weight: 600; color: var(--blue); letter-spacing: .5px; margin-bottom: 14px; }
        .step-title { font-size: 17px; font-weight: 600; letter-spacing: -.3px; color: var(--text); margin-bottom: 8px; }
        .step-desc { font-size: 13.5px; color: var(--text2); line-height: 1.6; }

        /* SPECS */
        .specs-wrap { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; }
        @media (max-width: 640px) { .specs-wrap { grid-template-columns: 1fr; } }
        .spec-card { background: var(--off); border-radius: 16px; padding: 28px; }
        .spec-title { font-size: 20px; font-weight: 600; letter-spacing: -.4px; margin-bottom: 20px; }
        .spec-rows { display: flex; flex-direction: column; gap: 0; }
        .spec-row { display: flex; justify-content: space-between; align-items: center; padding: 10px 0; border-bottom: 1px solid var(--off2); font-size: 13.5px; }
        .spec-row:last-child { border-bottom: none; }
        .spec-key { color: var(--text3); }
        .spec-val { color: var(--text); font-weight: 500; }

        /* TEAM */
        .team-grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 48px; }
        @media (max-width: 640px) { .team-grid { grid-template-columns: 1fr; gap: 40px; } }
        .team-card { display: flex; align-items: center; gap: 24px; }
        
        /* สไตล์ของรูปภาพ (วงกลม ตัดขอบสวยงาม) */
        .team-img-wrap {
          width: 160px; height: 160px; border-radius: 50%; overflow: hidden;
          background: var(--off2); flex-shrink: 0;
          object-fit: cover; border: 4px solid var(--white);
          box-shadow: var(--shadow-sm); 
        }

        .team-info { display: flex; flex-direction: column; gap: 6px; }
        .team-name { font-size: 18px; font-weight: 600; color: var(--text); letter-spacing: -.4px; }
        .team-role { font-size: 14px; color: var(--blue); font-weight: 500; }

        .advisor-section-title { margin-top: 80px; margin-bottom: 40px; font-size: 24px; font-weight: 600; letter-spacing: -.5px; color: var(--text); display: flex; align-items: center; gap: 10px; }
        .advisor-title-line { flex: 1; height: 1px; background: var(--off2); }
        .advisor-card-wrap { display: flex; justify-content: center; }

        /* CTA */
        .cta { background: var(--off); }
        .cta-in { max-width: 1080px; margin: 0 auto; padding: 80px 24px; text-align: center; }
        .cta-title { font-size: clamp(30px, 4vw, 48px); font-weight: 300; letter-spacing: -1.5px; margin-bottom: 16px; }
        .cta-title strong { font-weight: 600; }
        .cta-sub { font-size: 17px; color: var(--text2); margin-bottom: 36px; font-weight: 300; }

        /* FOOTER */
        footer { border-top: 1px solid var(--off2); }
        .footer-in { max-width: 1080px; margin: 0 auto; padding: 24px 24px; display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 10px; }
        .footer-text { font-size: 12px; color: var(--text3); }
      `}</style>

      <nav>
        <div className="nav-in">
          <div className="nav-logo">
            <div className="logo-box">
              <svg width="15" height="15" viewBox="0 0 18 18" fill="none">
                <path d="M3 13s2-4 6-4 6-4 6-4" stroke="white" strokeWidth="1.8" strokeLinecap="round"/>
                <circle cx="9" cy="15" r="2" fill="white"/>
              </svg>
            </div>
            <div className="nav-logo-text">
              <span className="logo-name">CloudSeg</span>
              <span className="logo-suffix"> Satellite Image Analysis</span>
            </div>
          </div>
          <Link href="/segment" className="btn btn-primary btn-sm">
            Open App →
          </Link>
        </div>
      </nav>

      <section className="hero">
        <div className="hero-eyebrow">Satellite Image Analysis</div>
        <h1 className="hero-title">
          Cloud &amp; Shadow<br/>
          <strong>Segmentation.</strong>
        </h1>
        <p className="hero-sub">
          อัปโหลด GeoTIFF 4 band แล้วให้ AI ตรวจจับเมฆและเงาดาวเทียม
          แบบ real-time — ทีละ tile จนได้ mask พร้อมใช้งาน
        </p>
        <div className="hero-btns">
          <Link href="/segment" className="btn btn-primary">
            Get Started →
          </Link>
          <a href="#how" className="btn btn-ghost">ดูวิธีการทำงาน</a>
        </div>
        <p className="hero-note">Cloud + Shadow mask · GeoTIFF · Shapefile · Overlay PNG</p>
      </section>

      <div className="mockup-wrap">
        <div className="mockup">
          <div className="mockup-bar">
            <div className="dot-r"/><div className="dot-y"/><div className="dot-g"/>
            <div className="mockup-url">cloudseg.app / segment</div>
          </div>
          <div className="mockup-screen">
            <div className="mockup-ui">
              <div className="mockup-left">
                <div className="mock-card">
                  <div className="mock-title">Band Files</div>
                  {[
                    {l:"B",bg:"#e5f0ff",fg:"#0057b8",w:"100%"},
                    {l:"G",bg:"#e5f5ec",fg:"#1a6b35",w:"100%"},
                    {l:"R",bg:"#fdecea",fg:"#b71c1c",w:"100%"},
                    {l:"N",bg:"#fff8e1",fg:"#7d4e00",w:"100%"},
                  ].map(b => (
                    <div className="mock-band" key={b.l}>
                      <div className="mock-pill" style={{background:b.bg,color:b.fg}}>{b.l}</div>
                      <div className="mock-bar-bg">
                        <div className="mock-bar-fill" style={{width:b.w,background:b.fg,opacity:.5}}/>
                      </div>
                    </div>
                  ))}
                </div>
                <div className="mock-card">
                  <div className="mock-title">Pipeline</div>
                  {[
                    {lbl:"Upload",     status:"done"},
                    {lbl:"RGB Preview",status:"done"},
                    {lbl:"Load Model", status:"done"},
                    {lbl:"Inference",  status:"run"},
                    {lbl:"Write Masks",status:""},
                    {lbl:"Overlay",    status:""},
                  ].map(s => (
                    <div className="mock-step" key={s.lbl}>
                      <div className={`mock-circle${s.status?" "+s.status:""}`}>
                        {s.status==="done"?"✓":s.status==="run"?"↻":""}
                      </div>
                      <div className={`mock-step-lbl${s.status===" run"?" run":""}`} style={{color:s.status==="run"?"#0071e3":s.status==="done"?"#1d1d1f":"#aeaeb2"}}>{s.lbl}</div>
                    </div>
                  ))}
                </div>
              </div>
              <div className="mockup-right">
                <div className="mock-img">
                  <div className="mock-cloud-red"/>
                  <div className="mock-cloud-blue"/>
                  <span className="mock-img-label">Live Inference</span>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      <div className="divider"/>

      <section className="section" id="how">
        <div className="section-eyebrow">How it works</div>
        <div className="section-title">4 ขั้นตอน<br/><strong>ตั้งแต่ต้นจนได้ผลลัพธ์</strong></div>
        <div className="steps-grid">
          {STEPS.map(s => (
            <div className="step-card" key={s.n}>
              <div className="step-num">{s.n}</div>
              <div className="step-title">{s.title}</div>
              <div className="step-desc">{s.desc}</div>
            </div>
          ))}
        </div>
      </section>

      <div className="divider"/>

      <section className="section">
        <div className="section-eyebrow">Specifications</div>
        <div className="section-title">รายละเอียด<br/><strong>ของระบบ</strong></div>
        <div className="specs-wrap">
          <div className="spec-card">
            <div className="spec-title">Model</div>
            <div className="spec-rows">
              {SPECS.map(s => (
                <div className="spec-row" key={s.label}>
                  <span className="spec-key">{s.label}</span>
                  <span className="spec-val">{s.value}</span>
                </div>
              ))}
            </div>
          </div>
          <div className="spec-card">
            <div className="spec-title">Outputs</div>
            <div className="spec-rows">
              {[
                { label:"Cloud mask",  value:"GeoTIFF (0/1)" },
                { label:"Shadow mask", value:"GeoTIFF (0/1)" },
                { label:"Combined",    value:"GeoTIFF (0/1/2)" },
                { label:"Overlay",     value:"PNG (RGB + mask)" },
                { label:"Shapefile",   value:".shp + .dbf + .prj" },
                { label:"Live preview",value:"Partial overlay PNG" },
              ].map(s => (
                <div className="spec-row" key={s.label}>
                  <span className="spec-key">{s.label}</span>
                  <span className="spec-val">{s.value}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </section>

      <div className="divider"/>

      <section className="section">
        <div className="section-eyebrow">Our Team</div>
        <div className="section-title">ทีมผู้พัฒนา<br/><strong>และที่ปรึกษา</strong></div>
        
        <div className="team-wrap">
          <div className="team-grid">
            {DEVELOPERS.map(dev => (
              <div className="team-card" key={dev.name}>
                {/* เปลี่ยนเป็นรูปภาพจาก properties ที่เราสร้างไว้ */}
                <img src={dev.img} alt={dev.name} className="team-img-wrap" />
                <div className="team-info">
                  <div className="team-name">{dev.name}</div>
                  <div className="team-role">{dev.role}</div>
                </div>
              </div>
            ))}
          </div>

          <div className="advisor-section-title">
            <div className="advisor-title-line"></div>
            <span>Advisor</span>
            <div className="advisor-title-line"></div>
          </div>

          <div className="advisor-card-wrap">
            <div className="team-card">
              {/* เปลี่ยนเป็นรูปภาพจาก properties ที่เราสร้างไว้ */}
              <img src={ADVISOR.img} alt={ADVISOR.name} className="team-img-wrap" />
              <div className="team-info">
                <div className="team-name">{ADVISOR.name}</div>
                <div className="team-role">{ADVISOR.role}</div>
              </div>
            </div>
          </div>
        </div>
      </section>

      <section className="cta">
        <div className="cta-in">
          <h2 className="cta-title">พร้อมใช้งาน<br/><strong>เริ่มได้เลย</strong></h2>
          <p className="cta-sub">อัปโหลด GeoTIFF แล้วดูผลลัพธ์ภายในไม่กี่นาที</p>
          <Link href="/segment" className="btn btn-primary" style={{fontSize:16,padding:"13px 32px"}}>
            Open CloudSeg →
          </Link>
        </div>
      </section>

      <footer>
        <div className="footer-in">
          <span className="footer-text">CloudSeg — Cloud &amp; Shadow Segmentation</span>
          <span className="footer-text">Powered by FastAPI · HuggingFace · TensorFlow</span>
        </div>
      </footer>
    </>
  );
}
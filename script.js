// EchoScope — Peak Picker
let audioCtx;
let workletNode;
let stream;
let buffer = [];
let sampleRate = 48000;

const $ = (s)=>document.querySelector(s);
const wave = $("#wave");
const g = wave.getContext("2d");

const recMsEl = $("#recMs");
const preMsEl = $("#preMs");
const pulseMsEl = $("#pulseMs");
const pulseVolEl = $("#pulseVol");

const envMsEl = $("#envMs");
const threshEl = $("#thresh");
const minSepEl = $("#minSep");

const tubeLEl = $("#tubeL");
const geomEl = $("#geom");
const extraPathWrap = $("#customPathWrap");
const extraPathEl = $("#extraPath");

const measureBtn = $("#measureBtn");
const startBtn = $("#startBtn");
const stopBtn = $("#stopBtn");
const exportBtn = $("#exportBtn");
const setT1Btn = $("#setT1");
const setT2Btn = $("#setT2");
const recalcBtn = $("#recalc");
const statusEl = $("#status");

const srEl = $("#sr");
const t1El = $("#t1");
const a1El = $("#a1");
const t2El = $("#t2");
const a2El = $("#a2");
const dtEl = $("#dt");
const vEl  = $("#v");

let pickMode = null; // 't1' or 't2' or null
let lastData = null;
let lastPeaks = null;

function setStatus(s){ statusEl.textContent = s; }

function resetUI(){
  [t1El,a1El,t2El,a2El,dtEl,vEl].forEach(el=>el.textContent="—");
  exportBtn.disabled = true;
  draw([], []);
  lastData = null; lastPeaks = null;
}

geomEl.addEventListener("change", ()=>{
  extraPathWrap.style.display = (geomEl.value === "custom") ? "" : "none";
});

async function initAudio(){
  if(audioCtx) return;
  audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  sampleRate = audioCtx.sampleRate;
  srEl.textContent = sampleRate.toFixed(0);
  await audioCtx.audioWorklet.addModule('recorder-worklet.js');
}

async function attachMic(){
  stream = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation:false, noiseSuppression:false, autoGainControl:false }
  });
  const src = audioCtx.createMediaStreamSource(stream);
  workletNode = new AudioWorkletNode(audioCtx, 'recorder');
  src.connect(workletNode);
  workletNode.connect(audioCtx.destination);
  buffer = [];
  workletNode.port.onmessage = (e)=>{
    if(e.data.type === 'samples') buffer.push(e.data.payload);
  };
}

function teardown(){
  try{ workletNode && workletNode.disconnect(); }catch{}
  try{ audioCtx && audioCtx.close(); }catch{}
  try{ stream && stream.getTracks().forEach(t=>t.stop()); }catch{}
  workletNode = null; audioCtx = null; stream = null;
}

function stopRec(){
  stopBtn.disabled = true;
  setStatus("停止処理...");
  teardown();

  const totalLen = buffer.reduce((acc,a)=>acc + a.length, 0);
  const data = new Float32Array(totalLen);
  let o=0;
  buffer.forEach(a=>{ data.set(a, o); o+=a.length; });

  lastData = data;
  const peaks = autoDetectPeaks(data);
  lastPeaks = peaks;
  renderPeaks(peaks);
  startBtn.disabled = false;
  measureBtn.disabled = false;
}

async function startRecOnly(){
  try{
    startBtn.disabled = true; stopBtn.disabled = false;
    setStatus("初期化...");
    await initAudio();
    await attachMic();
    setStatus("録音中...");
    const ms = Math.max(100, parseInt(recMsEl.value||"1200",10));
    setTimeout(stopRec, ms);
  }catch(err){
    console.error(err);
    setStatus("マイク取得に失敗: 権限やデバイスを確認してください");
    startBtn.disabled = false;
    stopBtn.disabled = true;
  }
}

async function measureWithPulse(){
  try{
    measureBtn.disabled = true; stopBtn.disabled = false;
    setStatus("初期化...");
    await initAudio();
    await attachMic();
    const recMs = Math.max(100, parseInt(recMsEl.value||"1200",10));
    const preMs = Math.max(50, parseInt(preMsEl.value||"150",10));
    const pulseMs = Math.max(1, parseInt(pulseMsEl.value||"8",10));
    const vol = Math.max(0, Math.min(1, parseFloat(pulseVolEl.value||"0.8")));

    const startTime = audioCtx.currentTime + preMs/1000;
    playPulseAt(startTime, pulseMs/1000, vol);

    setStatus("録音中...（パルス発音→自動ピーク検出）");
    setTimeout(stopRec, recMs);
  }catch(err){
    console.error(err);
    setStatus("エラー: " + err.message);
    measureBtn.disabled = false;
  }
}

function playPulseAt(startTime, durSec, vol){
  const len = Math.max(1, Math.floor(sampleRate * durSec));
  const noise = audioCtx.createBuffer(1, len, sampleRate);
  const ch = noise.getChannelData(0);
  for(let i=0;i<ch.length;i++) ch[i] = (Math.random()*2-1);
  const src = audioCtx.createBufferSource();
  src.buffer = noise;

  const hp = audioCtx.createBiquadFilter(); hp.type='highpass'; hp.frequency.value = 800;
  const lp = audioCtx.createBiquadFilter(); lp.type='lowpass';  lp.frequency.value = 6000;
  const g = audioCtx.createGain(); g.gain.value = 0;

  src.connect(hp).connect(lp).connect(g).connect(audioCtx.destination);

  const a = g.gain;
  a.setValueAtTime(0, startTime);
  a.linearRampToValueAtTime(vol, startTime + 0.002);
  a.exponentialRampToValueAtTime(0.001, startTime + durSec);
  a.setValueAtTime(0, startTime + durSec + 0.01);

  src.start(startTime);
  src.stop(startTime + durSec + 0.02);
}

function movingAverageAbs(data, win){
  const out = new Float32Array(data.length);
  let sum = 0;
  for(let i=0;i<data.length;i++){
    const v = Math.abs(data[i]);
    sum += v;
    if(i>=win) sum -= Math.abs(data[i-win]);
    out[i] = sum / Math.min(i+1, win);
  }
  return out;
}

function autoDetectPeaks(data){
  const sr = sampleRate;
  const envWin = Math.max(1, Math.floor(sr * (parseFloat(envMsEl.value||"1.5")/1000)));
  const env = movingAverageAbs(data, envWin);

  // relative threshold
  let maxv = 0; for(let i=0;i<env.length;i++) if(env[i]>maxv) maxv=env[i];
  const T = (maxv>0) ? (parseFloat(threshEl.value||"0.08") * maxv) : parseFloat(threshEl.value||"0.08");

  const minSep = Math.max(1, Math.floor(sr * (parseFloat(minSepEl.value||"40")/1000)));
  const candidates = [];
  let i = 1;
  while(i < env.length-1){
    if(env[i] >= T && env[i] >= env[i-1] && env[i] >= env[i+1]){
      // local max
      candidates.push(i);
      i += minSep; // enforce separation
    }else{
      i++;
    }
  }

  // take first two peaks
  const peaks = candidates.slice(0,2);
  // refine on raw |data| around each peak (±1 ms)
  const ref = [];
  const refineWin = Math.max(1, Math.floor(sr * 0.001));
  for(const p of peaks){
    let bestIdx = p, bestVal = 0;
    const s = Math.max(0, p - refineWin), e = Math.min(data.length, p + refineWin + 1);
    for(let k=s;k<e;k++){
      const v = Math.abs(data[k]);
      if(v > bestVal){ bestVal = v; bestIdx = k; }
    }
    ref.push(bestIdx);
  }
  return ref;
}

function renderPeaks(peaks){
  const data = lastData;
  const sr = sampleRate;
  if(!data) return;
  draw(data, peaks.map((idx, n)=>({index: idx, color: n===0?"#1f77b4":"#d62728"})));

  let t1=NaN,a1=NaN,t2=NaN,a2=NaN;
  if(peaks[0] != null){
    t1 = peaks[0]/sr; a1 = Math.abs(data[peaks[0]]);
  }
  if(peaks[1] != null){
    t2 = peaks[1]/sr; a2 = Math.abs(data[peaks[1]]);
  }
  t1El.textContent = isFinite(t1)?t1.toFixed(6):"—";
  a1El.textContent = isFinite(a1)?a1.toFixed(4):"—";
  t2El.textContent = isFinite(t2)?t2.toFixed(6):"—";
  a2El.textContent = isFinite(a2)?a2.toFixed(4):"—";

  const dt = (isFinite(t1)&&isFinite(t2)) ? (t2-t1) : NaN;
  dtEl.textContent = isFinite(dt)?dt.toFixed(6):"—";

  exportBtn.disabled = false;
  exportBtn.onclick = () => exportCSV({t1,a1,t2,a2,dt,sr});
  recalcSpeed(dt);
}

function recalcSpeed(dtOverride){
  const dt = (typeof dtOverride === "number" && isFinite(dtOverride)) ? dtOverride :
             (isFinite(parseFloat(dtEl.textContent)) ? parseFloat(dtEl.textContent) : NaN);
  if(!isFinite(dt) || dt<=0){ vEl.textContent="—"; return; }
  let v;
  if(geomEl.value === "round"){
    const L = Math.max(0, parseFloat(tubeLEl.value||"0"));
    v = (2 * L) / dt;
  }else{
    const dL = Math.max(0, parseFloat(extraPathEl.value||"0"));
    v = dL / dt;
  }
  vEl.textContent = isFinite(v) ? v.toFixed(3) : "—";
}

recalcBtn.addEventListener("click", ()=> recalcSpeed());

function draw(data, marks=[]){
  const W = wave.width, H = wave.height;
  const ctx = g;
  ctx.clearRect(0,0,W,H);
  ctx.fillStyle = "#fff"; ctx.fillRect(0,0,W,H);
  ctx.strokeStyle = "#e5e7eb"; ctx.beginPath(); ctx.moveTo(0,H/2); ctx.lineTo(W,H/2); ctx.stroke();

  if(!data || data.length===0) return;

  const step = Math.ceil(data.length / W);
  ctx.strokeStyle = "#4f6aa0"; ctx.beginPath();
  for(let x=0; x<W; x++){
    const start = x*step;
    const end = Math.min((x+1)*step, data.length);
    let min = 1, max = -1;
    for(let i=start;i<end;i++){
      const v = data[i];
      if(v<min) min=v; if(v>max) max=v;
    }
    const y1 = H/2 - min * (H*0.45);
    const y2 = H/2 - max * (H*0.45);
    ctx.moveTo(x, y1);
    ctx.lineTo(x, y2);
  }
  ctx.stroke();

  marks.forEach(m => {
    const x = Math.floor((m.index / data.length) * W);
    ctx.fillStyle = m.color || "#d24";
    ctx.fillRect(x, 0, 2, H);
  });
}

// Manual pick: click canvas with t₁手動 / t₂手動ボタン
setT1Btn.addEventListener("click", ()=>{ pickMode = (pickMode==='t1'?null:'t1'); setStatus(pickMode==='t1'?'t₁をクリックで指定':''); });
setT2Btn.addEventListener("click", ()=>{ pickMode = (pickMode==='t2'?null:'t2'); setStatus(pickMode==='t2'?'t₂をクリックで指定':''); });
wave.addEventListener("click", (ev)=>{
  if(!pickMode || !lastData) return;
  const rect = wave.getBoundingClientRect();
  const x = ev.clientX - rect.left;
  const W = wave.width;
  const idx = Math.round((x / W) * lastData.length);
  // refine to nearest local |data| max ±1ms
  const sr = sampleRate;
  const win = Math.max(1, Math.floor(sr*0.001));
  let best = idx, bestVal = 0;
  for(let k=Math.max(0,idx-win); k<Math.min(lastData.length,idx+win+1); k++){
    const v = Math.abs(lastData[k]);
    if(v > bestVal){ bestVal = v; best = k; }
  }
  if(!lastPeaks) lastPeaks = [];
  if(pickMode==='t1') lastPeaks[0] = best;
  if(pickMode==='t2') lastPeaks[1] = best;
  renderPeaks(lastPeaks);
  pickMode = null;
  setStatus("手動指定を適用しました");
});

function exportCSV({t1,a1,t2,a2,dt,sr}){
  const L = parseFloat(tubeLEl.value||"");
  const mode = geomEl.value;
  const dL = (mode==='round') ? (2*L) : parseFloat(extraPathEl.value||"");
  const v = (isFinite(dt) && dt>0) ? (dL/dt) : NaN;
  const header = ["sample_rate_Hz","t1_s","A1","t2_s","A2","delta_t_s","mode","L_m","extra_path_m","speed_mps"];
  let csv = header.join(",") + "\\n";
  csv += [sr, 
          isFinite(t1)?t1.toFixed(6):"", 
          isFinite(a1)?a1.toFixed(6):"", 
          isFinite(t2)?t2.toFixed(6):"", 
          isFinite(a2)?a2.toFixed(6):"", 
          isFinite(dt)?dt.toFixed(6):"", 
          mode, 
          (mode==='round')?L.toFixed(6):"", 
          (mode==='custom')?dL.toFixed(6):"", 
          isFinite(v)?v.toFixed(6):""].join(",") + "\\n";
  const blob = new Blob([csv], {type:"text/csv"});
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "peak_picker_result.csv";
  a.click();
  URL.revokeObjectURL(a.href);
}

measureBtn.addEventListener("click", measureWithPulse);
startBtn.addEventListener("click", startRecOnly);
stopBtn.addEventListener("click", stopRec);
recalcBtn.addEventListener("click", ()=>recalcSpeed());

resetUI();

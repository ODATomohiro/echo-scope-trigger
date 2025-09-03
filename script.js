// EchoScope — Reflection Minimal v1.2 (threshold guide)
let audioCtx;
let workletNode;
let stream;
let buffer = [];
let sampleRate = 48000;

const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent);

const $ = (s)=>document.querySelector(s);
const wave = $("#wave");
const g = wave.getContext("2d");

const recMsEl = $("#recMs");
const preMsEl = $("#preMs");
const pulseTypeEl = $("#pulseType");
const pulseMsEl = $("#pulseMs");
const pulseVolEl = $("#pulseVol");

const envMsEl = $("#envMs");
const threshEl = $("#thresh");
const minSepEl = $("#minSep");
const showCandsEl = $("#showCands");
const applyTop2Btn = $("#applyTop2");

const measureBtn = $("#measureBtn");
const startBtn = $("#startBtn");
const stopBtn = $("#stopBtn");
const pulseTestBtn = $("#pulseTest");
const exportBtn = $("#exportBtn");
const setT1Btn = $("#setT1");
const setT2Btn = $("#setT2");
const clearMarksBtn = $("#clearMarks");
const statusEl = $("#status");

const srEl = $("#sr");
const t1El = $("#t1");
const a1El = $("#a1");
const t2El = $("#t2");
const a2El = $("#a2");
const dtEl = $("#dt");

let lastData = null;
let marks = {t1:null, t2:null};
let candidates = [];
let pickMode = null;

function setStatus(s){ statusEl.textContent = s; }

function resetUI(){
  [t1El,a1El,t2El,a2El,dtEl].forEach(el=>el.textContent="—");
  exportBtn.disabled = true;
  draw([], []);
  lastData = null; marks = {t1:null, t2:null}; candidates = [];
  if(isIOS){ pulseTypeEl.value="sine"; pulseMsEl.value="60"; }
}

async function initAudio(workletNeeded=true){
  if(audioCtx) return;
  audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  sampleRate = audioCtx.sampleRate;
  srEl.textContent = sampleRate.toFixed(0);
  if(workletNeeded){
    try{ await audioCtx.audioWorklet.addModule('recorder-worklet.js'); }catch(e){ console.warn("Worklet load failed:", e); }
  }
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
  updateCandidates();
  redrawAll();
  exportBtn.disabled = false;
  exportBtn.onclick = () => exportCSV();
  setStatus("完了：波形から t₁/t₂ をクリックで指定してください（候補は参考表示）");
  startBtn.disabled = false;
  measureBtn.disabled = false;
}

async function startRecOnly(){
  try{
    startBtn.disabled = true; stopBtn.disabled = false;
    setStatus("初期化...");
    await initAudio(true);
    await attachMic();
    setStatus("録音中...");
    const ms = Math.max(200, parseInt(recMsEl.value||"1200",10));
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
    await initAudio(true);
    await audioCtx.resume();
    await attachMic();
    const recMs = Math.max(200, parseInt(recMsEl.value||"1200",10));
    const preMs = Math.max(50, parseInt(preMsEl.value||"150",10));
    const pulseMs = Math.max(2, parseInt(pulseMsEl.value||"60",10));
    const vol = Math.max(0, Math.min(1, parseFloat(pulseVolEl.value||"0.8")));
    const type = pulseTypeEl.value;

    const startTime = audioCtx.currentTime + Math.max(0.05, preMs/1000);
    playPulseAt(startTime, pulseMs/1000, vol, type);

    setStatus("録音中...（パルス→手動ピーク）");
    setTimeout(stopRec, recMs);
  }catch(err){
    console.error(err);
    setStatus("エラー: " + err.message);
    measureBtn.disabled = false;
  }
}

function playPulseAt(startTime, durSec, vol, type){
  const g = audioCtx.createGain();
  g.gain.value = 0;
  let src;
  if(type === "sine"){
    src = audioCtx.createOscillator();
    src.type = "sine";
    src.frequency.value = 1500;
  }else{ // noise
    const len = Math.max(1, Math.floor(sampleRate * durSec));
    const noise = audioCtx.createBuffer(1, len, sampleRate);
    const ch = noise.getChannelData(0);
    for(let i=0;i<ch.length;i++) ch[i] = (Math.random()*2-1);
    const bs = audioCtx.createBufferSource();
    bs.buffer = noise;
    src = bs;
  }

  const hp = audioCtx.createBiquadFilter(); hp.type='highpass'; hp.frequency.value = 600;
  const lp = audioCtx.createBiquadFilter(); lp.type='lowpass';  lp.frequency.value = 7000;

  src.connect(hp).connect(lp).connect(g).connect(audioCtx.destination);

  const a = g.gain;
  a.setValueAtTime(0, startTime);
  a.linearRampToValueAtTime(vol, startTime + 0.003);
  a.exponentialRampToValueAtTime(0.001, startTime + durSec);
  a.setValueAtTime(0, startTime + durSec + 0.02);

  if(src.start) src.start(startTime);
  if(src.stop)  src.stop(startTime + durSec + 0.03);
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

function findCandidates(data){
  if(!data || data.length===0) return [];
  const sr = sampleRate;
  const envWin = Math.max(1, Math.floor(sr * (parseFloat(envMsEl.value||"1.2")/1000)));
  const env = movingAverageAbs(data, envWin);

  // relative threshold
  let maxv = 0; for(let i=0;i<env.length;i++) if(env[i]>maxv) maxv=env[i];
  const Trel = Math.max(0.0, Math.min(1.0, parseFloat(threshEl.value||"0.06")));
  const T = (maxv>0) ? (Trel * maxv) : Trel;

  const minSep = Math.max(1, Math.floor(sr * (parseFloat(minSepEl.value||"2.5")/1000)));
  const cands = [];
  let i = 1;
  while(i < env.length-1){
    if(env[i] >= T && env[i] >= env[i-1] && env[i] >= env[i+1]){
      cands.push(i);
      i += minSep; // enforce separation
    }else{
      i++;
    }
  }

  // refine on raw |data| around each cand (±1 ms)
  const ref = [];
  const refineWin = Math.max(1, Math.floor(sr * 0.001));
  for(const p of cands){
    let bestIdx = p, bestVal = 0;
    const s = Math.max(0, p - refineWin), e = Math.min(data.length, p + refineWin + 1);
    for(let k=s;k<e;k++){
      const v = Math.abs(data[k]);
      if(v > bestVal){ bestVal = v; bestIdx = k; }
    }
    ref.push(bestIdx);
  }
  return ref.slice(0, 8);
}

function updateCandidates(){
  candidates = findCandidates(lastData);
}

function redrawAll(){
  const marksList = [
    ...(marks.t1!=null?[{index:marks.t1,color:"#1f77b4"}]:[]),
    ...(marks.t2!=null?[{index:marks.t2,color:"#d62728"}]:[]),
    ...(showCandsEl.checked ? candidates.map(i=>({index:i,color:"#888"})) : [])
  ];
  draw(lastData, marksList);
  updateReadoutNumbers();
}

function draw(data, marksList=[]){
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

  marksList.forEach(m => {
    if(!lastData) return;
    const x = Math.floor((m.index / lastData.length) * W);
    ctx.fillStyle = m.color || "#d24";
    ctx.fillRect(x, 0, 2, H);
  });
}

function updateReadoutNumbers(){
  const sr = sampleRate;
  let t1=NaN,a1=NaN,t2=NaN,a2=NaN,dt=NaN;
  if(lastData && marks.t1!=null){ t1 = marks.t1/sr; a1 = Math.abs(lastData[marks.t1]); }
  if(lastData && marks.t2!=null){ t2 = marks.t2/sr; a2 = Math.abs(lastData[marks.t2]); }
  if(isFinite(t1) && isFinite(t2)) dt = t2 - t1;

  t1El.textContent = isFinite(t1)?t1.toFixed(6):"—";
  a1El.textContent = isFinite(a1)?a1.toFixed(4):"—";
  t2El.textContent = isFinite(t2)?t2.toFixed(6):"—";
  a2El.textContent = isFinite(a2)?a2.toFixed(4):"—";
  dtEl.textContent = isFinite(dt)?dt.toFixed(6):"—";
}

function exportCSV(){
  const sr = sampleRate;
  let t1="",a1="",t2="",a2="",dt="";
  if(marks.t1!=null){ t1 = (marks.t1/sr).toFixed(6); a1 = Math.abs(lastData[marks.t1]).toFixed(6); }
  if(marks.t2!=null){ t2 = (marks.t2/sr).toFixed(6); a2 = Math.abs(lastData[marks.t2]).toFixed(6); }
  if(marks.t1!=null && marks.t2!=null){ dt = ((marks.t2-marks.t1)/sr).toFixed(6); }
  const header = ["sample_rate_Hz","t1_s","A1","t2_s","A2","delta_t_s"];
  let csv = header.join(",") + "\\n";
  csv += [sr, t1, a1, t2, a2, dt].join(",") + "\\n";
  const blob = new Blob([csv], {type:"text/csv"});
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "reflection_min_v12_result.csv";
  a.click();
  URL.revokeObjectURL(a.href);
}

async function pulseTest(){
  try{
    await initAudio(false);
    await audioCtx.resume();
    const type = pulseTypeEl.value;
    const dur = Math.max(2, parseInt(pulseMsEl.value||"60",10))/1000;
    const vol = Math.max(0, Math.min(1, parseFloat(pulseVolEl.value||"0.8")));
    const t = audioCtx.currentTime + 0.10;
    playPulseAt(t, dur, vol, type);
    setStatus("パルスを再生しました（録音なし）");
  }catch(err){
    console.error(err);
    setStatus("パルステスト失敗: " + err.message);
  }
}

function refineToLocalPeak(idx){
  if(!lastData) return idx;
  const sr = sampleRate;
  const win = Math.max(1, Math.floor(sr*0.001));
  let best = idx, bestVal = 0;
  for(let k=Math.max(0, idx-win); k<Math.min(lastData.length, idx+win+1); k++){
    const v = Math.abs(lastData[k]);
    if(v > bestVal){ bestVal = v; best = k; }
  }
  return best;
}

setT1Btn.addEventListener("click", ()=>{ pickMode = (pickMode==='t1'?null:'t1'); setStatus(pickMode==='t1'?'t₁をクリックで指定':''); });
setT2Btn.addEventListener("click", ()=>{ pickMode = (pickMode==='t2'?null:'t2'); setStatus(pickMode==='t2'?'t₂をクリックで指定':''); });
clearMarksBtn.addEventListener("click", ()=>{
  marks = {t1:null, t2:null};
  redrawAll();
});

wave.addEventListener("click", (ev)=>{
  if(!pickMode || !lastData) return;
  const rect = wave.getBoundingClientRect();
  const x = ev.clientX - rect.left;
  const W = wave.width;
  const idx = Math.round((x / W) * lastData.length);
  const refined = refineToLocalPeak(idx);
  if(pickMode==='t1') marks.t1 = refined;
  if(pickMode==='t2') marks.t2 = refined;
  pickMode = null;
  redrawAll();
  setStatus("手動指定を適用しました");
});

[envMsEl, threshEl, minSepEl, showCandsEl].forEach(el=>{
  el.addEventListener("input", ()=>{ updateCandidates(); redrawAll(); });
});

applyTop2Btn.addEventListener("click", ()=>{
  if(candidates.length >= 2){
    marks.t1 = candidates[0];
    marks.t2 = candidates[1];
    redrawAll();
  }
});

resetUI();

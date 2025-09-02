// EchoScope — Trigger mode: report first reaction time (t_mic), relative to pulse emission time (t_emit)
let audioCtx;
let workletNode;
let stream;
let buffer = [];
let sampleRate = 48000;

const $ = (s)=>document.querySelector(s);
const wave = $("#wave");
const g = wave.getContext("2d");

const measureBtn = $("#measureBtn");
const pulseBtn = $("#pulseBtn");
const startBtn = $("#startBtn");
const stopBtn = $("#stopBtn");
const exportBtn = $("#exportBtn");
const statusEl = $("#status");

const recMsEl = $("#recMs");
const preMsEl = $("#preMs");
const threshEl = $("#thresh");
const envMsEl = $("#envMs");
const pulseMsEl = $("#pulseMs");
const pulseVolEl = $("#pulseVol");

const srEl = $("#sr");
const tEmitEl = $("#tEmit");
const tMicEl  = $("#tMic");
const dtEl    = $("#dt");

const distEl = $("#dist");
const pathModeEl = $("#pathMode");
const calcVBtn = $("#calcVBtn");
const vEl = $("#v");

let lastResult = null;

function setStatus(s){ statusEl.textContent = s; }

function resetUI(){
  srEl.textContent = "—"; tEmitEl.textContent = "—"; tMicEl.textContent="—";
  dtEl.textContent="—"; vEl.textContent="—";
  exportBtn.disabled = true;
  draw([], []);
  lastResult = null;
}

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
  // ハウリング回避のためモニタなし
  src.connect(workletNode);
  workletNode.connect(audioCtx.destination);
  buffer = [];
  workletNode.port.onmessage = (e)=>{
    if(e.data.type === 'samples'){
      buffer.push(e.data.payload);
    }
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

  // Analyze
  const res = analyzeForFirstPeak(data, sampleRate);
  showResult(res);
  startBtn.disabled = false;
  measureBtn.disabled = false;
}

async function startRecOnly(){
  try{
    startBtn.disabled = true; stopBtn.disabled = false;
    setStatus("マイク許可/初期化...");
    await initAudio();
    await attachMic();
    setStatus("録音中...（必要なら手で音を出してください）");
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
    measureBtn.disabled = true; stopBtn.disabled = true;
    setStatus("初期化...");
    await initAudio();
    await attachMic();
    const recMs = Math.max(100, parseInt(recMsEl.value||"1200",10));
    const preMs = Math.max(0, parseInt(preMsEl.value||"150",10));
    const pulseMs = Math.max(1, parseInt(pulseMsEl.value||"8",10));
    const vol = Math.max(0, Math.min(1, parseFloat(pulseVolEl.value||"0.8")));
    // スケジュール：録音→プレロール→パルス→停止
    const tEmitEst = preMs / 1000; // 録音開始からの相対時刻（推定）
    setTimeout(()=>playPulse(pulseMs, vol), preMs);
    setStatus("録音中...（パルスを発音します）");
    setTimeout(stopRec, recMs);
    // 保存して後でUIへ
    lastResult = { tEmitEst };
  }catch(err){
    console.error(err);
    setStatus("エラー: " + err.message);
    measureBtn.disabled = false;
  }
}

function playPulse(pulseMs=8, vol=0.8){
  if(!audioCtx) return;
  const now = audioCtx.currentTime + 0.01;
  const len = Math.floor(sampleRate * (pulseMs/1000));
  const noise = audioCtx.createBuffer(1, Math.max(1,len), sampleRate);
  const ch = noise.getChannelData(0);
  for(let i=0;i<ch.length;i++) ch[i] = (Math.random()*2-1);
  const src = audioCtx.createBufferSource();
  src.buffer = noise;

  const hp = audioCtx.createBiquadFilter(); hp.type='highpass'; hp.frequency.value = 800;
  const lp = audioCtx.createBiquadFilter(); lp.type='lowpass';  lp.frequency.value = 6000;
  const g = audioCtx.createGain(); g.gain.value = 0;

  src.connect(hp).connect(lp).connect(g).connect(audioCtx.destination);

  const a = g.gain;
  a.cancelScheduledValues(now);
  a.setValueAtTime(0, now);
  a.linearRampToValueAtTime(vol, now + 0.002);
  a.exponentialRampToValueAtTime(0.001, now + pulseMs/1000);
  a.setValueAtTime(0, now + pulseMs/1000 + 0.01);

  src.start(now);
  src.stop(now + pulseMs/1000 + 0.02);
}

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

  // marks: [{index, color}]
  marks.forEach(m => {
    const x = Math.floor((m.index / data.length) * W);
    ctx.fillStyle = m.color || "#d24";
    ctx.fillRect(x, 0, 2, H);
  });
}

function movingAverageAbs(data, win){
  const out = new Float32Array(data.length);
  let sum = 0;
  const N = data.length;
  for(let i=0;i<N;i++){
    const v = Math.abs(data[i]);
    sum += v;
    if(i>=win) sum -= Math.abs(data[i-win]);
    out[i] = sum / Math.min(i+1, win);
  }
  return out;
}

function findFirstCross(env, threshold){
  for(let i=0;i<env.length;i++){
    if(env[i] >= threshold) return i;
  }
  return -1;
}

function analyzeForFirstPeak(data, sr){
  if(!data || data.length===0){
    setStatus("録音データなし");
    return null;
  }
  const envMs = Math.max(0.5, parseFloat(envMsEl.value||"1.5"));
  const win = Math.max(1, Math.floor(sr * (envMs/1000)));
  const env = movingAverageAbs(data, win);

  // 正規化して閾値判定
  let maxv = 0; for(let i=0;i<env.length;i++) if(env[i]>maxv) maxv = env[i];
  const baseThresh = parseFloat(threshEl.value||"0.08");
  const T = maxv>0 ? baseThresh * maxv : baseThresh;

  const idx = findFirstCross(env, T);
  draw(data, idx>=0 ? [{index: idx, color:"#d24"}] : []);

  const pre = Math.max(0, parseInt(preMsEl.value||"150",10))/1000;
  const tEmitEst = lastResult?.tEmitEst ?? pre;
  const tMic = idx>=0 ? idx / sr : NaN;
  const dt  = (isFinite(tMic) ? tMic : NaN) - tEmitEst;

  return { tEmitEst, tMic, dt, sampleRate: sr, havePeak: idx>=0 };
}

function showResult(res){
  if(!res){ setStatus("解析失敗"); return; }
  tEmitEl.textContent = isFinite(res.tEmitEst) ? res.tEmitEst.toFixed(5) : "—";
  tMicEl.textContent  = isFinite(res.tMic) ? res.tMic.toFixed(5) : "—";
  dtEl.textContent    = isFinite(res.dt) ? res.dt.toFixed(5) : "—";
  setStatus(res.havePeak ? "完了：反応時刻を検出しました" : "しきい値超えを検出できませんでした（しきい値/平滑窓を調整）");

  exportBtn.disabled = false;
  exportBtn.onclick = () => exportCSV(res);
}

function exportCSV(res){
  const header = ["sample_rate_Hz","t_emit_s","t_mic_s","delta_t_s"];
  let csv = header.join(",") + "\\n";
  csv += [res.sampleRate, 
          isFinite(res.tEmitEst)?res.tEmitEst.toFixed(6):"", 
          isFinite(res.tMic)?res.tMic.toFixed(6):"", 
          isFinite(res.dt)?res.dt.toFixed(6):""
         ].join(",") + "\\n";
  const blob = new Blob([csv], {type:"text/csv"});
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "trigger_result.csv";
  a.click();
  URL.revokeObjectURL(a.href);
}

calcVBtn.addEventListener("click", ()=>{
  const dt = parseFloat(dtEl.textContent);
  if(!isFinite(dt) || dt <= 0){ vEl.textContent = "—"; return; }
  const d = Math.max(0, parseFloat(distEl.value||"0"));
  const mode = pathModeEl.value;
  const v = (mode === "one") ? (d / dt) : (2*d / dt);
  vEl.textContent = v.toFixed(3);
});

measureBtn.addEventListener("click", measureWithPulse);
pulseBtn.addEventListener("click", async () => { await initAudio(); playPulse(parseInt(pulseMsEl.value||"8",10), parseFloat(pulseVolEl.value||"0.8")); });
startBtn.addEventListener("click", startRecOnly);
stopBtn.addEventListener("click", stopRec);

resetUI();

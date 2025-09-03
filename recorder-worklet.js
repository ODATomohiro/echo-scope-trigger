// recorder-worklet.js (no monitor to avoid feedback)
class RecorderProcessor extends AudioWorkletProcessor {
  process(inputs, outputs){
    const input = inputs[0];
    const out = outputs[0];
    if(input && input[0]){
      const ch0 = input[0];
      const copy = new Float32Array(ch0.length);
      copy.set(ch0);
      this.port.postMessage({type:'samples', payload: copy}, [copy.buffer]);
    }
    if(out && out[0]){
      // 無音モニタ（スピーカーへ返さない）
      out[0].fill(0);
    }
    return true;
  }
}
registerProcessor('recorder', RecorderProcessor);

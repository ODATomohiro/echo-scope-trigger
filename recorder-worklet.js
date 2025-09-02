// recorder-worklet.js
class RecorderProcessor extends AudioWorkletProcessor {
  constructor(){
    super();
    this.port.postMessage({type:'ready'});
  }
  process(inputs, outputs, parameters){
    const input = inputs[0];
    if(input && input[0]){
      const ch0 = input[0];
      const copy = new Float32Array(ch0.length);
      copy.set(ch0);
      this.port.postMessage({type:'samples', payload: copy}, [copy.buffer]);
    }
    // 出力はスルー（無音化したい場合は out.fill(0) ）
    if(outputs[0] && inputs[0]){
      const out = outputs[0][0];
      out.set(inputs[0][0]);
    }
    return true;
  }
}
registerProcessor('recorder', RecorderProcessor);

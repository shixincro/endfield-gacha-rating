import {loadPyodide} from '../vendor/pyodide/pyodide.mjs';
import {scoreCharacter} from './core/character.js';
import {scoreWeaponRecord} from './core/weapon-scoring.js';

let runtime,ocr,activeId;
const progress=message=>self.postMessage({type:'progress',id:activeId,message});
async function initialize(){
  if(runtime)return runtime;
  progress('正在加载浏览器计算环境（首次打开需要下载）…');
  const pyodide=await loadPyodide({indexURL:new URL('../vendor/pyodide/',import.meta.url).href});
  progress('正在加载评分组件…');
  await pyodide.loadPackage('numpy');
  const response=await fetch(new URL('./python-core.zip',import.meta.url));
  if(!response.ok)throw new Error('计算文件加载失败，请重新加载页面。');
  pyodide.unpackArchive(new Uint8Array(await response.arrayBuffer()),'zip',{extractDir:'/app'});
  pyodide.registerJsModule('browser_scoring',{
    score_character:text=>JSON.stringify(scoreCharacter(JSON.parse(text))),
    score_weapon:text=>JSON.stringify(scoreWeaponRecord(JSON.parse(text))),
  });
  pyodide.runPython("import sys; sys.path.insert(0, '/app/browser/python'); import bridge; bridge.initialize('/app')");
  runtime=pyodide;
  return runtime;
}
function dispatch(pyodide,request){
  pyodide.globals.set('_browser_request',JSON.stringify(request));
  try{
    const result=JSON.parse(pyodide.runPython('bridge.dispatch_json(_browser_request)'));
    if(!result.ok){const error=new Error(result.error);error.code=result.code;throw error;}
    return result.value;
  }finally{pyodide.globals.delete('_browser_request');}
}
async function recognize(pyodide,data){
  if(!ocr){
    const [{createBrowserOCR},ort]=await Promise.all([
      import('./ocr/runtime.mjs'),import('../vendor/onnxruntime/ort.wasm.min.mjs'),
    ]);
    ort.env.wasm.wasmPaths=new URL('../vendor/onnxruntime/',import.meta.url).href;
    ocr=await createBrowserOCR(pyodide,{ort,baseURL:new URL('./ocr/assets/',import.meta.url),onProgress:progress});
  }
  const result=await ocr.recognize(data);
  const prefix='/browser-evidence/'+data.id+'/',target='/data/'+data.id+'/';
  function publicPaths(value){
    if(typeof value==='string'&&value.startsWith(prefix))return target+value.slice(prefix.length);
    if(Array.isArray(value))return value.map(publicPaths);
    if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([k,v])=>[k,publicPaths(v)]));
    return value;
  }
  const document=publicPaths(result.document);
  document.file=data.name;document.sourceImage=target+String(data.name).replace(/^.*[\\/]/,'').replace(/[\x00-\x1f]/g,'_');
  const session=dispatch(pyodide,{op:'from_documents',data:{id:data.id,documents:[document]}});
  return {session,files:result.files.map(file=>({...file,path:publicPaths(file.path)}))};
}
// Pyodide callbacks and ONNX inference share one stateful worker. Serialize all
// requests, including requests arriving while inference awaits its WASM result.
let queue=Promise.resolve();
self.onmessage=event=>{
  const {id,op,data}=event.data;
  queue=queue.then(async()=>{
    activeId=id;
    try{
      const pyodide=await initialize();
      const value=op==='recognize'?await recognize(pyodide,data):dispatch(pyodide,{op,data});
      self.postMessage({type:'result',id,value});
    }catch(error){self.postMessage({type:'error',id,error:error.message||String(error),code:error.code});}
  });
};

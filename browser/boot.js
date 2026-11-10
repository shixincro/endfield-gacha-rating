import {BrowserRatingAPI} from './api.js';
const message=document.getElementById('browserRuntimeStatus');
function report(text){message.textContent=text;message.hidden=!text;}
async function boot(){
  if(!window.isSecureContext||!window.Worker||!window.indexedDB||!window.WebAssembly){
    throw new Error('请在支持 WebAssembly 的浏览器中，通过 HTTPS 网站或本机 localhost 打开。');
  }
  const runtime=new BrowserRatingAPI({onProgress:report});
  window.BrowserRating=runtime;
  for(const name of ['ui-model.js','character-edit.js','app.js','manual-supplement.js']){
    await new Promise((resolve,reject)=>{
      const script=document.createElement('script');script.src=new URL('../'+name,import.meta.url).href;
      script.onload=resolve;script.onerror=()=>reject(new Error('页面组件加载失败，请刷新后重试。'));document.head.append(script);
    });
  }
}
boot().catch(error=>report(error.message));

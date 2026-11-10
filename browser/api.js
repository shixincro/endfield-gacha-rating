import {RecordStore} from './storage.js';
const newId=()=>crypto.randomUUID().replaceAll('-','');
const clone=value=>structuredClone(value);

export class BrowserRatingAPI {
  constructor({onProgress=()=>{}}={}){
    this.store=new RecordStore();this.jobs=new Map();this.pending=new Map();this.urls=new Map();this.sequence=0;
    this.scoreQueues=new Map();this.scoreChains=new Map();
    this.onProgress=onProgress;
    this.worker=new Worker(new URL('./worker.js',import.meta.url),{type:'module'});
    this.worker.onmessage=({data})=>{
      const task=this.pending.get(data.id);if(!task)return;
      if(data.type==='progress'){this.onProgress(data.message);task.onProgress?.(data.message);return;}
      this.pending.delete(data.id);
      this.onProgress('');
      if(data.type==='error'){const error=new Error(data.error);error.code=data.code;task.reject(error);}
      else task.resolve(data.value);
    };
    this.worker.onerror=event=>{
      const error=new Error('浏览器计算环境未能运行，请重新加载页面。'+(event.message||''));
      this.fatalError=error;
      for(const task of this.pending.values())task.reject(error);this.pending.clear();this.onProgress(error.message);
    };
    window.addEventListener('pagehide',event=>{
      // A back/forward-cache page will resume with its existing image DOM.
      if(event.persisted)return;
      for(const url of this.urls.values())URL.revokeObjectURL(url);this.urls.clear();
    });
  }
  call(op,data,onProgress){
    if(this.fatalError)return Promise.reject(this.fatalError);
    const id=++this.sequence;
    return new Promise((resolve,reject)=>{this.pending.set(id,{resolve,reject,onProgress});this.worker.postMessage({id,op,data});});
  }
  evidenceURL(path){return this.urls.get(path)||null;}
  async hydrate(session){
    for(const {path,blob} of await this.store.evidence(session))if(!this.urls.has(path))this.urls.set(path,URL.createObjectURL(blob));
    return session;
  }
  async original(id){const record=await this.store.get(id);if(!record)throw new Error('记录已删除或不存在，请重新导入。');return record;}
  async score(data){
    const id=data?.session?.id;
    // Capture the submitted draft before waiting. All local writes for this
    // record run in order; another tab still has an independent writer chain.
    const previous=this.scoreQueues.get(id)||Promise.resolve();
    const task=previous.catch(()=>{}).then(async()=>{
      const original=await this.original(id),candidate=data.session;
      const baseline=candidate.browserStorageVersion,chain=this.scoreChains.get(id);
      if(baseline!=null&&baseline!==original.browserStorageVersion){
        const localAdvance=chain&&chain.head===original.browserStorageVersion&&chain.ancestors.has(baseline);
        if(!localAdvance)throw new Error('记录已在其他页面修改或删除，请重新打开后再修改。');
        // An older local calculation must not overwrite a later draft. Equal
        // revisions can only be retried when their editable facts are equal.
        const facts=s=>JSON.stringify([s.ledger,s.reviewed,s.scoringScenario]);
        if(candidate.revision===original.revision&&facts(candidate)===facts(original))return this.hydrate(original);
        if(!(candidate.revision>original.revision))throw new Error('旧版本计算已丢弃，请使用最新记录。');
      }
      data.original=original;
      const value=await this.call('score',data);
      await this.store.save(value,{original});
      const ancestors=chain&&chain.head===original.browserStorageVersion?chain.ancestors:new Set();
      if(original.browserStorageVersion!=null)ancestors.add(original.browserStorageVersion);
      this.scoreChains.set(id,{head:value.browserStorageVersion,ancestors});
      return this.hydrate(value);
    });
    this.scoreQueues.set(id,task);
    try{return await task;}finally{if(this.scoreQueues.get(id)===task)this.scoreQueues.delete(id);}
  }
  async confirmed(text){
    const bare=text.replace(/^\uFEFF+/,''),digests=new Set();
    for(const source of [text,bare,'\uFEFF'+bare]){
      const bytes=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(source));
      digests.add(Array.from(new Uint8Array(bytes),v=>v.toString(16).padStart(2,'0')).join(''));
    }
    const values=new Set();
    for(const session of await this.store.sessions())for(const document of session.documents||[]){
      if(digests.has(document.source_sha256))for(const value of document.userConfirmations?.fullPoolHistories||[])if(typeof value==='string')values.add(value);
    }
    return [...values];
  }
  async importImages(data){
    if([...this.jobs.values()].some(job=>job.status==='running'))throw new Error('已有识图任务正在运行，请等待完成。');
    if(!Array.isArray(data?.files)||!data.files.length||data.files.length>12)throw new Error('请选择1—12张截图。');
    const files=clone(data.files),id=newId();
    const job={id,status:'running',message:'正在准备本地识图…',completed:0,total:files.length,items:[],sessions:[],succeeded:0,failed:0};
    this.jobs.set(id,job);
    // Complete outside the API call so existing progress UI remains responsive.
    (async()=>{
      for(const [index,file] of files.entries()){
        const item={index,name:file.name},recordId=newId();
        try{
          if(typeof file.data!=='string'||file.data.length>36*1024*1024)throw new Error('单张截图不能超过25 MB。');
          const bytes=Uint8Array.from(atob(file.data),char=>char.charCodeAt(0));delete file.data;
          if(bytes.length>25*1024*1024)throw new Error('单张截图不能超过25 MB。');
          const value=await this.call('recognize',{name:file.name,bytes,id:recordId},message=>{job.message=`${index+1}/${files.length}：${message}`;});
          await this.store.save(value.session,{files:value.files});
          await this.hydrate(value.session);job.sessions.push(value.session);job.succeeded++;
          Object.assign(item,{status:'done',sessionId:recordId});
        }catch(error){job.failed++;Object.assign(item,{status:'error',error:error.message});}
        job.items.push(item);job.completed=index+1;
      }
      job.status=job.sessions.length?'done':'error';job.session=job.sessions[0];
      job.message=`已独立保存 ${job.succeeded} 条记录`+(job.failed?`，${job.failed} 张失败`:'');
      // Bound job memory; persistent history lives in IndexedDB.
      const finished=[...this.jobs.values()].filter(row=>row.status!=='running');
      finished.slice(0,-3).forEach(row=>this.jobs.delete(row.id));
    })();
    return {id};
  }
  async api(path,body){
    if(path==='/api/config'){
      const config=await this.call('init');await this.store.ready;
      this.onProgress('');return config;
    }
    if(path==='/api/sessions')return (await this.store.sessions()).map(s=>({id:s.id,updatedAt:s.updatedAt,reviewed:s.reviewed||false,
      name:(s.documents||[]).map(d=>d.file||'记录').join('、')})).sort((a,b)=>b.updatedAt-a.updatedAt);
    if(path==='/api/sessions/delete'){
      const result=await this.store.remove(body?.ids);
      for(const id of [...result.deleted,...result.missing])this.scoreChains.delete(id);
      const removedEvidence=new Set(result.deletedEvidence);
      for(const [path,url] of this.urls)if(removedEvidence.has(path)){URL.revokeObjectURL(url);this.urls.delete(path);}
      return result;
    }
    if(path.startsWith('/api/sessions/'))return this.hydrate(await this.original(path.slice('/api/sessions/'.length)));
    if(path.startsWith('/api/jobs/')){const job=this.jobs.get(path.slice('/api/jobs/'.length));if(!job)throw new Error('识图任务不存在。');return clone(job);}
    if(path==='/api/import')return this.importImages(body);
    if(path==='/api/records/import'){
      const data={...clone(body),confirmedCompletePools:await this.confirmed(body?.text||'')};
      const session=await this.call('import_record',data);await this.store.save(session);return session;
    }
    if(path==='/api/restore'){
      const session=await this.call('restore',body);await this.store.save(session);return this.hydrate(session);
    }
    const op={'/api/score':'score','/api/validate':'validate','/api/hypothesis/plan':'hypothesis_plan','/api/hypothesis/preview':'hypothesis_preview'}[path];
    if(op){
      const data=clone(body);
      if(op==='score')return this.score(data);
      const original=await this.original(data?.session?.id);data.original=original;
      const value=await this.call(op,data);
      return value;
    }
    throw new Error('不支持的浏览器操作：'+path);
  }
}

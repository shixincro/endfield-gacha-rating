// The browser origin owns its records. No server path is ever written or read.
const SCHEMA='gacha-rating-session-v1';
const validId=value=>typeof value==='string'&&/^[a-f0-9]{32}$/.test(value);
const refs=value=>{
  const found=new Set();
  function walk(node){
    if(typeof node==='string'&&node.startsWith('/data/'))found.add(node);
    else if(Array.isArray(node))node.forEach(walk);
    else if(node&&typeof node==='object')Object.values(node).forEach(walk);
  }
  walk(value);return found;
};
function storageError(error){
  return new Error(error?.name==='QuotaExceededError'
    ?'浏览器存储空间不足，本次记录未保存。请先导出 JSON 备份并清理不需要的记录。'
    :'无法保存浏览器记录：'+(error?.message||'请检查是否禁用了网站存储。'));
}
export class RecordStore {
  constructor(name='endfield-gacha-rating-browser-v1'){
    this.ready=new Promise((resolve,reject)=>{
      const request=indexedDB.open(name,1);
      request.onupgradeneeded=()=>{
        request.result.createObjectStore('sessions',{keyPath:'id'});
        request.result.createObjectStore('evidence',{keyPath:'path'});
      };
      request.onerror=()=>reject(storageError(request.error));
      request.onblocked=()=>reject(new Error('浏览器记录库被旧页面占用，请关闭其他旧页面后重试。'));
      request.onsuccess=()=>{const db=request.result;db.onversionchange=()=>db.close();resolve(db);};
    });
  }
  async read(store,key){
    const db=await this.ready;
    return new Promise((resolve,reject)=>{
      const tx=db.transaction(store,'readonly'),request=key===undefined?tx.objectStore(store).getAll():tx.objectStore(store).get(key);
      request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(storageError(request.error));
    });
  }
  async sessions(){return (await this.read('sessions')).filter(s=>s?.schemaVersion===SCHEMA&&validId(s.id));}
  async get(id){if(!validId(id))throw new Error('无效的记录编号。');return this.read('sessions',id);}
  async save(session,{original=null,files=[]}={}){
    if(!validId(session?.id)||session.schemaVersion!==SCHEMA)throw new Error('记录格式错误，未保存。');
    const db=await this.ready;
    return new Promise((resolve,reject)=>{
      const tx=db.transaction(['sessions','evidence'],'readwrite');let failure;
      const store=tx.objectStore('sessions'),request=store.get(session.id);
      const version=crypto.randomUUID().replaceAll('-','');
      tx.oncomplete=()=>{session.browserStorageVersion=version;resolve(session);};
      tx.onerror=()=>reject(failure||storageError(tx.error));
      tx.onabort=()=>reject(failure||storageError(tx.error));
      request.onsuccess=()=>{
        const current=request.result;
        // New browser records carry an opaque commit token, not just a UI
        // revision. Two tabs can independently arrive at the same revision.
        const changed=original&&(!current||(original.browserStorageVersion!=null
          ?current.browserStorageVersion!==original.browserStorageVersion
          :current.revision!==original.revision||current.updatedAt!==original.updatedAt));
        if(changed){
          failure=new Error('记录已在其他页面修改或删除，请重新打开后再修改。');tx.abort();return;
        }
        if(!original&&current){failure=new Error('记录编号重复，未覆盖已有记录。');tx.abort();return;}
        // A restored JSON's old token is deliberately ignored. Only this
        // transaction creates the new persistent version, atomically with its
        // evidence. Failed writes leave both caller and stored version intact.
        store.put({...session,browserStorageVersion:version});
        for(const file of files){
          if(typeof file.path!=='string'||!file.path.startsWith('/data/'+session.id+'/')){
            failure=new Error('图片证据与记录不匹配，未保存。');tx.abort();return;
          }
          tx.objectStore('evidence').put({path:file.path,blob:new Blob([file.bytes],{type:file.mime})});
        }
      };
    });
  }
  async evidence(session){
    const paths=[...refs(session)],db=await this.ready;
    if(!paths.length)return [];
    return new Promise((resolve,reject)=>{
      const tx=db.transaction('evidence','readonly'),rows=[];
      for(const path of paths){const q=tx.objectStore('evidence').get(path);q.onsuccess=()=>{if(q.result)rows.push(q.result);};}
      tx.oncomplete=()=>resolve(rows);tx.onerror=()=>reject(storageError(tx.error));
    });
  }
  async remove(ids){
    if(!Array.isArray(ids)||!ids.length||ids.length>1000||ids.some(id=>!validId(id)))throw new Error('请选择1—1000条有效记录。');
    const db=await this.ready,wanted=new Set(ids);
    return new Promise((resolve,reject)=>{
      const tx=db.transaction(['sessions','evidence'],'readwrite');
      const result={deleted:[],missing:[],failed:[],retainedEvidence:[],deletedEvidence:[]};
      const request=tx.objectStore('sessions').getAll();
      request.onsuccess=()=>{
        const all=request.result,kept=new Set();
        all.filter(s=>!wanted.has(s.id)).forEach(s=>refs(s).forEach(path=>kept.add(path)));
        for(const id of wanted){
          const session=all.find(s=>s.id===id);
          if(!session){result.missing.push(id);continue;}
          tx.objectStore('sessions').delete(id);result.deleted.push(id);
          let shared=false;
          for(const path of refs(session)){
            if(kept.has(path))shared=true;
            else {tx.objectStore('evidence').delete(path);result.deletedEvidence.push(path);}
          }
          if(shared)result.retainedEvidence.push(id);
        }
      };
      tx.oncomplete=()=>resolve(result);tx.onerror=()=>reject(storageError(tx.error));tx.onabort=()=>reject(storageError(tx.error));
    });
  }
}

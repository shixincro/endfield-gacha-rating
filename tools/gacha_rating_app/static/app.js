'use strict';
const $=id=>document.getElementById(id);
const labels={characterSix:'角色六星',up:'当期UP',limited:'限定',five:'角色五星',weaponSix:'六星武器',signature:'当期专武'};
const ui=window.RatingUIModel;
const edit=window.CharacterEdit;
const characters=[...edit.LIMITED,...edit.COMMON];
let token='',planningVersion='',characterVersion='',weaponVersion='',recognitionVersion='',scoringScenarioVersion='',interruptionVersion='',session=null,files=[],revision=0,timer=null,busy=false,requestId=0;
let characterDraft=null,weaponDraft=null,weaponProfileDraft=false,dialogOrigin=null,resultsTab='character',luckRevealed=false;
let autoReviewQueue=[],autoReviewIndex=0,autoReviewDirty=false,characterReviewPoolId=null;
let navigationId=0,historyRows=[],historySelected=new Set(),historyDeleteIds=[],historyDeleting=false,historyRequestId=0,restoring=false;
const deletedRecordIds=new Set();
let hypothesis=null,hypothesisEpoch=0;
let planningExemptionRequest=null,planningDetailPoolId=null,planningExemptionError=null;
let scoringScenarioRequest=null;
let resultCaptureBusy=false;
const scoreSettingPending=()=>!!planningExemptionRequest||!!scoringScenarioRequest;
let draftValidationTimer=null,draftValidationEpoch=0,draftValidationRequest=0,draftValidationLedger=null,draftValidationState='idle',draftValidationMessage='',draftFingerprint='',draftOpeningSignature='';
const characterPoolViews=new Map();
let weaponIssueView=null,queueIssueView=null;
const viewDialogs=['planningDetailDialog','planningAllDialog','historyDialog','hypothesisDialog','manualSupplementDialog'];
const clone=value=>JSON.parse(JSON.stringify(value));
const effectiveCharacter=value=>edit.validateInterruption(value)?value:edit.projectCharacter(value).character;
const hasWeaponProfile=w=>ui.hasWeaponProfile(w);
const el=(tag,text,cls)=>{const n=document.createElement(tag);if(text!==undefined)n.textContent=text;if(cls)n.className=cls;return n;};
const displayText=value=>String(value??'').replace(/(?:，)?请核对(?:原图)?[。！]?/g,'').replace(/待核对/g,'数据异常').replace(/核对/g,'查看');
const noticeStates={status:{sequence:0,timer:null,hideTimer:null},error:{sequence:0,timer:null,hideTimer:null}};
const modalOrder=[];
function resetNoticeTimers(state){clearTimeout(state.timer);clearTimeout(state.hideTimer);state.timer=null;state.hideTimer=null;return ++state.sequence;}
function notificationHost(){return [...modalOrder].reverse().find(node=>node.open)||document.activeElement?.closest?.('dialog[open]')||document.body;}
function showNotificationStack(host=notificationHost()){
  const stack=$('notifications');
  // Keep notices inside the active modal's non-inert subtree, then use the
  // popover layer so a notice and its close button stay above that dialog.
  if(stack.parentNode!==host){if(typeof stack.hidePopover==='function'&&stack.matches(':popover-open'))stack.hidePopover();stack.remove();host.append(stack);}
  if(typeof stack.showPopover==='function'&&!stack.matches(':popover-open'))stack.showPopover();
}
function hideIdleNotificationStack(){
  const stack=$('notifications');if($('status').hidden&&$('error').hidden&&typeof stack.hidePopover==='function'&&stack.matches(':popover-open'))stack.hidePopover();
}
function syncNotificationStack(){if($('status').hidden&&$('error').hidden)hideIdleNotificationStack();else showNotificationStack();}
function openDialog(id){
  const dialog=$(id);if(!dialog.open){dialog.showModal();modalOrder.push(dialog);}syncNotificationStack();
}
for(const id of ['resultsDialog',...viewDialogs])$(id).addEventListener('close',()=>{
  const index=modalOrder.indexOf($(id));if(index>=0)modalOrder.splice(index,1);syncNotificationStack();
});
function dismissNotice(id){
  const target=$(id),state=noticeStates[id],sequence=resetNoticeTimers(state);if(target.hidden)return;
  target.classList.add('is-leaving');
  state.hideTimer=setTimeout(()=>{if(state.sequence!==sequence)return;target.hidden=true;state.hideTimer=null;hideIdleNotificationStack();},250);
}
function showNotice(id,message,running=false){
  const target=$(id),state=noticeStates[id],host=notificationHost(),sequence=resetNoticeTimers(state);
  target.replaceChildren();target.className='toast-notice'+(id==='error'?' is-error':'')+(running?' is-running':'');target.hidden=!message;
  if(!message){hideIdleNotificationStack();return;}
  const close=el('button','×','notice-close');close.type='button';close.setAttribute('aria-label','关闭通知');close.onclick=()=>dismissNotice(id);
  target.append(el('span',displayText(message),'notice-message'),close);
  showNotificationStack(host);
  if(!running)state.timer=setTimeout(()=>{if(state.sequence===sequence)dismissNotice(id);},3000);
}
function error(message){showNotice('error',message);}
function status(message,running=false){showNotice('status',message,running);}
async function api(path,body){
  const response=await fetch(path,body===undefined?{}:{method:'POST',headers:{'Content-Type':'application/json','X-App-Token':token},body:JSON.stringify(body)});
  const value=await response.json();if(!response.ok)throw Error(value.error||'请求失败');return value;
}
function button(text,fn){const n=el('button',text);n.type='button';n.onclick=(...args)=>{const result=fn(...args);draftChanged();return result;};return n;}
function field(title,value,onChange,type='number'){
  const wrap=el('label',undefined,'field');wrap.append(el('span',title));const input=el('input');input.type=type;input.value=value??'';
  if(type==='number'){input.min=0;input.step=1;}
  let previous=String(input.value);const change=()=>{const value=String(input.value);if(value===previous)return;previous=value;onChange(value===''?null:type==='number'?Number(value):value);draftChanged();};
  input.oninput=change;input.onchange=change;wrap.append(input);return wrap;
}
function select(value,options,onChange){
  const input=el('select');for(const [key,label]of options){const op=el('option',label);op.value=key;input.append(op);}
  input.value=String(value??'');input.onchange=()=>{onChange(input.value);draftChanged();};return input;
}
function issueText(issue){return displayText(typeof issue==='string'?issue:issue.message||issue.code||JSON.stringify(issue));}
function issueBox(issue){return el('div',issueText(issue),'warning'+(issue.severity==='error'?' error':''));}
function issuesForEditor(ledger, mode) {
  const weaponAxes = ['signature', 'weaponSix'];
  const root = (ledger?.issues || []).filter(issue => !issue.axes?.length || issue.axes.some(axis =>
    mode === 'weapon' ? weaponAxes.includes(axis) : !weaponAxes.includes(axis)));
  return mode === 'weapon' ? root : [...root, ...(ledger?.character?.issues || [])];
}
function renderLedgerIssues(){
  const items=issuesForEditor(session?.ledger,resultsTab);
  $('currentGlobalIssues').replaceChildren(...items.map(issueBox));
  $('currentGlobalIssues').hidden=!items.length;
}
function draftSignature(){return JSON.stringify([characterDraft,weaponDraft,weaponProfileDraft]);}
function draftCandidate(){
  const candidate=clone(session);
  if(resultsTab==='weapon')candidate.ledger.weapon=ui.weaponForSave(weaponDraft,weaponProfileDraft);
  else candidate.ledger.character=clone(characterDraft);
  return candidate;
}
function validationIssues(items){return (items||[]).filter(i=>i?.code!=='weapon_pool_count_missing');}
function renderDraftValidation(){
  if(!characterDraft||!dialogIsCurrent())return;
  const ledger=draftValidationLedger||session.ledger,globalIssues=issuesForEditor(ledger,resultsTab),effective=effectiveCharacter(characterDraft);
  const role=resultsTab==='character';
  const localGlobal=role?[validateInitialHistory(),validateSummaryEdits(),edit.validateLinks(characterDraft)].filter(Boolean):[];
  if(role&&characterDraft.quotaSummary&&(!Number.isSafeInteger(characterDraft.quotaSummary.Q)||characterDraft.quotaSummary.Q<0))localGlobal.push('全记录武库配额须为非负整数。');
  const localIssue=message=>({code:'current_input',severity:'error',message});
  const unique=items=>[...new Map(items.map(i=>[issueText(i),i])).values()];
  const globals=unique([...globalIssues,...localGlobal.map(localIssue)]);
  $('currentGlobalIssues').replaceChildren(...globals.map(issueBox));
  $('currentGlobalIssues').hidden=!globals.length;
  if(queueIssueView){queueIssueView.replaceChildren(...globals.map(issueBox));}
  let errors=recognitionErrors(globals).length,warnings=globals.length-errors;
  for(const p of role?(characterDraft.pools||[]):[]){
    const evaluated=effective.pools.find(q=>q.id===p.id);
    if(!evaluated){characterPoolViews.get(p)?.issues.replaceChildren(el('p','已排除：本池明细保留，不参与本次评分。','muted small'));continue;}
    const issues=(ledger.character?.pools||[]).find(q=>q.id===p.id)?.issues||[];
    const problem=validateEditedPool(evaluated,{allowMissingQuota:edit.allowsMissingQuota(effective)});
    const current=unique([...issues,...(problem?[localIssue(problem)]:[])]),count=recognitionErrors(current).length;
    errors+=count;warnings+=current.length-count;
    const view=characterPoolViews.get(p)?.issues;if(!view)continue;
    view.replaceChildren(...(!count&&draftValidationState==='valid'?[el('p','本池当前校验通过。','validation-ok small')]:[]),...current.map(issueBox));
  }
  const weaponIssues=role?[]:validationIssues(ledger.weapon?.issues),weaponErrors=!role&&weaponDraft?ui.validateWeapon(ui.weaponForSave(weaponDraft,weaponProfileDraft),{requireProfile:weaponProfileDraft}):[];
  const currentWeapon=unique([...weaponIssues,...weaponErrors.map(localIssue)]),weaponCount=recognitionErrors(currentWeapon).length;
  errors+=weaponCount;warnings+=currentWeapon.length-weaponCount;
  if(weaponIssueView)weaponIssueView.replaceChildren(...currentWeapon.map(issueBox));
  const summary=$('draftValidationSummary');summary.hidden=false;
  const pending=draftValidationState==='pending';summary.className='draft-validation '+(pending?'is-pending':draftValidationState==='failed'||errors?'is-error':'is-valid');
  summary.textContent=pending?'正在校验当前修改…'+(errors?' 当前仍有'+errors+'项问题。':''):
    draftValidationState==='failed'?'校验未完成：'+draftValidationMessage:
    errors?'当前仍有'+errors+'项问题，请查看下方提示。':
    draftValidationState==='valid'?'当前修改已通过校验，保存后生效。'+(warnings?' 另有'+warnings+'条提示。':''):'等待校验当前数据…';
}
function draftChanged(force=false){
  if(!characterDraft||!dialogIsCurrent()||!$('resultsDialog').open)return;
  const signature=draftSignature();if(!force&&signature===draftFingerprint)return;draftFingerprint=signature;
  clearTimeout(draftValidationTimer);draftValidationRequest++;draftValidationLedger=null;draftValidationState='pending';draftValidationMessage='';
  dialogError('characterDialogError','');dialogError('weaponDialogError','');renderDraftValidation();
  const epoch=draftValidationEpoch,sequence=draftValidationRequest,id=session.id,rev=revision;
  draftValidationTimer=setTimeout(async()=>{
    draftValidationTimer=null;const candidate=draftCandidate();
    try{
      const response=await api('/api/validate',{session:candidate});
      if(epoch!==draftValidationEpoch||sequence!==draftValidationRequest||session?.id!==id||revision!==rev||!dialogIsCurrent()||!$('resultsDialog').open)return;
      if(!response?.ledger)throw Error('服务没有返回当前校验结果。');
      draftValidationLedger=response.ledger;draftValidationState='valid';renderDraftValidation();
    }catch(e){
      if(epoch!==draftValidationEpoch||sequence!==draftValidationRequest||session?.id!==id||revision!==rev||!dialogIsCurrent()||!$('resultsDialog').open)return;
      draftValidationState='failed';draftValidationMessage=displayText(e.message);renderDraftValidation();
    }
  },250);
}
async function refreshCommittedValidation(){
  const id=session.id,rev=revision,candidate=clone(session);
  try{
    const response=await api('/api/validate',{session:candidate});if(session?.id!==id||revision!==rev)return;
    const validated=response.ledger;if(!validated)return;
    session.ledger.issues=validated.issues||[];
    if(session.ledger.character){session.ledger.character.issues=validated.character?.issues||[];
      for(const p of session.ledger.character.pools||[])p.issues=validated.character?.pools?.find(q=>q.id===p.id)?.issues||[];}
    if(session.ledger.weapon)session.ledger.weapon.issues=validated.weapon?.issues||[];
    if(autoReviewQueue.length){
      const key=item=>item.type+':'+(item.id||''),remaining=new Set(gatherReviewQueue().map(key)),current=autoReviewQueue[autoReviewIndex];
      autoReviewQueue=autoReviewQueue.filter((item,index)=>index<=autoReviewIndex||remaining.has(key(item)));
      // A later, untouched queue page can become unnecessary after the previous
      // saved pool fixes a global mismatch. Never discard edits on that page.
      if(current&&!remaining.has(key(current))&&draftSignature()===draftOpeningSignature){advanceAutoReview();return;}
      $('characterIssueProgress').textContent=(current?.type==='history'?'补充信息 ':'异常项 ')+(autoReviewIndex+1)+' / '+autoReviewQueue.length;
    }
    renderReviewActions();
    if(characterDraft&&!draftValidationLedger)renderDraftValidation();else if(!characterDraft)renderLedgerIssues();
  }catch(e){if(session?.id===id&&revision===rev)error('修改后的校验未完成：'+e.message);}
}
function applyConfirmedDefaults(value){
  const pools=value?.ledger?.character?.pools;if(!Array.isArray(pools)||!pools.length)return false;
  let updated=false;
  if(value.ledger.character.completeHistory!==true)for(const issue of value.ledger.character.issues||[]){
    if(issue?.code==='incomplete_history'&&issue.severity==='error'){
      issue.severity='warning';issue.message='仅评分导入区间：未知开头等待段不计六星等待分，限定不猜期初New。';updated=true;
    }
  }
  for(const pool of pools)if(pool.ended==null){pool.ended=true;pool.endedSource='confirmed-all-banners-default';updated=true;}
  for(const p of pools)if(p?.rushUsed===true&&p.rushAt==null&&Number.isSafeInteger(p.total)&&p.total>=30){p.rushAt=30;p.rushAtSource='confirmed-default-after-main-30';updated=true;}
  return updated;
}
function markStale(message='记录已修改，等待重算…'){
  $('interruptionNotice').hidden=true;
  setLuckRevealed(false);$('radarRevealArea').hidden=true;$('calculating').textContent=message;$('calculating').hidden=false;$('radar').hidden=true;
  $('planningHighlights').replaceChildren(el('p',message,'muted'));$('planning').replaceChildren(el('p',message,'muted'));
  if(session?.scoringScenario?.enabled===true&&latestSavedPool())$('planningHighlights').append(button('查看末池详情',openLatestPlanningDetail));
  $('planningBreakdown').hidden=true;$('planningTopPools').replaceChildren();
  $('exportRadar').disabled=true;$('save').disabled=true;
  renderScoringScenario();
}
function changed(defer=false){
  if(!session)return;revision++;session.revision=revision;session.reviewed=false;
  error('');markStale();renderReviewActions();clearTimeout(timer);if(!defer)timer=setTimeout(()=>calculate(false),500);
}
async function calculate(reviewed,{preserveReview=false}={}){
  if(!session||historyDeleting||scoreSettingPending())return;clearTimeout(timer);const defaultsApplied=applyConfirmedDefaults(session);
  if(reviewed||defaultsApplied){revision++;session.revision=revision;}
  const myRevision=revision,myRequest=++requestId;if(!preserveReview)session.reviewed=reviewed;markStale('正在计算…');
  try{
    const updated=await api('/api/score',{session});if(myRequest!==requestId||myRevision!==revision)return false;
    session=updated;renderLedgerIssues();renderResults();renderReviewActions();refreshHistory();return true;
  }catch(e){if(myRequest!==requestId||myRevision!==revision)return false;error(e.message);$('calculating').textContent='计算未完成，请检查提示。';return false;}
}
function selected(list){if(restoring)return;files=[...list];$('selection').textContent=files.length?files.map(f=>f.name).join('、'):'尚未选择截图';$('import').disabled=busy||historyDeleting||scoreSettingPending()||!files.length;}
$('images').onchange=e=>selected(e.target.files);
const dz=$('dropzone');dz.ondragover=e=>{e.preventDefault();dz.classList.add('drag');};dz.ondragleave=()=>dz.classList.remove('drag');
dz.ondrop=e=>{e.preventDefault();dz.classList.remove('drag');selected(e.dataTransfer.files);};
const readFile=f=>new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(String(reader.result).split(',')[1]);reader.onerror=()=>reject(Error('无法读取文件'));reader.readAsDataURL(f);});
function importFailures(items){return (items||[]).filter(i=>i.status==='error').map(i=>(i.name||'截图')+'：'+displayText(i.error||'未能识别，请检查图片后重试。')).join('\n');}
async function openSavedSession(id){
  if(historyDeleting||restoring||deletedRecordIds.has(id))return false;
  const navigation=++navigationId;error('');status('正在打开记录…',true);
  try{
    const value=await api('/api/sessions/'+id);if(navigation!==navigationId||historyDeleting||restoring||deletedRecordIds.has(id))return false;
    const loaded=await loadSession(value);
    if(session?.id!==id||loaded===false)return false;
    if(!autoReviewQueue.length)status('已打开本机记录。');
    return true;
  }catch(e){if(navigation===navigationId){error(e.message);status('');}return false;}
}
$('import').onclick=async()=>{
  if(busy||historyDeleting||restoring||scoreSettingPending())return;
  let completedSummary='';
  try{
    error('');if(!files.length||files.length>12)throw Error('请选择1—12张截图，每张图将独立建档。');
    if(files.reduce((s,f)=>s+f.size,0)>70*1024*1024)throw Error('这一批图片超过70 MB，请分批处理。');
    busy=true;updateHistoryControls();$('import').disabled=true;status('正在读取截图…',true);const uploaded=[];
    for(const f of files)uploaded.push({name:f.name,data:await readFile(f)});
    const job=await api('/api/import',{files:uploaded});
    while(true){
      const progress=await api('/api/jobs/'+job.id);status(progress.message,progress.status==='running');
      if(progress.status==='error'){
        const failed=(progress.items||[]).filter(item=>item.status==='error').length;
        if(failed)completedSummary=`已完成：0 份独立记录，${failed} 张失败。`;
        throw Error([progress.message,importFailures(progress.items)].filter(Boolean).join('\n'));
      }
      if(progress.status==='done'){
        const sessions=progress.sessions||(progress.session?[progress.session]:[]);
        if(sessions.length)await loadSession(sessions[0],{reviewImport:true});
        const failed=progress.failed??(progress.items||[]).filter(item=>item.status==='error').length;
        completedSummary=`已完成：${sessions.length} 份独立记录，${failed} 张失败。可在本机历史记录中打开。`;status(completedSummary);
        error(importFailures(progress.items));
        refreshHistory();break;
      }
      await new Promise(resolve=>setTimeout(resolve,900));
    }
  }catch(e){error(e.message);status(completedSummary);}finally{busy=false;$('import').disabled=historyDeleting||!files.length;updateHistoryControls();}
};
function loadSession(value,{reviewImport=false}={}){
  if(historyDeleting||deletedRecordIds.has(value?.id))return false;
  planningExemptionRequest=null;planningExemptionError=null;planningDetailPoolId=null;scoringScenarioRequest=null;
  navigationId++;requestId++;clearTimeout(timer);resetAutoReview();closeReviewDialogs();closeViewDialogs();session=value;revision=value.revision||1;
  // Filling agreed defaults does not revoke previously confirmed identities.
  const defaultsApplied=applyConfirmedDefaults(value);if(defaultsApplied){revision++;session.revision=revision;}
  reviewImport=reviewImport||gatherReviewQueue(value).length>0;
  error('');$('workspace').hidden=false;$('recordTitle').textContent=(value.documents||[]).map(d=>d.file).join(' / ');
  renderLedgerIssues();updateHistoryControls();
  const planningOutdated=!!planningVersion&&value.result?.planning?.version!==planningVersion;
  const characterOutdated=!!characterVersion&&value.result?.character?.version!==characterVersion;
  const weaponOutdated=!!weaponVersion&&value.result?.weaponVersion!==weaponVersion;
  const recognitionOutdated=!!recognitionVersion&&value.recognitionVersion!==recognitionVersion;
  const scenarioOutdated=value.scoringScenario?.enabled===true&&(!value.result?.hypothesis||value.result?.scoringScenario?.enabled!==true||value.result.scoringScenario.plan?.poolId!==value.scoringScenario.poolId||(!!scoringScenarioVersion&&value.result.scoringScenario.version!==scoringScenarioVersion));
  const interruptionOutdated=!!interruptionVersion&&value.ledger?.character?.interruptionCorrection?.excludedIndices?.length>0&&value.result?.interruptionCorrection?.version!==interruptionVersion;
  if(recognitionOutdated||interruptionOutdated){
    // Revalidate the edited ledger before presenting an obsolete OCR summary error.
    // Only this opened record is rescored; original screenshots are not recognized again.
    const loadedId=session.id,loadedRevision=revision;
    markStale('记录校验逻辑已更新，正在重新校验与计算…');
    return calculate(false,{preserveReview:true}).then(ok=>{
      if(ok&&session?.id===loadedId&&revision===loadedRevision)startAutoReview();
      return ok;
    });
  }
  if(reviewImport&&startAutoReview()){if(defaultsApplied||planningOutdated||characterOutdated||weaponOutdated||scenarioOutdated)autoReviewDirty=true;return;}
  if(defaultsApplied||planningOutdated||characterOutdated||weaponOutdated||scenarioOutdated){markStale(planningOutdated||characterOutdated||weaponOutdated||scenarioOutdated?'评分规则已更新，正在重新计算…':'正在按当前记录重新计算…');return calculate(false,{preserveReview:true});}
  renderResults();refreshHistory();
}

// The two editors reuse the dialog shell; each submits only its own draft.
function closeReviewDialogs(){
  closeHypothesis();
  clearTimeout(draftValidationTimer);draftValidationTimer=null;draftValidationEpoch++;draftValidationRequest++;draftValidationLedger=null;draftValidationState='idle';draftFingerprint='';draftOpeningSignature='';weaponIssueView=null;queueIssueView=null;
  $('draftValidationSummary').hidden=true;$('currentGlobalIssues').replaceChildren();
  if($('resultsDialog').open)$('resultsDialog').close();
  characterDraft=null;weaponDraft=null;dialogOrigin=null;characterReviewPoolId=null;
  characterPoolViews.clear();$('review').replaceChildren();
}
function closeViewDialogs(){for(const id of viewDialogs)if($(id).open)$(id).close();}
function resetAutoReview(){autoReviewQueue=[];autoReviewIndex=0;autoReviewDirty=false;}
function recognitionErrors(items){return (items||[]).filter(i=>i?.severity==='error');}
function firstPool(character){return [...(character?.pools||[])].sort((a,b)=>a.index-b.index)[0];}
function needsInitialHistory(character){
  character=effectiveCharacter(character);
  const first=firstPool(character),history=character?.firstPoolHistory;
  return !!first&&!first.interruptionBefore&&first.index!==0&&!(history?.poolId===first.id&&typeof history.isFirstPool==='boolean');
}
function poolNeedsReview(p,character=session?.ledger.character){
  character=effectiveCharacter(character);p=character?.pools.find(q=>q.id===p.id);if(!p)return false;
  return recognitionErrors(p.issues).length>0||!Number.isSafeInteger(p.total)||p.total<0||
    typeof p.rushUsed!=='boolean'||
    (p.events||[]).some(e=>!Number.isSafeInteger(e.at)||!characters.includes(e.character))||
    (p.rush||[]).some(e=>!characters.includes(e.character))||
    !!edit.validatePool(p,{allowMissingQuota:edit.allowsMissingQuota(character)})||
    (Number.isSafeInteger(p.total)&&p.total>=0&&((p.tokens||[]).length!==Math.floor(p.total/240)||(p.tokens||[]).some((e,i)=>e.at!==240*(i+1))));
}
function characterConflicts(ledger){
  const character=ledger.character||{pools:[]};
  return recognitionErrors(issuesForEditor(ledger,'character')).length>0||!!edit.validateLinks(character)||
    (character.pools||[]).some(p=>poolNeedsReview(p,character))||
    (ledger.unresolvedCards||[]).some(card=>!character.pools?.some(p=>p.evidence?.unresolvedCardId===card.id));
}
function gatherReviewQueue(value=session){
  const ledger=value?.ledger||{},queue=[...(ledger.character?.pools||[])].sort((a,b)=>(a.index??0)-(b.index??0))
    .filter(p=>poolNeedsReview(p,ledger.character)).map(p=>({type:'pool',id:p.id}));
  if(needsInitialHistory(ledger.character))queue.unshift({type:'history'});
  if(ledger.character&&edit.validateLinks(ledger.character))queue.push({type:'links'});
  const w=ledger.weapon;
  if(w&&(recognitionErrors(validationIssues(w.issues)).length||recognitionErrors(issuesForEditor(ledger,'weapon').filter(i=>i.axes?.length&&i.axes.every(axis=>['weaponSix','signature'].includes(axis)))).length||((w.N??0)>0&&ui.validateWeapon(w).length)))queue.push({type:'weapon'});
  if(recognitionErrors(issuesForEditor(ledger,'character')).length||
    (ledger.unresolvedCards||[]).some(card=>!(ledger.character?.pools||[]).some(pool=>pool.evidence?.unresolvedCardId===card.id)))queue.push({type:'info'});
  return queue;
}
function startAutoReview(){
  resetAutoReview();autoReviewQueue=gatherReviewQueue();if(!autoReviewQueue.length)return false;
  requestId++;clearTimeout(timer);markStale('识别数据存在异常。');openNextReview();return true;
}
function openNextReview(){
  const item=autoReviewQueue[autoReviewIndex];
  if(item?.type==='pool'&&!effectiveCharacter(session.ledger.character).pools.some(p=>p.id===item.id)){autoReviewIndex++;return openNextReview();}
  if(item?.type==='history'&&!needsInitialHistory(session.ledger.character)){autoReviewIndex++;return openNextReview();}
  if(item?.type==='links'&&!edit.validateLinks(session.ledger.character)){autoReviewIndex++;return openNextReview();}
  if(!item){
    const dirty=autoReviewDirty;resetAutoReview();closeReviewDialogs();
    const finished=()=>status(gatherReviewQueue().length?'记录仍有缺失或冲突，有关分数暂不可用。':'修改已保存，计算完成。');
    if(dirty){
      status('修改已保存，正在计算…',true);const id=session.id,scoring=calculate(false),rev=revision;
      scoring.then(ok=>{if(session?.id===id&&revision===rev){if(ok)finished();else status('计算未完成，请查看错误原因。');}});
    }else{renderResults();finished();}return;
  }
  status('');
  openResults(item.type==='weapon'?'weapon':'character',false,{fromQueue:true,poolId:item.type==='pool'?item.id:null});
}
function advanceAutoReview(){closeReviewDialogs();autoReviewIndex++;openNextReview();}
function cancelResults(){
  const active=autoReviewQueue.length>0,dirty=autoReviewDirty;closeReviewDialogs();resetAutoReview();renderReviewActions();
  renderLedgerIssues();
  if(dirty)calculate(false);else if(active)renderResults();
  status('');
}
function renderSourceEvidence(target,docs){
  for(const d of docs){const src=d.sourceImage;if(typeof src!=='string'||!src.startsWith('/data/'))continue;
    const figure=el('figure',undefined,'pool-evidence'),a=el('a'),img=el('img');a.href=src;a.target='_blank';a.rel='noopener';img.src=src;img.alt=d.file||'识别原图';img.loading='lazy';a.append(img);figure.append(a,el('figcaption',d.file||'识别原图'));target.append(figure);
  }
}
function poolSource(p){
  const ev=p?.evidence||{},doc=(session.documents||[]).find(d=>(ev.source_sha256&&d.source_sha256===ev.source_sha256)||(ev.file&&d.file===ev.file));
  return ev.crop||ev.sourceImage||doc?.sourceImage;
}
function dialogIsCurrent(){return session&&dialogOrigin?.id===session.id&&dialogOrigin.revision===revision;}
function dialogError(id,message){$(id).textContent=displayText(message);$(id).hidden=!message;}
function renderReviewActions(){
  const w=session?.ledger.weapon,active=!!(w&&(hasWeaponProfile(w)||w.lossDraws>0)&&ui.validateWeapon(w).length===0);
  const roleButton=$('openResults');
  const hasData=!!(session?.ledger.character?.pools?.length||session?.ledger.unresolvedCards?.length||issuesForEditor(session?.ledger,'character').length);
  const bad=hasData&&characterConflicts(session.ledger);
  roleButton.classList.toggle('is-consistent',hasData&&!bad);
  roleButton.classList.toggle('has-conflicts',!!bad);
  roleButton.setAttribute('aria-label','限定池识别结果'+(hasData?(bad?'，有矛盾':'，自洽'):''));
  $('manualSupplement').disabled=!session||busy||historyDeleting||restoring||scoreSettingPending();
  $('weaponConfigured').classList.toggle('is-active',active);$('weaponConfigured').setAttribute('aria-pressed',String(active));
  $('openResults').disabled=!session||historyDeleting||restoring;$('weaponConfigured').disabled=!w||historyDeleting||restoring||scoreSettingPending();
  $('resultsApply').disabled=restoring||scoreSettingPending();
}
const roleTabs=[
  ['resultsCharacterTab','characterResultsPanel'],
  ['interruptionTab','interruptionReview'],
  ['initialHistoryTab','initialHistory'],
  ['summaryTab','summaryReview'],
];
function selectRoleTab(index,focus=false){
  roleTabs.forEach(([tabId,panelId],i)=>{
    const selected=i===index&&resultsTab==='character',tab=$(tabId);
    tab.setAttribute('aria-selected',String(selected));tab.tabIndex=selected?0:-1;
    $(panelId).hidden=!selected;
    if(selected&&focus)tab.focus();
  });
}
function openResults(mode='character',enableProfile=false,{fromQueue=false,poolId=null}={}){
  if(!session||historyDeleting||scoreSettingPending()||(restoring&&!fromQueue))return;
  if($('resultsDialog').open&&!fromQueue)return;
  if(!fromQueue)resetAutoReview();closeReviewDialogs();
  resultsTab=mode==='weapon'?'weapon':'character';
  const weapon=resultsTab==='weapon',step=autoReviewQueue[autoReviewIndex];
  characterReviewPoolId=poolId;characterDraft=clone(session.ledger.character||{pools:[]});
  weaponDraft=weapon&&session.ledger.weapon?clone(session.ledger.weapon):null;
  weaponProfileDraft=weapon&&(enableProfile||hasWeaponProfile(weaponDraft));dialogOrigin={id:session.id,revision};
  dialogError('characterDialogError','');dialogError('weaponDialogError','');
  $('characterTabs').hidden=weapon;$('weaponResultsPanel').hidden=!weapon;
  const headerConflict=step?.type==='info'&&issuesForEditor(session.ledger,'character').some(i=>i.code==='character_summary_mismatch');
  selectRoleTab(step?.type==='history'?2:headerConflict?3:0);
  $('resultsDialogTitle').textContent=weapon?'武器修正':'限定池识别结果';
  if(weapon)renderWeaponReview();else renderCharacterReview();
  renderReviewActions();
  $('resultsApply').textContent=autoReviewQueue.length?'保存并继续':'保存修改';
  $('resultsSaveHint').textContent=step?.type==='pool'?'保存将确认本池出货位置和角色。':'';
  openDialog('resultsDialog');
  draftOpeningSignature=draftSignature();
  draftChanged(true);
}
function renderInitialHistory(){
  const target=$('initialHistory');target.replaceChildren();
  const first=firstPool(characterDraft);if(!first){target.append(el('p','暂无角色卡池。','empty'));return;}
  const effectiveFirst=firstPool(effectiveCharacter(characterDraft));
  if(effectiveFirst?.interruptionBefore){target.append(el('p','当前评分从'+effectiveFirst.banner+'的0水位重新开始，原首池信息继续保留。','muted small'));return;}
  const details=el('div',undefined,'initial-history');
  details.append(el('h3',first.banner));
  const history=characterDraft.firstPoolHistory;
  const mode=history?.poolId===first.id?String(history.isFirstPool):first.index===0?'true':'';
  const choice=el('label',undefined,'field');choice.append(el('span','这是账号首次抽限定池吗？'),select(mode,[['','尚未确认'],['true','是，这是首次'],['false','不是，前面还有记录']],v=>{
    if(v===''){delete characterDraft.firstPoolHistory;renderCharacterReview();return;}
    characterDraft.firstPoolHistory={poolId:first.id,isFirstPool:v==='true'};
    if(v==='true'){
      characterDraft.initialOwned=[];edit.setInitialPity(characterDraft,first,0);first.freeAllowance=10;
      const ordered=[...characterDraft.pools].sort((a,b)=>a.index-b.index);
      characterDraft.completeHistory=ordered.every((p,i)=>!i||p.index===ordered[i-1].index+1);
      characterDraft.historyEvidence='user-confirmed-account-first-pool';
    }else{
      characterDraft.completeHistory=false;characterDraft.historyEvidence='user-confirmed-earlier-history';
      characterDraft.initialPity=first.initialPity??characterDraft.initialPity??null;
    }
    renderCharacterReview();
  }));details.append(choice);
  if(mode==='false'||(mode===''&&first.index!==0)){
    const ownership=el('label',undefined,'field');ownership.append(el('span','此前图鉴'),select(Array.isArray(characterDraft.initialOwned)?'known':'unknown',[
      ['known','勾选已拥有角色'],['unknown','暂不确定']],v=>{
      characterDraft.initialOwned=v==='known'?[]:null;renderCharacterReview();
    }));details.append(ownership);
    if(Array.isArray(characterDraft.initialOwned)){
      details.append(el('p','勾选首池开始前已拥有的角色。','muted small'));
      const grid=el('div',undefined,'owned-grid');
      for(const name of characters){const label=el('label',undefined,'check'),input=el('input');input.type='checkbox';input.checked=characterDraft.initialOwned.includes(name);
        input.onchange=()=>{characterDraft.initialOwned=characters.filter(n=>n===name?input.checked:characterDraft.initialOwned.includes(n));draftChanged();};
        label.append(input,el('span',name));grid.append(label);
      }details.append(grid);
    }
  }
  const meta=el('div',undefined,'pool-meta');
  meta.append(field('首池期初水位（不清楚可留空）',first.initialPity??characterDraft.initialPity,v=>{
    edit.setInitialPity(characterDraft,first,v);refreshPoolWaterViews();
  }));
  const free=el('label',undefined,'field');free.append(el('span','首池免费额度'),select(first.freeAllowance??(mode==='true'?10:''),[
    ['','未知 / 按前池推断'],['10','10抽'],['20','20抽（前期60节点或特殊赠送）']],v=>{if(v==='')delete first.freeAllowance;else first.freeAllowance=Number(v);renderCharacterReview();}));meta.append(free);
  details.append(meta);
  target.append(details);
}
function validateInitialHistory(){
  if(firstPool(effectiveCharacter(characterDraft))?.interruptionBefore)return '';
  const h=characterDraft.firstPoolHistory,first=firstPool(characterDraft);
  if(autoReviewQueue[autoReviewIndex]?.type==='history'&&needsInitialHistory(characterDraft))return '请选择首池是否是账号首次抽限定池。';
  if(characterDraft.initialPity!=null&&(!Number.isSafeInteger(characterDraft.initialPity)||characterDraft.initialPity<0||characterDraft.initialPity>79))return '首池期初水位须为0—79的整数，或留空。';
  if(h?.isFirstPool&&h.poolId===first?.id&&(first.initialPity!==0||characterDraft.initialPity!==0||(characterDraft.initialOwned||[]).length))return '首次抽限定池应从0水位开始、没有此前限定图鉴；若有此前记录，请改选“不是”。';
  return '';
}
function renderInterruptionReview(){
  const target=$('interruptionReview');target.replaceChildren();
  const chosen=characterDraft.interruptionCorrection?.excludedIndices||[],selected=new Set(chosen);
  const details=el('div',undefined,'interruption-review');
  details.append(el('p','勾选要排除的卡池。下一段从0水位开始，取消勾选即可恢复。','muted small'));
  const grid=el('div',undefined,'interruption-grid');
  edit.BANNERS.forEach((banner,index)=>{
    const label=el('label',undefined,'check'),input=el('input');input.type='checkbox';input.checked=selected.has(index);input.dataset.bannerIndex=String(index);
    input.onchange=()=>{
      const values=new Set(characterDraft.interruptionCorrection?.excludedIndices||[]);input.checked?values.add(index):values.delete(index);
      characterDraft.interruptionCorrection={excludedIndices:[...values].sort((a,b)=>a-b),freeAllowances:{...(characterDraft.interruptionCorrection?.freeAllowances||{})}};
      renderCharacterReview();draftChanged();
    };
    const present=characterDraft.pools.some(p=>p.index===index);
    label.append(input,el('span',banner+' · '+edit.LIMITED[index]+(present?'':'（未导入）')));grid.append(label);
  });details.append(grid);
  if(!edit.validateInterruption(characterDraft)){
    const {summary}=edit.projectCharacter(characterDraft);
    for(const pool of summary.resetPools){
      const row=el('div',undefined,'interruption-resume');row.append(el('strong',pool.banner+' · 从0水位重新开始'));
      const free=el('label',undefined,'field');free.append(el('span',pool.banner+'免费抽'),select(pool.freeAllowance,[['0','0抽'],['10','10抽'],['20','20抽']],v=>{
        (characterDraft.interruptionCorrection.freeAllowances??={})[pool.index]=Number(v);renderCharacterReview();
      }));row.append(free);details.append(row);
    }
    if(selected.size&&!summary.resetPools.length)details.append(el('p','已排除所选卡池；当前没有其后的保留记录。','muted small'));
    const invalidHypothesis=interruptedHypothesisReason(characterDraft);
    if(invalidHypothesis)details.append(el('p',invalidHypothesis+'，保存时将关闭该假设，可按新记录重新设置。','muted small'));
    if(selected.size)details.append(button('清除中断修正',()=>{delete characterDraft.interruptionCorrection;renderCharacterReview();}));
  }
  target.append(details);
}
function interruptedHypothesisReason(character){
  if(!session?.scoringScenario?.enabled)return '';
  const next=effectiveCharacter(character).pools.at(-1);
  if(next?.id!==session.scoringScenario.poolId)return '原假设保底对应的末池已排除';
  const saved=session.ledger.character;
  if(JSON.stringify(character.interruptionCorrection)!==JSON.stringify(saved.interruptionCorrection)){
    const previous=effectiveCharacter(saved).pools.find(p=>p.id===next.id);
    if(previous?.tail!==next.tail)return '中断修正改变了原假设的补抽位置';
  }
  return '';
}
function renderSummaryReview(){
  const target=$('summaryReview');target.replaceChildren();
  const docs=(session.documents||[]).filter(d=>d.overview?.character);
  if(!docs.length){target.append(el('p','这份记录没有截图顶部汇总。','empty'));return;}
  const details=el('div');
  const seen=new Set();
  for(const doc of docs){const key=doc.source_sha256||doc.file;if(seen.has(key))continue;seen.add(key);
    const matches=o=>doc.source_sha256?o.source_sha256===doc.source_sha256:!o.source_sha256&&o.file===doc.file;
    const saved=(characterDraft.summaryOverrides||[]).find(matches),box=el('div',undefined,'summary-source');box.append(el('strong',doc.file||'来源截图'));
    const mode=el('label',undefined,'field');mode.append(el('span','顶部汇总依据'),select(saved?.mode||'original',[
      ['original','原始识别值（默认）'],['override','手工修正顶部数字'],['details','仅以当前明细为准']],v=>{
      characterDraft.summaryOverrides=(characterDraft.summaryOverrides||[]).filter(o=>!matches(o));
      if(v!=='original')characterDraft.summaryOverrides.push({source_sha256:doc.source_sha256,file:doc.file,mode:v,...(v==='override'?Object.fromEntries(['N','K6','off'].map(k=>[k,doc.overview.character[k]??null])):{})});
      renderSummaryReview();
    }));box.append(mode);
    if(saved?.mode==='override'){
      const meta=el('div',undefined,'pool-meta');for(const [k,label]of [['N','主池总抽数'],['K6','主池六星数'],['off','歪出次数']])meta.append(field(label,Object.hasOwn(saved,k)?saved[k]:doc.overview.character[k],v=>saved[k]=v));
      box.append(meta,el('p','空白表示不使用该项顶部数字校验；六星和歪数均不含加急、信物。','muted small'));
    }else box.append(el('p',`原图：${doc.overview.character.N??'未知'}抽 / ${doc.overview.character.K6??'未知'}个六星 / 歪${doc.overview.character.off??'未知'}次`,'muted small'));
    details.append(box);
  }target.append(details);
}
function validateSummaryEdits(){
  for(const o of characterDraft.summaryOverrides||[])if(o.mode==='override'){
    for(const k of ['N','K6','off'])if(o[k]!=null&&(!Number.isSafeInteger(o[k])||o[k]<0))return '顶部汇总修正须为非负整数，或留空。';
    if(o.K6!=null&&o.N!=null&&o.K6>o.N)return '顶部汇总六星数不能大于主池总抽数。';
    if(o.off!=null&&o.K6!=null&&o.off>o.K6)return '顶部汇总歪出次数不能大于六星数。';
  }return '';
}
function derivedPoolTail(p){
  return edit.derivedPoolTail(p);
}
function updatePoolWater(p){
  edit.updatePoolWater(characterDraft,p);refreshPoolWaterViews();
}
function refreshPoolWaterViews(){
  const effective=effectiveCharacter(characterDraft);
  for(const [pool,view]of characterPoolViews){
    const evaluated=effective.pools.find(p=>p.id===pool.id),display=evaluated||pool;
    view.tail.value=display.tail??'';view.initial.value=display.initialPity??'';
    view.initial.disabled=!!evaluated&&(!!evaluated.interruptionBefore||evaluated.initialPity!==pool.initialPity);
    view.tail.disabled=!!evaluated&&evaluated.tail!==pool.tail;
    if(view.free){view.free.value=display.freeAllowance??'';view.free.disabled=!!evaluated?.interruptionBefore;}
    if(view.scope){
      view.scope.hidden=!!evaluated&&!evaluated.interruptionBefore&&evaluated.initialPity===pool.initialPity&&evaluated.tail===pool.tail;
      view.scope.textContent=!evaluated?'原始明细保留。本池不参与角色评分和规划亏损。':
        '中断修正后：期初水位'+(evaluated.initialPity??'未知')+'，期末水位'+(evaluated.tail??'未知')+(evaluated.interruptionBefore?'，免费'+evaluated.freeAllowance+'抽':'')+'。原始水位 '+(pool.initialPity??'未知')+' → '+(pool.tail??'未知')+' 继续保留。';
    }
    view.summary.textContent=pool.up+' · '+(pool.total??'?')+' 抽 · '+(pool.events||[]).length+' 个主池六星';
    if(view.addRush)view.addRush.disabled=!Number.isSafeInteger(pool.total)||pool.total<30||(pool.rush||[]).length>=10;
    if(view.emptyRush){
      view.emptyRush.disabled=!Number.isSafeInteger(pool.total)||pool.total<30;
      view.emptyRush.setAttribute('aria-pressed',String(pool.rushUsed===true&&pool.rush?.length===0));
    }
    if(view.tokens){view.tokens.hidden=!pool.tokens?.length;view.tokens.textContent='信物节点：'+(pool.tokens||[]).map(e=>e.at).join('、');}
  }
}
function closeHypothesis(){
  hypothesisEpoch++;hypothesis=null;
  if($('hypothesisDialog').open)$('hypothesisDialog').close();
  $('hypothesisComparison').replaceChildren();$('hypothesisPreview').disabled=true;
}
function hypothesisIsCurrent(state,epoch,request){
  return hypothesis===state&&hypothesisEpoch===epoch&&state.request===request&&session?.id===state.id&&revision===state.revision&&$('hypothesisDialog').open;
}
function hypothesisError(message){$('hypothesisError').textContent=displayText(message);$('hypothesisError').hidden=!message;}
function hypothesisPayload(state){return {session:clone(state.candidate),poolId:state.poolId,mode:state.mode};}
function hypothesisSettings(state){return {enabled:true,poolId:state.poolId,mode:state.mode,choices:clone(state.choices),additionalFive:state.additionalFive};}
function hypothesisInputProblem(state){
  if(!state?.plan||state.pending)return '请先等待假设计划生成。';
  const unchosen=(state.plan.events||[]).find(event=>event.requiredChoice&&!(event.allowedCharacters||[]).includes(state.choices[event.at]));
  if(unchosen)return '请选择第'+unchosen.at+'抽六星的角色。';
  if(state.additionalFive!=null&&(!Number.isSafeInteger(state.additionalFive)||state.additionalFive<0))return '新增五星数须留空或填写非负整数。';
  if(state.additionalFive!=null&&Number.isSafeInteger(state.plan.additionalFiveMin)&&state.additionalFive<state.plan.additionalFiveMin)return '这段假设至少需要'+state.plan.additionalFiveMin+'个新增五星；也可留空，五星评分将暂不可用。';
  if(state.additionalFive!=null&&Number.isSafeInteger(state.plan.additionalFiveMax)&&state.additionalFive>state.plan.additionalFiveMax)return '这段假设最多可填写'+state.plan.additionalFiveMax+'个新增五星。';
  return '';
}
function renderHypothesisActivation(){
  const state=hypothesis,enabled=session?.scoringScenario?.enabled===true,pending=!!scoringScenarioRequest;
  $('hypothesisEnabled').checked=pending?scoringScenarioRequest.settings.enabled:enabled;
  $('hypothesisEnabled').disabled=!state||scoreSettingPending()||busy||restoring||historyDeleting||(!enabled&&(!state.plan||state.pending||!$('calculating').hidden));
  const same=enabled&&state&&JSON.stringify(hypothesisSettings(state))===JSON.stringify({enabled:true,poolId:session.scoringScenario.poolId,mode:session.scoringScenario.mode,choices:session.scoringScenario.choices||{},additionalFive:session.scoringScenario.additionalFive??null});
  $('hypothesisApply').hidden=!enabled||same;
  $('hypothesisApply').disabled=!state||scoreSettingPending()||!!hypothesisInputProblem(state);
  $('hypothesisApplyHint').textContent=pending?'正在保存并更新主页评分…':enabled?(same?'已启用；主页全部评分正在使用这组假设。':'主页仍使用上次已保存的假设；点击“应用当前假设设置”更新。'):'配置角色后勾选启用，主页评分会立即重算并保存。新增五星留空时，最终五星轴暂不可用。';
  if(state){for(const node of [...$('hypothesisControls').querySelectorAll('input'),...$('hypothesisControls').querySelectorAll('select'),...$('hypothesisChoices').querySelectorAll('select')])node.disabled=scoreSettingPending();}
}
function invalidateHypothesisPreview(){
  if(!hypothesis)return;$('hypothesisComparison').replaceChildren();hypothesisError('');
  if(!hypothesis.plan)return;
  hypothesis.request++;hypothesis.pending=false;
  $('hypothesisStatus').textContent='假设条件已更新，点击预览评分变化。';$('hypothesisPreview').disabled=!hypothesis.plan;
  renderHypothesisActivation();
}
function renderHypothesisPlan(plan,notices=[]){
  $('hypothesisPlan').replaceChildren(el('p',`从本池第 ${plan.fromTotal} 抽补到第 ${plan.toTotal} 抽，新增 ${plan.addedDraws} 抽。`,'hypothesis-range'));
  const fiveInput=$('hypothesisControls').querySelector('input');
  if(fiveInput){fiveInput.min=plan.additionalFiveMin??0;fiveInput.max=plan.additionalFiveMax??'';}
  if(Number.isSafeInteger(plan.additionalFiveMin)&&Number.isSafeInteger(plan.additionalFiveMax))$('hypothesisPlan').append(el('p','如填写新增五星数，范围为 '+plan.additionalFiveMin+'—'+plan.additionalFiveMax+' 个；留空则最终五星评分暂不可用。','muted small'));
  $('hypothesisChoices').replaceChildren();
  for(const event of plan.events||[]){
    if(event.requiredChoice){
      const label=el('label',undefined,'field');label.append(el('span','第'+event.at+'抽六星角色'));
      label.append(select(hypothesis.choices[event.at]||'',[['','请选择'],...(event.allowedCharacters||[]).map(name=>[name,name])],value=>{
        if(!hypothesis)return;hypothesis.choices[event.at]=value||null;invalidateHypothesisPreview();
      }));$('hypothesisChoices').append(label);
    }else $('hypothesisChoices').append(el('p','第'+event.at+'抽：'+(event.character||'六星')+(event.forced?'（首UP保底）':''),'muted small'));
  }
  $('hypothesisNotices').replaceChildren(...notices.map(notice=>el('p',issueText(notice),'muted small')));
  renderHypothesisActivation();
}
async function requestHypothesisPlan(){
  const state=hypothesis;if(!state)return;
  const epoch=hypothesisEpoch,request=++state.request;state.plan=null;state.pending=true;
  $('hypothesisPlan').replaceChildren();$('hypothesisChoices').replaceChildren();$('hypothesisComparison').replaceChildren();$('hypothesisNotices').replaceChildren();
  hypothesisError('');$('hypothesisStatus').textContent='正在确认可补到的保底位置…';$('hypothesisPreview').disabled=true;
  renderHypothesisActivation();
  try{
    const response=await api('/api/hypothesis/plan',hypothesisPayload(state));if(!hypothesisIsCurrent(state,epoch,request))return;
    if(!response?.plan||![response.plan.fromTotal,response.plan.toTotal,response.plan.addedDraws].every(Number.isSafeInteger))throw Error('服务没有返回完整的假设计划。');
    state.plan=response.plan;state.pending=false;renderHypothesisPlan(response.plan,response.notices||[]);
    $('hypothesisStatus').textContent=(response.plan.events||[]).some(event=>event.requiredChoice)?'请选择假设出货的角色，再预览评分。':'计划已准备好，可预览评分。';$('hypothesisPreview').disabled=false;
  }catch(e){if(hypothesisIsCurrent(state,epoch,request)){state.pending=false;hypothesisError(e.message);$('hypothesisStatus').textContent='未能生成假设计划。';renderHypothesisActivation();}}
}
function openHypothesis(poolId){
  if(!session||historyDeleting||scoreSettingPending())return;
  const pools=effectiveCharacter(session.ledger.character)?.pools||[],pool=pools.find(item=>item.id===poolId)||(!poolId?[...pools].sort((a,b)=>a.index-b.index).at(-1):null);
  if(!pool){dialogError('characterDialogError','请先保存补充的卡池，再设置假设补到保底。');return;}
  closeHypothesis();poolId=pool.id;
  const modeDefault=(pool.events||[]).some(event=>event.character===pool.up)?'next-six-80':'first-up-120';
  const saved=session.scoringScenario?.enabled===true&&session.scoringScenario.poolId===poolId?session.scoringScenario:null;
  hypothesis={id:session.id,revision,candidate:clone(session),poolId,mode:saved?.mode||modeDefault,choices:clone(saved?.choices||{}),additionalFive:saved?.additionalFive??null,plan:null,request:0,pending:false};
  $('hypothesisTitle').textContent=pool.banner+' · 假设补到保底';$('hypothesisControls').replaceChildren();hypothesisError('');
  const mode=el('label',undefined,'field');mode.append(el('span','假设目标'),select(hypothesis.mode,[['first-up-120','补到首次UP的120抽保底'],['next-six-80','补到下一次六星保底']],value=>{
    if(!hypothesis)return;hypothesis.mode=value;hypothesis.choices={};requestHypothesisPlan();
  }));
  $('hypothesisControls').append(mode,field('新增五星数（可选，留空则五星评分未知）',hypothesis.additionalFive,value=>{
    if(!hypothesis)return;hypothesis.additionalFive=value;invalidateHypothesisPreview();
  }));
  openDialog('hypothesisDialog');requestHypothesisPlan();
}
function renderHypothesisComparison(response,additionalFive){
  const target=$('hypothesisComparison');target.replaceChildren();
  target.append(el('h3','假设评分对比'),el('p','勾选启用可应用到主页。','muted small'));
  const table=el('table'),head=el('tr');for(const title of ['项目','当前','假设后','变化'])head.append(el('th',title));table.append(head);
  const append=(label,before,after,unit,complete=true)=>{
    const row=el('tr'),format=value=>Number.isFinite(value)?value.toFixed(2)+unit:'暂不可用';
    row.append(el('td',label),el('td',format(before)),el('td',format(after)),el('td',complete&&Number.isFinite(before)&&Number.isFinite(after)?(after-before>0?'+':'')+(after-before).toFixed(2)+unit:'—'));table.append(row);
  };
  for(const key of ['characterSix','up','limited',...(additionalFive==null?[]:['five'])]){
    const before=response.before?.axes?.[key],after=response.after?.axes?.[key];append(labels[key],before?.score,after?.score,' 分');
    for(const [side,axis]of [['当前',before],['假设后',after]])if(axis?.reason)target.append(el('p',labels[key]+' · '+side+'：'+displayText(axis.reason),'muted small'));
  }
  for(const [label,summarize]of [['资源损耗',ui.planningOverview],['机会估值',ui.planningOpportunityOverview]]){
    const before=summarize(response.before?.planning),after=summarize(response.after?.planning);
    append(label+(before.complete&&after.complete?' 合计':' 部分合计'),before.total,after.total,' 抽',before.complete&&after.complete);
  }
  const wrap=el('div',undefined,'table-wrap');wrap.append(table);target.append(wrap);
  if(additionalFive==null)target.append(el('p','新增五星数未填写，本次不比较角色五星评分，也不要求填写假设配额。','muted small'));
  const planNotices=new Set([...$('hypothesisNotices').children].map(node=>node.textContent));
  for(const notice of response.notices||[])if(!planNotices.has(issueText(notice)))target.append(el('p',issueText(notice),'muted small'));
}
$('hypothesisPreview').onclick=async()=>{
  const state=hypothesis;if(!state?.plan||state.pending||scoreSettingPending())return;
  const problem=hypothesisInputProblem(state);if(problem){hypothesisError(problem);return;}
  const epoch=hypothesisEpoch,request=++state.request,additionalFive=state.additionalFive;state.pending=true;hypothesisError('');
  $('hypothesisComparison').replaceChildren();$('hypothesisStatus').textContent='正在计算假设评分…';$('hypothesisPreview').disabled=true;
  try{
    const response=await api('/api/hypothesis/preview',{...hypothesisPayload(state),choices:clone(state.choices),additionalFive});
    if(!hypothesisIsCurrent(state,epoch,request))return;
    if(!response?.before||!response?.after)throw Error('服务没有返回完整的评分对比。');
    state.pending=false;renderHypothesisComparison(response,additionalFive);$('hypothesisStatus').textContent='假设预览完成；勾选启用后应用到主页评分。';$('hypothesisPreview').disabled=false;renderHypothesisActivation();
  }catch(e){if(hypothesisIsCurrent(state,epoch,request)){state.pending=false;hypothesisError(e.message);$('hypothesisStatus').textContent='假设评分未完成。';$('hypothesisPreview').disabled=false;}}
};
function latestSavedPool(){return [...(effectiveCharacter(session?.ledger.character)?.pools||[])].sort((a,b)=>(a.index??-1)-(b.index??-1)).at(-1);}
function openLatestPlanningDetail(){
  const pool=latestSavedPool();if(!pool)return;
  openPlanningDetail(session.result?.planning?.pools?.find(row=>row.id===pool.id)||{id:pool.id,banner:pool.banner,status:'partial',localLoss:null});
}
function renderScoringScenario(){
  const target=$('scoringScenario'),latest=latestSavedPool();target.replaceChildren();target.hidden=!latest||planningDetailPoolId!==latest.id;if(target.hidden)return;
  const active=session.scoringScenario?.enabled===true,plan=session.result?.scoringScenario?.plan;
  target.className='scoring-scenario'+(active?' is-active':'');
  const check=el('label',undefined,'check'),input=el('input');input.type='checkbox';input.checked=scoringScenarioRequest?scoringScenarioRequest.settings.enabled:active;
  input.disabled=scoreSettingPending()||busy||restoring||historyDeleting||(!active&&(!$('calculating').hidden||!session.ledger.character?.pools?.length));
  input.onchange=()=>{if(active)setScoringScenario({enabled:false});else{input.checked=false;openHypothesis();}};
  check.append(input,el('span','启用假设补到保底'));target.append(check);
  if(scoringScenarioRequest)target.append(el('p','正在保存设置并更新全部评分…','small'));
  else if(active){
    target.append(el('strong',$('calculating').hidden?'当前显示：假设评分':'假设设置已启用，当前评分等待重算'));
    if(plan)target.append(el('p',(plan.banner||'末池')+'：'+plan.fromTotal+' → '+plan.toTotal+' 抽，假设新增 '+plan.addedDraws+' 抽。','small'));
    target.append(el('p','实际记录未增加抽数；取消勾选恢复实际评分。'+(session.scoringScenario.additionalFive==null?' 新增五星未填写，五星轴暂不可用。':''),'muted small'));
  }else target.append(el('p','当前按实际记录评分。勾选后先配置假设条件。','muted small'));
  const settings=button(active?'修改假设设置':'配置假设条件',()=>openHypothesis());settings.disabled=scoreSettingPending()||busy||restoring||historyDeleting||!session.ledger.character?.pools?.length;target.append(settings);
}
async function setScoringScenario(settings){
  if(!session||scoreSettingPending()||busy||restoring||historyDeleting)return;
  if(settings.enabled){
    const problem=hypothesisInputProblem(hypothesis);if(problem){hypothesisError(problem);renderHypothesisActivation();return;}
    if(!$('calculating').hidden){hypothesisError('请先完成实际记录的评分，再启用假设。');renderHypothesisActivation();return;}
  }
  const transaction={id:session.id,revision,request:++requestId,settings:clone(settings)},candidate=clone(session);
  candidate.scoringScenario=clone(settings);candidate.revision=revision+1;
  scoringScenarioRequest=transaction;clearTimeout(timer);timer=null;
  if(hypothesis){hypothesis.request++;hypothesis.pending=false;hypothesisError('');}
  updateHistoryControls();$('save').disabled=true;renderScoringScenario();renderHypothesisActivation();$('hypothesisPreview').disabled=true;
  const isCurrent=()=>scoringScenarioRequest===transaction&&session?.id===transaction.id&&revision===transaction.revision&&requestId===transaction.request;
  try{
    const updated=await api('/api/score',{session:candidate});if(!isCurrent())return;
    if(updated?.id!==transaction.id||updated.revision!==candidate.revision||updated.scoringScenario?.enabled!==settings.enabled||!updated.result||
      (settings.enabled&&updated.result.scoringScenario?.enabled!==true))throw Error('服务未返回已保存的假设评分，请重新打开记录确认。');
    const revealed=luckRevealed;session=updated;revision=updated.revision;scoringScenarioRequest=null;
    syncOpenScoreRevision(transaction.revision);renderResults();setLuckRevealed(revealed);
    if(!characterDraft)renderLedgerIssues();
    if($('planningDetailDialog').open){const row=session.result.planning?.pools?.find(p=>p.id===planningDetailPoolId);if(row)openPlanningDetail(row);}
    updateHistoryControls();renderHypothesisActivation();error('');refreshHistory();
    if(hypothesis){$('hypothesisStatus').textContent=settings.enabled?'已启用假设，主页全部评分已更新并保存。':'已关闭假设，主页已恢复实际评分。';$('hypothesisPreview').disabled=!hypothesis.plan;}
  }catch(e){
    if(!isCurrent())return;scoringScenarioRequest=null;
    const message='假设设置保存失败：'+displayText(e.message)+' 仍保留原设置。';
    if($('hypothesisDialog').open)hypothesisError(message);else error(message);
    updateHistoryControls();renderScoringScenario();renderHypothesisActivation();$('save').disabled=!$('calculating').hidden;$('hypothesisPreview').disabled=!hypothesis?.plan;
  }
}
$('hypothesisEnabled').onchange=()=>setScoringScenario($('hypothesisEnabled').checked&&hypothesis?hypothesisSettings(hypothesis):{enabled:false});
$('hypothesisApply').onclick=()=>{if(hypothesis)setScoringScenario(hypothesisSettings(hypothesis));};
function renderManualPoolTools(){
  const target=$('manualPoolTools');target.replaceChildren();if(!characterDraft)return;
  const available=edit.availableBanners(characterDraft);
  if(!available.length){target.append(el('p','全部'+edit.BANNERS.length+'个卡池已有记录。','muted small'));return;}
  const picker=el('label',undefined,'field');picker.append(el('span','漏识别的卡池'));
  let selected='';const add=button('补充漏识别卡池',()=>{
    try{
      const pool=edit.addPool(characterDraft,Number(selected));characterReviewPoolId=null;
      if(autoReviewQueue[autoReviewIndex]?.type==='history')autoReviewQueue.splice(autoReviewIndex,1,{type:'pool',id:pool.id},...(needsInitialHistory(characterDraft)?[{type:'history'}]:[]));
      renderCharacterReview(null,pool.id);
    }
    catch(e){dialogError('characterDialogError',e.message);}
  });add.disabled=true;
  picker.append(select('',[['','请选择'],...available.map(item=>[String(item.index),item.banner+' · '+item.up])],value=>{selected=value;add.disabled=value==='';}));
  const actions=el('div',undefined,'actions');actions.append(picker,add);target.append(actions,el('p','补充整池后，按原图填写实际抽数和出货记录。','muted small'));
}
function assignUnresolvedPoolCard(card,index){
  if(!characterDraft||!dialogIsCurrent())return;
  const candidate=clone(characterDraft),pool=edit.addPool(candidate,index);
  for(const key of ['total','tail','quota','rushUsed','rushAt'])pool[key]=card[key]??null;
  for(const key of ['events','rush','tokens'])pool[key]=clone(Array.isArray(card[key])?card[key]:[]);
  if(card.initialPity!=null)pool.initialPity=card.initialPity;
  if(typeof card.ended==='boolean')pool.ended=card.ended;
  pool.evidence={...clone(card.evidence||{}),manual:true,unresolvedCardId:card.id,source_sha256:card.source_sha256,file:card.file};
  // Binding a card chooses its pool, not the identity of every OCR row. Keep
  // row evidence untouched until the user explicitly saves the visible pool.
  if(pool.tail==null)edit.updatePoolWater(candidate,pool);
  if(candidate.pools[0]?.id===pool.id)candidate.initialPity=pool.initialPity;
  characterDraft=candidate;characterReviewPoolId=pool.id;
  autoReviewQueue.splice(autoReviewIndex,0,{type:'pool',id:pool.id});
  $('resultsApply').textContent='保存并继续';$('resultsSaveHint').textContent='保存并继续将确认本池当前填写的角色与出货位置。';
  renderCharacterReview(null,pool.id);
}
function renderUnresolvedPoolCards(){
  const target=$('unresolvedPoolCards');target.replaceChildren();
  const bound=new Set((characterDraft?.pools||[]).map(pool=>pool.evidence?.unresolvedCardId).filter(Boolean));
  const cards=(session?.ledger.unresolvedCards||[]).filter(card=>!bound.has(card.id));target.hidden=!cards.length;
  if(!cards.length)return;
  target.append(el('h3','有'+cards.length+'张卡片尚未确认卡池名称'),el('p','出货明细已单独保留。选择原图对应的卡池后，继续检查并保存明细。','muted small'));
  const available=edit.availableBanners(characterDraft);
  for(const card of cards){
    const block=el('section',undefined,'unresolved-pool-card');block.dataset.cardId=card.id;
    block.append(el('h4',card.bannerRaw||'卡池名称未识别'));
    const doc=(session.documents||[]).find(doc=>card.source_sha256?doc.source_sha256===card.source_sha256:doc.file===card.file);
    const source=card.evidence?.crop||card.evidence?.sourceImage||doc?.sourceImage;
    if(source)renderSourceEvidence(block,[{sourceImage:source,file:card.file||'未确认卡池的原图'}]);
    block.append(el('p','主池总抽数 '+(card.total??'未知')+' · 期末水位 '+(card.tail??'未知')+' · 武库配额 '+(card.quota??'未知'),'muted small'));
    const table=el('table'),head=el('tr');for(const title of ['类型','累计位置','角色','原文'])head.append(el('th',title));table.append(head);
    for(const [kind,events]of [['主池',card.events||[]],['加急',card.rush||[]]])for(const event of events){
      const row=el('tr');row.append(el('td',kind),el('td',kind==='主池'?event.at??'未知':'独立十连'),el('td',event.character||'未识别'),el('td',event.evidence?.raw||event.raw_text||''));table.append(row);
    }
    if((card.events||[]).length||(card.rush||[]).length){const wrap=el('div',undefined,'table-wrap');wrap.append(table);block.append(wrap);}
    else block.append(el('p','此卡片没有识别到六星出货，仍可选择卡池并填写完整记录。','muted small'));
    if(available.length){
      let selected='';const choose=button('使用所选卡池并检查明细',()=>{
        try{if(selected!=='')assignUnresolvedPoolCard(card,Number(selected));}catch(e){dialogError('characterDialogError',e.message);}
      });choose.disabled=true;
      const label=el('label',undefined,'field');label.append(el('span','这张卡片对应的卡池'),select('',[['','请选择'],...available.map(item=>[String(item.index),item.banner+' · '+item.up])],value=>{selected=value;choose.disabled=value==='';}));
      const actions=el('div',undefined,'actions');actions.append(label,choose);block.append(actions);
    }else block.append(el('p','支持的卡池均已有记录。请先检查已有卡池，这张卡片不会自动合并或重复计入。','warning'));
    target.append(block);
  }
}
function renderCharacterReview(focusEvent=null,focusPoolId=null){
  if(!characterDraft)return;
  renderInterruptionReview();renderInitialHistory();renderSummaryReview();renderManualPoolTools();renderUnresolvedPoolCards();
  const effective=effectiveCharacter(characterDraft);
  const expanded=new Set([...$('review').querySelectorAll('details')].filter(n=>n.open).map(n=>n.dataset.poolId));
  const historyStep=autoReviewQueue[autoReviewIndex]?.type==='history';
  const pools=(characterDraft.pools||[]).filter(p=>characterReviewPoolId==null||p.id===characterReviewPoolId);
  $('review').replaceChildren();characterPoolViews.clear();let focusInput=null;
  const queued=autoReviewQueue.length>0,item=autoReviewQueue[autoReviewIndex];
  $('resultsDialog').classList.toggle('queue-review',queued&&item?.type==='pool');
  $('characterEvidence').replaceChildren();queueIssueView=null;$('characterEvidence').hidden=!queued;
  $('characterIssueProgress').hidden=!queued;$('characterIssueProgress').textContent=queued?'异常项 '+(autoReviewIndex+1)+' / '+autoReviewQueue.length:'';
  if(queued&&item?.type==='info'){
    queueIssueView=el('div');$('characterEvidence').append(queueIssueView);
    renderSourceEvidence($('characterEvidence'),session.documents||[]);
  }
  if(queued&&item?.type==='links'){queueIssueView=el('div');$('characterEvidence').append(queueIssueView);}
  if(!pools.length&&!historyStep)$('review').append(el('p','未识别到角色卡池。','empty'));
  if(queued&&item?.type==='pool'&&characterReviewPoolId!=null)$('review').append(button('展开全部卡池一起修改',()=>{characterReviewPoolId=null;renderCharacterReview();}));
  if(characterDraft.quotaSummary){
    const q=characterDraft.quotaSummary,meta=el('div',undefined,'pool-meta');
    meta.append(field('全记录武库配额产出',q.Q,v=>q.Q=v));$('review').append(meta,
      el('p',`配额覆盖主池${q.N}抽、加急${q.R}次、六星${q.K6}个；此来源未提供逐池配额。`,'muted small'));
  }else if(edit.allowsMissingQuota(characterDraft)){
    const meta=el('div',undefined,'pool-meta');
    meta.append(field('补充后的全记录武库配额产出（选填）',null,value=>{
      if(value==null)delete characterDraft.quotaSummary;
      else characterDraft.quotaSummary={scope:'all-pools',Q:value};
    }));
    $('review').append(meta);
  }
  for(const p of pools){
    const evaluated=effective.pools.find(q=>q.id===p.id),excluded=!evaluated;
    const block=el('details',undefined,'pool'),summary=el('summary');
    block.dataset.poolId=String(p.id);block.open=expanded.has(String(p.id))||p.id===focusPoolId;
    if(queued&&item?.type==='pool'){block.open=true;const src=poolSource(p);
      if(src)renderSourceEvidence($('characterEvidence'),[{sourceImage:src,file:p.banner+' · 记录图'}]);
      else $('characterEvidence').append(el('p','原图当前不可用，可重新导入原截图。','warning'));
    }
    const summaryText=el('span',p.up+' · '+(p.total??'?')+' 抽 · '+(p.events||[]).length+' 个主池六星','muted');
    summary.append(el('strong',p.banner+(excluded?' · 已排除':'')),summaryText);block.append(summary);
    if(excluded)block.classList.add('is-excluded');
    const scope=el('p',undefined,'interruption-pool-note');block.append(scope);
    const initialField=field('期初水位',p.initialPity,v=>{
      edit.setInitialPity(characterDraft,p,v);refreshPoolWaterViews();renderInitialHistory();
    });
    const tailField=field('期末水位',p.tail,v=>{edit.setTail(characterDraft,p,v);refreshPoolWaterViews();renderInitialHistory();});
    characterPoolViews.set(p,{initial:initialField.querySelector('input'),tail:tailField.querySelector('input'),summary:summaryText,scope});
    const meta=el('div',undefined,'pool-meta');meta.append(field('主池总抽数',p.total,v=>{p.total=v;edit.syncTokens(p);updatePoolWater(p);}),initialField,tailField);
    if(p.id===focusPoolId)focusInput=meta.querySelector('input');
    if(p.quota!=null||!characterDraft.quotaSummary)meta.append(field('武库配额产出',p.quota,v=>p.quota=v));
    const rushLabel=el('label',undefined,'field');
    rushLabel.append(el('span','加急使用状态'),select(p.rushUsed,[['','未知'],['true','已使用'],['false','未使用']],v=>{edit.setRushUsed(p,v===''?null:v==='true');renderCharacterReview();}));meta.append(rushLabel);
    if(p.rushUsed===true)meta.append(field('用加急时主池进度（默认30）',p.rushAt??30,v=>{p.rushAt=v??30;p.rushAtSource=v==null?'confirmed-default-after-main-30':'explicit';}));block.append(meta);
    const freeField=el('label',undefined,'field');freeField.append(el('span','本池免费额度'),select(p.freeAllowance??'',[['','自动推断'],['10','10抽'],['20','20抽']],v=>{if(v==='')delete p.freeAllowance;else p.freeAllowance=Number(v);renderInitialHistory();}));meta.append(freeField);
    if(evaluated?.interruptionBefore){const option=el('option','0抽');option.value='0';freeField.querySelector('select').append(option);}
    characterPoolViews.get(p).free=freeField.querySelector('select');
    if(p.complete===false){const label=el('label',undefined,'check'),check=el('input');check.type='checkbox';
      check.onchange=()=>{p.complete=check.checked;draftChanged();};label.append(check,el('span','缺失明细已补全（不再作为不完整卡池）'));block.append(label);
    }
    const issueView=el('div',undefined,'pool-current-issues');characterPoolViews.get(p).issues=issueView;block.append(issueView);
    block.append(el('p','按本池累计抽数填写主池出货位置。','muted small'));
    const table=el('table'),head=el('tr');for(const title of ['类型','本池累计位置','角色','头像证据','操作'])head.append(el('th',title));table.append(head);
    const addRow=(event,type,index)=>{
      const row=el('tr');row.append(el('td',type));const pos=el('td');
      if(type==='主池')pos.append(field('累计抽数',event.at,v=>{event.at=v;updatePoolWater(p);}));else pos.textContent='独立十连';row.append(pos);
      const char=el('td');char.append(select(event.character,[['','未识别'],...characters.map(n=>[n,n])],v=>{event.character=v||null;event.identitySource='manual';}));row.append(char);
      const evidence=el('td'),ev=event.evidence,crop=event.crop||ev?.crop||ev?.avatarCrop;
      if(crop?.startsWith('/data/')){const a=el('a');a.href=crop;a.target='_blank';a.rel='noopener';const img=el('img');img.src=crop;img.alt='原图头像';a.append(img);evidence.append(a);}
      row.append(evidence);
      const actions=el('td');actions.append(button('移除行',()=>{(type==='主池'?p.events:p.rush).splice(index,1);if(type==='主池')updatePoolWater(p);renderCharacterReview();}));row.append(actions);table.append(row);
      if(event===focusEvent){block.open=true;focusInput=pos.querySelector('input')||char.querySelector('select');}
    };
    (p.events||[]).forEach((e,i)=>addRow(e,'主池',i));(p.rush||[]).forEach((e,i)=>addRow(e,'加急',i));
    const wrap=el('div',undefined,'table-wrap');wrap.append(table);block.append(wrap);
    const actions=el('div',undefined,'actions');
    actions.append(button('补充出货记录',()=>{
      const event={at:null,character:null,source:'main',forced:false,identitySource:'manual'};(p.events??=[]).push(event);renderCharacterReview(event);
    }));
    const addRush=button('补充加急出货',()=>{
      const event={character:null,source:'rush',forced:false,identitySource:'manual'};(p.rush??=[]).push(event);p.rushUsed=true;
      if(p.rushAt==null){p.rushAt=30;p.rushAtSource='confirmed-default-after-main-30';}
      renderCharacterReview(event);
    });
    addRush.disabled=!Number.isSafeInteger(p.total)||p.total<30||(p.rush||[]).length>=10;
    const emptyRush=button('确认加急未出',()=>{
      edit.setRushUsed(p,true);
      p.rush=[];
      renderCharacterReview();
    });
    emptyRush.classList.add('empty-rush');
    characterPoolViews.get(p).addRush=addRush;characterPoolViews.get(p).emptyRush=emptyRush;
    actions.append(addRush,emptyRush);block.append(actions);
    if(p.evidence?.manual===true)actions.append(button('移除手动补充池',()=>{
      if(edit.removeManualPool(characterDraft,p.id)){
        characterReviewPoolId=null;
        if(autoReviewQueue[autoReviewIndex]?.id===p.id&&needsInitialHistory(characterDraft)){
          autoReviewQueue[autoReviewIndex]={type:'history'};selectRoleTab(2);
          if(autoReviewQueue[autoReviewIndex+1]?.type==='history')autoReviewQueue.splice(autoReviewIndex+1,1);
        }
        renderCharacterReview();
      }
    }));
    if(Number.isSafeInteger(p.total)&&p.total>=240)actions.append(button('按总抽数补全信物节点',()=>{edit.syncTokens(p);refreshPoolWaterViews();}));
    const nodes=el('p','','muted small');
    characterPoolViews.get(p).tokens=nodes;block.append(nodes);$('review').append(block);
  }
  refreshPoolWaterViews();
  if(focusInput){focusInput.focus();focusInput.scrollIntoView?.({block:'nearest'});}
  renderDraftValidation();
}
function renderWeaponReview(){
  const target=$('weaponReview');target.replaceChildren();$('weaponScoreDetails').replaceChildren();
  if(!weaponDraft){target.append(el('p','未识别到武器数据。','empty'));return;}
  const w=weaponDraft,meta=el('div',undefined,'pool-meta');
  for(const [key,label] of [['N','武器总抽数'],['K6','六星总数'],['KU','当期专武数']]){
    meta.append(field(label,w[key],value=>{w[key]=value;renderWeaponScoreDetails();}));
  }
  target.append(meta);
  const sections=Array.isArray(w.sections)?w.sections:[];
  if(sections.length){
    const details=el('details',undefined,'method');details.append(el('summary','武器池记录 · '+sections.length+'池'));
    for(const section of sections){
      if(!section||typeof section!=='object')continue;
      const events=section.eventsNewestFirst;
      const hits=Array.isArray(events)?[...events].reverse().filter(e=>typeof e?.weapon==='string').map(e=>e.weapon+(e.isUp?'（UP）':'')).join('、'):'';
      details.append(el('p',(section.banner||'未知池')+' · '+(section.total??'未知')+'抽'+(hits?' · '+hits:''),'small'));
    }
    target.append(details);
  }
  const toggleLabel=el('label',undefined,'check'),toggle=el('input');
  toggle.type='checkbox';toggle.id='weaponProfileDraft';toggle.checked=weaponProfileDraft;
  toggle.onchange=()=>{weaponProfileDraft=toggle.checked;renderWeaponReview();draftChanged();};
  toggleLabel.append(toggle,el('span','潜能配置修正'));target.append(toggleLabel);
  const config=ui.weaponConfigForForm(w),table=el('table',undefined,'weapon-config-table');
  const allocations=el('div',undefined,'pool-meta');
  const updateConfig=()=>{w.potentialConfig=config;w.profile=null;toggle.checked=weaponProfileDraft=true;renderWeaponScoreDetails();};
  function renderAllocations(){
    allocations.replaceChildren();
    const full=config.counts[4];
    if(!(Number.isInteger(full)&&full>1&&full<=30&&config.overflowCopies>0))return;
    for(let i=0;i<full;i++){
      allocations.append(field('满潜专武'+(i+1)+'溢出份数',config.overflowByType?.[i]||null,value=>{
        const amounts=Array.from({length:full},(_,j)=>config.overflowByType?.[j]??0);
        amounts[i]=value??0;config.overflowByType=amounts;updateConfig();
      }));
    }
  }
  function updateAllocationFields(){
    const full=config.counts[4];
    if(Number.isInteger(full)&&full>1&&full<=30&&config.overflowCopies>0){
      config.overflowByType=Array.from({length:full},(_,j)=>config.overflowByType?.[j]??0);
    }else delete config.overflowByType;
    renderAllocations();
  }
  const fields=[field('总专武种类',config.totalTypes,value=>{config.totalTypes=value;updateConfig();})];
  for(let i=0;i<5;i++)fields.push(field((i+1)+'潜专武数量',config.counts[i]||null,value=>{
    config.counts[i]=value??0;if(i===4)updateAllocationFields();updateConfig();
  }));
  fields.push(field('溢出专武数量',config.overflowCopies||null,value=>{
    config.overflowCopies=value??0;updateAllocationFields();updateConfig();
  }));
  fields.push(field('亏损抽数（选填）',w.lossDraws,value=>{w.lossDraws=value;renderWeaponScoreDetails();}));
  for(let i=0;i<fields.length;i+=2){
    const row=el('tr');for(const input of fields.slice(i,i+2)){const cell=el('td');cell.append(input);row.append(cell);}table.append(row);
  }
  target.append(table,allocations,el('p','亏损抽数仅从当期专武的评分抽数中扣除。','muted small'));renderAllocations();
  weaponIssueView=el('div',undefined,'weapon-current-issues');target.append(weaponIssueView);
  renderWeaponScoreDetails();renderDraftValidation();
}
function renderWeaponScoreDetails(){
  const target=$('weaponScoreDetails');target.replaceChildren();if(!weaponDraft)return;
  const saved=session.ledger.weapon,mode=hasWeaponProfile(saved);
  if(!dialogIsCurrent()||!$('calculating').hidden||weaponProfileDraft!==mode||
    JSON.stringify(ui.makeWeaponConfirmation(weaponDraft,weaponProfileDraft))!==JSON.stringify(ui.makeWeaponConfirmation(saved,mode))){
    target.append(el('p','保存后重新评分。','muted small'));return;
  }
  for(const key of ['weaponSix','signature'])if(session.result?.axes?.[key]?.reason){
    target.append(el('p',labels[key]+'：'+displayText(session.result.axes[key].reason),'warning'));
  }
}
function validateEditedPool(p,{allowMissingQuota=false}={}){
  return edit.validatePool(p,{allowMissingQuota});
}
function applyResults(){
  if(scoreSettingPending()){dialogError('characterDialogError','正在保存评分设置，请完成后再保存识别结果。');return;}
  if(!characterDraft||!dialogIsCurrent()){dialogError('characterDialogError','记录版本已变化，请重新打开识别结果。');selectRoleTab(0);return;}
  const item=autoReviewQueue[autoReviewIndex],queued=!!item;
  const original=session.ledger.character||{pools:[]};
  const effective=effectiveCharacter(characterDraft),effectiveIds=new Set(effective.pools.map(p=>p.id));
  const changedPools=characterDraft.pools.filter(p=>JSON.stringify(p)!==JSON.stringify(original.pools?.find(q=>q.id===p.id)));
  const correctionOnly=JSON.stringify(characterDraft.interruptionCorrection)!==JSON.stringify(original.interruptionCorrection)&&changedPools.length===0;
  const poolsToSave=(queued&&item.type==='pool'?[...new Set([...changedPools,characterDraft.pools.find(p=>p.id===item.id)])].filter(Boolean):changedPools).filter(p=>effectiveIds.has(p.id));
  const characterChanged=resultsTab==='character'&&(JSON.stringify(characterDraft)!==JSON.stringify(original)||poolsToSave.length>0);
  const weaponChanged=resultsTab==='weapon'&&weaponDraft&&(JSON.stringify(weaponDraft)!==JSON.stringify(session.ledger.weapon)||weaponProfileDraft!==hasWeaponProfile(session.ledger.weapon)||item?.type==='weapon');
  const initialProblem=resultsTab==='character'&&(edit.validateInterruption(characterDraft)||validateInitialHistory()||validateSummaryEdits());
  if(initialProblem){dialogError('characterDialogError',initialProblem);selectRoleTab(0);return;}
  if(characterChanged&&characterDraft.quotaSummary&&(!Number.isSafeInteger(characterDraft.quotaSummary.Q)||characterDraft.quotaSummary.Q<0)){
    dialogError('characterDialogError','全记录武库配额须为非负整数。');selectRoleTab(0);return;
  }
  // The initial-history step can precede unresolved OCR rows. Keep their issues
  // untouched and let the following per-pool steps repair them.
  if(item?.type!=='history'){
    for(const p of poolsToSave){const problem=validateEditedPool(effective.pools.find(q=>q.id===p.id),{allowMissingQuota:edit.allowsMissingQuota(effective)});if(problem){dialogError('characterDialogError',p.banner+'：'+problem);selectRoleTab(0);return;}}
    const linkProblem=characterChanged&&!correctionOnly?edit.validateLinks(characterDraft):'';
    if(linkProblem){dialogError('characterDialogError',linkProblem);selectRoleTab(0);return;}
  }
  if(weaponChanged){const errors=ui.validateWeapon(ui.weaponForSave(weaponDraft,weaponProfileDraft),{requireProfile:weaponProfileDraft});if(errors.length){dialogError('weaponDialogError',errors.join('；'));return;}}
  for(const p of item?.type==='history'?[]:poolsToSave){
    edit.normalizePool(p);
    if(item?.type==='pool'&&p.id===item.id){
      for(const event of [...(p.events||[]),...(p.rush||[])])event.identityReviewed=true;
      p.eventReviewConfirmed=true;
    }
  }
  if(characterChanged&&characterDraft.quotaSummary?.scope==='all-pools'){
    const pools=characterDraft.pools;
    if(pools.every(p=>Number.isSafeInteger(p.total)&&p.total>=0&&typeof p.rushUsed==='boolean'&&Array.isArray(p.events)&&Array.isArray(p.rush))){
      Object.assign(characterDraft.quotaSummary,{N:pools.reduce((n,p)=>n+p.total,0),R:pools.filter(p=>p.rushUsed).length,
        K6:pools.reduce((n,p)=>n+p.events.length+p.rush.length,0)});
    }
  }
  const staleHypothesis=characterChanged&&interruptedHypothesisReason(characterDraft);
  if(characterChanged)session.ledger.character=characterDraft;
  if(staleHypothesis)session.scoringScenario={enabled:false};
  if(weaponChanged){
    weaponDraft=ui.weaponForSave(weaponDraft,weaponProfileDraft);
    weaponDraft.issues=(weaponDraft.issues||[]).filter(i=>i.code!=='weapon_pool_count_missing');
    session.ledger.weapon=weaponDraft;session.weaponReview=ui.makeWeaponConfirmation(weaponDraft,weaponProfileDraft);
  }
  const modified=characterChanged||weaponChanged;
  if(queued){
    if(modified){autoReviewDirty=true;changed(true);}
    if(item.type==='history'){
      closeReviewDialogs();autoReviewQueue=gatherReviewQueue();autoReviewIndex=0;openNextReview();
    }else advanceAutoReview();
    if(modified&&autoReviewQueue.length)refreshCommittedValidation();
  }
  else{closeReviewDialogs();if(modified)changed();}
  if(staleHypothesis)status(staleHypothesis+'，已关闭该假设，请按新记录重新设置。');
}
$('openResults').onclick=()=>openResults();
$('resultsCancel').onclick=cancelResults;$('resultsApply').onclick=applyResults;
roleTabs.forEach(([tabId],index)=>{
  const tab=$(tabId);
  tab.onclick=()=>selectRoleTab(index);
  tab.addEventListener('keydown',event=>{
    if(!['ArrowLeft','ArrowRight','Home','End'].includes(event.key))return;
    event.preventDefault();
    const next=event.key==='Home'?0:event.key==='End'?roleTabs.length-1:
      (index+(event.key==='ArrowRight'?1:-1)+roleTabs.length)%roleTabs.length;
    selectRoleTab(next,true);
  });
});
$('weaponConfigured').onclick=()=>{
  if(session?.ledger.weapon)openResults('weapon');
};
$('resultsDialog').addEventListener('cancel',event=>{event.preventDefault();cancelResults();});
$('resultsDialog').addEventListener('click',event=>{
  if(event.target!==$('resultsDialog'))return;const r=$('resultsDialog').getBoundingClientRect();
  if(event.clientX<r.left||event.clientX>r.right||event.clientY<r.top||event.clientY>r.bottom)cancelResults();
});
function setLuckRevealed(value){
  luckRevealed=!!value;$('luckContent').classList.toggle('concealed',!luckRevealed);
  $('luckContent').setAttribute('aria-hidden',String(!luckRevealed));$('luckContent').inert=!luckRevealed;
  $('radarRevealArea').classList.toggle('is-concealed',!luckRevealed);$('revealLuck').hidden=luckRevealed;
  $('exportRadar').disabled=!luckRevealed||historyDeleting||resultCaptureBusy;
}
$('revealLuck').onclick=()=>{if($('calculating').hidden&&!$('radarRevealArea').hidden)setLuckRevealed(true);};

function scoreText(value){return Number.isFinite(value)?value.toFixed(1):'—';}
function lossText(value){return Number.isFinite(value)?value.toFixed(2):'—';}
function renderResults(){
  const r=session.result;$('calculating').hidden=true;$('radar').hidden=false;$('radarRevealArea').hidden=false;$('save').disabled=historyDeleting;setLuckRevealed(false);
  const title=ui.luckTitle(r.axes);$('luckTitle').textContent=title.name;
  drawRadar(r.axes);renderPlanningHighlights(r.planning);renderPlanning(r.planning);renderScoringScenario();
  const correction=r.interruptionCorrection,notice=$('interruptionNotice');notice.hidden=!correction?.enabled;
  notice.textContent=correction?.enabled?'中断修正已启用 · 排除：'+(correction.excludedBanners||[]).join('、'):'';
}
function drawRadar(axes){
  const hypothetical=session?.result?.scoringScenario?.enabled===true,height=hypothetical?640:600;
  const ns='http://www.w3.org/2000/svg',svg=document.createElementNS(ns,'svg');svg.setAttribute('viewBox','0 0 720 '+height);svg.setAttribute('role','img');svg.setAttribute('aria-label','六维欧非雷达图，缺失项不填充');
  const add=(tag,attrs,text)=>{const n=document.createElementNS(ns,tag);for(const[k,v]of Object.entries(attrs))n.setAttribute(k,v);if(text!==undefined)n.textContent=text;svg.append(n);return n;};
  add('rect',{width:720,height,fill:'#ffffff'});const point=(i,r)=>[360+Math.sin(i*Math.PI/3)*r,285-Math.cos(i*Math.PI/3)*r];
  for(const level of [20,40,60,80,100])add('polygon',{points:Array.from({length:6},(_,i)=>point(i,level*1.9).join(',')).join(' '),fill:'none',stroke:'#cbd5c9','stroke-width':1.7});
  for(let i=0;i<6;i++){const[x,y]=point(i,190);add('line',{x1:360,y1:285,x2:x,y2:y,stroke:'#cbd5c9','stroke-width':1.7});}
  add('polygon',{points:Array.from({length:6},(_,i)=>point(i,95).join(',')).join(' '),fill:'none',stroke:'#879b88','stroke-width':2,'stroke-dasharray':'6 6'});
  const keys=Object.keys(labels),scores=keys.map(k=>axes[k]?.score);
  if(scores.every(Number.isFinite))add('polygon',{points:scores.map((s,i)=>point(i,s*1.9).join(',')).join(' '),fill:'#79ad8652',stroke:'#226953','stroke-width':4});
  scores.forEach((s,i)=>{
    if(Number.isFinite(s)){const[x,y]=point(i,s*1.9);add('circle',{cx:x,cy:y,r:6,fill:'#226953'});}
    const[x,y]=point(i,245),anchor=i===0||i===3?'middle':i<3?'start':'end';
    add('text',{x,y,fill:'#172a27','font-family':'Microsoft YaHei, sans-serif','font-size':22,'font-weight':700,'text-anchor':anchor},labels[keys[i]]);
    add('text',{x,y:y+34,fill:Number.isFinite(s)?'#226953':'#596d57','font-family':'Segoe UI, sans-serif','font-size':30,'font-weight':800,'text-anchor':anchor},scoreText(s));
  });add('text',{x:375,y:190,fill:'#586e5e','font-size':14,'font-weight':700,'font-family':'Segoe UI, sans-serif'},'50');
  if(hypothetical){
    svg.setAttribute('aria-label','假设补到保底后的六维欧非雷达图，非实际抽卡结果');
    add('text',{x:360,y:615,fill:'#8c571f','font-family':'Microsoft YaHei, sans-serif','font-size':18,'font-weight':700,'text-anchor':'middle'},'假设补到保底 · 非实际抽卡结果');
  }
  $('radar').replaceChildren(svg);
}
function renderPlanningHighlights(planning){
  const target=$('planningHighlights'),list=$('planningTopPools'),o=ui.planningOverview(planning);target.replaceChildren();list.replaceChildren();$('planningBreakdown').hidden=false;const score=el('div',undefined,'planning-score');
  if(o.title)target.append(el('p',o.title,'rating-title'));
  const amount=el('span',undefined,'planning-score-amount');
  amount.append(el('strong',o.total==null?'数据不足':o.total.toFixed(2),'planning-score-value'+(o.total==null?' is-unavailable':'')));
  if(o.total!=null)amount.append(el('span','抽','planning-score-unit'));
  score.append(el('span','资源损耗','planning-score-label'),amount);
  if(!o.complete)score.append(el('p','已算 '+o.count+'/'+o.totalPools+' 池 · 数据不完整','muted small'));target.append(score);
  if(o.exemptedPools)target.append(el('p','已豁免 '+o.exemptedPools+' 池，共 '+lossText(o.exemptedLossSum)+' 抽；可在“查看全部”中取消。','planning-exemption-note small'));
  const b=ui.planningOpportunityOverview(planning),op=el('div',undefined,'opportunity-score');
  const opportunityAmount=el('span',undefined,'planning-score-amount');
  opportunityAmount.append(el('strong',b.total==null?'数据不足':b.total.toFixed(2),'planning-score-value'+(b.total==null?' is-unavailable':'')));
  if(b.total!=null)opportunityAmount.append(el('span','抽','planning-score-unit'));
  op.append(el('span','机会估值','planning-score-label'),opportunityAmount);
  if(!b.complete)op.append(el('p','已算 '+b.count+'/'+b.totalPools+' 池 · 数据不完整','muted small'));
  target.append(op);
  if(!o.topPools.length){list.append(el('p',o.count?'已计算卡池没有正亏损。':'暂无可计算的亏损明细。','empty'));return;}
  o.topPools.forEach((row,index)=>{
    const card=el('div',undefined,'deduction-row'),details=button('详情',()=>openPlanningDetail(row));
    details.setAttribute('aria-haspopup','dialog');details.setAttribute('aria-label',(row.banner||row.id)+'亏损详情');
    const loss=el('span','亏 '+ui.planningCountedLoss(row).toFixed(2)+' ','deduction-score loss-positive');loss.append(el('span','抽','planning-score-unit'));
    card.append(el('strong',(index+1)+'. '+(row.banner||row.id),'deduction-title'),loss,details);list.append(card);
  });
}
function renderPlanningViews(){
  renderPlanningHighlights(session.result.planning);renderPlanning(session.result.planning);
  if($('planningDetailDialog').open){const row=session.result.planning?.pools?.find(p=>p.id===planningDetailPoolId);if(row)openPlanningDetail(row);}
}
function syncOpenScoreRevision(oldRevision,{poolId,checked}={}){
  if(hypothesis?.id===session.id&&hypothesis.revision===oldRevision){
    hypothesis.revision=revision;hypothesis.candidate=clone(session);hypothesis.request++;hypothesis.pending=false;
    const savedPlan=session.result?.scoringScenario?.plan;
    if(session.result?.scoringScenario?.enabled&&savedPlan?.poolId===hypothesis.poolId&&savedPlan.mode===hypothesis.mode)hypothesis.plan=savedPlan;
    renderHypothesisActivation();
    if(!hypothesis.plan&&$('hypothesisDialog').open)requestHypothesisPlan();
  }
  if(!characterDraft||dialogOrigin?.id!==session.id||dialogOrigin.revision!==oldRevision)return;
  const p=characterDraft.pools?.find(p=>p.id===poolId);if(p)p.planningExempt=checked;
  // The opening snapshot changes by this saved flag alone: unrelated draft edits
  // remain dirty and are never replaced by the scoring response.
  if(draftOpeningSignature){const opening=JSON.parse(draftOpeningSignature),original=opening[0]?.pools?.find(p=>p.id===poolId);if(original)original.planningExempt=checked;draftOpeningSignature=JSON.stringify(opening);}
  dialogOrigin.revision=revision;draftChanged(true);
}
async function setPlanningExemption(poolId,checked){
  if(!session||scoreSettingPending()||busy||restoring||historyDeleting||!$('calculating').hidden)return;
  const pool=session.ledger.character?.pools?.find(p=>p.id===poolId),row=session.result.planning?.pools?.find(p=>p.id===poolId);
  if(!pool||!row||(checked&&!(row.status==='ok'&&Number.isFinite(row.localLoss)&&row.localLoss>0)))return;
  if((pool.planningExempt===true)===checked)return;
  const transaction={id:session.id,revision,request:++requestId,poolId,checked},candidate=clone(session);
  candidate.revision=revision+1;candidate.ledger.character.pools.find(p=>p.id===poolId).planningExempt=checked;
  planningExemptionRequest=transaction;planningExemptionError=null;clearTimeout(timer);timer=null;
  updateHistoryControls();$('save').disabled=true;renderPlanningViews();
  const isCurrent=()=>planningExemptionRequest===transaction&&session?.id===transaction.id&&revision===transaction.revision&&requestId===transaction.request;
  try{
    const updated=await api('/api/score',{session:candidate});if(!isCurrent())return;
    if(updated?.id!==transaction.id||updated.revision!==candidate.revision||!updated.result?.planning||
      updated.ledger?.character?.pools?.find(p=>p.id===poolId)?.planningExempt!==checked)throw Error('服务未返回已保存的豁免结果，请重新打开记录确认。');
    session=updated;revision=updated.revision;planningExemptionRequest=null;
    syncOpenScoreRevision(transaction.revision,{poolId,checked});
    if(!characterDraft)renderLedgerIssues();
    renderPlanningViews();updateHistoryControls();$('save').disabled=false;refreshHistory();
  }catch(e){
    if(!isCurrent())return;planningExemptionRequest=null;planningExemptionError={poolId,message:'豁免保存失败：'+displayText(e.message)+' 当前仍保留原结果，可重试。'};
    renderPlanningViews();updateHistoryControls();$('save').disabled=false;if(!$('planningDetailDialog').open)error(planningExemptionError.message);
  }
}
function openPlanningDetail(row){
    row=session.result?.planning?.pools?.find(p=>p.id===row.id)||row;planningDetailPoolId=row.id;
    renderScoringScenario();
    const counted=ui.planningCountedLoss(row),card=$('planningDetailContent');card.replaceChildren();$('planningDetailTitle').textContent=(row.banner||row.id)+' · 资源损耗 '+(Number.isFinite(counted)?counted.toFixed(2)+' 抽':'数据不足');
    const p=effectiveCharacter(session.ledger.character)?.pools?.find(p=>p.id===row.id),anchor=row.anchor;
    const scenarioPlan=session.result?.scoringScenario?.enabled===true&&session.result.scoringScenario.plan?.poolId===row.id?session.result.scoringScenario.plan:null;
    if(scenarioPlan){
      card.append(el('p','资源损耗按假设补抽后的结果计算。','scenario-detail-note'));
      card.append(el('p','假设新增 '+scenarioPlan.addedDraws+' 抽：'+(scenarioPlan.events||[]).map(event=>'第'+event.at+'抽 '+(event.character||session.scoringScenario?.choices?.[event.at]||'六星')+(event.forced?'（首UP保底）':'')).join('；'),'muted small'));
    }
    const exemption=el('div',undefined,'planning-exemption'),choice=el('label',undefined,'check'),input=el('input');input.type='checkbox';
    const pending=planningExemptionRequest?.poolId===row.id,exempt=p?.planningExempt===true||row.planningExempt===true;
    input.checked=pending?planningExemptionRequest.checked:exempt;
    input.disabled=!p||scoreSettingPending()||busy||restoring||historyDeleting||!$('calculating').hidden||(!exempt&&!(row.status==='ok'&&Number.isFinite(row.localLoss)&&row.localLoss>0));
    input.onchange=()=>setPlanningExemption(row.id,input.checked);choice.append(input,el('span','豁免此项亏损'));exemption.append(choice,
      el('p','豁免后，本池正亏损不计入资源损耗合计和称号；可随时取消。','muted small'));
    exemption.append(el('p','原亏损 '+lossText(row.localLoss)+' 抽 · 本次计入 '+(counted==null?'数据不足':lossText(counted)+' 抽')+(exempt?' · 已选择豁免'+(row.exemptedLoss>0?'（已豁免 '+lossText(row.exemptedLoss)+' 抽）':'（当前未免除亏损）'):''),'planning-exemption-note small'));
    if(pending)exemption.append(el('p','正在保存…','muted small'));
    if(planningExemptionError?.poolId===row.id)exemption.append(el('p',planningExemptionError.message,'error small'));
    if(!exempt&&input.disabled&&!planningExemptionRequest)exemption.append(el('p','仅已完成计算的正亏损可选择豁免。','muted small'));
    card.append(exemption);
    const anchorName=anchor?.kind==='new-limited'?'New限定「'+anchor.character+'」'+(anchor.source==='rush'?'（加急）':''):anchor?.source==='token'?'UP信物':anchor?.source==='rush'?'加急UP':'当期UP';
    card.append(el('p',anchor?'以第'+anchor.at+'抽的'+anchorName+'为停点参照。':row.status==='partial'?'有效收获停点存在缺项，未猜填。':'本池未获得有效收获，参照为用完免费抽后停手。','muted small'));
    if(row.stopRule==='complete-free-allowance')card.append(el('p','免费额度内出货，理想停点仍为用完本池'+row.freeAllowance+'抽免费额度。','muted small'));
    const dl=el('dl'),items=[
      ['实际 / 理想停点',(row.actual?.stop??row.total)+' / '+(row.idealStop??'—')+' 抽'],
      ['免费额度',(row.freeAllowance??'—')+' 抽'],
      ['期初 / 实际期末 / 理想水位',(p?.initialPity??'—')+' / '+(row.actual?.pity??'—')+' / '+(row.reference?.pity??'—')],
      ['永久投入差',lossText(row.permanentDelta)+' 抽'],['水位价值差',lossText(row.waterValueDelta)+' 抽'],['赠券价值差',lossText(row.rewardValueDelta)+' 抽']
    ];
    if(row.missingPity>0){items.splice(3,0,['少积累水位',row.missingPity+' 抽水位']);card.append(el('p',row.reason||'参考水位仅用于规划估值，不代表实际补抽结果。','muted small'));}
    for(const[label,value]of items)dl.append(el('dt',label),el('dd',value));card.append(dl);
    if(Number.isFinite(row.localLoss))card.append(el('p',lossText(row.permanentDelta)+' − ('+lossText(row.waterValueDelta)+') − ('+lossText(row.rewardValueDelta)+') ≈ '+row.localLoss.toFixed(2)+' 抽','deduction-formula'));
    for(const warning of row.warnings||[])card.append(el('p',issueText(warning),'muted small'));
    const b=row.opportunity;card.append(el('h3','机会估值 · '+(b?.status==='ok'&&Number.isFinite(b.value)?b.value.toFixed(2)+' 抽':'数据不足')));
    if(p?.events?.length)card.append(el('p','实际主池出货：'+p.events.map(e=>'第'+e.at+'抽 '+e.character+(e.forced?'（120保底）':'')).join('；'),'muted small'));
    const src=poolSource(p);if(src)renderSourceEvidence(card,[{sourceImage:src,file:(row.banner||row.id)+' · 记录图'}]);else card.append(el('p','此记录的原图当前不可用。','muted small'));
    if(!$('planningDetailDialog').open)openDialog('planningDetailDialog');
}
function renderPlanning(planning){
  const target=$('planning');target.replaceChildren();if(!planning?.pools?.length){target.append(el('p','没有可计算的角色记录。','empty'));return;}
  const o=ui.planningOverview(planning),total=el('p',undefined,'planning-total');
  total.append(el('strong','亏损'+(o.complete?'合计':'部分合计')+'：'+(o.total==null?'数据不足':o.total.toFixed(2)+' 抽')),el('span','（已计 '+o.count+'/'+o.totalPools+' 池）','muted small'));target.append(total);
  const b=ui.planningOpportunityOverview(planning);target.append(el('p','机会估值'+(b.complete?'合计':'部分合计')+'：'+(b.total==null?'数据不足':b.total.toFixed(2)+' 抽')+'（已计 '+b.count+'/'+b.totalPools+' 池）','muted small'));
  const table=el('table'),head=el('tr');for(const name of ['卡池','实际 / 理想停点','漏用免费抽','资源损耗（抽）','机会估值（抽）','计算依据'])head.append(el('th',name));table.append(head);
  for(const row of planning.pools){
    const tr=el('tr');tr.append(el('td',row.banner||row.id||'卡池'),el('td',(row.actual?.stop??row.total??'—')+' / '+(row.idealStop??'—')),el('td',row.missedFree??'—'));
    const value=ui.planningCountedLoss(row),loss=el('td',Number.isFinite(value)?value.toFixed(2):'数据不足','loss-number '+(value>0?'loss-positive':'loss-negative'));
    if(row.planningExempt===true)loss.append(el('span',row.exemptedLoss>0?'已豁免':'已选择豁免','planning-exempt-badge'));tr.append(loss);
    tr.append(el('td',row.opportunity?.status==='ok'&&Number.isFinite(row.opportunity.value)?row.opportunity.value.toFixed(2):'数据不足','loss-number'));
    const detail=el('td',undefined,'loss-detail'),reason=row.reason||row.message||(row.warnings||[]).map(issueText).join('；');
    detail.append(el('span',displayText(reason)||'永久投入差 '+scoreText(row.permanentDelta)+' − 水位价值差 '+scoreText(row.waterValueDelta)+' − 奖励价值差 '+scoreText(row.rewardValueDelta)));
    if(row.status==='provisional')detail.append(el('span',' · 进行中暂算'));detail.append(button('详情',()=>openPlanningDetail(row)));tr.append(detail);table.append(tr);
  }
  const wrap=el('div',undefined,'table-wrap');wrap.append(table);target.append(wrap);
  for(const w of planning.warnings||[])target.append(el('p',issueText(w),'muted small'));
}
function closeViewDialog(id){
  if(id==='hypothesisDialog'){closeHypothesis();return;}
  if(id==='historyDialog'){if(historyDeleting||restoring)return;cancelHistoryDeleteConfirmation();}
  $(id).close();
}
for(const node of document.querySelectorAll('[data-close-dialog]'))node.onclick=()=>closeViewDialog(node.getAttribute('data-close-dialog'));
for(const id of viewDialogs){
  $(id).addEventListener('cancel',event=>{event.preventDefault();closeViewDialog(id);});
  $(id).addEventListener('click',event=>{if(event.target!==$(id))return;const r=$(id).getBoundingClientRect();if(event.clientX<r.left||event.clientX>r.right||event.clientY<r.top||event.clientY>r.bottom)closeViewDialog(id);});
}
$('openHistory').onclick=()=>{if(historyDeleting||restoring)return;cancelHistoryDeleteConfirmation();openDialog('historyDialog');refreshHistory();};
$('openAllPlanning').onclick=()=>{openDialog('planningAllDialog');};
function download(blob,name){const url=URL.createObjectURL(blob),a=el('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}
$('save').onclick=()=>{if(session&&!scoreSettingPending())download(new Blob([JSON.stringify(session,null,2)],{type:'application/json'}),'抽卡评分记录.json');};
function resultCaptureAvailable(){
  return !!session?.result&&luckRevealed&&!busy&&!historyDeleting&&!restoring&&!scoreSettingPending()&&$('calculating').hidden;
}
function resultSnapshot(){
  const source=$('resultCapture'),bounds=source.getBoundingClientRect();
  if(!(bounds.width>0&&bounds.height>0))throw Error('评分结果尚未显示，请稍后重试。');
  const stage=el('div'),layout=source.cloneNode(true);
  stage.setAttribute('aria-hidden','true');stage.inert=true;
  stage.style.cssText='position:fixed;left:-20000px;top:0;pointer-events:none;';
  layout.classList.add('result-snapshot-layout');stage.append(layout);document.body.append(stage);
  // Measure a fixed landscape layout offscreen; the on-screen page keeps its
  // responsive layout. Then inline resolved styles for asset-free rendering.
  const copyStyle=(original,copy)=>{
    if(original.nodeType!==1)return;
    const style=getComputedStyle(original);
    for(const property of style)copy.style.setProperty(property,style.getPropertyValue(property));
    copy.style.setProperty('animation','none');copy.style.setProperty('transition','none');
    for(let i=0;i<original.children.length;i++)copyStyle(original.children[i],copy.children[i]);
  };
  try{
    const size=layout.getBoundingClientRect(),snapshot=layout.cloneNode(true);
    copyStyle(layout,snapshot);
    snapshot.style.setProperty('width',size.width+'px');
    snapshot.style.setProperty('height',size.height+'px');
    snapshot.style.setProperty('margin','0');
    snapshot.style.setProperty('background-color',getComputedStyle(document.body).backgroundColor);
    return {snapshot,width:Math.ceil(size.width),height:Math.ceil(size.height)};
  }finally{stage.remove();}
}
async function resultSnapshotPNG(capture,stillCurrent){
  await document.fonts?.ready;
  if(!stillCurrent())throw Error('评分结果已变化，请重新点击保存结果。');
  const {snapshot,width,height}=capture;
  const wrapper=document.createElementNS('http://www.w3.org/1999/xhtml','div');
  wrapper.append(snapshot);
  const markup=new XMLSerializer().serializeToString(wrapper);
  const svg='<svg xmlns="http://www.w3.org/2000/svg" width="'+width+'" height="'+height+'"><foreignObject width="100%" height="100%">'+markup+'</foreignObject></svg>';
  const image=new Image();
  await new Promise((resolve,reject)=>{image.onload=resolve;image.onerror=()=>reject(Error('结果图片生成失败，请重试。'));image.src='data:image/svg+xml;charset=utf-8,'+encodeURIComponent(svg);});
  if(!stillCurrent())throw Error('评分结果已变化，请重新点击保存结果。');
  const scale=Math.min(3,Math.max(2,window.devicePixelRatio||1),8192/Math.max(width,height));
  const canvas=document.createElement('canvas');
  canvas.width=Math.ceil(width*scale);canvas.height=Math.ceil(height*scale);
  const context=canvas.getContext('2d');
  if(!context)throw Error('当前浏览器无法生成结果图片。');
  context.scale(scale,scale);context.drawImage(image,0,0,width,height);
  return new Promise((resolve,reject)=>canvas.toBlob(blob=>{
    if(!stillCurrent())reject(Error('评分结果已变化，请重新点击保存结果。'));
    else if(blob)resolve(blob);else reject(Error('结果图片生成失败，请重试。'));
  },'image/png'));
}
$('exportRadar').onclick=async()=>{
  if(resultCaptureBusy||!resultCaptureAvailable())return;
  if(!navigator.clipboard?.write||typeof ClipboardItem!=='function'){
    error('当前浏览器无法复制图片到剪贴板，请在支持图片剪贴板的本机浏览器中打开。');return;
  }
  const record=session,recordRevision=revision,result=session.result;
  const stillCurrent=()=>session===record&&revision===recordRevision&&session.result===result&&resultCaptureAvailable();
  const button=$('exportRadar');resultCaptureBusy=true;button.disabled=true;button.textContent='正在复制…';error('');
  try{
    const png=resultSnapshotPNG(resultSnapshot(),stillCurrent);
    // Invoke write during this click; the promised PNG preserves user activation
    // while fonts and SVG rasterization finish asynchronously.
    png.catch(()=>{});
    await navigator.clipboard.write([new ClipboardItem({'image/png':png})]);
    status('结果图片已复制到剪贴板，可直接粘贴。');
  }catch(e){error(e.name==='NotAllowedError'?'未能写入剪贴板，请允许浏览器访问剪贴板后重试。':e.message||'复制结果失败，请重试。');}
  finally{resultCaptureBusy=false;button.textContent='保存结果';button.disabled=!resultCaptureAvailable();}
};
function restoreRecordName(value,index){
  return typeof value?.displayName==='string'&&value.displayName.trim()?value.displayName:
    (Array.isArray(value?.documents)?value.documents.map(d=>typeof d?.file==='string'?d.file:'').filter(Boolean).join(' / '):'')||'第'+(index+1)+'份记录';
}
function restoreSessions(value){
  const collection=value?.schemaVersion==='gacha-rating-collection-v1',records=collection?value.sessions:[value];
  if(!Array.isArray(records)||!records.length||records.length>12)throw Error('记录集合须包含1—12份独立记录。');
  for(const [index,record]of records.entries()){
    if(!record||record.schemaVersion!=='gacha-rating-session-v1'||!Array.isArray(record.documents)||!record.documents.length||record.documents.some(d=>!d||typeof d!=='object'||Array.isArray(d)))
      throw Error(restoreRecordName(record,index)+'：不是有效的评分记录；本次尚未导入任何记录。');
  }
  return records;
}
$('restore').onclick=()=>{if(!busy&&!historyDeleting&&!restoring&&!scoreSettingPending())$('restoreFile').click();};
$('restoreFile').onchange=async e=>{
  if(busy||historyDeleting||restoring||scoreSettingPending())return;
  let started=false;
  try{const file=e.target.files[0];if(!file)return;if(file.size>64*1024*1024)throw Error('记录集合超过64 MB，请分批导入。');
    restoring=true;started=true;navigationId++;updateHistoryControls();error('');
    status('正在校验保存的记录…',true);
    const value=JSON.parse(await file.text()),collection=value?.schemaVersion==='gacha-rating-collection-v1';
    if(!collection&&file.size>8*1024*1024)throw Error('记录文件过大。');
    const records=restoreSessions(value),restored=[],failures=[];
    for(const [index,record]of records.entries()){
      status('正在恢复 '+(index+1)+'/'+records.length+'：'+restoreRecordName(record,index),true);
      try{restored.push(await api('/api/restore',record));}
      catch(e){failures.push(restoreRecordName(record,index)+'：'+displayText(e.message));}
    }
    if(restored.length)await loadSession(restored[0]);
    const summary=collection?'已恢复 '+restored.length+'/'+records.length+' 份独立记录，'+failures.length+' 份失败。可在本机历史记录中打开。':restored.length?'记录已恢复并按当前算法重算。':'记录恢复失败。';
    $('historyDeleteFeedback').hidden=false;$('historyDeleteFeedback').textContent=summary+(failures.length?'\n'+failures.join('\n')+'\n成功记录已保留；重试时只导入失败的记录。':'');
    $('historyDeleteFeedback').className='history-feedback small'+(failures.length?' has-error':'');
    status(summary);error(failures.join('\n'));
  }catch(e){error(e.message);status('');}finally{
    restoring=false;e.target.value='';updateHistoryControls();
    if(started){if(session&&$('calculating').hidden){$('save').disabled=false;$('exportRadar').disabled=!luckRevealed;}await refreshHistory();}
  }
};
function updateHistoryControls(){
  const count=historySelected.size,confirming=!$('historyDeleteConfirmation').hidden,locked=historyDeleting||restoring||confirming;
  $('historySelectionCount').textContent='共'+historyRows.length+'份，已选'+count+'份';
  $('historySelectAll').checked=!!historyRows.length&&count===historyRows.length;
  $('historySelectAll').indeterminate=count>0&&count<historyRows.length;
  $('historySelectAll').disabled=locked||!historyRows.length;
  $('historySelectAllText').textContent=$('historySelectAll').checked?'取消全选':'全选';
  $('historyDelete').textContent='删除选中（'+count+'）';$('historyDelete').disabled=!count||busy||restoring||locked||scoreSettingPending();
  $('historyDeleteConfirm').disabled=historyDeleting||busy||restoring||scoreSettingPending();
  $('historyDeleteCancel').disabled=historyDeleting;
  $('restore').disabled=busy||historyDeleting||restoring||scoreSettingPending();
  for(const node of $('history').querySelectorAll('input'))node.disabled=locked;
  for(const node of $('history').querySelectorAll('button'))node.disabled=locked;
  for(const node of document.querySelectorAll('[data-close-dialog]'))if(node.getAttribute('data-close-dialog')==='historyDialog')node.disabled=historyDeleting||restoring;
  $('import').disabled=busy||historyDeleting||restoring||scoreSettingPending()||!files.length;$('images').disabled=historyDeleting||restoring||scoreSettingPending();
  if(historyDeleting||restoring){$('save').disabled=true;$('exportRadar').disabled=true;}
  renderReviewActions();renderScoringScenario();if(hypothesis)renderHypothesisActivation();
}
function renderHistory(){
  $('history').replaceChildren();
  if(!historyRows.length)$('history').append(el('p','暂无本机记录。','empty'));
  for(const item of historyRows){
    const row=el('div',undefined,'history-row'),label=el('label',undefined,'history-select'),check=el('input');
    check.type='checkbox';check.checked=historySelected.has(item.id);check.dataset.sessionId=item.id;check.setAttribute('aria-label','选择记录：'+item.name);
    check.onchange=()=>{if(historyDeleting||restoring||!$('historyDeleteConfirmation').hidden)return;check.checked?historySelected.add(item.id):historySelected.delete(item.id);updateHistoryControls();};
    label.append(check);const open=button(item.name,()=>openSavedSession(item.id));
    open.append(el('small',new Date(item.updatedAt*1000).toLocaleString('zh-CN')));row.append(label,open);$('history').append(row);
  }
  updateHistoryControls();
}
$('historySelectAll').onchange=()=>{
  if(historyDeleting||restoring||!$('historyDeleteConfirmation').hidden)return;
  historySelected=$('historySelectAll').checked?new Set(historyRows.map(row=>row.id)):new Set();renderHistory();
};
function cancelHistoryDeleteConfirmation(){
  if(historyDeleting)return;historyDeleteIds=[];$('historyDeleteConfirmation').hidden=true;updateHistoryControls();
}
$('historyDeleteCancel').onclick=cancelHistoryDeleteConfirmation;
$('historyDelete').onclick=()=>{
  if(historyDeleting||busy||restoring||scoreSettingPending())return;
  historyDeleteIds=historyRows.filter(row=>historySelected.has(row.id)).map(row=>row.id);if(!historyDeleteIds.length)return;
  if(historyDeleteIds.length>1000){historyDeleteIds=[];$('historyDeleteFeedback').hidden=false;$('historyDeleteFeedback').className='history-feedback small has-error';$('historyDeleteFeedback').textContent='一次最多删除1000份记录，请分批勾选后删除。';return;}
  $('historyDeleteTitle').textContent='确认删除这'+historyDeleteIds.length+'份本机记录？';
  $('historyDeleteNames').replaceChildren(...historyRows.filter(row=>historySelected.has(row.id)).map(row=>el('li',row.name)));
  $('historyDeleteConfirmation').hidden=false;$('historyDeleteFeedback').hidden=true;updateHistoryControls();$('historyDeleteCancel').focus();
};
function clearDeletedCurrentRecord(){
  planningExemptionRequest=null;planningExemptionError=null;planningDetailPoolId=null;scoringScenarioRequest=null;
  requestId++;navigationId++;revision++;clearTimeout(timer);timer=null;resetAutoReview();closeReviewDialogs();session=null;
  for(const id of viewDialogs)if(id!=='historyDialog'&&$(id).open)$(id).close();
  $('workspace').hidden=true;$('recordTitle').textContent='识别结果';
  for(const id of ['currentGlobalIssues','planning','planningHighlights','planningTopPools','planningDetailContent','radar','luckTitle','weaponReview','weaponScoreDetails','scoringScenario'])$(id).replaceChildren();
  $('planningBreakdown').hidden=true;$('calculating').hidden=true;$('radarRevealArea').hidden=true;
  setLuckRevealed(false);$('save').disabled=true;renderReviewActions();error('');status('');
}
$('historyDeleteConfirm').onclick=async()=>{
  if(historyDeleting||busy||restoring||scoreSettingPending()||!historyDeleteIds.length)return;
  const ids=[...historyDeleteIds],deletingCurrent=ids.includes(session?.id),resumeScore=deletingCurrent&&!$('calculating').hidden;
  historyDeleting=true;navigationId++;historyRequestId++;
  if(deletingCurrent){requestId++;clearTimeout(timer);timer=null;}
  $('historyDeleteFeedback').hidden=false;$('historyDeleteFeedback').textContent='正在删除'+ids.length+'份记录…';updateHistoryControls();
  try{
    const result=await api('/api/sessions/delete',{ids});
    if(!Array.isArray(result.deleted)||!Array.isArray(result.missing)||!Array.isArray(result.failed))throw Error('服务没有返回删除结果，请刷新列表确认。');
    const selected=new Set(ids),deleted=result.deleted.filter(id=>selected.has(id)),missing=result.missing.filter(id=>selected.has(id)),removed=new Set([...deleted,...missing]);
    const failed=ids.filter(id=>!removed.has(id));
    for(const id of removed)deletedRecordIds.add(id);
    historyRows=historyRows.filter(row=>!removed.has(row.id));historySelected=new Set(failed);
    if(session&&removed.has(session.id))clearDeletedCurrentRecord();
    const names=new Map(historyRows.map(row=>[row.id,row.name]));
    const failureText=failed.map(id=>(names.get(id)||id)+'：'+displayText(result.failed.find(item=>item.id===id)?.error||'未能删除，请重试。'));
    $('historyDeleteFeedback').textContent=['已删除'+deleted.length+'份',missing.length?'已不存在'+missing.length+'份':'',failed.length?'删除失败'+failed.length+'份，已保留勾选，可重试。':''].filter(Boolean).join('；')+(failureText.length?'\n'+failureText.join('\n'):'');
    $('historyDeleteFeedback').className='history-feedback small'+(failed.length?' has-error':'');
  }catch(e){
    $('historyDeleteFeedback').textContent='删除未完成：'+displayText(e.message)+' 勾选项已保留，可重试。';$('historyDeleteFeedback').className='history-feedback small has-error';
  }finally{
    historyDeleting=false;historyDeleteIds=[];$('historyDeleteConfirmation').hidden=true;renderHistory();
    if(session&&$('calculating').hidden){$('save').disabled=false;$('exportRadar').disabled=!luckRevealed;}
    await refreshHistory();
    if(resumeScore&&session)calculate(false);
  }
};
async function refreshHistory(){
  if(historyDeleting)return false;const request=++historyRequestId;
  try{
    const rows=await api('/api/sessions');if(request!==historyRequestId||historyDeleting)return false;
    historyRows=rows.filter(row=>!deletedRecordIds.has(row.id));const available=new Set(historyRows.map(row=>row.id));historySelected=new Set([...historySelected].filter(id=>available.has(id)));renderHistory();return true;
  }catch(e){if(request===historyRequestId){$('historyDeleteFeedback').hidden=false;$('historyDeleteFeedback').textContent='读取历史失败：'+displayText(e.message);updateHistoryControls();}return false;}
}
(async()=>{try{const config=await api('/api/config');token=config.token;planningVersion=typeof config.planningVersion==='string'?config.planningVersion:'';characterVersion=typeof config.characterVersion==='string'?config.characterVersion:'';weaponVersion=typeof config.weaponVersion==='string'?config.weaponVersion:'';recognitionVersion=typeof config.recognitionVersion==='string'?config.recognitionVersion:'';scoringScenarioVersion=typeof config.scoringScenarioVersion==='string'?config.scoringScenarioVersion:'';interruptionVersion=typeof config.interruptionVersion==='string'?config.interruptionVersion:'';await refreshHistory();}catch(e){error('本地服务未连接：'+e.message);}})();

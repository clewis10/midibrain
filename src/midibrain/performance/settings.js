/* One commit boundary for all configuration editors. Live amounts stay immediate. */
let settingsSaving=false;
document.addEventListener('DOMContentLoaded',()=>{
 const button=document.getElementById('restartRuntime');
 if(!button)return;
 button.onclick=async()=>{
  if(settingsSaving||hasSettingsEdits()){document.getElementById('notice').textContent='Save or discard edits before restarting.';return;}
  button.disabled=true;document.getElementById('notice').textContent='Restarting runtime…';
  let prior;
  try{const r=await fetch('/api/restart',{method:'POST'});const data=await r.json();if(!r.ok)throw new Error(data.detail||'Restart failed');prior=data.instance_id;}
  catch(error){document.getElementById('notice').textContent=error.message;button.disabled=false;return;}
  const deadline=Date.now()+30000;
  while(Date.now()<deadline){
   await new Promise(resolve=>setTimeout(resolve,500));
   try{const r=await fetch('/api/status',{cache:'no-store',signal:AbortSignal.timeout(2000)});if(r.ok){const s=await r.json();if(s.instance_id&&s.instance_id!==prior){location.reload();return;}}}catch{}
  }
  document.getElementById('notice').textContent='Runtime has not returned yet. Refresh to check its status.';button.disabled=false;
 };
});
function hasSettingsEdits(){return banksDirty||patchbayDirty||performanceDirty;}
function updateSettingsStatus(banks,routes){
 const node=document.getElementById('settingsStatus');
 node.textContent=settingsSaving?'Saving…':hasSettingsEdits()?'Unsaved edits':banks.staged||routes.restart_required?'Saved · restart runtime to activate':'Edits stay in draft until saved';
 document.getElementById('discardSettings').disabled=settingsSaving||!hasSettingsEdits();
}
async function saveSettings(){
 if(settingsSaving||!bankDraft||!patchbayDraft)return;
 for(const input of document.querySelectorAll('[data-layout-count]'))input.commitLayout();
 const invalid=[...document.querySelectorAll('main input')].find(input=>!input.disabled&&!input.checkValidity());
 if(invalid){document.getElementById('notice').textContent='Correct '+(invalid.getAttribute('aria-label')||'invalid fields')+' before saving.';return;}
 const edits={};if(banksDirty||!bankState.native)edits.banks=structuredClone(bankDraft);if(patchbayDirty)edits.routing=structuredClone(patchbayDraft);if(performanceDirty)edits.performance=structuredClone(performanceDraft);
 settingsSaving=true;document.querySelector('main').inert=true;document.getElementById('save').disabled=true;document.getElementById('discardSettings').disabled=true;
 try{
  const response=await fetch('/api/settings',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(edits)});const result=await response.json();
  if(!response.ok)throw new Error(typeof result.detail==='string'?result.detail:JSON.stringify(result.detail));
  banksDirty=patchbayDirty=performanceDirty=false;bankRevision++;patchbayRevision++;performanceSignature='';document.getElementById('performanceDraftStatus').textContent='';
  document.getElementById('notice').textContent=result.demo?'Applied in simulation · no hardware profile saved.':result.restart_required?'Settings saved. Restart the runtime to activate device, bank, routing and related MOD changes.':'Settings saved and active.';
 }catch(error){document.getElementById('notice').textContent=error.message;}
 finally{settingsSaving=false;document.querySelector('main').inert=false;}
}
function discardSettings(){
 if(settingsSaving)return;
 banksDirty=patchbayDirty=performanceDirty=false;bankRevision++;patchbayRevision++;
 bankDraft=structuredClone(bankState.draft);patchbayDraft=structuredClone(routing.patchbay);performanceDraft=performanceState?.native?structuredClone(performanceState.draft_config||performanceState.config):null;
 rebuildBanks();buildPatchbay();if(performanceDraft)buildPerformance();document.getElementById('performanceDraftStatus').textContent='';
 document.getElementById('notice').textContent='Unsaved edits discarded.';
}
window.addEventListener('beforeunload',event=>{if(hasSettingsEdits()){event.preventDefault();event.returnValue='';}});

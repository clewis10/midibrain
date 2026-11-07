/* Workspace shell owns navigation geometry only; MIDI drafts stay in their editors. */
let sidebarSignature='';
function closeNavigation(){document.getElementById('appShell').classList.remove('sidebar-open');document.getElementById('sidebarScrim').hidden=true;updateNavigationState();}
function updateNavigationState(){const shell=document.getElementById('appShell');const open=innerWidth<=600?shell.classList.contains('sidebar-open'):innerWidth<=1100?shell.classList.contains('sidebar-expanded'):!shell.classList.contains('sidebar-collapsed');document.getElementById('toggleSidebar').setAttribute('aria-expanded',String(open));document.getElementById('appSidebar').inert=innerWidth<=600&&!open;}
function toggleNavigation(){const shell=document.getElementById('appShell');if(innerWidth<=600){const open=shell.classList.toggle('sidebar-open');document.getElementById('sidebarScrim').hidden=!open;}else if(innerWidth<=1100)shell.classList.toggle('sidebar-expanded');else shell.classList.toggle('sidebar-collapsed');updateNavigationState();}
function updateShell(){
 const name=activeWorkspace==='groups'?activeGroup:activeWorkspace;
 const labels={mixer:['PERFORM','Banks'],sidechain:['PERFORM','MOD'],controls:['CONNECT','Routing'],clock:['CONNECT','Clock'],devices:['CONNECT','Devices'],activity:['MONITOR','Activity']};
 const [category,title]=labels[name]||labels.mixer;document.getElementById('workspaceCategory').textContent=category;document.getElementById('workspaceTitle').textContent=title;document.title='midi:brain · '+title;
 const signature=JSON.stringify([name,name==='sidechain'?performanceDraft?.mods.map(m=>[m.name,m.shape,m.enabled]):null,name==='sidechain'?selectedMod:null,name==='mixer'?bankDraft?.banks.map(b=>[b.id,b.name]):null]);
 if(signature===sidebarSignature)return;sidebarSignature=signature;
 const root=document.getElementById('sidebarContext');root.replaceChildren();
 if(name==='sidechain'&&performanceDraft){const heading=el('div','SOURCES');heading.className='nav-section';root.appendChild(heading);performanceDraft.mods.forEach((mod,i)=>{const button=action('MOD '+(i+1)+' / '+mod.name,()=>{selectedMod=i;buildMods();sidebarSignature='';updateShell();closeNavigation();});button.className='mod-context';button.setAttribute('aria-pressed',String(i===selectedMod));button.appendChild(el('small',(mod.enabled?'Enabled':'Bypassed')+' · '+mod.shape));root.appendChild(button);});}
 if(name==='mixer'&&bankDraft){const heading=el('div','BANKS');heading.className='nav-section';root.appendChild(heading);bankDraft.banks.forEach((bank,i)=>root.appendChild(action(String(i+1).padStart(2,'0')+' / '+bank.name,()=>{const panel=document.querySelectorAll('#bankEditor>.bank-form')[i];panel?.scrollIntoView({block:'start',behavior:'smooth'});closeNavigation();})));}
}
document.addEventListener('DOMContentLoaded',()=>{
 document.getElementById('toggleSidebar').onclick=toggleNavigation;document.getElementById('collapseSidebar').onclick=()=>innerWidth<=600?closeNavigation():toggleNavigation();document.getElementById('sidebarScrim').onclick=closeNavigation;
 document.querySelector('.workspace-nav').addEventListener('click',event=>{if(event.target.closest('button')){document.getElementById('workspaceMain').scrollTop=0;closeNavigation();}});
 document.addEventListener('keydown',event=>{if(event.key==='Escape'){closeNavigation();document.getElementById('toggleSidebar').focus();}});
 window.addEventListener('resize',()=>{if(innerWidth>600)closeNavigation();updateNavigationState();});updateNavigationState();
});

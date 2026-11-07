/* Live overview. Rendering stays read-only and uses the same status polls as the editors. */
const activityHistory={mods:[[],[],[]],lastCount:null,lastAt:null,rate:0,state:null};

function activityNode(tag,className,text){const node=document.createElement(tag);if(className)node.className=className;if(text!==undefined)node.textContent=text;return node;}
function activityPercent(value){return Math.round(Math.max(0,Math.min(1,Number(value)||0))*100);}
function activityName(value){return String(value||'').replaceAll('_',' ').replace(/\b\w/g,c=>c.toUpperCase());}
function activityStat(label,value,detail){const box=activityNode('article','activity-stat');box.append(activityNode('small','',label),activityNode('strong','',value),activityNode('span','',detail));return box;}

function renderActivitySummary(status,performance){
 const root=document.getElementById('activitySummary');if(!root)return;
 const now=Date.now(),elapsed=activityHistory.lastAt===null?0:(now-activityHistory.lastAt)/1000;
 if(elapsed>0&&status.sent_count>=activityHistory.lastCount)activityHistory.rate=(status.sent_count-activityHistory.lastCount)/elapsed;
 activityHistory.lastCount=status.sent_count;activityHistory.lastAt=now;
 const captures=performance.slots?.filter(slot=>slot.saved).length||0;
 root.replaceChildren(
  activityStat('Runtime',status.running?'RUNNING':'STOPPED',(status.demo?'Simulation · ':'')+(status.held_notes||0)+' held notes'),
  activityStat('MIDI output',activityHistory.rate.toFixed(1)+' /s',(status.sent_count||0)+' sent · '+(status.pending||0)+' queued'),
  activityStat('Clock',performance.clock?.receiving?(performance.clock.bpm?performance.clock.bpm.toFixed(1)+' BPM':'LOCKED'):'NO CLOCK',performance.clock?.running?'Transport running':'Transport stopped'),
  activityStat('Performance',captures+' / 8 saved',(performance.shift?'Shift on':'Shift off')+(performance.pending?' · action queued':' · no queued action'))
 );
}

function modWave(history){
 const svg=document.createElementNS('http://www.w3.org/2000/svg','svg');svg.setAttribute('viewBox','0 0 240 72');svg.setAttribute('role','img');svg.setAttribute('aria-label','Recent MOD output');
 const zero=document.createElementNS(svg.namespaceURI,'line');zero.setAttribute('x1','0');zero.setAttribute('x2','240');zero.setAttribute('y1','36');zero.setAttribute('y2','36');zero.setAttribute('class','wave-zero');svg.appendChild(zero);
 const path=document.createElementNS(svg.namespaceURI,'polyline');const count=Math.max(2,history.length);path.setAttribute('points',history.map((value,index)=>`${index*240/(count-1)},${36-Math.max(-1,Math.min(1,value))*30}`).join(' '));path.setAttribute('class','wave-line');svg.appendChild(path);return svg;
}

function renderActivityMods(performance){
 const root=document.getElementById('activityMods');if(!root)return;root.replaceChildren();
 if(!performance.native){root.appendChild(activityNode('div','activity-empty','Activate bank setup to monitor MOD sources.'));return;}
 performance.config.mods.forEach((mod,index)=>{
  const value=performance.values[index]||0,source=performance.sources?.[index]||{};
  const history=activityHistory.mods[index];history.push(value);while(history.length<40)history.unshift(0);if(history.length>40)history.shift();
  const card=activityNode('article','activity-card mod-monitor'),header=activityNode('header'),title=activityNode('div');
  title.append(activityNode('small','',`MOD ${index+1}`),activityNode('h3','',mod.name));
  header.append(title,activityNode('span','muted',mod.enabled?(source.active?'ACTIVE':'ARMED'):'BYPASSED'));card.appendChild(header);
  card.appendChild(modWave(history));
  const routes=(mod.targets?.length||0)+(mod.bank_targets?.length||0)+(mod.destinations?.length||0),detail=activityNode('div','muted',`${activityName(mod.shape)} · ${activityName(mod.playback)} · ${routes} destination${routes===1?'':'s'}`);
  const trigger=mod.trigger?(mod.trigger.type==='note'?`Note ${mod.trigger.number??'any'} · ch ${mod.trigger.channel}`:`CC ${mod.trigger.number} · ch ${mod.trigger.channel}`):'Manual trigger';
  card.append(detail,activityNode('div','muted',`${trigger} · ${source.held||0} held`));
  const meter=activityNode('div','meter'),fill=activityNode('i');fill.style.width=activityPercent(Math.abs(value))+'%';meter.appendChild(fill);card.append(meter,activityNode('small','',`Output ${value.toFixed(3)} · amount ${Math.round(mod.amount*100)}%`));root.appendChild(card);
 });
}

function renderActivityClock(routing,performance){
 const root=document.getElementById('activityClock');if(!root)return;root.replaceChildren();
 const clock=performance.clock||{},beats=performance.config?.beats_per_bar||4,unit=performance.config?.beat_unit||4,barQuarters=beats*4/unit;
 const quarter=clock.quarter||0,within=((quarter%barQuarters)+barQuarters)%barQuarters,progress=barQuarters?within/barQuarters:0;
 const ring=activityNode('div','clock-ring');ring.style.setProperty('--clock-progress',(progress*100)+'%');ring.append(activityNode('strong','',clock.bpm?clock.bpm.toFixed(1):'—'),activityNode('small','',clock.bpm?'BPM':'NO CLOCK'));
 const detail=activityNode('div','clock-detail');
 const rows=[['Position',`${Math.floor(quarter/barQuarters)+1}.${Math.floor(within/(4/unit))+1}`],['Meter',`${beats}/${unit}`],['Input',routing.active_patchbay?.clock?.source||routing.patchbay?.clock?.source||'Not assigned'],['Forwarding',(routing.active_patchbay?.clock?.destinations?.length||0)+' outputs']];
 for(const [label,value] of rows){const box=activityNode('div');box.append(activityNode('small','',label),activityNode('strong','',value));detail.appendChild(box);}root.append(ring,detail);
}

function renderActivityBanks(banks,performance){
 const root=document.getElementById('activityBanks');if(!root)return;root.replaceChildren();
 if(!performance.native||!banks.active?.banks?.length){root.appendChild(activityNode('div','activity-empty','No active banks.'));return;}
 for(const bank of banks.active.banks){const row=activityNode('div','activity-bank');const name=activityNode('div');name.append(activityNode('strong','',bank.name),activityNode('small','',bank.destination));row.appendChild(name);
  performance.config.mods.forEach((mod,index)=>{const unified=(mod.destinations||[]).filter(t=>t.scale_by_bank&&t.banks.includes(bank.id)),route=mod.bank_targets.find(target=>target.bank===bank.id)||(unified.length?{parameter:unified.map(t=>t.parameter).join(', ')}:null),depth=index===0?bank.depth:(bank.mod_depths?.[index]||0),signal=performance.values[index]||0,live=route?(route.parameter==='volume'?Math.max(0,signal):Math.abs(signal))*mod.amount*depth*(unified.length?Math.max(...unified.map(t=>Math.abs(t.amount))):1):0;const cell=activityNode('div','activity-bank-mod');cell.appendChild(activityNode('span','',`M${index+1}`));const track=activityNode('div','track'),configured=activityNode('em'),fill=activityNode('i');configured.style.width=activityPercent(depth)+'%';fill.style.width=activityPercent(live)+'%';track.append(configured,fill);cell.append(track,activityNode('span','',route?`${Math.round(live*100)}/${Math.round(depth*100)}%`:'OFF'));cell.title=route?`${mod.name} → ${route.parameter}: ${Math.round(live*100)}% live from ${Math.round(depth*100)}% bank amount`:`${mod.name} is not routed to ${bank.name}`;row.appendChild(cell);});root.appendChild(row);}
}

function renderActivityParameters(performance){
 const root=document.getElementById('activityParameters');if(!root)return;
 const targets=performance.targets||[],changed=targets.filter(target=>target.value!==null&&target.output!==null&&Math.round(target.value)!==Math.round(target.output)),counts=performance.target_counts||{tracked:targets.length,known:targets.filter(target=>target.value!==null).length,moving:changed.length};
 root.replaceChildren();const summary=activityNode('div','parameter-summary');
 for(const [label,value] of [['Tracked',counts.tracked],['Known',counts.known],['Moving',counts.moving]]){const item=activityNode('div');item.append(activityNode('strong','',String(value)),activityNode('small','',label));summary.appendChild(item);}root.appendChild(summary);
 if(!changed.length){root.appendChild(activityNode('div','activity-empty','All known parameter outputs match their base values.'));return;}
 for(const target of changed.slice(0,6)){const minimum=target.signature?.[3]??0,maximum=target.signature?.[4]??127,base=target.value,output=target.output,card=activityNode('div','parameter-change'),header=activityNode('header');header.append(activityNode('strong','',target.name),activityNode('output','',`${Math.round(base)} → ${Math.round(output)}`));card.appendChild(header);const meter=activityNode('div','parameter-meter'),fill=activityNode('i'),marker=activityNode('b'),norm=value=>maximum>minimum?activityPercent((value-minimum)/(maximum-minimum)):0;fill.style.width=norm(output)+'%';marker.style.left=`calc(${norm(base)}% - 1px)`;meter.append(fill,marker);card.appendChild(meter);root.appendChild(card);}
 if(changed.length>6)root.appendChild(activityNode('small','muted',`+ ${changed.length-6} more moving parameters`));
}

function eventDescription(event){
 if(event.type==='note_on'||event.type==='note_off')return `${activityName(event.type)} · note ${event.note} · velocity ${event.velocity}`;
 const control=event.control??event.cc;if(control!==undefined)return `CC ${control} · value ${event.value} · channel ${event.channel}`;
 return activityName(event.type||'MIDI message');
}
function renderActivityEvents(events){const root=document.getElementById('events'),details=root?.closest('details'),count=document.getElementById('activityEventCount');if(count)count.textContent=(events?.length||0)+' buffered';if(!root||!details?.open)return;root.replaceChildren();const recent=(events||[]).slice(-8).reverse();if(!recent.length){root.appendChild(activityNode('li','', 'Waiting for MIDI…'));return;}for(const event of recent){const input=Object.hasOwn(event,'input'),row=activityNode('li',input?'input':'output');row.append(activityNode('span','event-direction',input?'IN':'OUT'),activityNode('span','',input?event.input:(event.output||event.destination||'MIDI')),activityNode('span','event-detail',eventDescription(event)));root.appendChild(row);}}

function renderActivity(status,routing,banks,performance){
 activityHistory.state={status,routing,banks,performance};
 if(typeof activeWorkspace!=='undefined'&&activeWorkspace!=='activity')return;
 if(!performance.native){document.getElementById('activitySummary')?.replaceChildren(activityStat('Runtime',status.running?'RUNNING':'STOPPED','Bank setup is not active'));renderActivityEvents(status.events);return;}
 renderActivitySummary(status,performance);renderActivityMods(performance);renderActivityClock(routing,performance);renderActivityBanks(banks,performance);renderActivityParameters(performance);renderActivityEvents(status.events);
}
document.querySelector('.activity-log-disclosure')?.addEventListener('toggle',()=>{if(activityHistory.state)renderActivityEvents(activityHistory.state.status.events);});

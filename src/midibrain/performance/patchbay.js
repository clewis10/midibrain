/* DOM-built route editor: device names are text, never HTML. */
let patchbayDirty=false, patchbayDraft=null, patchbayRevision=0, patchbayInventory=null;
function el(tag,text){const node=document.createElement(tag);if(text!==undefined)node.textContent=text;return node;}
function dirtyPatchbay(){patchbayDirty=true;patchbayRevision++;document.getElementById('patchbayStatus').textContent='Unsaved route edits';}
function choosePort(names,value,label,onchange,empty='Choose a port…'){
  const select=el('select');select.setAttribute('aria-label',label);
  for(const name of ['',...new Set([...names,...(value?[value]:[])])]){const option=el('option',name?(name+(names.includes(name)?'':' — unavailable')):empty);option.value=name;select.appendChild(option);}
  select.value=value||'';select.onchange=()=>{onchange(select.value);dirtyPatchbay();};return select;
}
function labeled(text,control){const label=el('label',text);label.appendChild(control);return label;}
function numeric(value,max,label,onchange,min=0){const input=el('input');input.type='number';input.min=min;input.max=max;input.value=value;input.setAttribute('aria-label',label);input.oninput=()=>{onchange(Number(input.value));dirtyPatchbay();};return input;}
function action(text,fn){const button=el('button',text);button.onclick=fn;return button;}
function buildPatchbay(){
  const d=patchbayDraft,inventory=patchbayInventory,source=document.getElementById('clockSource');
  const replacement=choosePort(inventory.inputs,d.clock.source,'Clock source / master input',value=>{d.clock.source=value||null;if(!value)d.clock.destinations=[];buildPatchbay();},'Off — no clock master');
  replacement.id='clockSource';source.replaceWith(replacement);
  const transport=document.getElementById('clockTransport');transport.checked=d.clock.transport;transport.onchange=()=>{d.clock.transport=transport.checked;dirtyPatchbay();};
  const targets=document.getElementById('clockTargets');targets.replaceChildren(el('legend','Send clock to these output ports'));
  for(const name of new Set([...inventory.outputs,...d.clock.destinations])){const input=el('input');input.type='checkbox';input.checked=d.clock.destinations.includes(name);input.disabled=!d.clock.source||name===d.clock.source;input.onchange=()=>{d.clock.destinations=input.checked?[...d.clock.destinations,name]:d.clock.destinations.filter(n=>n!==name);dirtyPatchbay();};const label=el('label');label.append(input,document.createTextNode(name+(inventory.outputs.includes(name)?'':' — unavailable')));targets.appendChild(label);}
  if(typeof buildMappingRows==='function')buildMappingRows(true);
}
function renderPatchbay(state){
  const $=id=>document.getElementById(id);
  const inventoryChanged=JSON.stringify(patchbayInventory)!==JSON.stringify(state.available);
  patchbayInventory=state.available;
  if(inventoryChanged){
    $('inventoryHint').textContent=state.demo?'SIMULATION · example devices below make routing editable without hardware. No MIDI is sent.':'All MIDI endpoints reported by this host. Inputs enter MIDIBRAIN; outputs leave MIDIBRAIN.';
    const groups=new Map();
    for(const direction of ['inputs','outputs'])for(const name of state.available[direction]){const group=name.includes(':')?name.split(':')[0]:name;if(!groups.has(group))groups.set(group,{inputs:[],outputs:[]});groups.get(group)[direction].push(name);}
    $('portInventory').replaceChildren();
    for(const [name,ports] of groups){const card=el('div');card.className='port-card';card.appendChild(el('h3',name));for(const [direction,names] of Object.entries(ports)){card.appendChild(el('p',direction==='inputs'?'IN → MIDIBRAIN':'OUT ← MIDIBRAIN'));for(const name of names)card.appendChild(el('p',name));if(!names.length)card.appendChild(el('p','No '+direction+' reported'));}$('portInventory').appendChild(card);}
    if(!groups.size)$('portInventory').appendChild(el('p','No MIDI ports reported. Connect a USB MIDI device to the runtime host.'));
  }
  if(!patchbayDraft||(!patchbayDirty&&JSON.stringify(patchbayDraft)!==JSON.stringify(state.patchbay))){patchbayDraft=structuredClone(state.patchbay);buildPatchbay();buildRouteRange();}else if(inventoryChanged&&!patchbayDirty){buildPatchbay();buildRouteRange();}
  const active=state.active_patchbay.clock;
  $('clockLive').textContent=state.demo?'Clock monitor: simulation — no incoming hardware clock.':!active.source?'Active clock: off':('Active source: '+active.source+' · '+(state.clock_status.receiving?'Receiving clock':'Waiting for clock')+' · '+state.clock_status.ticks+' ticks received');
  if(!state.demo&&active.source){const last=state.clock_status.transport_events?.at(-1);if(last)$('clockLive').textContent+=' · Last transport from source: '+last.type.toUpperCase()+' '+Math.floor(last.age_seconds)+'s ago ('+(last.forwarded?'forwarded':'filtered')+')';const stops=state.clock_status.transport_counts?.stop||0;$('clockLive').textContent+=' · '+stops+' Stop messages received · Longest observed clock gap: '+(state.clock_status.max_tick_gap_ms||0).toFixed(1)+' ms';}
  const lines=['CLOCK: '+(active.source||'Off')+' → '+(active.destinations.join(' + ')||'No destinations')];
  for(const route of state.active_patchbay.cc)lines.push(route.source+' / ch '+route.channel+' / CC '+route.cc+' → '+route.destinations.map(t=>t.port+' / ch '+t.channel+' / CC '+t.cc).join(' + '));
  $('activePatchbay').textContent=lines.join('\n');
  if(!patchbayDirty)$('patchbayStatus').textContent=state.demo?'Simulation routes applied in memory.':state.restart_required?(state.routing_saved?'Saved · restart runtime to activate.':'Pending changes · Save settings, then restart runtime.'):'Routes match this session.';
  $('routingLifecycle').textContent=state.demo?'Simulation: apply and inspect routes here. No hardware is opened and saving is disabled.':'Save settings → Restart runtime. Active routes stay in place until restart.';

}

function buildRouteRange(){
 const root=document.getElementById('routeRange');if(!root)return;root.replaceChildren();
 const details=el('details');details.className='route-range';details.appendChild(el('summary','Add consecutive CC routes'));
 const row=el('div');row.className='bar';
 const source=choosePort(patchbayInventory.inputs,'','Range input',()=>{}),output=choosePort(patchbayInventory.outputs,'','Range output',()=>{});
 // These are tool inputs, not saved routes until Add routes succeeds.
 source.onchange=output.onchange=null;
 const field=(label,value,min,max)=>{const input=numeric(value,max,label,()=>{},min);input.oninput=null;input.required=true;row.appendChild(labeled(label,input));return input;};
 row.appendChild(labeled('Input port',source));const channel=field('Input channel',1,1,16),start=field('First input CC',16,0,119),count=field('Knobs',16,1,64);
 row.appendChild(labeled('Output port',output));const outChannel=field('Output channel',16,1,16),outStart=field('First output CC',70,0,119);
 const range={min:0,max:127};row.appendChild(outputRange(range,'Consecutive destinations',()=>{}));
 const status=el('p');status.setAttribute('role','status');
 row.appendChild(action('Add routes',()=>{
  const inputs=[channel,start,count,outChannel,outStart];if(!source.value||!output.value||inputs.some(i=>!i.checkValidity())||Number(start.value)+Number(count.value)>120||Number(outStart.value)+Number(count.value)>120){status.textContent='Choose both ports and a CC range within 0–119.';return;}
  const added=Array.from({length:Number(count.value)},(_,i)=>({source:source.value,page:typeof mappingPage==='string'?mappingPage:'Page 1',channel:Number(channel.value),cc:Number(start.value)+i,destinations:[{port:output.value,channel:Number(outChannel.value),cc:Number(outStart.value)+i,min:range.min,max:range.max}]}));
  const stem=p=>p.replace(/ \d+:\d+$/,'');
  if(patchbayDraft.cc.length+added.length>64||added.some(r=>patchbayDraft.cc.some(x=>stem(x.source)===stem(r.source)&&x.channel===r.channel&&x.cc===r.cc))){status.textContent='This range overlaps an existing input route or exceeds 64 routes. Existing routes were kept.';return;}
  patchbayDraft.cc.push(...added);dirtyPatchbay();buildPatchbay();status.textContent=added.length+' routes added to draft. Save settings and restart to activate.';
 }));details.append(row,status);root.appendChild(details);
}

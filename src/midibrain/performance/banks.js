let selectedAction=0;
let banksDirty=false,bankDraft=null,bankState=null,bankPorts=null,bankRevision=0,bankDepthSignature='';
let deviceKind='controller';const editorOpen=new Map(),editorPages=new Map(),deviceChannelViews=new Map();
function rememberEditors(root){for(const detail of root.querySelectorAll('details[data-editor-key]'))editorOpen.set(detail.dataset.editorKey,detail.open);}
function editorDetails(key,title,initial=false){const detail=el('details');detail.dataset.editorKey=key;detail.open=editorOpen.has(key)?editorOpen.get(key):initial;detail.appendChild(el('summary',title));return detail;}
function showDeviceKind(kind){deviceKind=kind;for(const button of document.querySelectorAll('[data-device-kind]'))button.setAttribute('aria-pressed',String(button.dataset.deviceKind===kind));document.getElementById('deviceEditor').hidden=kind==='catalog';document.getElementById('catalogPanel').hidden=kind!=='catalog';document.getElementById('addController').hidden=kind!=='controller';document.getElementById('addDestination').hidden=kind!=='destination';for(const box of document.querySelectorAll('#deviceEditor>[data-kind]'))box.hidden=box.dataset.kind!==kind;devicePicker();}
function bankChanged(){banksDirty=true;bankRevision++;document.getElementById('bankStatus').textContent='Unsaved device / bank changes';const status=document.getElementById('brainActionStatus');if(status)status.textContent='Unsaved Brain action / bank changes';}
function bankInput(value,label,change,type='text',min=0,max=127){const input=el('input');input.type=type;input.required=type==='number'&&!/ (input|feedback) (channel|cc)$/.test(label)&&!label.endsWith(' reset');input.value=value??'';input.setAttribute('aria-label',label);if(type==='number'){input.min=min;input.max=max;}input.oninput=()=>{if(type==='text')change(input.value);bankChanged();};input.onchange=()=>{change(type==='number'?(input.value===''?null:Number(input.value)):input.value);bankChanged();};return input;}
function bankSelect(options,value,label,change){const select=el('select');select.setAttribute('aria-label',label);for(const [key,title] of options){const option=el('option',title);option.value=key;select.appendChild(option);}select.value=value??'';select.onchange=()=>{change(select.value);bankChanged();};return select;}
function bankCheck(value,label,change){const input=el('input');input.type='checkbox';input.checked=value;input.setAttribute('aria-label',label);input.onchange=()=>{change(input.checked);bankChanged();};return input;}
function bankPort(value,direction,label,change){return bankSelect([['','Unassigned'],...[...new Set([...bankPorts[direction],...(value?[value]:[])])].map(n=>[n,n+(bankPorts[direction].includes(n)?'':' — unavailable')])],value,label,v=>change(v||null));}
function bankID(prefix){return prefix+'-'+crypto.randomUUID().slice(0,8);}
function layoutCount(value,label,change,min,max){const input=bankInput(value,label,()=>{} ,'number',min,max);input.dataset.layoutCount='true';input.commitLayout=()=>{const n=Number(input.value);if(input.value!==''&&Number.isInteger(n)&&n>=min&&n<=max)change(n);};input.oninput=bankChanged;input.onchange=()=>{input.commitLayout();bankChanged();rebuildBanks();};return input;}

function controllerLayers(device){return (device?.layers|| (device?.alternate?['normal','alternate']:['normal'])).filter(key=>device?.layer_types?.[key]!=='direct');}
function layerName(device,key){return device?.input_names?.[key]||({normal:'Main',alternate:'Alternate'}[key]||key);}
function blankControl(device){return Object.fromEntries(controllerLayers(device).map(k=>[k,{source:null,feedback:null,parameter:null}]));}
function normalizeBanks(device){for(const bank of bankDraft.banks.filter(b=>b.controller===device.id)){while(bank.controls.length<device.controls_per_bank)bank.controls.push(blankControl(device));bank.controls.length=device.controls_per_bank;const layers=controllerLayers(device);bank.controls=bank.controls.map(control=>Object.fromEntries(layers.map(k=>[k,control[k]||{source:null,feedback:null,parameter:null}])));}}
function rebuildBanks(){buildDeviceEditor();buildBankEditor();buildBrainActions();}
function buildBankEditor(){const root=document.getElementById('bankEditor');rememberEditors(root);root.replaceChildren();
 const controllers=bankDraft.devices.filter(d=>d.kind==='controller'),destinations=bankDraft.devices.filter(d=>d.kind==='destination');
 if(!bankDraft.banks.length)root.appendChild(el('p','No banks. Add a bank and choose its controller and destination definition.'));
 bankDraft.banks.forEach(bank=>{const controller=controllers.find(d=>d.id===bank.controller),destination=destinations.find(d=>d.id===bank.destination);const box=el('div');box.className='bank-form';box.appendChild(el('h3',bank.name));
 const bar=el('div');bar.className='bar';bar.append(labeled('MOD bank amounts: include in snapshots',bankCheck(bank.depth_include_snapshot??false,bank.id+' depth snapshots',v=>bank.depth_include_snapshot=v)),labeled('MOD bank amounts: include in default resets (to zero)',bankCheck(bank.depth_include_reset??false,bank.id+' depth default resets',v=>bank.depth_include_reset=v)));bar.append(labeled('Bank name',bankInput(bank.name,bank.id+' name',v=>bank.name=v)),labeled('Controller',bankSelect(controllers.map(d=>[d.id,d.name]),bank.controller,bank.id+' controller',v=>{bank.controller=v;const d=controllers.find(d=>d.id===v);bank.controls=Array.from({length:d.controls_per_bank},()=>blankControl(d));rebuildBanks();})),labeled('Shared destination defaults',bankSelect(destinations.map(d=>[d.id,d.name]),bank.destination,bank.id+' destination',v=>{bank.destination=v;bank.channels=destinations.find(d=>d.id===v)?.channel_mode==='selectable'?[destinations.find(d=>d.id===v).channels[0].id]:[];bank.midi_channels=[1];bank.depth=0;bank.depth_overrides={};for(const c of bank.controls)for(const binding of Object.values(c))binding.parameter=null;rebuildBanks();})));
 bar.append(action('Duplicate bank',()=>{const clone=structuredClone(bank);clone.id=bankID('bank');clone.name=bank.name+' copy';clone.depth=0;clone.mod_depths=[0,0,0];clone.depth_overrides={};for(const c of clone.controls)for(const binding of Object.values(c)){binding.source=null;binding.feedback=null;}bankDraft.banks.push(clone);bankChanged();rebuildBanks();}),action('Remove bank',()=>{bankDraft.banks=bankDraft.banks.filter(b=>b.id!==bank.id);bankDraft.resets=bankDraft.resets.filter(r=>r.bank!==bank.id);bankChanged();rebuildBanks();}));if(bankState.active.banks.some(b=>b.id===bank.id))bar.appendChild(action('Reset bank values',()=>banksDirty?document.getElementById('notice').textContent='Save or discard bank edits before resetting values.':post('bank-reset',{bank:bank.id})));box.appendChild(bar);
 const targets=el('fieldset');targets.appendChild(el('legend',destination?.channel_mode==='selectable'?'Parameter sets':'Logical destination channels'));
 if(destination?.channel_mode==='selectable'){
 targets.appendChild(bankSelect(destination.channels.map(c=>[String(c.id),c.name]),String(bank.channels[0]??''),bank.id+' parameter set',v=>{bank.channels=[Number(v)];bank.depth=0;bank.depth_overrides={};for(const c of bank.controls)for(const b of Object.values(c))b.parameter=null;buildBankEditor();}));
 }else for(const channel of destination?.channels||[]){const label=el('label');label.append(bankCheck(bank.channels.includes(channel.id),bank.id+' target '+channel.id,v=>{bank.channels=v?[...bank.channels,channel.id]:bank.channels.filter(cid=>cid!==channel.id);if(!v)delete bank.depth_overrides?.[String(channel.id)];buildBankEditor();}),document.createTextNode(channel.name));targets.appendChild(label);}box.appendChild(targets);
 if(destination?.channel_mode==='selectable'){const midi=el('fieldset');midi.appendChild(el('legend','Send on MIDI channels'));for(let ch=1;ch<=16;ch++){const label=el('label');label.append(bankCheck((bank.midi_channels||[]).includes(ch),bank.id+' MIDI channel '+ch,v=>{bank.midi_channels=v?[...(bank.midi_channels||[]),ch]:(bank.midi_channels||[]).filter(n=>n!==ch);}),document.createTextNode(String(ch)));midi.appendChild(label);}box.appendChild(midi);}

 box.appendChild(el('p',controller?controller.controls_per_bank+' controls per bank'+(' · '+controllerLayers(controller).length+' layers'):'Choose a controller'));
 const names=Object.fromEntries((destination?.channels||[]).flatMap(ch=>Object.entries(ch.parameters).map(([key,p])=>[key,p.label])));const summary=el('div');summary.className='bank-parameters';bank.controls.forEach((c,i)=>{const row=el('div');row.className='bank-parameter';row.appendChild(el('span',String(i+1).padStart(2,'0')));const layers=el('div');for(const [layer,binding] of Object.entries(c)){const line=el('div');line.className='parameter-layer';line.append(el('strong',binding.label||(({depth:'MOD 1 amount',mod_depth_2:'MOD 2 amount',mod_depth_3:'MOD 3 amount'}[binding.parameter]||names[binding.parameter]||'Unassigned'))),el('small',layerName(controller,layer)));if(binding.sends?.length)line.appendChild(el('small','+ '+binding.sends.length+' destination'+(binding.sends.length>1?'s':'')));layers.appendChild(line);}row.appendChild(layers);summary.appendChild(row);});box.insertBefore(summary,bar);const amounts=el('div');amounts.className='bank-mod-amounts depth-grid';amounts.dataset.bank=bank.id;box.insertBefore(amounts,bar);root.appendChild(box);
 });
 polishBanks();
}
function extraDestinations(bank,binding,label){
 const root=el('div');root.className='extra-destinations';
 const devices=bankDraft.devices.filter(d=>d.kind==='destination');
 (binding.sends||[]).forEach((send,i)=>{
 const row=el('div');row.className='bar';const device=devices.find(d=>d.id===send.device),set=device?.channels.find(c=>c.id===send.set);
 row.append(labeled('Device',bankPick(devices.map(d=>[d.id,d.name]),send.device,label+' send '+i+' device',v=>{send.device=v;const d=devices.find(d=>d.id===v);send.set=d.channels[0].id;send.parameter=Object.keys(d.channels[0].parameters)[0];buildMappingRows(true);})),
 labeled('Parameter set',bankPick((device?.channels||[]).map(c=>[String(c.id),c.name]),String(send.set),label+' send '+i+' set',v=>{send.set=Number(v);send.parameter=Object.keys(device.channels.find(c=>c.id===send.set).parameters)[0];buildMappingRows(true);})),
 labeled('Parameter',bankPick(Object.entries(set?.parameters||{}).map(([k,p])=>[k,(p.section?p.section+' / ':'')+p.label]),send.parameter,label+' send '+i+' parameter',v=>send.parameter=v)));
 if(device?.channel_mode==='selectable')row.appendChild(labeled('MIDI ch',bankInput(send.midi_channel,label+' send '+i+' MIDI channel',v=>send.midi_channel=v,'number',1,16)));
 row.appendChild(outputRange(send,label+' send '+i,bankChanged));
 row.appendChild(action('Remove destination',()=>{binding.sends.splice(i,1);bankChanged();buildMappingRows(true);}));root.appendChild(row);
 });
 root.appendChild(action('Add destination',()=>{const d=devices.find(d=>d.id!==bank.destination)||devices[0];if(!d)return;binding.sends??=[];binding.sends.push({device:d.id,set:d.channels[0].id,parameter:Object.keys(d.channels[0].parameters)[0],midi_channel:1});bankChanged();buildMappingRows(true);}));
 return root;
}
function brainNumber(value,label,change,min,max){const input=bankInput(value,label,change,'number',min,max);input.oninput=()=>{change(input.value===''?null:Number(input.value));bankChanged();};return input;}
function buildBrainActions(){
 const root=document.getElementById('brainActions');if(!root||!bankDraft)return;rememberEditors(root);root.replaceChildren();const picker=el('nav');picker.className='device-picker';picker.setAttribute('aria-label','Choose a Brain action');root.appendChild(picker);selectedAction=Math.min(selectedAction,Math.max(0,bankDraft.resets.length-1));
 const controllers=bankDraft.devices.filter(d=>d.kind==='controller');
 bankDraft.resets.forEach((binding,i)=>{
 const box=el('div');box.className='bank-form';const row=el('div');row.className='bar';const prefix='Brain action '+(i+1);
 row.append(labeled('Controller',bankSelect(controllers.map(d=>[d.id,d.name]),binding.controller,prefix+' controller',v=>binding.controller=v)),
 labeled('Input MIDI ch',brainNumber(binding.channel,prefix+' channel',v=>binding.channel=v,1,16)),
 labeled('Input CC',brainNumber(binding.cc,prefix+' CC',v=>binding.cc=v,0,119)),
 labeled('MIDIBRAIN action',bankSelect([['reset','Reset values'],['depth','MOD 1 bank amount'],['release','MOD 1 release time'],['panic','Release all envelopes']],binding.action||'reset',prefix+' action',v=>{binding.action=v;binding.channel_id=null;binding.bank=v==='depth'?bankDraft.banks[0]?.id:null;bankChanged();buildBrainActions();})));
 const kind=binding.action||'reset';
 if(kind==='reset'||kind==='depth'){
 const options=[...(kind==='reset'?[['','All banks']]:[]),...bankDraft.banks.map(b=>[b.id,b.name])];
 if(binding.channel_id!=null)options.push(['legacy-channel','Logical channel '+binding.channel_id+' (legacy)']);
 row.appendChild(labeled('Target',bankSelect(options,binding.channel_id!=null?'legacy-channel':binding.bank||'',prefix+' target',v=>{if(v!=='legacy-channel'){binding.bank=v||null;binding.channel_id=null;}})));
 }
 if(kind==='release')for(const key of ['min_ms','max_ms'])row.appendChild(labeled(key==='min_ms'?'Minimum ms':'Maximum ms',brainNumber(binding[key]??(key==='min_ms'?0:2000),prefix+' '+key,v=>binding[key]=v,0,10000)));
 row.appendChild(midiLearnButton(controllers.find(d=>d.id===binding.controller),binding,v=>Object.assign(binding,v)));row.appendChild(action('Remove action',()=>{bankDraft.resets.splice(i,1);bankChanged();buildBrainActions();}));const kindName={reset:'Reset values',depth:'MOD 1 bank amount',release:'Release time',panic:'Release envelopes'}[binding.action||'reset'];const target=bankDraft.banks.find(b=>b.id===binding.bank)?.name||(binding.channel_id?'Channel '+binding.channel_id:'All banks');const title=kindName+' · '+((binding.action||'reset')==='reset'||binding.action==='depth'?target:'Global');const caption=(controllers.find(c=>c.id===binding.controller)?.name||'Controller')+' · MIDI '+binding.channel+' / CC '+binding.cc;
 const choose=action(title,()=>{selectedAction=i;buildBrainActions();});choose.appendChild(el('small',caption));choose.setAttribute('aria-pressed',String(selectedAction===i));picker.appendChild(choose);box.hidden=selectedAction!==i;box.dataset.action=binding.action||'reset';box.append(el('h3',title),el('p',caption),row);root.appendChild(box);
 });
 if(!bankDraft.resets.length)root.appendChild(el('p','No controller shortcuts yet.'));
 document.getElementById('addBrainAction').onclick=()=>{if(!controllers.length)return;const controller=controllers[0];const used=new Set(bankDraft.resets.filter(r=>r.controller===controller.id).map(r=>r.channel+':'+r.cc));for(const b of bankDraft.banks.filter(b=>b.controller===controller.id))for(const c of b.controls)for(const x of Object.values(c))if(x.source)used.add(x.source.channel+':'+x.source.cc);let address=null;for(let channel=1;channel<=16&&!address;channel++)for(let cc=0;cc<=119;cc++)if(!used.has(channel+':'+cc)){address={channel,cc};break;}if(!address){document.getElementById('notice').textContent='No free CC address for this controller.';return;}bankDraft.resets.push({controller:controller.id,...address,action:'reset',bank:null,channel_id:null});selectedAction=bankDraft.resets.length-1;bankChanged();buildBrainActions();};
}
function buildDeviceEditor(){const root=document.getElementById('deviceEditor');rememberEditors(root);root.replaceChildren();
 for(const device of bankDraft.devices){const box=el('div');box.className='bank-form';box.dataset.kind=device.kind;box.dataset.deviceId=device.id;box.hidden=device.kind!==deviceKind;box.appendChild(el('h3',device.name+' / '+device.kind));const bar=el('div');bar.className='bar';bar.append(labeled('Device name',bankInput(device.name,device.id+' device name',v=>device.name=v)),action('Remove device',()=>{if(bankDraft.banks.some(b=>b.controller===device.id||b.destination===device.id||b.controls.some(c=>Object.values(c).some(binding=>(binding.sends||[]).some(s=>s.device===device.id))))){document.getElementById('notice').textContent='Remove or reassign this device’s banks first.';return;}bankDraft.devices=bankDraft.devices.filter(d=>d.id!==device.id);bankDraft.resets=bankDraft.resets.filter(r=>r.controller!==device.id);bankChanged();rebuildBanks();}));
 if(device.provenance){const note=el('p');note.className='device-attribution';note.appendChild(document.createTextNode(device.provenance.attribution+' · '));const link=el('a','Source CSV');if(device.provenance.source?.startsWith('https://github.com/pencilresearch/midi/'))link.href=device.provenance.source;link.target='_blank';link.rel='noreferrer';note.appendChild(link);note.appendChild(document.createTextNode(' · CC BY-SA 4.0 · selected CC rows adapted'));box.appendChild(note);}
 if(device.kind==='controller'){
 bar.prepend(labeled('Controller input',bankPort(device.input,'inputs',device.id+' input port',v=>{const oldName=device.input?.split(':')[0];if(!device.name||['New controller','Trigger source','MIDI input',oldName].includes(device.name))device.name=v?.split(':')[0]||'MIDI input';device.input=v;rebuildBanks();})));
 const layout=editorDetails('controller-layout-'+device.id,'Bank layout & feedback');const options=el('div');options.className='bar';
 layout.appendChild(action('Edit controller pages',()=>{mappingController=device.id;mappingBank='';showGroup('controls');buildMappingRows(true);}));
 options.append(labeled('Feedback output (optional)',bankPort(device.feedback_output,'outputs',device.id+' feedback port',v=>device.feedback_output=v)),labeled('Controls per bank',layoutCount(device.controls_per_bank,device.id+' controls per bank',v=>{device.controls_per_bank=v;normalizeBanks(device);},1,64)),labeled('Input variants (optional)',layoutCount(controllerLayers(device).length,device.id+' layer count',v=>{const direct=(device.layers||[]).filter(key=>device.layer_types?.[key]==='direct');if(!Number.isInteger(v)||v<1||v+direct.length>8)return;const keys=controllerLayers(device).slice(0,v);while(keys.length<v){let n=keys.length+1;let key=n===2?'alternate':'layer'+n;while(keys.includes(key)||direct.includes(key))key='layer'+(++n);keys.push(key);}device.layers=[...keys,...direct];for(const key of Object.keys(device.layer_types||{}))if(!device.layers.includes(key))delete device.layer_types[key];normalizeBanks(device);},1,8)));
 layout.append(options,el('p','Pages are managed in Routing. Optional input variants let one control have additional MIDI addresses, such as a shifted knob. Reducing counts removes draft mappings.'));
 box.append(bar,el('p','Select this controller on MOD to configure its trigger type, MIDI channel and note or CC. Bank layout is only needed when assigning bank controls.'),layout);
 }else{
 bar.append(labeled('Device structure',bankSelect([['fixed','Device-specific channels (L6)'],['selectable','Shared parameter sets (synth tracks)']],device.channel_mode||'fixed',device.id+' channel mode',v=>{device.channel_mode=v;for(const bank of bankDraft.banks.filter(b=>b.destination===device.id))bank.midi_channels=bank.midi_channels?.length?bank.midi_channels:[1];rebuildBanks();})),labeled('Reset parameters at startup',bankCheck(device.initialize||false,device.id+' startup reset',v=>device.initialize=v)),labeled('Output port',bankPort(device.output,'outputs',device.id+' output port',v=>device.output=v)),labeled(device.channel_mode==='selectable'?'Parameter set count':'Logical channel count',bankInput(device.channels.length,device.id+' channel count',v=>{if(!Number.isInteger(v)||v<1||v>16)return;while(device.channels.length<v){const prior=device.channels.at(-1);const next=structuredClone(prior);next.id=Math.max(...device.channels.map(c=>c.id))+1;next.name='Channel '+next.id;for(const p of Object.values(next.parameters))p.channel=Math.min(16,p.channel+1);if(next.volume)next.volume.channel=Math.min(16,next.volume.channel+1);device.channels.push(next);}device.channels.length=v;for(const b of bankDraft.banks.filter(b=>b.destination===device.id)){b.channels=b.channels.filter(cid=>device.channels.some(c=>c.id===cid));b.depth_overrides=Object.fromEntries(Object.entries(b.depth_overrides||{}).filter(([cid])=>b.channels.includes(Number(cid))));}rebuildBanks();},'number',1,16)));box.appendChild(bar);
 if(device.provenance){const mode=bar.querySelector('select[aria-label=\"'+device.id+' channel mode\"]');mode.disabled=true;mode.title='Structure supplied by the device definition';}
 const details=editorDetails('device-'+device.id,'Parameter values & defaults',true);details.appendChild(el('p','Set CC addresses and output limits here. Options contains defaults, snapshot/reset inclusion and value type.'));box.appendChild(el('p',device.channel_mode==='selectable'?'Define Track, FX or Master parameters once. Banks choose a parameter set and the MIDI channels assigned on your device. SYN, Filter and AMP are pages within a track, not separate MIDI channels.':'Keep explicit MIDI channel + CC addresses for each logical channel.'));
 for(const channel of device.channels){const section=editorDetails('channel-'+device.id+'-'+channel.id,channel.name,channel.id===device.channels[0].id);section.className='channel-template';section.appendChild(labeled((device.channel_mode==='selectable'?'Parameter set ':'Logical channel ')+channel.id,bankInput(channel.name,device.id+' channel '+channel.id+' name',v=>channel.name=v)));const wrap=el('div');wrap.className='table-wrap';const table=el('table');const head=el('tr');['Page','Parameter',...(device.channel_mode==='selectable'?[]:['MIDI ch']),'CC','Min','Max','Default value','Snapshots','Default resets','Value type',''].forEach(t=>head.appendChild(el('th',t)));table.appendChild(head);
 for(const [key,param] of Object.entries(channel.parameters)){const tr=el('tr');tr.dataset.page=param.section||'Custom';tr.appendChild(el('td',param.section||'Custom'));for(const field of ['label',...(device.channel_mode==='selectable'?[]:['channel']),'cc','min','max','reset']){const cell=el('td');cell.appendChild(bankInput(param[field]??(field==='min'?0:field==='max'?127:null),device.id+' '+channel.id+' '+key+' '+field,v=>param[field]=v,field==='label'?'text':'number',field==='channel'?1:0,field==='channel'?16:field==='cc'?119:127));tr.appendChild(cell);}for(const [flag,title,defaultValue] of [['include_snapshot','Include in snapshots',true],['include_reset','Include in default resets',true]]){const td=el('td');td.appendChild(bankCheck(param[flag]??defaultValue,device.id+' '+channel.id+' '+key+' '+title,v=>{for(const alias of Object.values(channel.parameters)){if(alias.channel===param.channel&&alias.cc===param.cc)alias[flag]=v;}buildDeviceEditor();}));tr.appendChild(td);}const typeCell=el('td');typeCell.appendChild(bankSelect([['','Unspecified'],['knob','Knob / smooth'],['switch','Switch / stepped']],param.continuous===undefined?'':param.continuous?'knob':'switch',device.id+' '+channel.id+' '+key+' value type',v=>{for(const alias of Object.values(channel.parameters)){if(alias.channel===param.channel&&alias.cc===param.cc){if(v==='')delete alias.continuous;else alias.continuous=v==='knob';}}}));tr.appendChild(typeCell);const cell=el('td');cell.appendChild(action('Remove',()=>{delete channel.parameters[key];bankChanged();rebuildBanks();}));tr.appendChild(cell);table.appendChild(tr);}const pages=[...new Set(Object.values(channel.parameters).map(p=>p.section||'Custom'))];const pageKey=device.id+'-'+channel.id;const page=bankSelect([['','All pages'],...pages.map(p=>[p,p])],editorPages.get(pageKey)||'',device.id+' '+channel.id+' parameter page',()=>{});const filterPage=()=>{for(const row of table.querySelectorAll('tr[data-page]'))row.hidden=!!page.value&&row.dataset.page!==page.value;};page.onchange=()=>{editorPages.set(pageKey,page.value);filterPage();};filterPage();section.appendChild(labeled('Parameter page',page));wrap.appendChild(table);section.appendChild(wrap);
 section.appendChild(action('Use minimum for unknown defaults',()=>{for(const p of Object.values(channel.parameters)){if(p.reset==null&&!p.alias)p.reset=p.min??0;}bankChanged();buildDeviceEditor();}));section.appendChild(action('Add parameter',()=>{let i=1;while(channel.parameters['param'+i])i++;channel.parameters['param'+i]={label:'Parameter '+i,channel:1,cc:0,reset:0,continuous:true};bankChanged();rebuildBanks();const input=[...document.querySelectorAll('#deviceEditor input')].find(n=>n.getAttribute('aria-label')===device.id+' '+channel.id+' param'+i+' label');input?.focus();}));
 section.appendChild(labeled('Sidechain volume mapping',bankCheck(!!channel.volume,device.id+' '+channel.id+' volume enabled',v=>{channel.volume=v?{channel:1,cc:7,curve:[[0,127],[1,0]]}:null;rebuildBanks();})));
 if(channel.volume){const vol=el('div');vol.className='bar';for(const field of ['channel','cc'])vol.appendChild(labeled('Volume '+field,bankInput(channel.volume[field],device.id+' '+channel.id+' volume '+field,v=>channel.volume[field]=v,'number',field==='channel'?1:0,field==='channel'?16:119)));
 section.append(vol,volumeCurveEditor(device,channel));}details.appendChild(section);
 }box.append(details,el('p',device.channel_mode==='selectable'?'Templates can target any MIDI channel from each bank. Blank resets are skipped; incoming controller values scale to Min–Max.':'New logical channels copy the preceding channel on the next MIDI channel. Verify addresses. Blank resets are skipped.'));}
 root.appendChild(box);
 }
 polishDeviceParameters();devicePicker();
}
function bankStructure(setup){const copy=structuredClone(setup);for(const bank of copy.banks){delete bank.depth;delete bank.mod_depths;delete bank.depth_overrides;}return JSON.stringify(copy);}
function renderBanks(state,routing){bankState=state;bankPorts=routing.available;for(const button of document.querySelectorAll('[data-device-kind]'))button.onclick=()=>showDeviceKind(button.dataset.deviceKind);
 if(!bankDraft||(!banksDirty&&bankStructure(bankDraft)!==bankStructure(state.draft))){bankDraft=structuredClone(state.draft);rebuildBanks();}
 else if(!banksDirty){for(const bank of bankDraft.banks){const live=state.draft.banks.find(b=>b.id===bank.id);if(!live)continue;bank.depth=live.depth;bank.depth_overrides=structuredClone(live.depth_overrides||{});if(live.mod_depths)bank.mod_depths=structuredClone(live.mod_depths);else delete bank.mod_depths;}}
 document.getElementById('mixerSummary').textContent=state.active.banks.length+' active banks · device-defined layouts';
 if(!banksDirty)document.getElementById('bankStatus').textContent=state.staged?(state.saved?'Saved bank structure · restart to activate.':'Pending bank structure · save, then restart.'):(state.native?'Bank structure matches this session.':'Existing mappings imported. Save settings to activate bank-based control.');
 document.getElementById('brainActionStatus').textContent=banksDirty?'Unsaved device / bank / Brain action changes':document.getElementById('bankStatus').textContent;
 const signature=JSON.stringify(state.active.banks.map(b=>[b.id,b.name]));const root=document.getElementById('bankDepths');
 if(signature!==bankDepthSignature){bankDepthSignature=signature;root.replaceChildren();for(const bank of state.active.banks){const label=el('label',bank.name+' ');const output=el('span');output.id='bank-amount-'+bank.id;const input=el('input');input.type='range';input.min=0;input.max=100;input.id='bank-depth-'+bank.id;input.setAttribute('aria-label',bank.name+' MOD 1 bank amount');input.disabled=!state.native;input.oninput=()=>output.textContent=input.value+'%';input.onchange=async()=>{if(banksDirty){document.getElementById('notice').textContent='Save or discard bank edits before changing the live MOD 1 amount.';return;}await post('bank-depth',{bank:bank.id,depth:Number(input.value)/100});};label.append(output,input);root.appendChild(label);}}
 for(const bank of state.active.banks){const input=document.getElementById('bank-depth-'+bank.id);input.disabled=!state.native;if(document.activeElement!==input){input.value=Math.round(bank.depth*100);const mixed=new Set(Object.values(bank.depth_overrides||{})).size>1;document.getElementById('bank-amount-'+bank.id).textContent=mixed?'Mixed':input.value+'%';}}
 document.getElementById('addBank').onclick=()=>{const controller=bankDraft.devices.find(d=>d.kind==='controller'),destination=bankDraft.devices.find(d=>d.kind==='destination');if(!controller||!destination){document.getElementById('notice').textContent='Define a controller and destination in Devices first.';return;}bankDraft.banks.push({id:bankID('bank'),name:'New bank',controller:controller.id,destination:destination.id,channels:destination.channel_mode==='selectable'?[destination.channels[0].id]:[],midi_channels:[1],controls:Array.from({length:controller.controls_per_bank},()=>blankControl(controller)),depth:0,depth_overrides:{}});bankChanged();rebuildBanks();};
 document.getElementById('addController').onclick=()=>{bankDraft.devices.push({id:bankID('controller'),name:'New controller',kind:'controller',input:null,feedback_output:null,controls_per_bank:4,layers:['normal']});selectedDevices.controller=bankDraft.devices.at(-1).id;bankChanged();rebuildBanks();};
 document.getElementById('addDestination').onclick=()=>{bankDraft.devices.push({id:bankID('destination'),name:'New destination',kind:'destination',output:null,initialize:false,channel_mode:'selectable',channels:[{id:1,name:'Channel 1',parameters:{param1:{label:'Parameter 1',channel:1,cc:0,reset:0,continuous:true}},volume:null}]});selectedDevices.destination=bankDraft.devices.at(-1).id;bankChanged();rebuildBanks();};
}

// Focused views reuse the existing form controls and validation paths.
const selectedDevices={};
function devicePicker(){
 const root=document.getElementById('deviceEditor');if(!root||!bankDraft)return;
 root.querySelector('.device-picker')?.remove();
 const devices=bankDraft.devices.filter(d=>d.kind===deviceKind);if(!devices.some(d=>d.id===selectedDevices[deviceKind]))selectedDevices[deviceKind]=devices[0]?.id;
 const picker=el('nav');picker.className='device-picker';picker.setAttribute('aria-label','Choose a device');
 for(const d of devices){const button=action(d.name,()=>{selectedDevices[deviceKind]=d.id;devicePicker();});button.setAttribute('aria-pressed',String(d.id===selectedDevices[deviceKind]));button.appendChild(el('small',d.kind==='controller'?(d.input?.replace(/ \d+:\d+$/,'')||'Choose an input'):d.channels.length+' parameter sets'));picker.appendChild(button);}
 if(!devices.length)picker.appendChild(el('p','No devices in this category.'));
 root.prepend(picker);for(const box of root.querySelectorAll('[data-device-id]'))box.hidden=box.dataset.deviceId!==selectedDevices[deviceKind]||box.dataset.kind!==deviceKind;
}
function polishBanks(){
 const root=document.getElementById('bankEditor');
 [...root.children].forEach((box,index)=>{const bank=bankDraft.banks[index];if(!bank)return;const summary=box.querySelector('.bank-parameters'),bulk=box.querySelector('details'),settings=editorDetails('settings-'+bank.id,'Bank setup');
 for(const child of [...box.children])if(child!==summary&&!child.classList.contains('bank-mod-amounts')&&child.tagName!=='H3'&&child!==bulk)settings.appendChild(child);
 if(bulk)bulk.remove();box.append(action('Edit mappings',()=>goToMapping(bank,bank.controls[0]?.normal||Object.values(bank.controls[0]||{})[0]||{})),settings);
 for(const [i,control] of bank.controls.entries())for(const [variant,binding] of Object.entries(control)){const line=summary.children[i].querySelectorAll('.parameter-layer')[Object.keys(control).indexOf(variant)];const name=line.querySelector('strong')?.textContent||'Unassigned';line.replaceChildren();const link=el('button',name);link.className='bank-map-link';link.title='Edit this mapping in Routing';link.setAttribute('aria-label',bank.name+' control '+(i+1)+' '+variant+' — edit');link.onclick=()=>goToMapping(bank,binding);const subtitle=el('small',layerName(bankDraft.devices.find(d=>d.id===bank.controller),variant));line.append(link,subtitle,liveBankKnob(bank,i,variant,name,['depth','mod_depth_2','mod_depth_3'].includes(binding.parameter)));}

 });
}

document.addEventListener('DOMContentLoaded',()=>{for(const button of document.querySelectorAll('[data-quick-kind]'))button.onclick=()=>{const brain=button.dataset.quickKind==='brain';document.getElementById('quickBrain').hidden=!brain;document.getElementById('quickDevices').hidden=brain;for(const other of document.querySelectorAll('[data-quick-kind]'))other.setAttribute('aria-pressed',String(other===button));};});

let learnAttempt=0,learnToken=null;
function midiLearnButton(controller,target,apply){
 const wrap=el('div');wrap.className='midi-learn';const status=el('small');status.setAttribute('role','status');
 const button=action('MIDI learn',async()=>{
  const attempt=++learnAttempt,revision=bankRevision;
  if(learnToken)fetch('/api/learn/'+learnToken+'/cancel',{method:'POST'}).catch(()=>{});
  learnToken=null;
  const say=text=>{status.textContent=text;document.getElementById('notice').textContent=text;};
  if(bankState?.demo){say('MIDI learn needs the hardware runtime; this simulation does not open MIDI inputs.');return;}
  if(!controller?.input){say('Select an active input port for this controller in Devices first.');return;}
  button.disabled=true;
  try{
   const response=await fetch('/api/learn',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({port:controller.input})});const armed=await response.json();
   if(!response.ok)throw new Error(armed.detail||'Could not arm MIDI learn');
   if(attempt!==learnAttempt){await fetch('/api/learn/'+armed.id+'/cancel',{method:'POST'});return;}
   learnToken=armed.id;cancel.hidden=false;say('Listening to '+controller.name+' — move one control (CC). Existing routing stays active.');
   while(attempt===learnAttempt){
    await new Promise(resolve=>setTimeout(resolve,250));
    if(attempt!==learnAttempt)break;
    if(revision!==bankRevision){await fetch('/api/learn/'+armed.id+'/cancel',{method:'POST'});say('Learning cancelled because the draft changed. Arm again when ready.');break;}
    const poll=await fetch('/api/learn/'+armed.id);if(!poll.ok)throw new Error('Could not read MIDI learn status');const result=await poll.json();
    if(attempt!==learnAttempt||revision!==bankRevision)break;
    if(result.state==='listening')continue;
    if(result.state!=='captured'){say(result.state==='expired'?'No CC received within 30 seconds. Try again.':'MIDI learn '+result.state+'.');break;}
    const sameController=id=>{const d=bankDraft.devices.find(d=>d.id===id);return id===controller.id||(d?.input&&d.input.replace(/ \d+:\d+$/,'')===controller.input.replace(/ \d+:\d+$/,''));};
    const matches=source=>source&&source.channel===result.channel&&source.cc===result.cc;
    const collision=bankDraft.banks.some(b=>sameController(b.controller)&&b.controls.some(c=>Object.values(c).some(x=>x!==target&&matches(x.source))))||bankDraft.resets.some(x=>x!==target&&sameController(x.controller)&&matches(x));
    if(collision){say('MIDI '+result.channel+' / CC '+result.cc+' is already assigned on this controller. Existing assignments were kept.');break;}
    apply({channel:result.channel,cc:result.cc});bankChanged();rebuildBanks();say('Learned '+controller.name+' · MIDI '+result.channel+' / CC '+result.cc+' (value '+result.value+'). Review and apply the draft.');break;
   }
  }catch(error){if(attempt===learnAttempt)say(error.message);}
  finally{if(attempt===learnAttempt)learnToken=null;button.disabled=false;cancel.hidden=true;}
 });
 const cancel=action('Cancel learn',()=>{++learnAttempt;if(learnToken)fetch('/api/learn/'+learnToken+'/cancel',{method:'POST'}).catch(()=>{});learnToken=null;button.disabled=false;cancel.hidden=true;status.textContent='Learning cancelled.';});cancel.hidden=true;
 wrap.append(button,cancel,status);return wrap;
}

function renderBankModAmounts(state,performance){
 if(!performance.native)return;
 for(const root of document.querySelectorAll('.bank-mod-amounts')){
  const bank=state.active.banks.find(b=>b.id===root.dataset.bank);
  const signature=JSON.stringify(performance.config.mods.map(m=>[m.name,m.enabled,m.bank_targets,m.destinations]));
  if(root.dataset.signature!==signature){root.dataset.signature=signature;root.replaceChildren();performance.config.mods.forEach((mod,i)=>{
   if(!modUsesBank(mod,root.dataset.bank))return;
   const key=['depth','mod_depth_2','mod_depth_3'][i];if(bank?.controls.some(c=>Object.values(c).some(b=>b.parameter===key)))return;
   const label=el('label','MOD '+(i+1)+(mod.name==='MOD '+(i+1)?'':' · '+mod.name));const out=el('span');const range=el('input');range.type='range';range.min=0;range.max=100;range.dataset.mod=i;range.setAttribute('aria-label',(bank?.name||root.dataset.bank)+' MOD '+(i+1)+' amount');
   range.oninput=()=>out.textContent=range.value+'%';range.onchange=async()=>{await post('bank-mod-depth',{bank:root.dataset.bank,mod:i,depth:Number(range.value)/100});};label.append(out,range);root.appendChild(label);
  });}
  for(const range of root.querySelectorAll('input')){const i=Number(range.dataset.mod),mod=performance.config.mods[i],connected=modUsesBank(mod,root.dataset.bank);range.disabled=!bank||!connected||banksDirty||performanceDirty||state.staged;range.title=!connected?'Choose a bank destination on MOD':state.staged?'Restart to activate saved settings':'';if(document.activeElement!==range){range.value=Math.round((i===0?bank?.depth:bank?.mod_depths?.[i]||0)*100)||0;range.previousSibling.textContent=!connected?'Not connected':i===0&&new Set(Object.values(bank?.depth_overrides||{})).size>1?'Mixed':range.value+'%'+(!mod.enabled?' · bypassed':'');}}
 }
}

function volumeCurveEditor(device,channel){
 const root=el('div');root.className='volume-curve-editor';
 const draw=()=>{root.replaceChildren();const curve=channel.volume.curve;
 const svg=document.createElementNS('http://www.w3.org/2000/svg','svg');svg.setAttribute('viewBox','0 0 300 90');svg.setAttribute('role','img');svg.setAttribute('aria-label','Attenuation to MIDI CC curve');
 const line=document.createElementNS(svg.namespaceURI,'polyline');line.setAttribute('points',curve.map(([x,y])=>(10+x*280)+','+(80-y/127*70)).join(' '));line.setAttribute('fill','none');line.setAttribute('stroke','currentColor');line.setAttribute('stroke-width','2');svg.appendChild(line);root.appendChild(svg);
 curve.forEach((point,i)=>{const row=el('div');row.className='curve-point';const prefix=device.id+' '+channel.id+' curve '+i;
 const x=bankInput(point[0]*100,prefix+' attenuation percent',v=>point[0]=v/100,'number',0,100);x.step='any';x.disabled=i===0||i===curve.length-1;
 const y=bankInput(point[1],prefix+' CC',v=>point[1]=v,'number',0,127);
 row.append(labeled('Attenuation %',x),labeled(i===0?'Resting CC':i===curve.length-1?'Fully ducked CC':'CC value',y));
 if(i>0&&i<curve.length-1)row.appendChild(action('Remove point',()=>{curve.splice(i,1);bankChanged();draw();}));root.appendChild(row);});
 root.appendChild(action('Add curve point',()=>{let index=0;for(let i=1;i<curve.length-1;i++)if(curve[i+1][0]-curve[i][0]>curve[index+1][0]-curve[index][0])index=i;const a=curve[index],b=curve[index+1];curve.splice(index+1,0,[(a[0]+b[0])/2,Math.round((a[1]+b[1])/2)]);bankChanged();draw();}));
 // Redraw the graph without replacing focused number inputs.
 root.onchange=()=>line.setAttribute('points',curve.map(([x,y])=>(10+x*280)+','+(80-y/127*70)).join(' '));
 };draw();return root;
}

function polishDeviceParameters(){
 for(const table of document.querySelectorAll('#deviceEditor .table-wrap table')){
  const headers=[...table.querySelectorAll('th')].map(h=>h.textContent);table.classList.add('parameter-table');
  table.closest('.table-wrap').classList.add('parameter-rows');
  for(const row of table.querySelectorAll('tr[data-page]')){
   [...row.children].forEach((cell,i)=>{cell.dataset.label=headers[i];cell.dataset.advanced=String(!['Parameter','MIDI ch','CC','Min','Max'].includes(headers[i]));});
   const cell=el('td');cell.className='parameter-options';const button=action('Options',()=>{const open=row.classList.toggle('expanded');button.setAttribute('aria-expanded',String(open));});button.setAttribute('aria-expanded','false');cell.appendChild(button);row.appendChild(cell);
  }
 }
 if(new URLSearchParams(location.search).get('embedded')==='true'){
  for(const box of document.querySelectorAll('#deviceEditor>.bank-form[data-kind=destination]')){
   const identity=el('div');identity.className='device-identity';for(const child of [...box.children])if(child.tagName!=='DETAILS')identity.appendChild(child);box.prepend(identity);
   const channels=[...box.querySelectorAll('.channel-template')];if(!channels.length)continue;
   const deviceId=box.dataset.deviceId,nav=el('nav');nav.className='device-channel-tabs';nav.setAttribute('aria-label','Choose logical channel or parameter set');
   let selected=deviceChannelViews.get(deviceId);if(!channels.some(channel=>channel.dataset.editorKey===selected))selected=channels.find(channel=>channel.open)?.dataset.editorKey||channels[0].dataset.editorKey;
   const show=key=>{deviceChannelViews.set(deviceId,key);for(const channel of channels){channel.hidden=channel.dataset.editorKey!==key;channel.open=true;}for(const button of nav.children)button.setAttribute('aria-pressed',String(button.dataset.channelKey===key));};
   for(const channel of channels){const key=channel.dataset.editorKey;const button=action(channel.querySelector('summary').textContent,()=>show(key));button.dataset.channelKey=key;nav.appendChild(button);}
   channels[0].before(nav);show(selected);
  }
 }
}

function bankPick(options,value,label,change){return pickControl(options,value,label,v=>{change(v);bankChanged();});}

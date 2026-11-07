"""Optional setup/diagnostics; the MIDI runtime does not depend on this module."""
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import HTMLResponse, Response
from pathlib import Path
import copy
import hashlib
import json
from urllib.error import URLError
from .catalog import Catalogue
from pydantic import BaseModel, ConfigDict, Field, StrictInt


class Release(BaseModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)
    release_ms: float = Field(ge=0, le=10000)


class Depth(BaseModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)
    channel: int = Field(strict=True, ge=1, le=6)
    depth: float = Field(ge=0, le=1)


class Reset(BaseModel):
    model_config = ConfigDict(extra="forbid")
    channel: int | None = Field(default=None, strict=True, ge=1, le=6)


class Note(BaseModel):
    model_config = ConfigDict(extra="forbid")
    note: int = Field(default=60, strict=True, ge=0, le=127)
    velocity: int = Field(default=127, strict=True, ge=0, le=127)


class Columns(BaseModel):
    model_config = ConfigDict(extra="forbid")
    columns: list[list[StrictInt]] = Field(min_length=4, max_length=4)


class ColumnReset(BaseModel):
    model_config = ConfigDict(extra="forbid")
    column: int = Field(strict=True, ge=1, le=4)


class Trigger(BaseModel):
    model_config = ConfigDict(extra="forbid")
    channel: int = Field(strict=True, ge=1, le=16)
    note: int | None = Field(default=None, strict=True, ge=0, le=127)


class Ports(BaseModel):
    model_config = ConfigDict(extra="forbid")
    a4_input: str
    twister_input: str
    l6_output: str
    twister_output: str


def create_app(session):
    app = FastAPI(title="MIDIBRAIN performance setup")
    catalogue = Catalogue()

    @app.middleware("http")
    async def same_origin(request: Request, call_next):
        # Browser setup is intended for localhost / an SSH tunnel. Block
        # cross-site writes; do not expose this unauthenticated UI publicly.
        if request.method == "POST":
            origin = request.headers.get("origin")
            expected = f"{request.url.scheme}://{request.headers.get('host', '')}"
            if origin and origin != expected:
                from fastapi.responses import JSONResponse
                return JSONResponse({"detail": "Cross-origin writes are disabled"}, status_code=403)
        return await call_next(request)

    def command(action, **values):
        try:
            session.command(action, **values)
        except ValueError as exc:
            raise HTTPException(400, str(exc)) from exc
        return {"ok": True}

    @app.get("/", response_class=HTMLResponse)
    def index():
        return Path(__file__).with_name('patch.html').read_text()

    @app.get('/tools', response_class=HTMLResponse)
    def tools():
        return PAGE.replace('</html>', EMBEDDED + '</html>')

    @app.get('/workspace', response_class=HTMLResponse)
    @app.get('/surfaces', response_class=HTMLResponse)
    def surfaces():
        from fastapi.responses import RedirectResponse
        return RedirectResponse('/')

    @app.get('/api/surfaces/devices')
    def surface_devices():
        return {'devices': session.bank_snapshot()['active']['devices']}

    @app.get('/api/surfaces/runtime')
    def surface_runtime_state():
        with session.lock:
            snapshot = session.bank_snapshot()
            performance = session.performance_snapshot()
            return {**snapshot, 'instance_id': session.instance_id, 'running': session.running,
                    'performance': {'native': performance.get('native', False), 'mods': performance.get('config', {}).get('mods', []),
                                    'values': performance.get('values', []), 'clock': performance.get('clock', {})},
                    'definitions_revision': hashlib.sha256(json.dumps(snapshot['active']['devices'], sort_keys=True, separators=(',', ':')).encode()).hexdigest(),
                    'staged': snapshot['staged'] or session.next_performance is not None or session.routing_snapshot()['restart_required']}

    @app.post('/api/surfaces/validate-strip')
    def validate_surface_strip(body: dict):
        from .bank_engine import BankEngine
        from .profile import validate
        with session.lock:
            state = surface_runtime_state()
            bank = next((item for item in state['active']['banks'] if item['id'] == body.get('bank')), None)
            if state['staged'] or bank is None or bank != body.get('expected'):
                raise HTTPException(409, 'The runtime mapping changed or settings are staged. Read the active rig again.')
            replacement = body.get('replacement')
            if not isinstance(replacement, dict) or replacement.get('id') != bank['id']:
                raise HTTPException(400, 'Keep the runtime strip identity when proposing edits.')
            candidate = session.engine.settings_profile()
            candidate['bank_setup'] = copy.deepcopy(state['active'])
            candidate['bank_setup']['banks'] = [copy.deepcopy(replacement) if item['id'] == bank['id'] else item for item in candidate['bank_setup']['banks']]
            try:
                validate(candidate)
                BankEngine(candidate, lambda message: None)
            except (ValueError, KeyError, TypeError, IndexError) as exc:
                raise HTTPException(400, str(exc)) from exc
            return {'ok': True}

    @app.get('/surfaces.js')
    def surfaces_script():
        return Response(Path(__file__).with_name('surfaces.js').read_text(), media_type='text/javascript')

    @app.get('/surface-model.mjs')
    def surface_model():
        return Response(Path(__file__).with_name('surface-model.mjs').read_text(), media_type='text/javascript')

    @app.get('/surface-runtime.mjs')
    def surface_runtime():
        return Response(Path(__file__).with_name('surface-runtime.mjs').read_text(), media_type='text/javascript')

    @app.get('/surfaces.css')
    def surfaces_style():
        return Response(Path(__file__).with_name('surfaces.css').read_text(), media_type='text/css')

    @app.get('/workspace-tools.css')
    def workspace_tools_css():
        return Response(Path(__file__).with_name('workspace-tools.css').read_text(), media_type='text/css')

    @app.post('/api/learn')
    def arm_learn(body: dict):
        try: return session.arm_learn(body.get('port'), body.get('type', 'cc'))
        except ValueError as exc: raise HTTPException(400, str(exc)) from exc

    @app.get('/api/learn/{token}')
    def learn_status(token: str):
        return session.learn_status(token)

    @app.post('/api/learn/{token}/cancel')
    def cancel_learn(token: str):
        return session.learn_status(token, cancel=True)

    def catalogue_call(operation, *args):
        try:
            return operation(*args)
        except (URLError, OSError) as exc:
            raise HTTPException(502, "Could not reach the MIDI catalogue; check connectivity and try again") from exc
        except ValueError as exc:
            raise HTTPException(400, str(exc)) from exc

    @app.get("/api/catalog")
    def catalogue_index():
        return catalogue_call(catalogue.index)

    @app.get("/api/catalog/preview")
    def catalogue_preview(path: str):
        return catalogue_call(catalogue.preview, path)

    @app.post("/api/catalog/import")
    def catalogue_import(body: dict):
        if not isinstance(body.get('path'), str) or not isinstance(body.get('selected'), list):
            raise HTTPException(400, "CSV path and selected parameter rows are required")
        preview = catalogue_call(catalogue.preview, body['path'])
        if body.get('revision') != preview['revision']:
            raise HTTPException(409, "Catalogue changed; preview the file again before importing")
        return catalogue_call(catalogue.device, body['path'], body['selected'])

    @app.get('/performance.js')
    def performance_script():
        return Response(Path(__file__).with_name('performance.js').read_text(), media_type='text/javascript')

    @app.get('/activity.js')
    def activity_script():
        return Response(Path(__file__).with_name('activity.js').read_text(), media_type='text/javascript')

    @app.post('/api/bank-mod-depth')
    def bank_mod_depth(body: dict):
        if set(body) != {'bank', 'mod', 'depth'}: raise HTTPException(400, 'Bank, MOD and depth are required')
        return command('bank_mod_depth', **body)

    @app.get('/api/performance')
    def performance_state():
        return session.performance_snapshot()

    @app.get('/api/activity')
    def activity_state():
        return session.activity_snapshot()

    @app.post('/api/performance/config')
    def performance_config(body: dict):
        return command('performance_config', config=body)

    @app.post('/api/bank-control')
    def bank_control(body: dict):
        required = {'bank', 'index', 'layer', 'value', 'expected'}
        guards = {'runtime_instance', 'definitions_revision'}
        if set(body) not in (required, required | guards): raise HTTPException(400, 'Bank, control, input and value are required')
        with session.lock:
            if guards <= body.keys():
                state = surface_runtime_state()
                if state['staged'] or not state['running'] or body['runtime_instance'] != state['instance_id'] or body['definitions_revision'] != state['definitions_revision']:
                    raise HTTPException(409, 'Runtime or device definitions changed. Read the active rig again.')
            return command('bank_control', **{key: body[key] for key in required})

    @app.post('/api/performance/control')
    def performance_control(body: dict):
        if set(body) != {'index', 'kind', 'value', 'expected'}: raise HTTPException(400, 'Action and value are required')
        return command('performance_control', **body)

    @app.post('/api/performance/action')
    def performance_action(body: dict):
        return command('performance_action', command=body)

    @app.post('/api/performance/delete')
    def performance_delete(body: dict):
        return command('snapshot_delete', slot=body.get('slot'))

    @app.post('/api/performance/retry')
    def performance_retry():
        return command('snapshot_retry')

    @app.get('/live_banks.js')
    def live_banks_script():
        return Response(Path(__file__).with_name('live_banks.js').read_text(), media_type='text/javascript')

    @app.get('/mappings.js')
    def mappings_script():
        return Response(Path(__file__).with_name('mappings.js').read_text(), media_type='text/javascript')

    @app.get('/controls.js')
    def controls_script():
        return Response(Path(__file__).with_name('controls.js').read_text(), media_type='text/javascript')

    @app.get('/shell.js')
    def shell_script():
        return Response(Path(__file__).with_name('shell.js').read_text(), media_type='text/javascript')

    @app.get('/shell.css')
    def shell_style():
        return Response(Path(__file__).with_name('shell.css').read_text(), media_type='text/css')

    @app.get('/settings.js')
    def settings_script():
        return Response(Path(__file__).with_name('settings.js').read_text(), media_type='text/javascript')

    @app.get("/catalog.js")
    def catalogue_script():
        return Response(Path(__file__).with_name("catalog.js").read_text(), media_type="text/javascript")

    @app.get("/banks.js")
    def banks_script():
        return Response(Path(__file__).with_name("banks.js").read_text(), media_type="text/javascript")

    @app.get("/api/banks")
    def banks():
        return session.bank_snapshot()

    @app.post("/api/banks")
    def bank_setup(body: dict):
        return command("bank_setup", setup=body)

    @app.post("/api/bank-depth")
    def bank_depth(body: dict):
        if set(body) != {"bank", "depth"} or not isinstance(body.get("bank"), str):
            raise HTTPException(400, "Bank and depth are required")
        return command("bank_depth", **body)

    @app.post("/api/bank-reset")
    def bank_reset(body: dict):
        if set(body) != {"bank"} or not isinstance(body.get("bank"), str):
            raise HTTPException(400, "Bank is required")
        return command("bank_reset", **body)

    @app.get("/patchbay.js")
    def patchbay_script():
        return Response(Path(__file__).with_name("patchbay.js").read_text(), media_type="text/javascript")

    @app.post("/api/routing")
    def set_routing(body: dict):
        return command("routing", routing=body)

    @app.get("/api/status")
    def status():
        return session.snapshot()

    @app.post("/api/release")
    def release(body: Release):
        return command("release", **body.model_dump())

    @app.get("/api/routing")
    def routing():
        return session.routing_snapshot()

    @app.post("/api/trigger")
    def trigger(body: Trigger):
        return command("trigger", **body.model_dump())

    @app.post("/api/ports")
    def ports(body: Ports):
        return command("ports", ports=body.model_dump())

    @app.post("/api/depth")
    def depth(body: Depth):
        return command("depth", **body.model_dump())

    @app.post("/api/reset")
    def reset(body: Reset):
        return command("reset", **body.model_dump())

    @app.post("/api/columns")
    def columns(body: Columns):
        return command("columns", **body.model_dump())

    @app.post("/api/reset-column")
    def reset_column(body: ColumnReset):
        return command("reset_column", **body.model_dump())

    @app.post("/api/panic")
    def panic():
        return command("panic")

    @app.post('/api/settings')
    def settings(body: dict):
        try: return session.save_settings(body)
        except ValueError as exc: raise HTTPException(400, str(exc)) from exc
        except OSError as exc: raise HTTPException(500, 'Settings could not be saved; edits were kept') from exc

    @app.post('/api/restart')
    def restart_runtime():
        try:
            session.restart_process()
            return {'ok': True, 'instance_id': session.instance_id}
        except ValueError as exc:
            raise HTTPException(400, str(exc)) from exc

    @app.post("/api/save")
    def save():
        return command("save")

    @app.post("/api/demo-note")
    def note(body: Note):
        return command("note", **body.model_dump())

    from .patch_routes import register as register_patch
    register_patch(app, session)
    from .manual import register as register_manual
    register_manual(app)
    return app


EMBEDDED = """<link rel="stylesheet" href="/workspace-tools.css"><style>
.app-sidebar,.sidebar-scrim,#toggleSidebar,.workspace-location{display:none!important}
.app-shell{grid-template-columns:minmax(0,1fr)!important;--green:var(--cyan)}
.runtime-label{display:none}
#group-mixer{display:none!important}
.app-shell #save{background:#222f37;color:var(--cyan);border-color:#3c6475}
#workspace-snapshots>#snapshotsDisclosure{border:0;padding:0}
#workspace-snapshots>#snapshotsDisclosure>summary{display:none}
#workspace-snapshots #snapshotEditor>section:last-child{display:none}
</style><script>
const snapshotWorkspace=document.createElement('div');
snapshotWorkspace.id='workspace-snapshots';snapshotWorkspace.className='workspace';snapshotWorkspace.hidden=true;
snapshotWorkspace.append(document.getElementById('snapshotsDisclosure'));
document.getElementById('workspaceMain').append(snapshotWorkspace);
const routingNote=document.createElement('p');routingNote.className='muted';
routingNote.textContent='Executable controller mappings and MIDI paths. Canvas output previews are calculated separately; freeform canvas modules remain design-only.';
document.querySelector('#group-controls>section').insertBefore(routingNote,document.getElementById('quickDevices'));
const canvasActivity=document.createElement('section');canvasActivity.id='canvasActivity';
const canvasActivityHeading=document.createElement('h2');canvasActivityHeading.textContent='Canvas activity';
const canvasLayoutStatus=document.createElement('p'),canvasOutputStatus=document.createElement('p'),canvasOutputHeading=document.createElement('h3'),canvasOutputPreview=document.createElement('div');
canvasActivity.append(canvasActivityHeading,canvasLayoutStatus,canvasOutputStatus,canvasOutputHeading,canvasOutputPreview);
document.getElementById('workspace-activity').prepend(canvasActivity);
function navigateEmbedded(name){
 if(name==='mixer')name='controls';
 document.body.dataset.tool=name;
 if(['sidechain','controls','clock'].includes(name))showGroup(name);
 else if(['devices','activity','snapshots'].includes(name))showWorkspace(name);
 if(name==='snapshots')document.getElementById('snapshotsDisclosure').open=true;
 document.getElementById('workspaceMain').scrollTop=0;
}
function embeddedHasEdits(){return settingsSaving||embeddedStaging||hasSettingsEdits();}
let embeddedStaging=false;
window.addEventListener('message',async event=>{
 if(event.origin!==location.origin||event.source!==parent)return;
 if(event.data?.type==='midibrain:pane-layout')document.body.dataset.dock=event.data.direction==='stack'?'stack':'side';
 if(event.data?.type==='midibrain:canvas-activity'){
  const data=event.data;canvasLayoutStatus.textContent=data.layout;canvasOutputStatus.textContent=data.status;canvasOutputHeading.textContent=data.heading;canvasOutputPreview.replaceChildren();
  for(const text of (data.lines||[]).slice(0,16)){const line=document.createElement('p');line.textContent=text;canvasOutputPreview.append(line);}
 }
 if(event.data?.type==='midibrain:navigate')navigateEmbedded(event.data.workspace);
 if(event.data?.type==='midibrain:stage-strip'){
  const data=event.data,active=bankState?.active.banks.find(bank=>bank.id===data.bank),index=bankDraft?.banks.findIndex(bank=>bank.id===data.bank);
  if(settingsSaving||embeddedStaging||!active||index<0||JSON.stringify(active)!==JSON.stringify(data.expected)||JSON.stringify(bankDraft.banks[index])!==JSON.stringify(data.expected)){
   parent.postMessage({type:'midibrain:stage-result',ok:false,message:'The rig or its draft changed. Save/discard edits and read the active rig again.'},location.origin);return;
  }
  embeddedStaging=true;
  try{
   const response=await fetch('/api/surfaces/validate-strip',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({bank:data.bank,expected:data.expected,replacement:data.replacement})}),result=await response.json();
   if(!response.ok)throw new Error(result.detail||'Strip validation failed');
   if(settingsSaving||JSON.stringify(bankDraft.banks[index])!==JSON.stringify(data.expected))throw new Error('The rig draft changed during validation. No draft was replaced.');
   bankDraft.banks[index]=data.replacement;bankChanged();rebuildBanks();
   goToMapping(bankDraft.banks[index],bankDraft.banks[index].controls[0]?.normal||{});navigateEmbedded('controls');
   parent.postMessage({type:'midibrain:stage-result',ok:true,message:'Strip edits are validated and in the rig draft. Review and Save settings; restart when required. No MIDI was sent.'},location.origin);
  }catch(error){parent.postMessage({type:'midibrain:stage-result',ok:false,message:error.message},location.origin);}
  finally{embeddedStaging=false;}
 }
});
let embeddedReady=false;
setInterval(()=>{
 if(bankState&&bankDraft&&!embeddedReady){embeddedReady=true;parent.postMessage({type:'midibrain:editor-ready'},location.origin);}
 parent.postMessage({type:'midibrain:editor-state',dirty:hasSettingsEdits(),saving:settingsSaving,workspace:activeWorkspace==='groups'?activeGroup:activeWorkspace},location.origin);
},200);
</script>"""

PAGE = """<!doctype html>
<html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>midi:brain · Brain</title>
<style>
:root{color-scheme:dark;font:13px/1.6 "SFMono-Regular",Consolas,"Liberation Mono",monospace;background:#111214;color:#d8d8da;--accent:#dedee2;--muted:#92949c;--line:#35363c;--panel:#18191c}
*{box-sizing:border-box}body{max-width:1240px;margin:0 auto;padding:30px 32px 20px}button,input{font:inherit;color:inherit}button{border:1px solid var(--line);border-radius:0;padding:9px 12px;background:transparent;cursor:pointer;font-size:12px}button::before{content:'[ ';color:var(--accent)}button::after{content:' ]';color:var(--accent)}button:hover{background:#28292e;border-color:var(--accent);color:#ffffff}button:disabled{opacity:.45;cursor:default}button:focus-visible,input:focus-visible,summary:focus-visible{outline:2px solid var(--accent);outline-offset:4px}input{border:1px solid var(--line);border-radius:0;background:#111214;padding:7px}input[type=number]{width:96px;color:var(--accent)}input[type=checkbox]{accent-color:var(--accent);width:15px;height:15px;margin:0}input[type=range]{width:100%;padding:0;accent-color:var(--accent);cursor:pointer}
.masthead{display:flex;justify-content:space-between;align-items:center;border-top:1px solid var(--accent);border-bottom:1px solid var(--line);padding:25px 0;gap:20px}.eyebrow,.section-id,.terminal-label{color:var(--muted);font-size:11px;letter-spacing:1.8px;text-transform:uppercase}.brand{display:flex;gap:16px;align-items:center}.mark{font-size:23px;color:var(--accent);line-height:1.1;white-space:pre}h1{font-size:29px;letter-spacing:-1.5px;line-height:1.2;margin:5px 0;color:var(--accent);font-weight:500}h1 span{color:#777982}h2{font-size:15px;font-weight:500;color:var(--accent);margin:0;text-transform:uppercase;letter-spacing:1px}p{color:var(--muted);margin:8px 0 16px}.rig{text-align:right;font-size:11px;line-height:1.9;color:var(--muted)}.rig b{color:#d8d8da;font-weight:400}.status{padding:12px 0;color:var(--accent);font-size:12px;border-bottom:1px dashed var(--line)}.status::before{content:'> ';color:var(--muted)}#notice{color:#edc789;min-height:20px;margin:8px 0;font-size:12px;overflow-wrap:anywhere}
section{padding:22px 0;border-bottom:1px solid var(--line)}.section-head{display:flex;justify-content:space-between;align-items:center;gap:12px;margin-bottom:12px}.bar{display:flex;gap:12px;align-items:center;flex-wrap:wrap}.bar label{margin:0}.settings{display:flex;justify-content:space-between;gap:16px;flex-wrap:wrap}.settings p{margin:10px 0 0}.grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px}.channel{border:1px solid var(--line);background:var(--panel);padding:16px;min-width:0}.channel strong{display:block;font-size:12px;font-weight:400;color:var(--accent);letter-spacing:1.5px;text-transform:uppercase}.channel strong::before{content:'+-- ';color:#777982}.channel .targets{font-size:12px;color:#d8d8da;min-height:20px;margin:8px 0 14px}.channel button{width:100%;font-size:11px;padding:8px 3px}.knob{padding:9px 0;border-top:1px dashed var(--line);display:flex;justify-content:space-between;gap:8px;font-size:12px}.knob small{color:var(--muted);font-size:11px;text-align:right}.knob small::before{content:'/ ';color:#777982}fieldset{border:0;border-top:1px solid var(--line);padding:8px 0 16px;margin:0}legend{font-size:10px;text-transform:uppercase;letter-spacing:1px;color:var(--muted);padding:0 6px 0 0}fieldset label{display:inline-flex;align-items:center;gap:5px;margin:4px 9px 0 0;font-size:12px}.mixed{color:#edc789;font-size:11px;min-height:35px;margin:12px 0 4px}.muted{color:var(--muted);font-size:11px}.routing-help{max-width:95ch;margin:14px 0}.routing-help summary{cursor:pointer;color:var(--muted);font-size:11px}.routing-help p{font-size:12px;border-left:1px solid var(--line);padding-left:12px}.depth-grid{display:grid;grid-template-columns:repeat(6,minmax(0,1fr));gap:16px}.depth-grid label{border:1px solid var(--line);padding:12px;font-size:11px;text-transform:uppercase;color:var(--muted)}.depth-grid label span{float:right;color:var(--accent)}.depth-grid input{display:block;margin-top:18px}.actions{justify-content:space-between}#panic{border-color:#897044;color:#edc789}#save{background:var(--accent);color:#17181b;border-color:var(--accent)}#save::before,#save::after{color:inherit}pre{max-height:240px;overflow:auto;font:11px/1.8 "SFMono-Regular",Consolas,monospace;background:#101113;border:1px solid var(--line);padding:14px;color:#aaacb5;margin:0;min-height:85px}footer{display:flex;justify-content:space-between;gap:12px;padding:18px 0;color:#92949c;font-size:10px;letter-spacing:1px}label{display:block}
@media(max-width:850px){body{padding:20px}.grid{grid-template-columns:repeat(2,minmax(0,1fr))}.depth-grid{grid-template-columns:repeat(3,minmax(0,1fr))}.rig{display:none}}
@media(max-width:420px){body{padding:12px}.grid{grid-template-columns:1fr}.depth-grid{grid-template-columns:repeat(2,minmax(0,1fr))}h1{font-size:26px}.section-head{align-items:flex-start}.section-id{font-size:10px}footer{flex-direction:column}}

.channel:nth-child(1){--accent:#d58cdb}.channel:nth-child(2){--accent:#e4b078}.channel:nth-child(3){--accent:#89c69b}.channel:nth-child(4){--accent:#75bed9}
.channel{border-top:2px solid var(--accent)}.channel strong,.channel .targets{color:var(--accent)}
select{font:inherit;color:inherit;background:var(--panel);border:1px solid var(--line);padding:8px;max-width:100%;min-width:0}select:focus-visible{outline:2px solid var(--accent);outline-offset:3px}
.device-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:14px;margin:16px 0}.device-grid select{width:100%;margin-top:5px}.device-grid small{display:block;color:var(--muted);overflow-wrap:anywhere;margin-top:5px}.inventory{white-space:pre-wrap;overflow-wrap:anywhere;max-height:180px}.table-wrap{overflow:auto;margin-top:16px}table{width:100%;border-collapse:collapse;font-size:12px}th,td{text-align:left;padding:10px;border-bottom:1px solid var(--line);vertical-align:top}th{color:var(--muted);font-weight:400}td:last-child{white-space:pre-line}.knob{cursor:pointer;background:transparent;border:0;border-top:1px dashed var(--line);width:100%;text-align:left}.channel .knob{padding:9px 0;font-size:12px}.knob::before,.knob::after{content:none}.knob:hover{color:var(--accent)}.channel .knob[aria-pressed=true]{color:var(--accent);background:#24252a}
@media(max-width:600px){.device-grid{grid-template-columns:1fr}}
.port-card,.cc-route{border:1px solid var(--line);padding:16px;background:var(--panel);min-width:0;margin-bottom:12px}.port-card h3{font-size:13px;font-weight:500;margin:0 0 12px}.port-card p{margin:5px 0;overflow-wrap:anywhere}.port-card .direction{color:#75bed9}.checkline{display:flex;align-items:center;gap:8px}.route-source,.route-target{display:flex;align-items:end;flex-wrap:wrap;gap:10px;margin:12px 0}.route-source label:first-child,.route-target label:first-child{flex:1;min-width:180px}.route-source select,.route-target select{width:100%}.route-source input,.route-target input{width:70px}.route-target{padding-left:18px;border-left:2px solid #75bed9}#clockTargets{margin-top:18px}#clockTargets label{display:flex;overflow-wrap:anywhere;margin:10px 0}.cc-route h3{font-size:13px;font-weight:400;margin:0}.port-card h3{overflow-wrap:anywhere}#activePatchbay{white-space:pre-wrap;overflow-wrap:anywhere}

:root{--magenta:#d58cdb;--amber:#e4b078;--green:#89c69b;--cyan:#75bed9}
[hidden]{display:none!important}.masthead{border-top:0;position:relative}.masthead::before{content:'';height:3px;position:absolute;top:0;left:0;right:0;background:linear-gradient(to right,var(--magenta) 25%,var(--amber) 25%,var(--amber) 50%,var(--green) 50%,var(--green) 75%,var(--cyan) 75%)}.mark,h1 span{color:var(--magenta)}.eyebrow{color:var(--cyan)}.palette{display:inline-flex;gap:5px}.palette i{width:23px;height:4px;background:var(--magenta)}.palette i:nth-child(2){background:var(--amber)}.palette i:nth-child(3){background:var(--green)}.palette i:nth-child(4){background:var(--cyan)}
.workspace-nav{display:flex;gap:8px;align-items:center;border-bottom:1px solid var(--line);padding:12px 0;flex-wrap:wrap}.workspace-nav>[data-workspace]{--accent:var(--cyan)}.workspace-nav>[data-workspace][aria-pressed=true]{color:var(--cyan);background:#192329;border-color:var(--cyan)}.save-area{margin-left:auto;display:flex;align-items:center;gap:12px}#save{background:#26322b;color:var(--green);border-color:#496451}.workspace-heading{padding:26px 0 8px}.workspace-heading h2{font-size:22px;text-transform:none;margin-top:4px}.group-nav{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px;margin:12px 0 26px}.group-nav button{display:flex;flex-direction:column;align-items:flex-start;text-align:left;gap:8px;padding:16px;background:var(--panel);border-top:2px solid var(--accent);min-width:0;white-space:normal}.group-nav button::before,.group-nav button::after{content:none}.group-nav button:nth-child(1),#group-mixer{--accent:var(--magenta)}.group-nav button:nth-child(2),#group-sidechain{--accent:var(--amber)}.group-nav button:nth-child(3),#group-controls{--accent:var(--green)}.group-nav button:nth-child(4),#group-clock{--accent:var(--cyan)}.group-nav button[aria-pressed=true]{border-color:var(--accent);background:color-mix(in srgb,var(--accent) 10%,var(--panel))}.group-kind{color:var(--accent);font-size:10px;letter-spacing:1px}.group-nav strong{font-size:14px;color:var(--accent);font-weight:500}.group-nav span:not(.group-kind),.group-nav small{font-size:11px;color:var(--muted)}.group-nav small{margin-top:auto;padding-top:6px}.group-panel>section:first-child{padding-top:4px}.group-panel .section-id{color:var(--accent)}.group-panel h2{color:var(--accent)}.group-link{padding:12px 0}.group-link button{font-size:11px;border:0;padding:2px;color:var(--accent)}.routing-actions{padding:20px 0;--accent:var(--green)}.routing-actions details{margin-top:16px}.cc-route{border-left:2px solid var(--green)}.cc-route h3{color:var(--green)}.route-target{border-color:var(--cyan)}.port-card{border-top:2px solid var(--cyan)}.port-card:nth-child(4n+1){border-color:var(--magenta)}.port-card:nth-child(4n+2){border-color:var(--amber)}.port-card:nth-child(4n+3){border-color:var(--green)}.port-card h3{color:var(--cyan)}#workspace-activity{--accent:var(--green)}#events{border-left:2px solid var(--green)}.depth-grid label{border-top:2px solid var(--amber)}.depth-grid label span{color:var(--amber)}.depth-grid input{accent-color:var(--amber)}.group-panel:focus{outline:none}#workspace-devices h2{color:var(--cyan)}
@media(max-width:850px){.group-nav{grid-template-columns:repeat(2,minmax(0,1fr))}.save-area .muted{display:none}}
@media(max-width:420px){.group-nav{gap:8px}.group-nav button{padding:12px}.group-nav strong{font-size:12px}.save-area{margin-left:0}.workspace-nav{gap:6px}.workspace-nav button{padding:7px}.section-head{flex-wrap:wrap}}
.bank-form{border:1px solid var(--line);border-top:2px solid var(--accent);padding:16px;margin:16px 0;background:var(--panel)}.bank-form:nth-child(4n+1){--accent:var(--magenta)}.bank-form:nth-child(4n+2){--accent:var(--amber)}.bank-form:nth-child(4n+3){--accent:var(--green)}.bank-form:nth-child(4n+4){--accent:var(--cyan)}.bank-form h3{color:var(--accent);font-size:14px;font-weight:500}.bank-form .bar{margin:10px 0}.bank-form input[type=text]{max-width:220px;width:100%}.bank-form table input{width:65px}.bank-form table select{max-width:170px}.bank-form table td{min-width:75px}.bank-form summary{color:var(--accent);cursor:pointer}.bank-form details{margin-top:14px}.bank-form label{font-size:11px;color:var(--muted)}.bank-form input[type=checkbox]{margin:0 5px}.bank-form table label{display:inline-block}.bank-form .table-wrap{margin:8px 0}.bank-form select{max-width:260px}.device-title{color:var(--cyan)}#bankActions{border-top:1px solid var(--line)}#bankDepths{grid-template-columns:repeat(auto-fit,minmax(160px,1fr))}

body{max-width:1560px}.device-tabs{display:flex;gap:8px;flex-wrap:wrap;margin:18px 0}.device-tabs button[aria-pressed=true]{border-color:var(--cyan);color:var(--cyan);background:#1b292e}#bankEditor{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,290px),1fr));gap:14px;align-items:start}#bankEditor>.bank-form{margin:0;min-width:0}#bankEditor>.bank-form>.bar{display:grid;grid-template-columns:1fr 1fr;gap:8px}#bankEditor label{min-width:0}#bankEditor select,#bankEditor input[type=text]{width:100%;max-width:100%}#bankEditor button{font-size:11px;padding:7px}#bankEditor .bar>label:first-child{grid-column:1/-1}#bankEditor fieldset label{margin-right:10px}.bank-parameters{margin:16px 0;display:grid;gap:5px}.bank-parameter{border-top:1px solid var(--line);padding:9px 0;display:grid;grid-template-columns:20px 1fr;gap:5px}.bank-parameter>span{color:var(--accent)}.parameter-layer{display:flex;align-items:baseline;justify-content:space-between;gap:8px}.parameter-layer strong{font-weight:500;color:var(--accent);font-size:14px}.parameter-layer small{color:var(--muted);font-size:10px}#bankEditor>.bank-form:has(details[open]){grid-column:1/-1}#bankEditor>.bank-form:has(details[open])>.bar{display:flex;flex-wrap:wrap}#deviceEditor .table-wrap table input[type=text]{width:100%;max-width:none;min-width:210px}#deviceEditor .table-wrap td:nth-child(2){min-width:240px}.channel-template{border-top:1px solid var(--line);padding:20px 0}.device-attribution{font-size:11px;overflow-wrap:anywhere}a{color:var(--cyan)}#catalogFiles{max-height:260px;overflow:auto;display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:8px;margin:14px 0}#catalogPreview{margin:20px 0}#catalogPreview .table-wrap{max-height:400px;overflow:auto}.catalog-import-actions{display:flex;gap:12px;align-items:center;flex-wrap:wrap;margin:14px 0}.bank-form .parameter-layer strong{overflow-wrap:anywhere}.channel-mode-help{max-width:85ch}
@media(min-width:1300px){#bankEditor{grid-template-columns:repeat(4,minmax(0,1fr))}}
@media(max-width:600px){#bankEditor{grid-template-columns:1fr}.device-tabs{gap:5px}}
#bankEditor>.bank-form>.bar>label{grid-column:1/-1}#deviceEditor .table-wrap{max-height:480px;overflow:auto}#deviceEditor th{position:sticky;top:0;background:var(--panel);z-index:1}
.bank-mod-amounts.depth-grid{grid-template-columns:minmax(0,1fr);gap:10px;margin:20px 0}.bank-mod-amounts.depth-grid label{display:block;min-width:0;padding:10px;text-transform:none;overflow-wrap:anywhere}.bank-mod-amounts.depth-grid label span{float:none;display:block;margin-top:5px}.bank-mod-amounts.depth-grid input{width:100%;margin-top:8px}
</style>
<style>
.group-nav,#bankEditor{grid-template-columns:repeat(4,minmax(0,1fr));gap:14px}
#bankEditor>.bank-form{padding:18px}.bank-parameters{margin:12px 0 20px}.parameter-layer{padding:10px 8px;margin:2px 0;border-radius:5px;cursor:pointer}.parameter-layer:hover,.parameter-layer:focus-visible{background:color-mix(in srgb,var(--accent) 12%,transparent);outline:1px solid var(--accent)}
#bankEditor .bank-parameter{grid-template-columns:22px minmax(0,1fr)}#bankEditor details{margin-top:12px}#bankEditor summary{font-size:12px}
#brainActions{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:14px;margin:20px 0}#brainActions>.bank-form{margin:0;padding:20px;--accent:var(--green);border-top:2px solid var(--accent)}#brainActions>[data-action=depth]{--accent:var(--magenta)}#brainActions>[data-action=release]{--accent:var(--amber)}#brainActions>[data-action=panic]{--accent:var(--cyan)}#brainActions summary{font-size:15px;line-height:1.6}#brainActions .bar{display:grid;grid-template-columns:1fr 1fr;align-items:end}#brainActions label{display:flex;flex-direction:column;gap:7px;font-size:11px}#brainActions input,#brainActions select{width:100%;min-width:0}#brainActions p{font-size:11px}
.device-tabs{display:inline-flex;background:var(--panel);border:1px solid var(--line);border-radius:8px;padding:4px;gap:3px}.device-tabs button{border:0;border-radius:5px;padding:9px 16px;font-size:12px}.device-tabs button::before,.device-tabs button::after{content:none}#deviceEditor{display:grid;grid-template-columns:220px minmax(0,1fr);gap:20px;align-items:start}.device-picker{display:flex;flex-direction:column;gap:5px;position:sticky;top:12px}.device-picker button{text-align:left;white-space:normal;border:0;border-left:2px solid transparent;padding:14px}.device-picker button::before,.device-picker button::after{content:none}.device-picker button[aria-pressed=true]{border-color:var(--cyan);background:var(--panel);color:var(--cyan)}.device-picker small{display:block;color:var(--muted);margin-top:8px}#deviceEditor>.bank-form{margin:0;min-width:0}
.control-inspector{width:min(780px,calc(100vw - 32px));max-height:85vh;overflow:auto;box-sizing:border-box;background:var(--panel);color:var(--text);border:1px solid var(--cyan);border-radius:10px;padding:24px;--accent:var(--cyan)}.control-inspector::backdrop{background:#000a;backdrop-filter:blur(3px)}.inspector-heading{display:flex;align-items:center;justify-content:space-between;gap:16px}.inspector-fields{display:grid;grid-template-columns:1fr 1fr;gap:16px}.inspector-fields h3{font-size:12px}.inspector-destinations{grid-column:1/-1;grid-row:2;padding:16px;background:#101214;border-radius:7px}.inspector-fields select,.inspector-fields input{max-width:100%;width:100%;box-sizing:border-box}.inspector-destinations .bar{display:grid;grid-template-columns:1fr 1fr;padding:14px 0;border-top:1px solid var(--line)}.inspector-destinations label{display:flex;flex-direction:column;gap:6px;font-size:11px}
@media(max-width:1100px){.group-nav,#bankEditor{grid-template-columns:repeat(2,minmax(0,1fr))}#brainActions{grid-template-columns:repeat(2,minmax(0,1fr))}#deviceEditor{grid-template-columns:175px minmax(0,1fr)}}
@media(max-width:650px){.group-nav,#bankEditor,#brainActions{grid-template-columns:1fr}#deviceEditor{grid-template-columns:1fr}.device-picker{position:static;flex-direction:row;overflow:auto}.device-picker button{min-width:150px}.inspector-fields{gap:10px}.control-inspector{padding:16px}.device-tabs{display:flex}.device-tabs button{padding:8px}}

#deviceEditor>.bank-form{grid-column:2;grid-row:1}.device-picker{grid-column:1;grid-row:1;max-height:70vh;overflow:auto;min-width:0;background:var(--bg,#101214)}
#brainActions{grid-template-columns:240px minmax(0,1fr);align-items:start}#brainActions>.bank-form{grid-column:2;grid-row:1;min-width:0}#brainActions .device-picker{position:static}#brainActions>.bank-form h3{margin-top:0}.slot-name{display:flex;flex-direction:column;gap:6px;margin:8px 0 16px}.slot-name input{width:100%;min-width:140px}
@media(max-width:650px){#brainActions,#deviceEditor{grid-template-columns:1fr}#deviceEditor>.bank-form,#brainActions>.bank-form{grid-column:1;grid-row:2}.device-picker{grid-column:1;grid-row:1;max-height:none;position:static;flex-direction:row}.device-picker button{flex:0 0 170px}}

.midi-learn{display:flex;flex-wrap:wrap;gap:6px;align-items:flex-start;margin-top:8px;min-width:0}.midi-learn button{white-space:nowrap;flex:0 0 auto;max-width:none}.midi-learn small{flex-basis:100%;overflow-wrap:anywhere}.table-wrap td:has(.midi-learn){min-width:150px}.parameter-layer{flex-wrap:wrap}.parameter-layer strong{min-width:0}
/* Performance editors */
.group-nav{grid-template-columns:repeat(4,minmax(0,1fr))}
.workspace-disclosure{border:1px solid var(--line);border-radius:8px;padding:16px 20px;margin:22px 0}
.workspace-disclosure>summary{font-size:15px;cursor:pointer}.workspace-disclosure small{color:var(--muted);margin-left:16px;font-size:11px}
.snapshot-picker,.mod-picker{display:grid;gap:10px;margin:18px 0}.snapshot-picker{grid-template-columns:repeat(4,minmax(0,1fr))}.mod-picker{grid-template-columns:repeat(3,minmax(0,1fr))}
.snapshot-picker button,.mod-picker button{text-align:left;white-space:normal;padding:16px;border:1px solid var(--line);border-radius:7px;background:var(--panel)}
.snapshot-picker button::before,.snapshot-picker button::after,.mod-picker button::before,.mod-picker button::after,.action-picker button::before,.action-picker button::after{content:none}
.snapshot-picker small,.mod-picker small,.action-picker small{display:block;font-size:11px;color:var(--muted);margin-top:8px}
.mod-picker button[aria-pressed=true]{border-color:var(--amber);background:#2a251e;color:var(--amber)}
.mod-surface{border:1px solid var(--line);border-radius:10px;overflow:hidden;background:var(--panel)}.mod-heading{padding:20px 24px;display:flex;align-items:center;justify-content:space-between;gap:16px;border-bottom:1px solid var(--line)}.mod-heading h3{margin:0}
.mod-section{padding:22px 24px;border-bottom:1px solid var(--line)}.mod-section:last-child{border-bottom:0}.mod-section h4{margin:0 0 16px;font-size:12px;color:var(--amber);letter-spacing:1px}
.mod-fields{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:16px}.mod-fields label,.actions-form label{display:flex;flex-direction:column;gap:7px;font-size:12px;min-width:0}.mod-fields input,.mod-fields select,.actions-form input,.actions-form select{max-width:100%;width:100%;box-sizing:border-box}.mod-fields input[type=checkbox],.actions-form input[type=checkbox]{width:auto;align-self:start}
.mod-fields button{align-self:end}.mod-bank-row{display:grid;grid-template-columns:120px minmax(140px,1fr) minmax(130px,1fr) 48px;gap:14px;align-items:center;padding:14px 0;border-top:1px solid var(--line)}.mod-bank-row select{width:100%;max-width:100%}.mod-bank-row small{font-size:10px;color:var(--muted)}.mod-bank-row input[type=range]{width:100%;accent-color:var(--amber)}
.mod-destination{display:grid;grid-template-columns:minmax(140px,1fr) 120px auto;gap:12px;align-items:end;margin:14px 0}.mod-destination small{grid-column:1/-1;color:var(--muted)}
.actions-layout{display:grid;grid-template-columns:240px minmax(0,1fr);gap:20px}.action-picker{display:flex;flex-direction:column;gap:6px;max-height:620px;overflow:auto}.action-picker button{text-align:left;white-space:normal;padding:13px;border-radius:6px}.action-picker button[aria-pressed=true]{border-color:var(--green);background:#1c2923}.actions-form{background:var(--panel);border:1px solid var(--line);border-radius:8px;padding:22px;min-width:0}.actions-form>.bar{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:14px}.actions-toolbar{display:flex;gap:10px;align-items:center;margin:16px 0}
#legacyActionHost #brainActions{display:block;margin:0}#legacyActionHost #brainActions>.device-picker{display:none}#legacyActionHost #brainActions>.bank-form{border:0;padding:0;background:transparent}#legacyActionHost #brainActions>.bank-form[hidden]{display:none}
#snapshotEditor .bar{gap:12px;align-items:end}#snapshotEditor label{display:flex;flex-direction:column;gap:6px;font-size:12px}#snapshotEditor fieldset label{display:inline-flex;flex-direction:row;margin:8px}
#performanceControls{position:static;padding:18px 0;margin:16px 0;border-top:1px solid var(--line);background:transparent}#performanceControls p{font-size:11px;margin:8px 0}#performanceControls .bar{gap:10px}#performanceControls[hidden]{display:none}
.activity-summary{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px;margin:10px 0}.activity-stat,.activity-card{border:1px solid var(--line);background:var(--panel);padding:12px;min-width:0}.activity-stat{border-top:2px solid var(--cyan)}.activity-stat:nth-child(2){border-top-color:var(--green)}.activity-stat:nth-child(3){border-top-color:var(--amber)}.activity-stat:nth-child(4){border-top-color:var(--magenta)}.activity-stat small,.activity-card small{display:block;color:var(--muted);font-size:9px;letter-spacing:.7px;text-transform:uppercase}.activity-stat strong{display:block;font-size:18px;font-weight:400;color:var(--accent);margin:2px 0}.activity-stat span{font-size:10px;color:var(--muted)}
#workspace-activity .workspace-heading{padding:18px 0 4px}#workspace-activity .workspace-heading p{margin-bottom:8px}#workspace-activity section{padding:14px 0}.activity-signal-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px;margin:10px 0}.mod-monitor{--monitor:var(--amber);border-top:2px solid var(--monitor)}.mod-monitor:nth-child(2){--monitor:var(--green)}.mod-monitor:nth-child(3){--monitor:var(--cyan)}.mod-monitor header{display:flex;justify-content:space-between;gap:12px;align-items:start}.mod-monitor h3{font-size:12px;margin:0;color:var(--monitor);font-weight:500}.mod-monitor svg{display:block;width:100%;height:46px;margin:8px 0;background:#111214;border:1px solid var(--line)}.mod-monitor .wave-zero{stroke:#35363c;stroke-width:1}.mod-monitor .wave-line{fill:none;stroke:var(--monitor);stroke-width:2;vector-effect:non-scaling-stroke}.mod-monitor .meter{height:3px;background:#28292e;margin-top:6px}.mod-monitor .meter i{display:block;height:100%;background:var(--monitor)}
.activity-detail-grid{display:grid;grid-template-columns:.85fr 1.55fr 1fr;gap:10px}.activity-detail-grid>.activity-card h3{font-size:11px;color:var(--accent);font-weight:500;margin:0 0 10px;text-transform:uppercase;letter-spacing:1px}.clock-monitor{display:grid;grid-template-columns:70px minmax(0,1fr);gap:12px;align-items:center}.clock-ring{width:66px;height:66px;border-radius:50%;border:1px solid var(--line);background:conic-gradient(var(--cyan) var(--clock-progress,0%),#222329 0);display:grid;place-items:center;position:relative}.clock-ring::after{content:'';position:absolute;inset:7px;border-radius:50%;background:var(--panel)}.clock-ring strong,.clock-ring small{position:relative;z-index:1;text-align:center}.clock-ring strong{font-size:15px;color:var(--cyan);font-weight:400}.clock-ring small{font-size:7px}.clock-detail{display:grid;gap:5px}.clock-detail div{display:flex;justify-content:space-between;gap:8px;border-bottom:1px solid #292a2f;padding-bottom:3px}.clock-detail strong{color:var(--accent);font-weight:400;font-size:10px;text-align:right}.clock-detail small{font-size:8px}
.activity-bank{display:grid;grid-template-columns:66px repeat(3,minmax(76px,1fr));gap:7px;align-items:center;padding:6px 0;border-top:1px solid var(--line)}.activity-bank:first-child{border-top:0}.activity-bank>div:first-child strong{display:block;font-weight:400;font-size:10px}.activity-bank>div:first-child small{font-size:8px}.activity-bank-mod{display:grid;grid-template-columns:20px minmax(0,1fr) 42px;gap:4px;align-items:center;font-size:8px;color:var(--muted)}.activity-bank-mod .track,.parameter-meter{height:5px;background:#28292e;position:relative;overflow:hidden}.activity-bank-mod .track em{display:block;height:100%;position:absolute;left:0;top:0;background:#524836}.activity-bank-mod i,.parameter-meter i{display:block;height:100%;position:relative;background:var(--amber)}.activity-bank-mod:nth-child(3) .track em{background:#354b3b}.activity-bank-mod:nth-child(4) .track em{background:#324a53}.activity-bank-mod:nth-child(3) i{background:var(--green)}.activity-bank-mod:nth-child(4) i{background:var(--cyan)}
.parameter-summary{display:grid;grid-template-columns:repeat(3,1fr);gap:6px;margin-bottom:8px}.parameter-summary div{border-left:2px solid var(--line);padding-left:7px}.parameter-summary strong{display:block;font-size:15px;font-weight:400}.parameter-summary small{font-size:8px}.parameter-change{padding:5px 0;border-top:1px solid var(--line)}.parameter-change header{display:flex;justify-content:space-between;gap:8px;font-size:9px}.parameter-change strong{font-weight:400;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.parameter-change output{color:var(--magenta);white-space:nowrap}.parameter-meter{margin-top:4px}.parameter-meter i{background:var(--magenta)}.parameter-meter b{position:absolute;top:-2px;width:2px;height:9px;background:#fff}.activity-empty{color:var(--muted);padding:10px;border:1px dashed var(--line);grid-column:1/-1;font-size:10px}.activity-log-disclosure{padding:10px 0;border-bottom:1px solid var(--line)}.activity-log-disclosure>summary{cursor:pointer;color:var(--muted);font-size:10px;text-transform:uppercase;letter-spacing:1px}.activity-log-disclosure>summary small{margin-left:8px}.event-list{list-style:none;margin:10px 0 0;padding:0;border:1px solid var(--line);max-height:170px;overflow:auto;background:#101113}.event-list li{display:grid;grid-template-columns:44px minmax(130px,1fr) auto;gap:10px;padding:6px 10px;border-bottom:1px solid #27282d;font-size:10px}.event-list li:last-child{border-bottom:0}.event-direction{color:var(--green)}.event-list li.input .event-direction{color:var(--cyan)}.event-detail{color:var(--muted)}
@media(max-width:850px){.mod-fields{grid-template-columns:repeat(2,minmax(0,1fr))}.actions-layout{grid-template-columns:180px minmax(0,1fr)}.mod-bank-row{grid-template-columns:90px minmax(90px,1fr) minmax(90px,1fr) 40px}}
@media(max-width:950px){.activity-detail-grid{grid-template-columns:1fr 1.5fr}.activity-detail-grid>.activity-card:last-child{grid-column:1/-1}.activity-summary{grid-template-columns:repeat(2,minmax(0,1fr))}}
@media(max-width:650px){.group-nav{grid-template-columns:repeat(2,minmax(0,1fr))}.snapshot-picker{grid-template-columns:repeat(2,minmax(0,1fr))}.actions-layout{grid-template-columns:1fr}.action-picker{max-height:220px}.mod-heading,.mod-section{padding:16px}.mod-fields,.actions-form>.bar{grid-template-columns:1fr 1fr}.mod-bank-row{grid-template-columns:1fr 1fr}.mod-destination{grid-template-columns:1fr 100px}.mod-picker button{padding:12px 8px}.workspace-disclosure small{display:block;margin:8px 0}.activity-signal-grid,.activity-detail-grid{grid-template-columns:1fr}.activity-detail-grid>.activity-card:last-child{grid-column:auto}.activity-bank{min-width:440px}.activity-bank-wrap{overflow:auto}.event-list li{grid-template-columns:38px 1fr}.event-detail{grid-column:2}}
.bank-mod-amounts.depth-grid{grid-template-columns:minmax(0,1fr);gap:10px;margin:20px 0}.bank-mod-amounts.depth-grid label{display:block;min-width:0;padding:10px;text-transform:none;overflow-wrap:anywhere}.bank-mod-amounts.depth-grid label span{float:none;display:block;margin-top:5px}.bank-mod-amounts.depth-grid input{width:100%;margin-top:8px}

</style>

<link rel="stylesheet" href="/shell.css">
<div class="app-shell" id="appShell">
<aside class="app-sidebar" id="appSidebar" aria-label="Main navigation">
<header class="sidebar-brand"><span class="sidebar-mark" aria-hidden="true">[M]</span><h1>midi<span>:</span>brain<span>_</span></h1><button id="collapseSidebar" aria-label="Collapse sidebar" title="Collapse sidebar">‹</button></header>
<nav class="workspace-nav" aria-label="Workspace">
<div class="nav-section">PERFORM</div>
<button data-group="mixer" aria-pressed="true" title="Banks"><span class="nav-icon" aria-hidden="true">▦</span><span class="nav-label">Banks</span></button>
<button data-group="sidechain" aria-pressed="false" title="MOD"><span class="nav-icon" aria-hidden="true">∿</span><span class="nav-label">MOD</span></button>
<div class="nav-section">CONNECT</div>
<button data-group="controls" aria-pressed="false" title="Routing"><span class="nav-icon" aria-hidden="true">⇄</span><span class="nav-label">Routing</span></button>
<button data-group="clock" aria-pressed="false" title="Clock"><span class="nav-icon" aria-hidden="true">◷</span><span class="nav-label">Clock</span></button>
<button data-workspace="devices" aria-pressed="false" title="Devices"><span class="nav-icon" aria-hidden="true">⌘</span><span class="nav-label">Devices</span></button>
<div class="nav-section">MONITOR</div>
<button data-workspace="activity" aria-pressed="false" title="Activity"><span class="nav-icon" aria-hidden="true">≋</span><span class="nav-label">Activity</span></button>
</nav>
<div id="sidebarContext" class="sidebar-context"></div>
<div class="sidebar-foot"><span class="palette" aria-hidden="true"><i></i><i></i><i></i><i></i></span><span class="nav-label">MIDI / PERFORMANCE</span><a class="nav-label" href="/surfaces">SURFACES LAB ↗</a></div>
</aside>
<button class="sidebar-scrim" id="sidebarScrim" aria-label="Close navigation" hidden></button>
<div class="app-content">
<header class="workspace-toolbar"><button id="toggleSidebar" aria-controls="appSidebar" aria-expanded="true" aria-label="Toggle navigation">☰</button><div class="workspace-location"><span class="eyebrow" id="workspaceCategory">PERFORM</span><strong id="workspaceTitle">Banks</strong></div><span id="settingsStatus" class="muted" role="status">Edits stay in draft until saved</span><div class="save-area"><button id="save">Save settings</button><details class="runtime-menu"><summary aria-label="More settings">•••</summary><div><button id="discardSettings">Discard edits</button><button id="restartRuntime">Restart runtime</button></div></details></div></header>
<div class="workspace-alerts"><p id="notice" role="alert"></p><details id="connectionWarnings" hidden><summary id="connectionSummary"></summary><p>Connected gear keeps working. Saved connections retry automatically when available.</p><ul id="connectionList"></ul></details></div>
<main id="workspaceMain">

<div id="workspace-groups" class="workspace">
<div hidden><span id="mixerSummary"></span><span id="sidechainSummary"></span><span id="controlsSummary"></span><span id="clockSummary"></span></div>
<div id="group-mixer" class="group-panel" tabindex="-1"><div id="bankModOverview"></div><div id="liveActions"></div><section><div class="section-head"><h2>Banks</h2><span class="section-id">PLAY / Your controls</span></div><div class="bar"><button id="addBank">Add bank</button><button data-workspace="devices">Edit devices</button></div><div id="bankEditor"></div></section>
<details id="snapshotsDisclosure" class="workspace-disclosure"><summary>Snapshots <small>8 saved states · instant or on the one</small></summary><div id="snapshotEditor"></div></details>
</div>
<div id="group-sidechain" class="group-panel" tabindex="-1" hidden><section><div class="section-head"><h2>Modulation</h2><span class="section-id">ENVELOPES / LFO</span></div><p></p><div id="modEditor"></div></section></div>
<div hidden aria-hidden="true"><input id="triggerChannel"><input id="triggerNote"><button id="applyTrigger">Apply input filter</button><input id="release"><button id="apply">Apply release</button><div id="bankDepths"></div><button id="panic">Release all gates</button><span id="demoControls"><button id="noteOn">Demo note on</button><button id="noteOff">Demo note off</button></span></div>
<div id="group-controls" class="group-panel" tabindex="-1" hidden><section><div class="section-head"><h2>Routing</h2><span class="section-id">CONNECT / MIDI paths</span></div><p></p><div id="quickDevices"><div id="routeRange"></div><div id="ccRoutes"></div><button id="addRoute">Add CC route</button></div></section><div id="actionsSection" hidden><div id="performanceBindings"></div><div id="legacyActionHost"><div id="brainActions"></div><button id="addBrainAction">Add legacy action</button><p id="brainActionStatus" role="status"></p></div></div></div>
<div id="group-clock" class="group-panel" tabindex="-1" hidden><section><div class="section-head"><h2>Clock distribution</h2><span class="section-id">SYNC / Shared tempo</span></div><p>Choose the input carrying your master’s clock, then select every output that should follow it.</p>
<div class="bar"><label>Clock source / master input <select id="clockSource" aria-label="Clock source / master input"></select></label><label class="checkline"><input type="checkbox" id="clockTransport">Forward start, stop, continue &amp; song position</label></div>
<fieldset id="clockTargets"><legend>Send clock to these output ports</legend></fieldset><p id="clockLive" class="muted"></p></section></div>
<div id="patchbayActions" class="routing-actions" hidden><div class="bar"><span id="patchbayStatus" class="muted"></span></div><p id="routingLifecycle" class="muted">Save settings → Restart runtime. Active routes stay in place until restart.</p>
<details><summary>Active clock &amp; CC routes</summary><pre id="activePatchbay"></pre></details></div>
</div>
<div id="workspace-devices" class="workspace" hidden><section><div class="section-head"><h2>Device definitions</h2><span class="section-id">DEFINE / Layouts + parameters</span></div><p>Define your controller inputs and the parameters your instruments receive.</p><nav class="device-tabs" aria-label="Device definitions"><button data-device-kind="controller" aria-pressed="true">Controllers</button><button data-device-kind="destination" aria-pressed="false">Destinations</button><button data-device-kind="catalog" aria-pressed="false">Device catalogue</button></nav><div class="bar"><button id="addController">Add controller</button><button id="addDestination" hidden>Add destination</button></div><div id="deviceEditor"></div>
<div id="catalogPanel" hidden><h3>Device catalogue</h3><p>Browse the Pencil Research manufacturer/device index. Only the CSV you preview is fetched; nothing is imported automatically.</p><button id="loadCatalog">Load catalogue index</button><p id="catalogNotice" role="status"></p><div id="catalogBrowser" hidden><div class="bar"><label>Manufacturer <select id="catalogMaker"></select></label><label>Find device <input id="catalogSearch" type="search" placeholder="Filter device names"></label></div><div id="catalogFiles"></div></div><div id="catalogPreview"></div><p class="muted"><a href="https://github.com/pencilresearch/midi" target="_blank" rel="noreferrer">Pencil Research MIDI dataset</a> · <a href="https://creativecommons.org/licenses/by-sa/4.0/" target="_blank" rel="noreferrer">CC BY-SA 4.0</a>. Imports retain source, revision, and attribution. Verify the map against your device settings.</p></div></section><section><div class="section-head"><h2>Connected devices &amp; ports</h2><span class="section-id">01 / Inventory</span></div>
<p id="inventoryHint">Every input and output reported by the MIDI host. Inputs enter MIDIBRAIN; outputs leave MIDIBRAIN.</p>
<div id="portInventory" class="device-grid"></div>
<p class="muted">USB device groups use the host’s port names. A synth connected through a DIN cable appears under its USB interface: Digitone II → L6 MIDI IN appears as the L6 MIDI I/O input.</p></section></div>
<div id="workspace-activity" class="workspace" hidden>
<div class="workspace-heading"><div class="eyebrow">Live system view</div><h2>Activity</h2><p>See clock, modulation, bank amounts, parameter output and MIDI traffic together.</p></div>
<section><div class="section-head"><h2>Overview</h2><span class="section-id">MONITOR / Runtime</span></div><div id="activitySummary" class="activity-summary"></div></section>
<section><div class="section-head"><h2>MOD signals</h2><span class="section-id">LIVE / Sources</span></div><div id="activityMods" class="activity-signal-grid"></div></section>
<section><div class="section-head"><h2>System detail</h2><span class="section-id">SYNC / ROUTES / VALUES</span></div><div class="activity-detail-grid"><article class="activity-card"><h3>Clock</h3><div id="activityClock" class="clock-monitor"></div></article><article class="activity-card"><h3>Bank modulation <small>live / configured</small></h3><div class="activity-bank-wrap"><div id="activityBanks"></div></div></article><article class="activity-card"><h3>Parameters</h3><div id="activityParameters"></div></article></div></section>
<details class="activity-log-disclosure"><summary>Recent MIDI <small id="activityEventCount">0 messages</small></summary><ol id="events" class="event-list" tabindex="0" aria-label="Recent MIDI activity"><li>Waiting for MIDI…</li></ol></details>
</div>
<section id="performanceControls"><div class="bar"><span id="performanceDraftStatus" role="status"></span></div><p>Save settings commits all edits. MOD-only edits take effect when saved; device, bank and routing edits need a runtime restart. Snapshot captures save automatically in a separate file.</p><p id="performanceLive" role="status"></p></section><div id="bankActions" class="routing-actions"><div class="bar"><span id="bankStatus" class="muted"></span></div><p class="muted">Live MOD amounts respond immediately. Save settings keeps their values after restart.</p></div></main>
<footer class="runtime-bar"><div id="status" class="status" role="status">Connecting...</div><span class="runtime-label">MIDI:BRAIN</span></footer>
</div></div>
<script src="/patchbay.js"></script>
<script src="/controls.js"></script>
<script src="/banks.js"></script>
<script src="/mappings.js"></script>
<script src="/catalog.js"></script>
<script src="/performance.js"></script>
<script src="/activity.js"></script>
<script src="/live_banks.js"></script>
<script src="/settings.js"></script>
<script src="/shell.js"></script>
<script>
const $=id=>document.getElementById(id);let routing=null,triggerDirty=false,portsDirty=false,activeGroup='mixer',activeWorkspace='groups';
async function post(path,body={}){try{const r=await fetch('/api/'+path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});const data=await r.json();if(!r.ok)throw new Error(typeof data.detail==='string'?data.detail:JSON.stringify(data.detail));$('notice').textContent=path==='save'?'Settings saved.':'Applied.';return true;}catch(e){$('notice').textContent=e.message;return false;}}
function renderRuntimeStatus(s){
 const connections=s.connections||{},offline=(connections.endpoints||[]).filter(e=>e.state!=='connected');
 $('status').textContent=(s.demo?'SIMULATION · ':'')+(s.running?'Running':'Recovering')+(offline.length?' · '+offline.length+' unavailable connections':'')+' · '+s.held_notes+' held notes · '+s.sent_count+' CC messages'+(s.error?' · '+s.error:'');
 $('connectionWarnings').hidden=!offline.length&&!connections.discovery_error;
 $('connectionSummary').textContent=offline.length?'Connection details ('+offline.length+' unavailable)':'MIDI discovery is retrying';
 const list=$('connectionList');list.replaceChildren();
 for(const endpoint of offline){const item=document.createElement('li');item.textContent=endpoint.direction+' · '+endpoint.configured+' · '+(endpoint.state==='retrying'?'Retrying: '+endpoint.detail:'Unavailable');list.appendChild(item);}
 if(connections.discovery_error){const item=document.createElement('li');item.textContent='Discovery: '+connections.discovery_error;list.appendChild(item);}
 $('save').disabled=settingsSaving;$('save').textContent=s.demo?'Apply simulation':'Save settings';
}
function updatePageActions(){const onBrain=activeWorkspace==='groups';$('performanceControls').hidden=!(onBrain&&['mixer','sidechain','controls'].includes(activeGroup)&&performanceState?.native);$('bankActions').hidden=!(activeWorkspace==='devices'||onBrain&&activeGroup==='mixer');}
function showWorkspace(name){activeWorkspace=name;for(const item of document.querySelectorAll('.workspace'))item.hidden=item.id!=='workspace-'+name;for(const button of document.querySelectorAll('[data-workspace]'))button.setAttribute('aria-pressed',String(button.dataset.workspace===name));for(const button of document.querySelectorAll('[data-group]'))button.setAttribute('aria-pressed',String(name==='groups'&&button.dataset.group===activeGroup));updatePageActions();updateShell();}
function showGroup(name){activeGroup=name;showWorkspace('groups');for(const item of document.querySelectorAll('.group-panel'))item.hidden=item.id!=='group-'+name;for(const button of document.querySelectorAll('[data-group]'))button.setAttribute('aria-pressed',String(button.dataset.group===name));$('patchbayActions').hidden=!['controls','clock'].includes(name);if(performanceDraft)buildPerformance();updatePageActions();updateShell();}
for(const button of document.querySelectorAll('[data-workspace]'))button.onclick=()=>showWorkspace(button.dataset.workspace);
for(const button of document.querySelectorAll('[data-group]'))button.onclick=()=>showGroup(button.dataset.group);
$('apply').onclick=()=>post('release',{release_ms:Number($('release').value)});
$('save').onclick=saveSettings;$('discardSettings').onclick=discardSettings;
$('panic').onclick=()=>post('panic');
$('noteOn').onclick=()=>post('demo-note',{note:routing?.trigger.note??60,velocity:127});$('noteOff').onclick=()=>post('demo-note',{note:routing?.trigger.note??60,velocity:0});
for(const id of ['triggerChannel','triggerNote'])$(id).oninput=()=>{triggerDirty=true;};
$('applyTrigger').onclick=async()=>{const channel=Number($('triggerChannel').value),note=$('triggerNote').value===''?null:Number($('triggerNote').value);if(await post('trigger',{channel,note}))triggerDirty=false;};

async function refresh(){try{if(activeWorkspace==='activity'){const response=await fetch('/api/activity');if(!response.ok)throw new Error('Activity unavailable');const data=await response.json();renderRuntimeStatus(data.status);renderActivity(data.status,data.routing,data.banks,data.performance);return;}const responses=await Promise.all([fetch('/api/status'),fetch('/api/routing'),fetch('/api/banks'),fetch('/api/performance')]);if(responses.some(r=>!r.ok))throw new Error('Status unavailable');const [s,r,b,f]=await Promise.all(responses.map(r=>r.json()));routing=r;
renderRuntimeStatus(s);$('demoControls').hidden=!s.demo;
if(document.activeElement!==$('release'))$('release').value=s.release_ms;
if(!triggerDirty){$('triggerChannel').value=r.trigger.channel;$('triggerNote').value=r.trigger.note??'';}
if(activeWorkspace==='activity')renderActivity(s,r,b,f);else{renderPatchbay(r);renderBanks(b,r);renderPerformance(f,b);renderActivity(s,r,b,f);}
$('controlsSummary').textContent=r.patchbay.cc.length+' CC routes · '+((f.config?.actions?.length||0)+(b.active?.resets?.length||0))+' actions';$('clockSummary').textContent=r.active_patchbay.clock.source?r.active_patchbay.clock.destinations.length+' active destinations':'No master assigned';$('sidechainSummary').textContent='3 sources · individual bank amounts';
renderBankModAmounts(b,f);renderBankValues(b,f);renderBankOverview(b,f);if(activeWorkspace==='groups'&&activeGroup==='controls')buildMappingRows();updateSettingsStatus(b,r);updateShell();
}catch(e){$('status').textContent='Disconnected · '+e.message;}finally{setTimeout(refresh,activeWorkspace==='activity'?1000:700);}}refresh();
</script></html>"""

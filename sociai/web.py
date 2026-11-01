"""Tiny web UI (stdlib only): python -m sociai.web  ->  http://localhost:8000

Flow: fill the form -> Research -> review/edit the research -> Draft -> edit and copy.
"""

import json
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from .engine import Dossier, Engine, OutreachRequest

engine = Engine()

PAGE = r"""<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Sociai</title>
<style>
body{font:15px/1.5 system-ui,sans-serif;max-width:820px;margin:24px auto;padding:0 16px;color:#1d1d1f;background:#fafafa}
h1{margin:0 0 4px}.sub{color:#666;margin:0 0 20px}
label{display:block;font-weight:600;margin:14px 0 4px}
input,textarea,select{width:100%;box-sizing:border-box;padding:8px;border:1px solid #ccc;border-radius:6px;font:inherit;background:#fff}
textarea{min-height:80px}.row{display:flex;gap:12px}.row>div{flex:1}
button{margin-top:16px;padding:10px 18px;border:0;border-radius:6px;background:#2f5bea;color:#fff;font:inherit;cursor:pointer}
button:disabled{opacity:.5}.card{background:#fff;border:1px solid #e3e3e3;border-radius:8px;padding:16px;margin-top:20px}
.hidden{display:none}.muted{color:#666;font-size:13px}ul{padding-left:20px}
</style></head><body>
<h1>Sociai</h1><p class="sub">Researches who you're reaching out to, then drafts a message in your voice.</p>
<label>Use case</label>
<select id="preset"><option value="">Custom</option></select>
<label>Who are you reaching out to? (name + context, or a link)</label>
<input id="target" placeholder="e.g. Prof. Jane Doe, Stanford NLP group">
<label>What do you want?</label>
<textarea id="goal"></textarea>
<label>About you (optional)</label>
<textarea id="background"></textarea>
<label>Samples of your own writing (optional, paste 1-3 emails or posts)</label>
<textarea id="samples" placeholder="Separate samples with a line containing ---"></textarea>
<div class="row"><div><label>Channel</label><input id="channel" value="email"></div>
<div><label>Max words</label><input id="max_words" type="number" value="180"></div></div>
<button id="go">1. Research</button>

<div id="r" class="card hidden"><h3>Research <span class="muted">(edit anything that's wrong before drafting)</span></h3>
<textarea id="dossier" style="min-height:260px;font-family:ui-monospace,monospace;font-size:13px"></textarea>
<button id="draftBtn">2. Draft message</button></div>

<div id="d" class="card hidden"><h3>Draft</h3>
<input id="subject"><textarea id="body" style="min-height:220px;margin-top:8px"></textarea>
<div id="notes" class="muted"></div></div>

<script>
const PRESETS={
 "Student → professor (research)":["Ask to join their lab as an undergraduate research assistant next semester, or for a short call about open projects.","CS junior, took ML and NLP courses, built a small project fine-tuning a sentiment model."],
 "Job seeker → recruiter":["Get a referral or a first conversation about a role on their team.",""],
 "Founder → investor":["Get a 20-minute intro call about our pre-seed round.",""],
 "Sales → prospect":["Book a short demo of our product for their team.",""],
 "Networking / advice":["Ask for 15 minutes of advice about their career path.",""],
 "Journalist / podcast guest":["Invite them to be interviewed.",""]};
const sel=document.getElementById('preset');
for(const k in PRESETS){const o=document.createElement('option');o.textContent=k;sel.appendChild(o)}
sel.onchange=()=>{const p=PRESETS[sel.value];if(p){goal.value=p[0];background.value=p[1]}};
const $=id=>document.getElementById(id);
function req(){return{target:$('target').value,goal:$('goal').value,sender_background:$('background').value,
 writing_samples:$('samples').value.split(/\n---\n/).map(s=>s.trim()).filter(Boolean),
 channel:$('channel').value,max_words:+$('max_words').value}}
async function post(url,data,btn){btn.disabled=true;const t=btn.textContent;btn.textContent='Working…';
 try{const r=await fetch(url,{method:'POST',body:JSON.stringify(data)});const j=await r.json();if(j.error)throw j.error;return j}
 catch(e){alert(e)}finally{btn.disabled=false;btn.textContent=t}}
$('go').onclick=async()=>{const j=await post('/research',req(),$('go'));if(!j)return;
 window.dz=j;$('dossier').value=j.text;$('r').classList.remove('hidden')};
$('draftBtn').onclick=async()=>{const j=await post('/draft',{request:req(),dossier:window.dz.dossier,edited:$('dossier').value},$('draftBtn'));if(!j)return;
 $('subject').value=j.subject;$('body').value=j.body;
 $('notes').innerHTML='<p><b>Why it\'s personal</b></p><ul>'+j.personalization_notes.map(n=>'<li>'+n+'</li>').join('')+'</ul>'+
  '<p><b>Voice:</b> '+j.voice_notes+'</p>'+(j.open_questions.length?'<p><b>Check before sending</b></p><ul>'+j.open_questions.map(n=>'<li>'+n+'</li>').join('')+'</ul>':'');
 $('d').classList.remove('hidden')};
</script></body></html>"""


class EditedDossier(Dossier):
    """A dossier the user edited by hand: draft from their text, not the original."""

    def __init__(self, text: str):
        super().__init__(summary="", facts=[], hooks=[], cautions=[], sources=[])
        self._text = text

    def as_text(self) -> str:
        return self._text


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        self._send(200, PAGE.encode(), "text/html; charset=utf-8")

    def do_POST(self):
        data = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        try:
            if self.path == "/research":
                dossier = engine.research(OutreachRequest(**data))
                out = {"dossier": dossier.__dict__, "text": dossier.as_text()}
            elif self.path == "/draft":
                req = OutreachRequest(**data["request"])
                original = Dossier(**data["dossier"])
                dossier = original if data["edited"] == original.as_text() else EditedDossier(data["edited"])
                out = engine.draft(req, dossier).__dict__
            else:
                return self._send(404, b"{}", "application/json")
        except Exception as e:  # surface API errors in the UI during prototyping
            cause = f" (cause: {e.__cause__!r})" if e.__cause__ else ""
            out = {"error": f"{type(e).__name__}: {e}{cause}"}
        self._send(200, json.dumps(out).encode(), "application/json")

    def _send(self, code, body, ctype):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.end_headers()
        self.wfile.write(body)


if __name__ == "__main__":
    print("Sociai running at http://localhost:8000")
    ThreadingHTTPServer(("127.0.0.1", 8000), Handler).serve_forever()
